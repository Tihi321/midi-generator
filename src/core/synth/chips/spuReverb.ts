// The PS1 SPU reverb (`_reverb` stem): the psx-spx algorithm with its classic register presets, as a `SendBus` that the
// 16 or 24 SPU voices feed through their per-voice reverb send.
//
// Algorithm (nocash psx-spx, "SPU Reverb Registers" / "Reverb Formula"), run once per reverb tick on a ring buffer of
// 16-bit words (the "work area"), all products `(a * b) >> 15` and every intermediate saturated to 16 bits:
//   [mLSAME] = (Lin + [dLSAME] * vWALL - [mLSAME-1]) * vIIR + [mLSAME-1]        (same-side reflection, right alike)
//   [mLDIFF] = (Lin + [dRDIFF] * vWALL - [mLDIFF-1]) * vIIR + [mLDIFF-1]        (other-side reflection)
//   Lout     = vCOMB1 * [mLCOMB1] + vCOMB2 * [mLCOMB2] + vCOMB3 * [mLCOMB3] + vCOMB4 * [mLCOMB4]   (early echo)
//   APF1:  Lout -= vAPF1 * [mLAPF1-dAPF1]; [mLAPF1] = Lout; Lout = Lout * vAPF1 + [mLAPF1-dAPF1]
//   APF2:  the same with mLAPF2 / dAPF2 / vAPF2; the output is Lout * vLOUT (right alike).
// The ring pointer advances one word per tick; register values are in units of 8 bytes = 4 words, so a register
// difference d is a delay of 4 * d ticks. The reverb ticks at 22.05 kHz: the hardware computes the left and the right
// side on alternate 44.1 kHz samples, and this model runs both sides on every second DSP step.
//
// Rate conversion (accuracy versus cost): the hardware filters with a 39-tap FIR; here the 44.1 kHz send is decimated
// with the 4-tap binomial low-pass [1 3 3 1] / 8 and the 22.05 kHz output is linearly interpolated back to 44.1 kHz
// (1.5 DSP samples of latency). That keeps the lo-fi, slightly dark and metallic character of the 22.05 kHz reverb at
// a few operations per step; the saturating 16-bit integer math is kept so the hardware's grit and overload behaviour
// stay. The preset register tables are DATA from psx-spx (entered from the documentation; no emulator code is used).

import type { ChipConfig, Ps1ReverbPreset, Song } from '../../types'
import { DspClock } from '../sampler/clock'
import type { SendBus } from '../sampler/bus'

export const SPU_RATE = 44100
/** Reverb tick rate (the SPU reverb runs at half the sample rate). */
export const SPU_REVERB_RATE = SPU_RATE / 2

/** Index of every register in a preset's 32-entry list (the order of psx-spx's register dump at 1F801DC0h). */
export const REV = {
  dAPF1: 0, dAPF2: 1, vIIR: 2, vCOMB1: 3, vCOMB2: 4, vCOMB3: 5, vCOMB4: 6, vWALL: 7, vAPF1: 8, vAPF2: 9,
  mLSAME: 10, mRSAME: 11, mLCOMB1: 12, mRCOMB1: 13, mLCOMB2: 14, mRCOMB2: 15, dLSAME: 16, dRSAME: 17,
  mLDIFF: 18, mRDIFF: 19, mLCOMB3: 20, mRCOMB3: 21, mLCOMB4: 22, mRCOMB4: 23, dLDIFF: 24, dRDIFF: 25,
  mLAPF1: 26, mRAPF1: 27, mLAPF2: 28, mRAPF2: 29, vLIN: 30, vRIN: 31
} as const

export interface SpuReverbPreset {
  /** Work area size in bytes (psx-spx "Reverb Buffer Size" of the preset), at the top of the 512 KB SPU RAM. */
  bytes: number
  /** The 32 register values in the `REV` order; the v* ones are signed 16-bit (as raw 0x0000..0xFFFF here). */
  regs: readonly number[]
}

