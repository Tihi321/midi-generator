// The Dreamcast AICA DSP bus: a deterministic effect chain for the slots' DSP sends (`_dsp` stem).
//
// APPROXIMATION, stated plainly: the real AICA DSP runs a 128-step microprogram over a RAM ring buffer and is not
// emulated here. This bus models what that DSP was used for on the console, as fixed presets with a few parameters:
// a Freeverb-style reverb (room, hall, plate), a two-tap stereo chorus, and a stereo or ping-pong delay, and the
// combinations chorus + hall and chorus + delay. All of it runs at the AICA's 44.1 kHz step and is resampled to the
// output rate with the same clock the voices use. Everything is pure arithmetic on preallocated buffers (no random
// numbers, no time), so renders are bit-identical between runs and block sizes.
//
// The bus is wet only: the voices' dry path never goes through it, so the chorus does not touch the dry pitch.
//
// The reverb is the public Freeverb network (8 parallel damped combs and 4 series allpasses per side, right-side comb
// lengths spread by 23 samples); the comb lengths scale with the preset size and the `time` parameter.

import type { DcDsp, DcDspPreset, DreamcastConfig, Song } from '../../types'
import type { SendBus } from '../sampler/bus'
import { DspClock } from '../sampler/clock'

export const AICA_DSP_RATE = 44100

/** Short descriptions for the tools and the UI. */
export const AICA_DSP_INFO: Record<DcDspPreset, string> = {
  off: 'No DSP: the send is ignored.',
  room: 'Small, tight reverb.',
  hall: 'Large, long reverb: the synthwave staple for pads and leads.',
  plate: 'Bright, dense plate reverb (good on snares).',
  chorus: 'Lush stereo chorus (two modulated delay taps per side).',
  'chorus-hall': 'Stereo chorus into a hall reverb: wide, shimmering pads.',
  delay: 'Stereo feedback delay (delayMs, feedback).',
  echo: 'Ping-pong delay: repeats bounce between left and right.',
  'chorus-delay': 'Stereo chorus plus a feedback delay.'
}

// ---------------------------------------------------------------------------------------------
// RAM: the ring buffer the preset would need in AICA RAM (the budget in chips/dreamcast.ts)

const KB = 1024
const CHORUS_RAM = 16 * KB

function delayRam(dsp: DcDsp): number {
  const bytes = Math.round((Math.max(10, dsp.delayMs) * AICA_DSP_RATE) / 1000) * 4 // stereo, 16-bit
  return Math.ceil(bytes / (16 * KB)) * 16 * KB
}

/** Bytes of AICA RAM the DSP ring buffer of a preset takes: 16 KB chorus, 32 / 64 / 128 KB room / plate / hall, delay lines by delayMs. */
export function dspRamBytes(dsp: DcDsp): number {
  switch (dsp.preset) {
    case 'off':
      return 0
    case 'room':
      return 32 * KB
    case 'plate':
      return 64 * KB
    case 'hall':
    case 'chorus-hall':
      return 128 * KB
    case 'chorus':
      return CHORUS_RAM
    case 'delay':
    case 'echo':
      return delayRam(dsp)
    case 'chorus-delay':
      return CHORUS_RAM + delayRam(dsp)
  }
}

// ---------------------------------------------------------------------------------------------
// Presets

interface ReverbKind {
  /** Comb length scale (1 = the Freeverb lengths, 1116..1617 samples). */
  size: number
  /** Comb feedback at time = 0.5. */
  feedback: number
  /** Damping (one-pole low-pass in the combs, 0 = bright .. 1 = dark). */
  damp: number
}
const REVERBS: Record<'room' | 'hall' | 'plate', ReverbKind> = {
  room: { size: 0.55, feedback: 0.76, damp: 0.5 },
  hall: { size: 1.35, feedback: 0.86, damp: 0.3 },
  plate: { size: 0.85, feedback: 0.84, damp: 0.12 }
}

