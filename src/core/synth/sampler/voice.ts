// The base voice of the sample chips (SNES SPC700, PS1 SPU, Dreamcast AICA): one monophonic voice per channel that
// plays a resolved sample slot at the chip's DSP rate through a `SamplePlayback`, applies the chip's envelope, adds
// its send to the shared `SendBus` and resamples to the output rate with a `DspClock`.
//
// What a chip subclass provides (one subclass per chip keeps the per-step calls monomorphic):
//  - identity:   `instOf`, `sendLevelOf`, `calcPitch` (default: the 14-bit-style register 0x1000 = native rate)
//  - envelope:   `envParams`, `envStart`, `envStep`, `envRelease`, `envGain`, `envSounding`, `envReset`,
//                `beginDeclick` (retrigger on a sounding voice) and `onSampleEnd` (a one-shot ran out)
//  - optional:   `preStep()` before the envelope of every DSP step (pitch modulation, LFO: write
//                `playback.pitchOffset`) and `postSample(s)` on the interpolated sample (a per-voice filter, noise).
// The per-step order is: preStep, envStep, advance, onSampleEnd (if the sample ended), interpolate, postSample, then
// the output `s * envGain() * vol` and the send `out * linearGain * trim * sendLevel` panned into the bus.

import type { Instrument, Song } from '../../types'
import type { SampleTarget } from '../samplegen/bank'
import { tryResolveSampleSlot } from '../samplegen/bank'
import type { ChannelControl } from '../sequencer'
import { clamp, dbToGain, midiToHz } from '../tables'
import type { AuxOutput, ChipVoice, MixGroup, VoiceArgs } from '../chips/types'
import { type SendBus, busAux } from './bus'
import { DspClock, catmull } from './clock'
import { type Interpolation, SamplePlayback } from './playback'

/** What the base class needs from a chip's sample instrument. */
export interface SamplerInstrument {
  /** SampleSlot id. */
  sample: string
  /** MIDI note at which the sample plays at its native rate. */
  baseNote: number
  /** Fine tune in cents. */
  fine?: number
}

export interface SamplerConfig {
  /** DSP step rate in Hz (32000 on the SNES, 44100 on the PS1 and Dreamcast). */
  dspRate: number
  interp: Interpolation
  /** Which processing pipeline resolves the sample slots (a registered sample target). */
  target: SampleTarget
  /** Largest value of the pitch register (0x1000 = native); the default `calcPitch` clamps to 1..pitchMax. */
  pitchMax: number
  /** Multiplier from the voice output to the linear mix level. */
  linearGain: number
  /** Stem id of the bus (e.g. '_echo'); the voice of channel 0 exposes it. */
  auxId: string
}

export abstract class SamplerVoice<I extends SamplerInstrument> implements ChipVoice {
  readonly mixGroup: MixGroup = 'direct'
  readonly linearGain: number
  readonly aux?: AuxOutput

  protected song: Song
  protected trimGain = 1
  protected muted = false

  protected readonly playback: SamplePlayback
  protected readonly clock: DspClock
  protected readonly dspRate: number
  protected readonly target: SampleTarget
  protected readonly pitchMax: number
  /** The sample's native rate divided by the DSP rate. */
  protected baseRatio = 1
  protected active = false
  protected keyed = false
  /** Instrument waiting for the declick fade-out of the previous note to finish. */
  protected pending: I | null = null
  protected freqHz = 261.63

  // mix
  protected vol = 0
  protected panL = 1
  protected panR = 1
  /** Send level into the bus (0 = off; the SNES uses 1 for echo on). */
  protected sendLevel = 0
  protected inst: I | null = null
  /** True when a subclass overrides `preStep` or `postSample` (otherwise the lean `step` is used). */
  private readonly hooked: boolean