/** psx-spx reverb presets (register values and work-area sizes). 'off' has no entry. */
export const SPU_REVERB_PRESETS: Record<Exclude<Ps1ReverbPreset, 'off'>, SpuReverbPreset> = {
  room: {
    bytes: 0x26c0,
    regs: [0x007d, 0x005b, 0x6d80, 0x54b8, 0xbed0, 0x0000, 0x0000, 0xba80, 0x5800, 0x5300, 0x04d6, 0x0333, 0x03f0, 0x0227, 0x0374, 0x01ef, 0x0334, 0x01b5, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x01b4, 0x0136, 0x00b8, 0x005c, 0x8000, 0x8000]
  },
  'studio-small': {
    bytes: 0x1f40,
    regs: [0x0033, 0x0025, 0x70f0, 0x4fa8, 0xbce0, 0x4410, 0xc0f0, 0x9c00, 0x5280, 0x4ec0, 0x03e4, 0x031b, 0x03a4, 0x02af, 0x0372, 0x0266, 0x031c, 0x025d, 0x025c, 0x018e, 0x022f, 0x0135, 0x01d2, 0x00b7, 0x018f, 0x00b5, 0x00b4, 0x0080, 0x004c, 0x0026, 0x8000, 0x8000]
  },
  'studio-medium': {
    bytes: 0x4840,
    regs: [0x00b1, 0x007f, 0x70f0, 0x4fa8, 0xbce0, 0x4510, 0xbef0, 0xb4c0, 0x5280, 0x4ec0, 0x0904, 0x076b, 0x0824, 0x065f, 0x07a2, 0x0616, 0x076c, 0x05ed, 0x05ec, 0x042e, 0x050f, 0x0305, 0x0462, 0x02b7, 0x042f, 0x0265, 0x0264, 0x01b2, 0x0100, 0x0080, 0x8000, 0x8000]
  },
  'studio-large': {
    bytes: 0x6fe0,
    regs: [0x00e3, 0x00a9, 0x6f60, 0x4fa8, 0xbce0, 0x4510, 0xbef0, 0xa680, 0x5680, 0x52c0, 0x0dfb, 0x0b58, 0x0d09, 0x0a3c, 0x0bd9, 0x0973, 0x0b59, 0x08da, 0x08d9, 0x05e9, 0x07ec, 0x04b0, 0x06ef, 0x03d2, 0x05ea, 0x031d, 0x031c, 0x0238, 0x0154, 0x00aa, 0x8000, 0x8000]
  },
  hall: {
    bytes: 0xb400,
    regs: [0x01a5, 0x0139, 0x6000, 0x5000, 0x4c00, 0xb800, 0xbc00, 0xc000, 0x6000, 0x5c00, 0x15ba, 0x11bb, 0x14c2, 0x10bd, 0x11bc, 0x0dc1, 0x11c0, 0x0dc3, 0x0dc0, 0x09c1, 0x0bc4, 0x07c1, 0x0a00, 0x06cd, 0x09c2, 0x05c1, 0x05c0, 0x041a, 0x0274, 0x013a, 0x8000, 0x8000]
  },
  'half-echo': {
    bytes: 0x3c00,
    regs: [0x0017, 0x0013, 0x70f0, 0x4fa8, 0xbce0, 0x4510, 0xbef0, 0x8500, 0x5f80, 0x54c0, 0x0371, 0x02af, 0x02e5, 0x01df, 0x02b0, 0x01d7, 0x0358, 0x026a, 0x01d6, 0x011e, 0x012d, 0x00b1, 0x011f, 0x0059, 0x01a0, 0x00e3, 0x0058, 0x0040, 0x0028, 0x0014, 0x8000, 0x8000]
  },
  'space-echo': {
    bytes: 0xf6c0,
    regs: [0x033d, 0x0231, 0x7e00, 0x5000, 0xb400, 0xb000, 0x4c00, 0xb000, 0x6000, 0x5400, 0x1ed6, 0x1a31, 0x1d14, 0x183b, 0x1bc2, 0x16b2, 0x1a32, 0x15ef, 0x15ee, 0x1055, 0x1334, 0x0f2d, 0x11f6, 0x0c5d, 0x1056, 0x0ae1, 0x0ae0, 0x07a2, 0x0464, 0x0232, 0x8000, 0x8000]
  },
  // psx-spx "Chaos Echo": a delay with a feedback of vWALL = 0x8100 (about -0.99): long repeats of alternating polarity
  echo: {
    bytes: 0x18040,
    regs: [0x0001, 0x0001, 0x7fff, 0x7fff, 0x0000, 0x0000, 0x0000, 0x8100, 0x0000, 0x0000, 0x1fff, 0x0fff, 0x1005, 0x0005, 0x0000, 0x0000, 0x1005, 0x0005, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1004, 0x1002, 0x0004, 0x0002, 0x8000, 0x8000]
  },
  // psx-spx "Delay": the same taps without the feedback (vWALL = 0): one clean repeat
  delay: {
    bytes: 0x18040,
    regs: [0x0001, 0x0001, 0x7fff, 0x7fff, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1fff, 0x0fff, 0x1005, 0x0005, 0x0000, 0x0000, 0x1005, 0x0005, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x0000, 0x1004, 0x1002, 0x0004, 0x0002, 0x8000, 0x8000]
  }
}

