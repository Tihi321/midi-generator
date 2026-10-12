// SNES SPC700 / S-DSP voices: 8 BRR sample voices running at the DSP's native 32 kHz, 4-point Gaussian
// interpolation, 11-bit ADSR / GAIN envelopes on the real rate table, and a global echo (ring buffer with delay
// x 16 ms, feedback, 8-tap FIR and echo volume) with a per-voice echo send. The 32 kHz mix is resampled to the
// output rate (cubic) per voice; the echo is its own bus, exposed to the player as the `_echo` stem.
//
// Accuracy notes (see also samplegen/): decoded BRR is played from the encoder's PCM (identical to what the DSP
// decodes, modulo the 15-bit clamp); the envelope counters are per voice (the hardware shares one global counter
// with offsets, which only changes the phase of the steps); GAIN decay modes start from full level instead of 0 so
// they are usable as a one-register release shape; `rel` uses an exponential release instead of the hardware
// KOFF ramp (8/sample) which `off`/note cut still use; pitch is the 14-bit register (0x1000 = native 32 kHz, max
// 0x3FFF). No noise voice, pitch modulation or the program-controlled mute/reset flags.

import type { Instrument, SnesConfig, SnesEnvelope, SnesSampleInstrument, Song } from '../../types'
import { registerMixProfile } from '../mixer'
import type { ChannelControl } from '../sequencer'
import { GAUSS } from '../samplegen/gauss'
import { type SampleResult, tryResolveSampleSlot } from '../samplegen/bank'
import { clamp, dbToGain, midiToHz } from '../tables'
import { type AuxOutput, type ChipVoice, type VoiceArgs, registerVoice } from './types'

export const SNES_DSP_RATE = 32000
/** Frames per 16 ms echo delay step. */
export const SNES_ECHO_STEP_FRAMES = 512

/** Samples between envelope updates for rate index 0..31 (0 = never). */
export const SNES_RATE_PERIODS: readonly number[] = [
  0, 2048, 1536, 1280, 1024, 768, 640, 512, 384, 320, 256, 192, 160, 128, 96, 80,
  64, 48, 40, 32, 24, 20, 16, 12, 10, 8, 6, 5, 4, 3, 2, 1
]

const COUNTER_WRAP = 30720
/** Soft release: update period (steps) of the exponential decay used for `rel`. */
const SOFT_RELEASE_PERIOD = 12

