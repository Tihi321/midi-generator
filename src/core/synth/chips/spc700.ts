// SNES SPC700 / S-DSP voices: 8 BRR sample voices running at the DSP's native 32 kHz, 4-point Gaussian
// interpolation, 11-bit ADSR / GAIN envelopes on the real rate table, and a global echo (ring buffer with delay
// x 16 ms, feedback, 8-tap FIR and echo volume) with a per-voice echo send. The 32 kHz mix is resampled to the
// output rate (cubic) per voice; the echo is its own bus, exposed to the player as the `_echo` stem.
//
// The sample playback, the resampling clock, the send-bus contract and the key-on / declick / release template are
// the shared sampler core in `../sampler/`; this file keeps what is SNES-specific: the ADSR / GAIN envelope and the
// echo.
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
import { type SendBus, SharedBus } from '../sampler/bus'
import { DspClock } from '../sampler/clock'
import { SamplerVoice } from '../sampler/voice'
import { clamp } from '../tables'
import { type ChipVoice, type VoiceArgs, registerVoice } from './types'

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

// ---------------------------------------------------------------------------------------------
// Echo bus

const ECHO_MAX_FRAMES = 15 * SNES_ECHO_STEP_FRAMES

/** Echo ring buffer + 8-tap FIR + feedback, shared by the eight voices. Runs at 32 kHz. */
export class EchoBus implements SendBus {
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
  private readonly clock: DspClock

  constructor(sampleRate: number, maxBlock: number) {
    const cap = Math.ceil((maxBlock * SNES_DSP_RATE) / sampleRate) + 8
    this.sendL = new Float32Array(cap)
    this.sendR = new Float32Array(cap)
    this.outL = new Float32Array(cap)
    this.outR = new Float32Array(cap)
    this.clock = new DspClock(SNES_DSP_RATE, sampleRate)
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
    this.clock.reset()
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
    this.clock.resampleStereo(this.outL, this.outR, steps, L, R, n)
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

export class SpcVoice extends SamplerVoice<SnesSampleInstrument> {
  // envelope
  private env = 0
  private mode = MODE_ATTACK
  private ecnt = 0
  private relKind = REL_NONE
  private adsr: readonly number[] = [15, 7, 7, 0]
  private gainMode = 'direct'
  private gainRate = 0

  constructor(args: VoiceArgs, dsp: EchoBus) {
    super(args, dsp, { dspRate: SNES_DSP_RATE, interp: 'gauss', target: 'snes', pitchMax: 0x3fff, linearGain: 0.3, auxId: '_echo' })
  }

  /** Current 11-bit envelope level (0..2047) and pitch register (diagnostics and tests). */
  get envelopeLevel(): number {
    return this.env
  }
  get pitchRegister(): number {
    return this.playback.pitch
  }

  protected instOf(inst: Instrument | undefined): SnesSampleInstrument | null {
    return inst && inst.kind === 'snes-sample' ? inst : null
  }

  protected sendLevelOf(c: ChannelControl, e: SnesSampleInstrument): number {
    return (c.echo ?? e.echo) ? 1 : 0
  }

  private setEnvParams(env: SnesEnvelope | undefined): void {
    if (env && 'adsr' in env) {
      this.adsr = env.adsr
    } else if (env && 'gain' in env) {
      this.gainMode = env.gain.mode
      this.gainRate = env.gain.rate
    }
  }

  protected envParams(e: SnesSampleInstrument): void {
    this.setEnvParams(e.env)
  }

  protected envStart(inst: SnesSampleInstrument): void {
    this.ecnt = 0
    this.relKind = REL_NONE
    if ('gain' in inst.env) {
      this.mode = MODE_GAIN
      const m = this.gainMode
      this.env = m === 'direct' ? clamp(this.gainRate * 16, 0, 2047) : m === 'linear-dec' || m === 'exp-dec' ? 2047 : 0
    } else {
      this.mode = MODE_ATTACK
      this.env = 0
    }
  }

  protected envRelease(c: ChannelControl, e: SnesSampleInstrument | null): void {
    if (this.relKind === REL_DECLICK) return
    this.relKind = c.release && e ? REL_SOFT : REL_HARD
    this.mode = MODE_RELEASE
  }

  protected envGain(): number {
    return this.env / 2047
  }

  protected envSounding(): boolean {
    return this.env > 0
  }

  protected beginDeclick(): void {
    this.relKind = REL_DECLICK
  }

  protected envReset(): void {
    this.env = 0
    this.mode = MODE_ATTACK
    this.relKind = REL_NONE
  }

  protected onSampleEnd(): void {
    // end of a one-shot: the DSP forces a release to 0
    this.env = 0
    this.active = false
    this.keyed = false
  }

  private fire(period: number): boolean {
    return period > 0 && this.ecnt % period === 0
  }

  protected envStep(): void {
    this.ecnt++
    if (this.ecnt >= COUNTER_WRAP) this.ecnt = 0
    let env = this.env
    if (this.relKind === REL_DECLICK) {
      env -= 64
      if (env <= 0) {
        this.env = 0
        this.finishDeclick()
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
}

const echoBuses = new SharedBus((a) => new EchoBus(a.sampleRate, a.maxBlock))

registerVoice('snes', 'sample', (a): ChipVoice => new SpcVoice(a, echoBuses.get(a)))

registerMixProfile('snes', {
  outputGain: 1,
  filters: () => []
})