/** Work area bytes of a preset (0 for 'off'); never smaller than the largest register offset it addresses. */
export function spuReverbBytes(preset: Ps1ReverbPreset): number {
  const p = preset === 'off' ? undefined : SPU_REVERB_PRESETS[preset]
  if (!p) return 0
  let maxOff = 0
  for (const i of [REV.mLSAME, REV.mRSAME, REV.mLCOMB1, REV.mRCOMB1, REV.mLCOMB2, REV.mRCOMB2, REV.dLSAME, REV.dRSAME, REV.mLDIFF, REV.mRDIFF, REV.mLCOMB3, REV.mRCOMB3, REV.mLCOMB4, REV.mRCOMB4, REV.dLDIFF, REV.dRDIFF, REV.mLAPF1, REV.mRAPF1, REV.mLAPF2, REV.mRAPF2]) maxOff = Math.max(maxOff, p.regs[i]!)
  return Math.max(p.bytes, maxOff * 8 + 8)
}

/** Delay in ms between the input and the first repeat of the early echo (left side, first comb tap); 0 for 'off'. */
export function spuReverbFirstRepeatMs(preset: Ps1ReverbPreset): number {
  const p = preset === 'off' ? undefined : SPU_REVERB_PRESETS[preset]
  if (!p) return 0
  return (((p.regs[REV.mLSAME]! - p.regs[REV.mLCOMB1]!) * 4) / SPU_REVERB_RATE) * 1000
}

const sat = (v: number): number => (v > 32767 ? 32767 : v < -32768 ? -32768 : v)
const s16 = (v: number): number => (v >= 0x8000 ? v - 0x10000 : v)

/** The reverb as a send bus: the voices add their stereo send per 44.1 kHz step, `render` runs the steps and resamples. */
export class SpuReverb implements SendBus {
  readonly sendL: Float32Array
  readonly sendR: Float32Array
  steps = 0
  private readonly outL: Float32Array
  private readonly outR: Float32Array
  private readonly clock: DspClock

  private preset: Ps1ReverbPreset = 'off'
  private depth = 0
  private inputVol = 1
  private mem = new Int16Array(0)
  private size = 0
  private ptr = 0
  /** Register values: offsets in words (x4), coefficients as signed 16-bit. */
  private readonly r = new Int32Array(32)
  // 44.1 -> 22.05 kHz input history ([1 3 3 1] low-pass) and the 22.05 -> 44.1 kHz linear output interpolation
  private h0L = 0
  private h1L = 0
  private h2L = 0
  private h0R = 0
  private h1R = 0
  private h2R = 0
  private phase = 0
  private yL = 0
  private yR = 0
  /** Saturated 16-bit output of the last `tick`. */
  private tickL = 0
  private tickR = 0

  constructor(sampleRate: number, maxBlock: number) {
    const cap = Math.ceil((maxBlock * SPU_RATE) / sampleRate) + 8
    this.sendL = new Float32Array(cap)
    this.sendR = new Float32Array(cap)
    this.outL = new Float32Array(cap)
    this.outR = new Float32Array(cap)
    this.clock = new DspClock(SPU_RATE, sampleRate)
  }