function catmull(y0: number, y1: number, y2: number, y3: number, t: number): number {
  return ((((-0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3) * t + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * t + (-0.5 * y0 + 0.5 * y2)) * t) + y1
}

// ---------------------------------------------------------------------------------------------
// Echo bus

const ECHO_MAX_FRAMES = 15 * SNES_ECHO_STEP_FRAMES

/** Echo ring buffer + 8-tap FIR + feedback, shared by the eight voices. Runs at 32 kHz. */
export class EchoBus {
  /** Per-step stereo send accumulated by the voices for the current block (cleared after render). */
  readonly sendL: Float32Array
  readonly sendR: Float32Array
  /** Number of 32 kHz steps in the current block (set by the voices). */
  steps = 0
  private readonly outL: Float32Array
  private readonly outR: Float32Array
  private readonly bufL = new Float32Array(ECHO_MAX_FRAMES)
  private readonly bufR = new Float32Array(ECHO_MAX_FRAMES)
  private frames = 1
  private pos = 0
  private readonly histL = new Float64Array(8)
  private readonly histR = new Float64Array(8)
  private readonly fir = new Float64Array(8)
  private feedback = 0
  private volL = 0
  private volR = 0
  private readonly inc: number
  private frac = 0
  private readonly a = new Float64Array(4)
  private readonly b = new Float64Array(4)

  constructor(sampleRate: number, maxBlock: number) {
    const cap = Math.ceil((maxBlock * SNES_DSP_RATE) / sampleRate) + 8
    this.sendL = new Float32Array(cap)
    this.sendR = new Float32Array(cap)
    this.outL = new Float32Array(cap)
    this.outR = new Float32Array(cap)
    this.inc = SNES_DSP_RATE / sampleRate
    this.fir[0] = 1
  }

  /** Read the echo settings (cheap; called on construction and hot swaps). A delay change clears the buffer. */
  configure(song: Song): void {
    const cfg = song.chipConfig as SnesConfig
    const e = cfg.chip === 'snes' ? cfg.echo : undefined
    const delay = e ? clamp(Math.round(e.delay), 0, 15) : 0
    const frames = Math.max(1, delay * SNES_ECHO_STEP_FRAMES)
    if (frames !== this.frames) {
      this.frames = frames
      this.pos = 0
      this.bufL.fill(0)
      this.bufR.fill(0)
    }
    this.feedback = e ? clamp(e.feedback, -1, 1) : 0
    this.volL = e ? clamp(e.volL, -1, 1) : 0
    this.volR = e ? clamp(e.volR, -1, 1) : 0
    for (let i = 0; i < 8; i++) this.fir[i] = e ? clamp(e.fir[i] ?? 0, -1, 1) : i === 0 ? 1 : 0
  }

  reset(): void {
    this.bufL.fill(0)
    this.bufR.fill(0)
    this.histL.fill(0)
    this.histR.fill(0)
    this.sendL.fill(0)
    this.sendR.fill(0)
    this.pos = 0
    this.frac = 0
    this.a.fill(0)
    this.b.fill(0)
    this.steps = 0
  }

  /** Run `steps` DSP steps and resample the echo output to `n` frames. */
  render(L: Float32Array, R: Float32Array, n: number): void {
    const steps = this.steps
    const frames = this.frames
    const bufL = this.bufL
    const bufR = this.bufR
    const hl = this.histL
    const hr = this.histR
    const fir = this.fir
    let pos = this.pos
    for (let k = 0; k < steps; k++) {
      for (let i = 0; i < 7; i++) {
        hl[i] = hl[i + 1]!
        hr[i] = hr[i + 1]!
      }
      hl[7] = bufL[pos]!
      hr[7] = bufR[pos]!
      let fl = 0
      let fr = 0
      for (let i = 0; i < 8; i++) {
        fl += fir[i]! * hl[i]!
        fr += fir[i]! * hr[i]!
      }
      bufL[pos] = clamp(this.sendL[k]! + fl * this.feedback, -4, 4)
      bufR[pos] = clamp(this.sendR[k]! + fr * this.feedback, -4, 4)
      this.outL[k] = fl * this.volL
      this.outR[k] = fr * this.volR
      this.sendL[k] = 0
      this.sendR[k] = 0
      pos++
      if (pos >= frames) pos = 0
    }
    this.pos = pos
    // resample 32 kHz -> output rate with the same clock the voices use
    const a = this.a
    const b = this.b
    let k = 0
    let frac = this.frac
    for (let i = 0; i < n; i++) {
      while (frac >= 1) {
        frac -= 1
        a[0] = a[1]!
        a[1] = a[2]!
        a[2] = a[3]!
        b[0] = b[1]!
        b[1] = b[2]!
        b[2] = b[3]!
        a[3] = k < steps ? this.outL[k]! : 0
        b[3] = k < steps ? this.outR[k]! : 0
        k++
      }
      L[i] = catmull(a[0]!, a[1]!, a[2]!, a[3]!, frac)
      R[i] = catmull(b[0]!, b[1]!, b[2]!, b[3]!, frac)
      frac += this.inc
    }
    this.frac = frac
    this.steps = 0
  }
}

// ---------------------------------------------------------------------------------------------
// Voice

const MODE_ATTACK = 0
const MODE_DECAY = 1
const MODE_SUSTAIN = 2
const MODE_GAIN = 3
const MODE_RELEASE = 4

const REL_NONE = 0
const REL_SOFT = 1
const REL_HARD = 2
const REL_DECLICK = 3

export class SpcVoice implements ChipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.3
  readonly aux?: AuxOutput

  private song: Song
  private trimGain = 1
  private muted = false

  // sample playback
  private pcm: Int16Array = new Int16Array(0)
  private len = 0
  private loopStart = -1
  private rp = 0
  private h0 = 0
  private h1 = 0
  private h2 = 0
  private h3 = 0
  private cnt = 0
  private pitch = 0x1000
  private baseRatio = 1
  private active = false
  private keyed = false

  // envelope
  private env = 0
  private mode = MODE_ATTACK
  private ecnt = 0
  private relKind = REL_NONE
  private adsr: readonly number[] = [15, 7, 7, 0]
  private gainMode = 'direct'
  private gainRate = 0
  private pending: SnesSampleInstrument | null = null
  private freqHz = 261.63

  // mix
  private vol = 0
  private panL = 1
  private panR = 1
  private echoOn = false
  private inst: SnesSampleInstrument | null = null

  // 32 kHz -> output rate clock
  private readonly inc: number
  private frac = 0
  private a0 = 0
  private a1 = 0
  private a2 = 0
  private a3 = 0
  private k = 0

  constructor(
    private readonly args: VoiceArgs,
    private readonly dsp: EchoBus
  ) {
    this.song = args.song
    this.inc = SNES_DSP_RATE / args.sampleRate
    if (args.index === 0) {
      const dsp0 = dsp
      this.aux = { id: '_echo', render: (L, R, n) => dsp0.render(L, R, n) }
    }
    this.syncSong(args.song)
  }

  private syncSong(song: Song): void {
    this.song = song
    this.trimGain = dbToGain(song.channels[this.args.index]?.trim ?? 0)
    this.dsp.configure(song)
    // warm the sample cache so generation never happens on the audio thread
    for (const inst of song.instruments) if (inst.kind === 'snes-sample') tryResolveSampleSlot(song, inst.sample)
  }

  setSong(song: Song): void {
    this.syncSong(song)
  }

  /** Current 11-bit envelope level (0..2047) and pitch register (diagnostics and tests). */
  get envelopeLevel(): number {
    return this.env
  }
  get pitchRegister(): number {
    return this.pitch
  }

  setMuted(muted: boolean): void {
    this.muted = muted
  }

  private loadSample(inst: SnesSampleInstrument): boolean {
    const r: SampleResult | undefined = tryResolveSampleSlot(this.song, inst.sample)
    if (!r || r.pcm.length === 0) return false
    this.pcm = r.pcm
    this.len = r.pcm.length
    this.loopStart = r.loopStart !== undefined && r.loopStart < r.pcm.length ? r.loopStart : -1
    this.baseRatio = r.sampleRate / SNES_DSP_RATE
    return true
  }

  private setEnvParams(env: SnesEnvelope | undefined): void {
    if (env && 'adsr' in env) {
      this.adsr = env.adsr
    } else if (env && 'gain' in env) {
      this.gainMode = env.gain.mode
      this.gainRate = env.gain.rate
    }
  }

  private calcPitch(e: SnesSampleInstrument): number {
    const fine = e.fine ?? 0
    const ratio = (this.freqHz / midiToHz(e.baseNote)) * (fine ? Math.pow(2, fine / 1200) : 1)
    return clamp(Math.round(this.baseRatio * ratio * 0x1000), 1, 0x3fff)
  }

  private startNote(inst: SnesSampleInstrument): void {
    if (!this.loadSample(inst)) {
      this.active = false
      this.keyed = false
      return
    }
    this.inst = inst
    this.rp = 0
    this.h0 = this.h1 = this.h2 = this.h3 = 0
    this.cnt = 0
    this.ecnt = 0
    this.relKind = REL_NONE
    this.active = true
    this.keyed = true
    this.setEnvParams(inst.env)
    this.pitch = this.calcPitch(inst)
    if ('gain' in inst.env) {
      this.mode = MODE_GAIN
      const m = this.gainMode
      this.env = m === 'direct' ? clamp(this.gainRate * 16, 0, 2047) : m === 'linear-dec' || m === 'exp-dec' ? 2047 : 0
    } else {
      this.mode = MODE_ATTACK
      this.env = 0
    }
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const e = inst && inst.kind === 'snes-sample' ? inst : null
    this.freqHz = c.freqHz
    this.panL = c.pan > 0 ? 1 - c.pan : 1
    this.panR = c.pan < 0 ? 1 + c.pan : 1
    if (c.gate || c.vol > 0) this.vol = c.vol
    if (e) {
      this.echoOn = c.echo ?? e.echo
      if (this.inst === e || !this.keyed) this.setEnvParams(e.env)
    }
    if (c.trigger && e) {
      if (this.active && this.env > 0) {
        // retrigger on a sounding voice: declick (fast KOFF) first, as sound drivers do
        this.pending = e
        this.relKind = REL_DECLICK
      } else this.startNote(e)
    }
    const pi = this.inst ?? e
    if (this.active && pi) this.pitch = this.calcPitch(pi)
    if (!c.trigger && !c.gate && this.keyed && this.relKind !== REL_DECLICK) {
      this.relKind = c.release && e ? REL_SOFT : REL_HARD
      this.mode = MODE_RELEASE
    }
  }

  private fire(period: number): boolean {
    return period > 0 && this.ecnt % period === 0
  }

  private stepEnv(): void {
    this.ecnt++
    if (this.ecnt >= COUNTER_WRAP) this.ecnt = 0
    let env = this.env
    if (this.relKind === REL_DECLICK) {
      env -= 64
      if (env <= 0) {
        this.env = 0
        const p = this.pending
        this.pending = null
        this.active = false
        if (p) this.startNote(p)
        return
      }
      this.env = env
      return
    }
    switch (this.mode) {
      case MODE_ATTACK: {
        const rate = this.adsr[0]! * 2 + 1
        if (this.fire(SNES_RATE_PERIODS[rate]!)) {
          env += rate === 31 ? 1024 : 32
          if (env >= 0x7e0) this.mode = MODE_DECAY
          if (env > 0x7ff) env = 0x7ff
        }
        break
      }
      case MODE_DECAY: {
        if (this.fire(SNES_RATE_PERIODS[this.adsr[1]! * 2 + 16]!)) {
          env -= ((env - 1) >> 8) + 1
          if (env < 0) env = 0
          if (env >> 8 === this.adsr[2]!) this.mode = MODE_SUSTAIN
        }
        break
      }
      case MODE_SUSTAIN: {
        if (this.fire(SNES_RATE_PERIODS[this.adsr[3]!]!)) {
          env -= ((env - 1) >> 8) + 1
          if (env < 0) env = 0
        }
        break
      }
      case MODE_GAIN: {
        const m = this.gainMode
        if (m === 'direct') env = clamp(this.gainRate * 16, 0, 2047)
        else if (this.fire(SNES_RATE_PERIODS[this.gainRate]!)) {
          if (m === 'linear-dec') env -= 32
          else if (m === 'exp-dec') env -= ((env - 1) >> 8) + 1
          else if (m === 'linear-inc') env += 32
          else env += env < 0x600 ? 32 : 8
          env = clamp(env, 0, 2047)
        }
        break
      }
      default: {
        if (this.relKind === REL_SOFT) {
          if (this.fire(SOFT_RELEASE_PERIOD)) env -= ((env - 1) >> 8) + 1
          if (env <= 2) env = 0
        } else env -= 8
        if (env <= 0) {
          env = 0
          this.active = false
          this.keyed = false
        }
      }
    }
    this.env = env
  }

  private nextSample(): number {
    if (this.rp >= this.len) {
      if (this.loopStart >= 0) this.rp = this.loopStart
      else {
        // end of a one-shot: the DSP forces a release to 0
        this.env = 0
        this.active = false
        this.keyed = false
        return 0
      }
    }
    return this.pcm[this.rp++]!
  }

  /** One 32 kHz DSP step: returns the voice's dry output (-1..1) and adds its echo send. */
  private step32(): number {
    if (!this.active) return 0
    this.stepEnv()
    if (!this.active) return 0
    let cnt = this.cnt + this.pitch
    while (cnt >= 0x1000) {
      cnt -= 0x1000
      this.h0 = this.h1
      this.h1 = this.h2
      this.h2 = this.h3
      this.h3 = this.nextSample()
    }
    this.cnt = cnt
    const g = (cnt >> 4) & 255
    const s = (GAUSS[255 - g]! * this.h0 + GAUSS[511 - g]! * this.h1 + GAUSS[256 + g]! * this.h2 + GAUSS[g]! * this.h3) / 2048 / 32768
    const out = s * (this.env / 2047) * this.vol
    if (this.echoOn && !this.muted) {
      const k = this.k
      const g0 = out * this.linearGain * this.trimGain
      this.dsp.sendL[k] = this.dsp.sendL[k]! + g0 * this.panL
      this.dsp.sendR[k] = this.dsp.sendR[k]! + g0 * this.panR
    }
    return out
  }

  render(buf: Float32Array, from: number, to: number): void {
    this.k = 0
    let frac = this.frac
    let a0 = this.a0
    let a1 = this.a1
    let a2 = this.a2
    let a3 = this.a3
    const inc = this.inc
    for (let i = from; i < to; i++) {
      while (frac >= 1) {
        frac -= 1
        a0 = a1
        a1 = a2
        a2 = a3
        a3 = this.step32()
        this.k++
      }
      buf[i] = catmull(a0, a1, a2, a3, frac)
      frac += inc
    }
    this.frac = frac
    this.a0 = a0
    this.a1 = a1
    this.a2 = a2
    this.a3 = a3
    this.dsp.steps = this.k
  }

  reset(): void {
    this.active = false
    this.keyed = false
    this.pending = null
    this.env = 0
    this.mode = MODE_ATTACK
    this.relKind = REL_NONE
    this.vol = 0
    this.echoOn = false
    this.inst = null
    this.cnt = 0
    this.rp = 0
    this.h0 = this.h1 = this.h2 = this.h3 = 0
    this.frac = 0
    this.a0 = this.a1 = this.a2 = this.a3 = 0
    this.k = 0
    if (this.args.index === 0) this.dsp.reset()
  }
}

let currentEcho: EchoBus | null = null

registerVoice('snes', 'sample', (a): ChipVoice => {
  if (!currentEcho || a.index === 0) currentEcho = new EchoBus(a.sampleRate, a.maxBlock)
  return new SpcVoice(a, currentEcho)
})

registerMixProfile('snes', {
  outputGain: 1,
  filters: () => []
})