interface PresetDef {
  reverb: 'room' | 'hall' | 'plate' | null
  chorus: boolean
  delay: 'stereo' | 'pingpong' | null
}
const PRESETS: Record<DcDspPreset, PresetDef> = {
  off: { reverb: null, chorus: false, delay: null },
  room: { reverb: 'room', chorus: false, delay: null },
  hall: { reverb: 'hall', chorus: false, delay: null },
  plate: { reverb: 'plate', chorus: false, delay: null },
  chorus: { reverb: null, chorus: true, delay: null },
  'chorus-hall': { reverb: 'hall', chorus: true, delay: null },
  delay: { reverb: null, chorus: false, delay: 'stereo' },
  echo: { reverb: null, chorus: false, delay: 'pingpong' },
  'chorus-delay': { reverb: null, chorus: true, delay: 'stereo' }
}

/** Output level of the wet signal at mix 1 (the wet paths are normalised to about unit gain first). */
const WET_GAIN = 2

const COMB_LEN = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_LEN = [556, 441, 341, 225]
const SPREAD = 23
/** Largest comb scale the buffers are allocated for (size 1.35 x time 1.5). */
const MAX_SCALE = 2.1
const ALLPASS_FB = 0.5

const CHORUS_LEN = 4096
const MAX_DELAY = AICA_DSP_RATE + 8
const DELAY_DAMP = 0.35

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export class AicaDspBus implements SendBus {
  readonly sendL: Float32Array
  readonly sendR: Float32Array
  steps = 0
  private readonly outL: Float32Array
  private readonly outR: Float32Array
  private readonly clock: DspClock

  // settings
  private preset: DcDspPreset = 'off'
  private def: PresetDef = PRESETS.off
  private mix = 0
  private time = 0.5
  private feedback = 0
  private chorusRate = 0
  private chorusDepth = 0
  private delaySamples = 1

  // reverb: 8 combs + 4 allpasses per side (index 0..7 left, 8..15 right; allpass 0..3 left, 4..7 right)
  private readonly combBuf: Float32Array[] = []
  private readonly combLen = new Int32Array(16)
  private readonly combPos = new Int32Array(16)
  private readonly combLp = new Float64Array(16)
  private readonly apBuf: Float32Array[] = []
  private readonly apLen = new Int32Array(8)
  private readonly apPos = new Int32Array(8)
  private revFeedback = 0.84
  private revDamp = 0.3
  private revNorm = 0.2

  // chorus
  private readonly chL = new Float32Array(CHORUS_LEN)
  private readonly chR = new Float32Array(CHORUS_LEN)
  private chPos = 0
  private chPhase = 0

  // delay
  private readonly dlL = new Float32Array(MAX_DELAY)
  private readonly dlR = new Float32Array(MAX_DELAY)
  private dlPos = 0
  private dlLpL = 0
  private dlLpR = 0

  constructor(sampleRate: number, maxBlock: number) {
    const cap = Math.ceil((maxBlock * AICA_DSP_RATE) / sampleRate) + 8
    this.sendL = new Float32Array(cap)
    this.sendR = new Float32Array(cap)
    this.outL = new Float32Array(cap)
    this.outR = new Float32Array(cap)
    this.clock = new DspClock(AICA_DSP_RATE, sampleRate)
    for (let i = 0; i < 16; i++) this.combBuf.push(new Float32Array(Math.ceil((COMB_LEN[i & 7]! + (i >= 8 ? SPREAD : 0)) * MAX_SCALE) + 1))
    for (let i = 0; i < 8; i++) this.apBuf.push(new Float32Array(ALLPASS_LEN[i & 3]! + (i >= 4 ? SPREAD : 0) + 1))
    for (let i = 0; i < 8; i++) this.apLen[i] = ALLPASS_LEN[i & 3]! + (i >= 4 ? SPREAD : 0)
    this.setReverb(null)
  }

  /** Read the DSP settings (cheap; called on construction and hot swaps). A preset change clears the buffers. */
  configure(song: Song): void {
    const cfg = song.chipConfig as DreamcastConfig
    const d = cfg.chip === 'dreamcast' ? cfg.dsp : undefined
    const preset: DcDspPreset = d && d.preset in PRESETS ? d.preset : 'off'
    const mix = d ? clamp(d.mix, 0, 1) : 0
    const time = d ? clamp(d.time, 0, 1) : 0.5
    const delaySamples = d ? clamp(Math.round((d.delayMs * AICA_DSP_RATE) / 1000), 1, MAX_DELAY - 8) : 1
    const changedKind = preset !== this.preset
    this.mix = mix
    this.feedback = d ? clamp(d.feedback, 0, 0.95) : 0
    this.chorusRate = d ? clamp(d.chorusRate, 0, 1) : 0
    this.chorusDepth = d ? clamp(d.chorusDepth, 0, 1) : 0
    if (changedKind) {
      this.preset = preset
      this.def = PRESETS[preset]
      this.clearState()
    }
    if (changedKind || time !== this.time) {
      this.time = time
      this.setReverb(this.def.reverb)
    }
    if (delaySamples !== this.delaySamples) {
      this.delaySamples = delaySamples
      if (this.dlPos >= delaySamples) this.dlPos = 0
    }
  }

  private setReverb(kind: 'room' | 'hall' | 'plate' | null): void {
    if (!kind) return
    const k = REVERBS[kind]
    const scale = Math.min(MAX_SCALE, k.size * (0.5 + this.time))
    for (let i = 0; i < 16; i++) {
      const len = Math.max(8, Math.min(this.combBuf[i]!.length - 1, Math.round((COMB_LEN[i & 7]! + (i >= 8 ? SPREAD : 0)) * scale)))
      this.combLen[i] = len
      if (this.combPos[i]! >= len) this.combPos[i] = 0
    }
    this.revFeedback = clamp(k.feedback + (this.time - 0.5) * 0.16, 0.5, 0.95)
    this.revDamp = k.damp
    // unit gain for broadband input: 8 parallel combs, each with a power gain of about 1 / (1 - feedback^2)
    this.revNorm = Math.sqrt((1 - this.revFeedback * this.revFeedback) / 8)
  }

  private clearState(): void {
    for (const b of this.combBuf) b.fill(0)
    for (const b of this.apBuf) b.fill(0)
    this.combPos.fill(0)
    this.combLp.fill(0)
    this.apPos.fill(0)
    this.chL.fill(0)
    this.chR.fill(0)
    this.chPos = 0
    this.chPhase = 0
    this.dlL.fill(0)
    this.dlR.fill(0)
    this.dlPos = 0
    this.dlLpL = 0
    this.dlLpR = 0
  }

  reset(): void {
    this.clearState()
    this.sendL.fill(0)
    this.sendR.fill(0)
    this.clock.reset()
    this.steps = 0
  }

  /** Run `steps` DSP steps and resample the wet output to `n` frames. */
  render(L: Float32Array, R: Float32Array, n: number): void {
    const steps = this.steps
    const def = this.def
    const sendL = this.sendL
    const sendR = this.sendR
    const outL = this.outL
    const outR = this.outR
    if (this.preset === 'off' || this.mix === 0) {
      for (let k = 0; k < steps; k++) {
        sendL[k] = 0
        sendR[k] = 0
        outL[k] = 0
        outR[k] = 0
      }
      this.clock.resampleStereo(outL, outR, steps, L, R, n)
      this.steps = 0
      return
    }
    const gain = this.mix * WET_GAIN
    const hasRev = def.reverb !== null
    const chorus = def.chorus
    const delayKind = def.delay
    // chorus
    const chL = this.chL
    const chR = this.chR
    const chRate = (0.15 + this.chorusRate * 2.85) / AICA_DSP_RATE
    const chDepth = (0.0005 + this.chorusDepth * 0.0035) * AICA_DSP_RATE
    const chBase1 = 0.0115 * AICA_DSP_RATE
    const chBase2 = 0.0175 * AICA_DSP_RATE
    let chPos = this.chPos
    let chPhase = this.chPhase
    // reverb
    const combBuf = this.combBuf
    const combLen = this.combLen
    const combPos = this.combPos
    const combLp = this.combLp
    const apBuf = this.apBuf
    const apLen = this.apLen
    const apPos = this.apPos
    const fb = this.revFeedback
    const damp1 = this.revDamp
    const damp2 = 1 - damp1
    const norm = this.revNorm
    // delay
    const dlL = this.dlL
    const dlR = this.dlR
    const D = this.delaySamples
    const dfb = this.feedback
    let dlPos = this.dlPos
    let lpL = this.dlLpL
    let lpR = this.dlLpR

    for (let k = 0; k < steps; k++) {
      let inL = sendL[k]!
      let inR = sendR[k]!
      sendL[k] = 0
      sendR[k] = 0
      let wetL = 0
      let wetR = 0

      // ---- chorus: two modulated taps per side, the right side reads the opposite phases and crosses the channels
      let cL = inL
      let cR = inR
      if (chorus) {
        chL[chPos] = inL
        chR[chPos] = inR
        chPhase += chRate
        if (chPhase >= 1) chPhase -= 1
        const a = 6.283185307179586 * chPhase
        const sA = Math.sin(a)
        const sB = Math.sin(a + 3.141592653589793)
        const sC = Math.sin(a + 1.5707963267948966)
        const sD = Math.sin(a + 4.71238898038469)
        cL = 0.5 * (tap(chL, chPos, chBase1 + chDepth * sA) + tap(chR, chPos, chBase2 + chDepth * sB))
        cR = 0.5 * (tap(chR, chPos, chBase1 + chDepth * sC) + tap(chL, chPos, chBase2 + chDepth * sD))
        chPos++
        if (chPos >= CHORUS_LEN) chPos = 0
        inL = cL
        inR = cR
      }

      // ---- reverb (mono in, stereo out)
      if (hasRev) {
        const rin = (inL + inR) * 0.5
        let rl = 0
        let rr = 0
        for (let i = 0; i < 16; i++) {
          const buf = combBuf[i]!
          const p = combPos[i]!
          const o = buf[p]!
          const lp = o * damp2 + combLp[i]! * damp1
          combLp[i] = lp
          buf[p] = rin + lp * fb
          combPos[i] = p + 1 >= combLen[i]! ? 0 : p + 1
          if (i < 8) rl += o
          else rr += o
        }
        rl *= norm
        rr *= norm
        for (let i = 0; i < 4; i++) {
          rl = allpass(apBuf[i]!, apPos, apLen, i, rl)
          rr = allpass(apBuf[i + 4]!, apPos, apLen, i + 4, rr)
        }
        wetL += rl
        wetR += rr
      }

      // ---- delay (the first repeat is the raw tap, the feedback path is low-passed)
      if (delayKind !== null) {
        const rp = dlPos - D < 0 ? dlPos - D + MAX_DELAY : dlPos - D
        const tL = dlL[rp]!
        const tR = dlR[rp]!
        lpL += (tL - lpL) * (1 - DELAY_DAMP)
        lpR += (tR - lpR) * (1 - DELAY_DAMP)
        if (delayKind === 'stereo') {
          dlL[dlPos] = inL + dfb * lpL
          dlR[dlPos] = inR + dfb * lpR
        } else {
          // ping-pong: the input enters the left line, every repeat crosses to the other side
          dlL[dlPos] = (inL + inR) * 0.5 + dfb * lpR
          dlR[dlPos] = lpL
        }
        dlPos++
        if (dlPos >= MAX_DELAY) dlPos = 0
        wetL += tL
        wetR += tR
      }

      // the chorus alone is audible in the combined presets
      if (chorus && (hasRev || delayKind !== null)) {
        wetL += cL * 0.5
        wetR += cR * 0.5
      } else if (chorus) {
        wetL += cL
        wetR += cR
      }
      outL[k] = wetL * gain
      outR[k] = wetR * gain
    }
    this.chPos = chPos
    this.chPhase = chPhase
    this.dlPos = dlPos
    this.dlLpL = lpL
    this.dlLpR = lpR
    this.clock.resampleStereo(outL, outR, steps, L, R, n)
    this.steps = 0
  }
}

/** Read `delay` samples (fractional) behind the write position of a circular chorus line. */
function tap(buf: Float32Array, writePos: number, delay: number): number {
  let p = writePos - delay
  if (p < 0) p += CHORUS_LEN
  const i0 = Math.floor(p)
  const f = p - i0
  const a = buf[i0]!
  const b = buf[i0 + 1 >= CHORUS_LEN ? 0 : i0 + 1]!
  return a + (b - a) * f
}

function allpass(buf: Float32Array, pos: Int32Array, len: Int32Array, i: number, x: number): number {
  const p = pos[i]!
  const bo = buf[p]!
  buf[p] = x + bo * ALLPASS_FB
  pos[i] = p + 1 >= len[i]! ? 0 : p + 1
  return -x + bo
}
