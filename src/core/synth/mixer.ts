// Mixer: per-channel stems, trim + pan, chip mix model, per-chip output filters, soft limiter, Int16 output.
//
// Signal path per channel (linear model):  raw DAC units -> x linearGain -> chip filters (mono) -> x trim
//   -> pan gains -> x chip output gain -> stem (L/R) -> sum into the master -> soft limiter.
// The filters are linear, so with the linear model the stems add up to the pre-limiter master.
// NES 'nonlinear' model: the raw channel values are combined with the 2A03 pulse/tnd DAC formulas into a
// mono signal that goes through one filter chain (pan is ignored: the hardware is mono). Stems then use the
// single-channel nonlinear value (they do not sum exactly to the master).

import type { ChipId, Song } from '../types'
import type { ChipVoice } from './chips/types'
import { clamp, dbToGain } from './tables'

export type MixModel = 'nonlinear' | 'linear'

export interface Filter {
  process(buf: Float32Array, n: number): void
  reset(): void
}

class HighPass implements Filter {
  private px = 0
  private py = 0
  private readonly a: number
  constructor(sampleRate: number, cutoff: number) {
    const rc = 1 / (2 * Math.PI * cutoff)
    this.a = rc / (rc + 1 / sampleRate)
  }
  process(buf: Float32Array, n: number): void {
    let px = this.px
    let py = this.py
    const a = this.a
    for (let i = 0; i < n; i++) {
      const x = buf[i]!
      py = a * (py + x - px)
      px = x
      buf[i] = py
    }
    this.px = px
    this.py = py
  }
  reset(): void {
    this.px = 0
    this.py = 0
  }
}

class LowPass implements Filter {
  private y = 0
  private readonly k: number
  constructor(sampleRate: number, cutoff: number) {
    this.k = 1 - Math.exp((-2 * Math.PI * cutoff) / sampleRate)
  }
  process(buf: Float32Array, n: number): void {
    let y = this.y
    const k = this.k
    for (let i = 0; i < n; i++) {
      y += k * (buf[i]! - y)
      buf[i] = y
    }
    this.y = y
  }
  reset(): void {
    this.y = 0
  }
}

/** The DMG output capacitor (DC blocker, ~28 Hz at CPU-rate charge factor 0.999958). */
class GbCapacitor implements Filter {
  private cap = 0
  private readonly charge: number
  constructor(sampleRate: number) {
    this.charge = Math.pow(0.999958, 4194304 / sampleRate)
  }
  process(buf: Float32Array, n: number): void {
    let cap = this.cap
    const ch = this.charge
    for (let i = 0; i < n; i++) {
      const x = buf[i]!
      const out = x - cap
      cap = x - out * ch
      buf[i] = out
    }
    this.cap = cap
  }
  reset(): void {
    this.cap = 0
  }
}

export interface NonlinearModel {
  /** Combine the summed raw values of the four NES groups into one linear output. */
  combine(pulse: number, tri: number, noise: number, dpcm: number): number
}

export interface ChipMixProfile {
  /** Linear gain applied to the chip's channels (brings the chip to a usable level). */
  outputGain: number
  filters(sampleRate: number): Filter[]
  /** Quantise a -1..1 pan to what the chip can do (default: unchanged). */
  quantizePan?(pan: number): number
  nonlinear?: NonlinearModel
}

const NES_NONLINEAR: NonlinearModel = {
  combine(pulse, tri, noise, dpcm) {
    const p = Math.max(pulse, -50)
    const s = Math.max(tri / 8227 + noise / 12241 + dpcm / 22638, -0.005)
    return (95.88 * p) / (8128 + 100 * p) + (159.79 * s) / (1 + 100 * s)
  }
}

const profiles = new Map<ChipId, ChipMixProfile>()
const DEFAULT_PROFILE: ChipMixProfile = { outputGain: 1, filters: () => [] }

export function registerMixProfile(chip: ChipId, profile: ChipMixProfile): void {
  profiles.set(chip, profile)
}
export function mixProfileFor(chip: ChipId): ChipMixProfile {
  return profiles.get(chip) ?? DEFAULT_PROFILE
}

registerMixProfile('nes', {
  outputGain: 2,
  filters: (sr) => [new HighPass(sr, 90), new HighPass(sr, 440), new LowPass(sr, Math.min(14000, sr * 0.45))],
  nonlinear: NES_NONLINEAR
})
registerMixProfile('gb', {
  outputGain: 1.5,
  filters: (sr) => [new GbCapacitor(sr)],
  // NR51: each channel goes hard left, centre (both) or hard right
  quantizePan: (p) => (p < -0.33 ? -1 : p > 0.33 ? 1 : 0)
})