  /** Re-read the reverb settings (cheap; called on construction and hot swaps). A new preset clears the work area. */
  configure(song: Song): void {
    const cfg: ChipConfig = song.chipConfig
    const rv = cfg.chip === 'ps1' ? cfg.reverb : undefined
    const preset = rv?.preset ?? 'off'
    this.depth = rv ? Math.max(0, Math.min(1, rv.depth)) : 0
    this.inputVol = rv ? Math.max(0, Math.min(1, rv.inputVol)) : 0
    if (preset !== this.preset) {
      this.preset = preset
      this.loadPreset()
    }
  }

  private loadPreset(): void {
    const p = this.preset === 'off' ? undefined : SPU_REVERB_PRESETS[this.preset]
    this.clearState()
    if (!p) {
      this.mem = new Int16Array(0)
      this.size = 0
      return
    }
    this.size = spuReverbBytes(this.preset) >> 1
    this.mem = new Int16Array(this.size)
    for (let i = 0; i < 32; i++) {
      const v = p.regs[i]!
      // d* and m* registers are offsets in 8-byte units (4 words); the v* coefficients are signed 16-bit
      const isOffset = i < 2 || (i >= 10 && i <= 29)
      this.r[i] = isOffset ? v * 4 : s16(v)
    }
  }

  private clearState(): void {
    this.mem.fill(0)
    this.ptr = 0
    this.h0L = this.h1L = this.h2L = this.h0R = this.h1R = this.h2R = 0
    this.phase = 0
    this.yL = 0
    this.yR = 0
  }

  reset(): void {
    this.clearState()
    this.sendL.fill(0)
    this.sendR.fill(0)
    this.clock.reset()
    this.steps = 0
  }

  private wrap(i: number): number {
    return i >= this.size ? i - this.size : i < 0 ? i + this.size : i
  }