  constructor(
    protected readonly args: VoiceArgs,
    protected readonly bus: SendBus,
    cfg: SamplerConfig
  ) {
    this.song = args.song
    this.linearGain = cfg.linearGain
    this.dspRate = cfg.dspRate
    this.target = cfg.target
    this.pitchMax = cfg.pitchMax
    this.hooked = this.preStep !== SamplerVoice.prototype.preStep || this.postSample !== SamplerVoice.prototype.postSample
    this.playback = new SamplePlayback(cfg.interp)
    this.clock = new DspClock(cfg.dspRate, args.sampleRate)
    if (args.index === 0) this.aux = busAux(cfg.auxId, bus)
    this.syncSong(args.song)
  }

  // ---- hooks -------------------------------------------------------------------------------------

  /** The chip's sample instrument, or null for any other kind. */
  protected abstract instOf(inst: Instrument | undefined): I | null
  /** Send level for this tick (`c.echo` overrides the instrument's default). */
  protected abstract sendLevelOf(c: ChannelControl, e: I): number
  /** Read the envelope parameters of the instrument (called on key-on and while the same instrument sounds). */
  protected abstract envParams(e: I): void
  /** Reset the envelope state for a new note. */
  protected abstract envStart(e: I): void
  /** Advance the envelope by one DSP step; may clear `active` (and call `finishDeclick`). */
  protected abstract envStep(): void
  /** Key-off / release request (a tick without trigger or gate while keyed). `e` is null when the instrument is unknown. */
  protected abstract envRelease(c: ChannelControl, e: I | null): void
  /** Linear envelope gain 0..1 applied to the interpolated sample. */
  protected abstract envGain(): number
  /** True when a retrigger must fade the old note out first. */
  protected abstract envSounding(): boolean
  /** Start the declick fade-out of a retriggered voice (the chip's step calls `finishDeclick` when it reaches 0). */
  protected abstract beginDeclick(): void
  /** Back to the power-on envelope state. */
  protected abstract envReset(): void
  /** A one-shot sample ran past its end during this step. */
  protected abstract onSampleEnd(): void
  /** Before the envelope of every DSP step while active (pitch modulation, LFO). */
  protected preStep(): void {}
  /** On the interpolated sample before the envelope gain (filter, noise substitute). */
  protected postSample(s: number): number {
    return s
  }
  /** The 0x1000 = native-rate pitch register for a note at `freqHz`. */
  protected calcPitch(e: I): number {
    const fine = e.fine ?? 0
    const ratio = (this.freqHz / midiToHz(e.baseNote)) * (fine ? Math.pow(2, fine / 1200) : 1)
    return clamp(Math.round(this.baseRatio * ratio * 0x1000), 1, this.pitchMax)
  }

  // ---- song / state -------------------------------------------------------------------------------

  private syncSong(song: Song): void {
    this.song = song
    this.trimGain = dbToGain(song.channels[this.args.index]?.trim ?? 0)
    this.bus.configure(song)
    // warm the sample cache so generation never happens on the audio thread
    for (const inst of song.instruments) {
      const e = this.instOf(inst)
      if (e) tryResolveSampleSlot(song, e.sample, this.target)
    }
  }

  setSong(song: Song): void {
    this.syncSong(song)
  }

  setMuted(muted: boolean): void {
    this.muted = muted
  }

  private loadSample(inst: I): boolean {
    const r = tryResolveSampleSlot(this.song, inst.sample, this.target)
    if (!r || r.pcm.length === 0) return false
    this.playback.load(r.pcm, r.loopStart)
    this.baseRatio = r.sampleRate / this.dspRate
    return true
  }

  protected startNote(inst: I): void {
    if (!this.loadSample(inst)) {
      this.active = false
      this.keyed = false
      return
    }
    this.inst = inst
    this.playback.restart()
    this.active = true
    this.keyed = true
    this.envParams(inst)
    this.playback.pitch = this.calcPitch(inst)
    this.envStart(inst)
  }