/** Soft limiter: linear below 0.8, smooth knee towards +-1. */
export function softLimit(x: number): number {
  const a = x < 0 ? -x : x
  if (a <= 0.8) return x
  const s = 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2)
  return x < 0 ? -s : s
}

export interface StemBuffer {
  L: Float32Array
  R: Float32Array
}

export interface MixerOptions {
  sampleRate: number
  maxBlock: number
  mixModel?: MixModel
}

export class Mixer {
  readonly profile: ChipMixProfile
  readonly mixModel: MixModel
  private readonly nChan: number
  private readonly chain: Filter[][] = []
  private readonly master: Filter[]
  private readonly gl: Float64Array
  private readonly gr: Float64Array
  private readonly trim: Float64Array
  readonly muted: boolean[]
  private readonly tmp: Float32Array
  private readonly mono: Float32Array
  private song: Song

  constructor(song: Song, voices: readonly ChipVoice[], private readonly opts: MixerOptions) {
    this.song = song
    this.profile = mixProfileFor(song.chip)
    const cfgModel = song.chipConfig.chip === 'nes' ? song.chipConfig.mixModel : 'linear'
    this.mixModel = this.profile.nonlinear ? (opts.mixModel ?? cfgModel) : 'linear'
    this.nChan = voices.length
    this.voices = voices
    for (let i = 0; i < this.nChan; i++) this.chain.push(this.profile.filters(opts.sampleRate))
    this.master = this.profile.filters(opts.sampleRate)
    this.gl = new Float64Array(this.nChan).fill(1)
    this.gr = new Float64Array(this.nChan).fill(1)
    this.trim = new Float64Array(this.nChan).fill(1)
    this.muted = new Array<boolean>(this.nChan).fill(false)
    this.tmp = new Float32Array(opts.maxBlock)
    this.mono = new Float32Array(opts.maxBlock)
    this.syncTrim()
  }
  private voices: readonly ChipVoice[]

  /** Re-read trims from the song (after a hot swap). */
  setSong(song: Song, voices: readonly ChipVoice[]): void {
    this.song = song
    this.voices = voices
    this.syncTrim()
  }

  private syncTrim(): void {
    for (let i = 0; i < this.nChan; i++) this.trim[i] = dbToGain(this.song.channels[i]?.trim ?? 0)
  }

  setPan(i: number, pan: number): void {
    const p = clamp(this.profile.quantizePan ? this.profile.quantizePan(pan) : pan, -1, 1)
    this.gl[i] = p > 0 ? 1 - p : 1
    this.gr[i] = p < 0 ? 1 + p : 1
  }

  reset(): void {
    for (const c of this.chain) for (const f of c) f.reset()
    for (const f of this.master) f.reset()
  }