  /** One reverb tick on the decimated input (floats -1..1); stores the saturated 16-bit outputs in `tickL/tickR`. */
  private tick(inL: number, inR: number): void {
    const r = this.r
    const mem = this.mem
    const p = this.ptr
    const wall = r[REV.vWALL]!
    const iir = r[REV.vIIR]!
    const lin = sat(Math.round(inL * 32768 * this.inputVol)) * r[REV.vLIN]! >> 15
    const rin = sat(Math.round(inR * 32768 * this.inputVol)) * r[REV.vRIN]! >> 15

    // reflections: same side and other side
    let a = this.wrap(p + r[REV.mLSAME]! - 1)
    let prev = mem[a]!
    mem[this.wrap(p + r[REV.mLSAME]!)] = sat((sat(lin + ((mem[this.wrap(p + r[REV.dLSAME]!)]! * wall) >> 15) - prev) * iir >> 15) + prev)
    a = this.wrap(p + r[REV.mRSAME]! - 1)
    prev = mem[a]!
    mem[this.wrap(p + r[REV.mRSAME]!)] = sat((sat(rin + ((mem[this.wrap(p + r[REV.dRSAME]!)]! * wall) >> 15) - prev) * iir >> 15) + prev)
    a = this.wrap(p + r[REV.mLDIFF]! - 1)
    prev = mem[a]!
    mem[this.wrap(p + r[REV.mLDIFF]!)] = sat((sat(lin + ((mem[this.wrap(p + r[REV.dRDIFF]!)]! * wall) >> 15) - prev) * iir >> 15) + prev)
    a = this.wrap(p + r[REV.mRDIFF]! - 1)
    prev = mem[a]!
    mem[this.wrap(p + r[REV.mRDIFF]!)] = sat((sat(rin + ((mem[this.wrap(p + r[REV.dLDIFF]!)]! * wall) >> 15) - prev) * iir >> 15) + prev)

    // early echo: four comb taps per side
    const c1 = r[REV.vCOMB1]!
    const c2 = r[REV.vCOMB2]!
    const c3 = r[REV.vCOMB3]!
    const c4 = r[REV.vCOMB4]!
    let lo = sat(
      ((mem[this.wrap(p + r[REV.mLCOMB1]!)]! * c1) >> 15) +
        ((mem[this.wrap(p + r[REV.mLCOMB2]!)]! * c2) >> 15) +
        ((mem[this.wrap(p + r[REV.mLCOMB3]!)]! * c3) >> 15) +
        ((mem[this.wrap(p + r[REV.mLCOMB4]!)]! * c4) >> 15)
    )
    let ro = sat(
      ((mem[this.wrap(p + r[REV.mRCOMB1]!)]! * c1) >> 15) +
        ((mem[this.wrap(p + r[REV.mRCOMB2]!)]! * c2) >> 15) +
        ((mem[this.wrap(p + r[REV.mRCOMB3]!)]! * c3) >> 15) +
        ((mem[this.wrap(p + r[REV.mRCOMB4]!)]! * c4) >> 15)
    )

    // late reverb: two all-pass filters per side
    const apf1 = r[REV.vAPF1]!
    const apf2 = r[REV.vAPF2]!
    const d1 = r[REV.dAPF1]!
    const d2 = r[REV.dAPF2]!
    let t = mem[this.wrap(p + r[REV.mLAPF1]! - d1)]!
    lo = sat(lo - ((apf1 * t) >> 15))
    mem[this.wrap(p + r[REV.mLAPF1]!)] = lo
    lo = sat(((lo * apf1) >> 15) + t)
    t = mem[this.wrap(p + r[REV.mRAPF1]! - d1)]!
    ro = sat(ro - ((apf1 * t) >> 15))
    mem[this.wrap(p + r[REV.mRAPF1]!)] = ro
    ro = sat(((ro * apf1) >> 15) + t)
    t = mem[this.wrap(p + r[REV.mLAPF2]! - d2)]!
    lo = sat(lo - ((apf2 * t) >> 15))
    mem[this.wrap(p + r[REV.mLAPF2]!)] = lo
    lo = sat(((lo * apf2) >> 15) + t)
    t = mem[this.wrap(p + r[REV.mRAPF2]! - d2)]!
    ro = sat(ro - ((apf2 * t) >> 15))
    mem[this.wrap(p + r[REV.mRAPF2]!)] = ro
    ro = sat(((ro * apf2) >> 15) + t)

    const vol = Math.round(this.depth * 32767)
    this.tickL = (lo * vol) >> 15
    this.tickR = (ro * vol) >> 15
    this.ptr = p + 1 >= this.size ? 0 : p + 1
  }
  /** Run `steps` DSP steps and resample the reverb output to `n` frames. */
  render(L: Float32Array, R: Float32Array, n: number): void {
    const steps = this.steps
    const sl = this.sendL
    const sr = this.sendR
    const ol = this.outL
    const or = this.outR
    if (this.size === 0 || this.depth === 0) {
      // 'off' (or silent output): nothing to run, but keep the clock phase and clear the sends
      for (let k = 0; k < steps; k++) {
        sl[k] = 0
        sr[k] = 0
        ol[k] = 0
        or[k] = 0
      }
    } else {
      let phase = this.phase
      let yL = this.yL
      let yR = this.yR
      for (let k = 0; k < steps; k++) {
        const xl = sl[k]!
        const xr = sr[k]!
        sl[k] = 0
        sr[k] = 0
        if (phase === 0) {
          // first step of a pair: the previous tick's output
          this.h2L = this.h1L
          this.h1L = this.h0L
          this.h0L = xl
          this.h2R = this.h1R
          this.h1R = this.h0R
          this.h0R = xr
          ol[k] = yL
          or[k] = yR
          phase = 1
        } else {
          // second step: decimate [1 3 3 1] / 8 over the last four inputs, run the reverb tick, interpolate the output
          const dl = (this.h2L + 3 * this.h1L + 3 * this.h0L + xl) / 8
          const dr = (this.h2R + 3 * this.h1R + 3 * this.h0R + xr) / 8
          this.h2L = this.h1L
          this.h1L = this.h0L
          this.h0L = xl
          this.h2R = this.h1R
          this.h1R = this.h0R
          this.h0R = xr
          this.tick(dl, dr)
          const nl = this.tickL / 32768
          const nr = this.tickR / 32768
          ol[k] = (yL + nl) * 0.5
          or[k] = (yR + nr) * 0.5
          yL = nl
          yR = nr
          phase = 0
        }
      }
      this.phase = phase
      this.yL = yL
      this.yR = yR
    }
    this.clock.resampleStereo(ol, or, steps, L, R, n)
    this.steps = 0
  }
}