  /** The declick fade-out reached silence: start the waiting note (called from the chip's `envStep`). */
  protected finishDeclick(): void {
    const p = this.pending
    this.pending = null
    this.active = false
    if (p) this.startNote(p)
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const e = this.instOf(inst)
    this.freqHz = c.freqHz
    this.panL = c.pan > 0 ? 1 - c.pan : 1
    this.panR = c.pan < 0 ? 1 + c.pan : 1
    if (c.gate || c.vol > 0) this.vol = c.vol
    if (e) {
      this.sendLevel = this.sendLevelOf(c, e)
      if (this.inst === e || !this.keyed) this.envParams(e)
    }
    if (c.trigger && e) {
      if (this.active && this.envSounding()) {
        // retrigger on a sounding voice: declick (fast key-off) first, as sound drivers do
        this.pending = e
        this.beginDeclick()
      } else this.startNote(e)
    }
    const pi = this.inst ?? e
    if (this.active && pi) this.playback.pitch = this.calcPitch(pi)
    if (!c.trigger && !c.gate && this.keyed) this.envRelease(c, e)
  }

  // ---- rendering ----------------------------------------------------------------------------------

  /** One DSP step: returns the voice's dry output (-1..1) and adds its send to the bus. */
  private step(): number {
    if (!this.active) return 0
    this.envStep()
    if (!this.active) return 0
    const pb = this.playback
    if (pb.advance()) this.onSampleEnd()
    const s = pb.interpolate()
    const out = s * this.envGain() * this.vol
    if (this.sendLevel !== 0 && !this.muted) {
      const k = this.clock.k
      const bus = this.bus
      const g0 = out * this.linearGain * this.trimGain * this.sendLevel
      bus.sendL[k] = bus.sendL[k]! + g0 * this.panL
      bus.sendR[k] = bus.sendR[k]! + g0 * this.panR
    }
    return out
  }

  /** `step()` with the optional `preStep` / `postSample` hooks; chosen once per block so the plain step stays lean. */
  private stepHooked(): number {
    if (!this.active) return 0
    this.preStep()
    this.envStep()
    if (!this.active) return 0
    const pb = this.playback
    if (pb.advance()) this.onSampleEnd()
    const s = this.postSample(pb.interpolate())
    const out = s * this.envGain() * this.vol
    if (this.sendLevel !== 0 && !this.muted) {
      const k = this.clock.k
      const bus = this.bus
      const g0 = out * this.linearGain * this.trimGain * this.sendLevel
      bus.sendL[k] = bus.sendL[k]! + g0 * this.panL
      bus.sendR[k] = bus.sendR[k]! + g0 * this.panR
    }
    return out
  }

  render(buf: Float32Array, from: number, to: number): void {
    const clock = this.clock
    clock.k = 0
    let frac = clock.frac
    let a0 = clock.a0
    let a1 = clock.a1
    let a2 = clock.a2
    let a3 = clock.a3
    const inc = clock.inc
    if (this.hooked) {
      for (let i = from; i < to; i++) {
        while (frac >= 1) {
          frac -= 1
          a0 = a1
          a1 = a2
          a2 = a3
          a3 = this.stepHooked()
          clock.k++
        }
        buf[i] = catmull(a0, a1, a2, a3, frac)
        frac += inc
      }
    } else {
      for (let i = from; i < to; i++) {
        while (frac >= 1) {
          frac -= 1
          a0 = a1
          a1 = a2
          a2 = a3
          a3 = this.step()
          clock.k++
        }
        buf[i] = catmull(a0, a1, a2, a3, frac)
        frac += inc
      }
    }
    clock.frac = frac
    clock.a0 = a0
    clock.a1 = a1
    clock.a2 = a2
    clock.a3 = a3
    this.bus.steps = clock.k
  }

  reset(): void {
    this.active = false
    this.keyed = false
    this.pending = null
    this.envReset()
    this.vol = 0
    this.sendLevel = 0
    this.inst = null
    const pb = this.playback
    pb.cnt = 0
    pb.rp = 0
    pb.h0 = pb.h1 = pb.h2 = pb.h3 = 0
    this.clock.reset()
    if (this.args.index === 0) this.bus.reset()
  }
}