  /**
   * Mix `n` frames. `raw[i]` holds voice i's output in [0, n). Writes (overwrites) L/R[off, off+n) and, when
   * given, stems[i].L/R[off, off+n).
   */
  mix(
    raw: readonly Float32Array[],
    n: number,
    L: Float32Array,
    R: Float32Array,
    off: number,
    stems?: readonly StemBuffer[],
    aux?: readonly StemBuffer[],
    auxStems?: readonly StemBuffer[]
  ): void {
    const gain = this.profile.outputGain
    const nl = this.mixModel === 'nonlinear' && this.profile.nonlinear
    for (let i = 0; i < n; i++) {
      L[off + i] = 0
      R[off + i] = 0
    }
    const tmp = this.tmp
    if (nl) {
      const model = this.profile.nonlinear!
      const mono = this.mono
      for (let i = 0; i < n; i++) {
        let p = 0
        let t = 0
        let no = 0
        let d = 0
        for (let c = 0; c < this.nChan; c++) {
          if (this.muted[c]) continue
          const v = raw[c]![i]! * this.trim[c]!
          switch (this.voices[c]!.mixGroup) {
            case 'pulse':
              p += v
              break
            case 'tri':
              t += v
              break
            case 'noise':
              no += v
              break
            default:
              d += v
          }
        }
        mono[i] = model.combine(p, t, no, d)
      }
      for (const f of this.master) f.process(mono, n)
      for (let i = 0; i < n; i++) {
        const v = mono[i]! * gain
        L[off + i] = v
        R[off + i] = v
      }
      if (stems) {
        for (let c = 0; c < this.nChan; c++) {
          const st = stems[c]
          const voice = this.voices[c]!
          const tr = this.trim[c]!
          for (let i = 0; i < n; i++) {
            const v = raw[c]![i]! * tr
            tmp[i] =
              voice.mixGroup === 'pulse'
                ? model.combine(v, 0, 0, 0)
                : voice.mixGroup === 'tri'
                  ? model.combine(0, v, 0, 0)
                  : voice.mixGroup === 'noise'
                    ? model.combine(0, 0, v, 0)
                    : model.combine(0, 0, 0, v)
          }
          for (const f of this.chain[c]!) f.process(tmp, n)
          if (!st) continue
          const m = this.muted[c]
          const gL = this.gl[c]! * gain
          const gR = this.gr[c]! * gain
          for (let i = 0; i < n; i++) {
            st.L[off + i] = m ? 0 : tmp[i]! * gL
            st.R[off + i] = m ? 0 : tmp[i]! * gR
          }
        }
      }
    } else {
      for (let c = 0; c < this.nChan; c++) {
        const voice = this.voices[c]!
        const src = raw[c]!
        const k = voice.linearGain
        for (let i = 0; i < n; i++) tmp[i] = src[i]! * k
        for (const f of this.chain[c]!) f.process(tmp, n)
        const st = stems?.[c]
        const m = this.muted[c]
        const g = this.trim[c]! * gain
        const gL = this.gl[c]! * g
        const gR = this.gr[c]! * g
        if (m) {
          if (st) {
            st.L.fill(0, off, off + n)
            st.R.fill(0, off, off + n)
          }
          continue
        }
        for (let i = 0; i < n; i++) {
          const v = tmp[i]!
          L[off + i]! += v * gL
          R[off + i]! += v * gR
        }
        if (st) {
          for (let i = 0; i < n; i++) {
            st.L[off + i] = tmp[i]! * gL
            st.R[off + i] = tmp[i]! * gR
          }
        }
      }
    }
    if (aux) {
      // shared buses (SNES echo): already pan/trim applied, only the chip output gain is left
      for (let a = 0; a < aux.length; a++) {
        const src = aux[a]!
        const st = auxStems?.[a]
        for (let i = 0; i < n; i++) {
          const l = src.L[i]! * gain
          const r = src.R[i]! * gain
          L[off + i]! += l
          R[off + i]! += r
          if (st) {
            st.L[off + i] = l
            st.R[off + i] = r
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      L[off + i] = softLimit(L[off + i]!)
      R[off + i] = softLimit(R[off + i]!)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Int16 conversion with seeded TPDF dither

export class Dither {
  private s: number
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1
  }
  /** Uniform in [0, 1). */
  private rnd(): number {
    let x = this.s
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    this.s = x
    return x / 4294967296
  }
  /** Triangular noise in (-1, 1) LSB. */
  tpdf(): number {
    return this.rnd() - this.rnd()
  }
}

export function floatToInt16(src: Float32Array, dither?: Dither): Int16Array {
  const out = new Int16Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const v = src[i]! * 32767 + (dither ? dither.tpdf() : 0)
    out[i] = Math.max(-32768, Math.min(32767, Math.round(v)))
  }
  return out
}

/** Stereo Float32 -> Int16 with deterministic TPDF dither (one generator, L then R per frame). */
export function quantizeStereo(L: Float32Array, R: Float32Array, opts: { dither?: boolean; seed?: number } = {}): { L: Int16Array; R: Int16Array } {
  const d = opts.dither === false ? undefined : new Dither(opts.seed)
  const n = L.length
  const outL = new Int16Array(n)
  const outR = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    const a = L[i]! * 32767 + (d ? d.tpdf() : 0)
    const b = R[i]! * 32767 + (d ? d.tpdf() : 0)
    outL[i] = Math.max(-32768, Math.min(32767, Math.round(a)))
    outR[i] = Math.max(-32768, Math.min(32767, Math.round(b)))
  }
  return { L: outL, R: outR }
}

export function interleave(L: Int16Array, R: Int16Array): Int16Array {
  const out = new Int16Array(L.length * 2)
  for (let i = 0; i < L.length; i++) {
    out[2 * i] = L[i]!
    out[2 * i + 1] = R[i]!
  }
  return out
}
