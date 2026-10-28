// PlayStation SPU voices: 16 or 24 PS-X ADPCM sample voices on the shared sampler core (44.1 kHz DSP rate, Gaussian
// interpolation), the hardware ADSR per voice, pitch modulation, a global noise generator and the SPU reverb bus
// (`_reverb` stem, see spuReverb.ts). Spec: nocash psx-spx.
//
// What is modelled:
//  - ADSR: a 15-bit level, attack (linear or exponential, slowed above 0x6000), decay (always exponential), sustain
//    (increase or decrease, linear or exponential) and release, with the register formulas of psx-spx
//    (`cycles = 1 << max(0, shift - 11)`, `step << max(0, 11 - shift)`, exponential decrease scaled by the level).
//    The end flag of a one-shot sample mutes the voice at once. A `rel` (^^^) runs the instrument's release; a note cut
//    (===) and the retrigger declick are fast linear ramps (the hardware would click), as on the SNES voice.
//  - Pitch: the 16-bit step register, 0x1000 = 44.1 kHz, clamped at 0x4000.
//  - Pitch modulation (`pmod`): the step of voice n is scaled by `1 + out[n-1]`, the previous voice's ADSR-scaled output
//    (before the volume), exchanged through a per-step array on the shared core (`SpuCore.modOut`), since voices render
//    one after another in channel order. V1 has no previous voice.
//  - Noise (`noise`): one global LFSR (`SpuCore`) clocked every DSP step with the shift/step of the last key-on that used
//    noise; a noise voice outputs it instead of the sample (still multiplied by the ADSR). The LFSR advances exactly one
//    step per DSP step once any noise key-on happened, so renders are identical for every block size.
//
// Accuracy notes: decoded ADPCM is played from the encoder's PCM (the exact decode, see samplegen/psxAdpcm.ts); the
// per-voice volume is the float cell volume x pan (no 15-bit volume registers, sweep or phase-invert modes); the Gaussian
// interpolator is the shared S-DSP-style 4-tap bell kernel (unity DC gain) rather than psx-spx's own 512-entry table, so
// the interpolation response differs slightly; the CD/external audio inputs and the reverb-bus read/write
// enables are not modelled.

import type { Instrument, PsxSampleInstrument } from '../../types'
import { registerMixProfile } from '../mixer'
import { SharedBus } from '../sampler/bus'
import { SamplerVoice } from '../sampler/voice'
import type { ChannelControl } from '../sequencer'
import { SpuReverb } from './spuReverb'
import { type ChipVoice, type VoiceArgs, markChipPlayable, registerVoice } from './types'
import '../samplegen/psxAdpcm' // registers the 'psx' sample target

export const SPU_DSP_RATE = 44100

// ---------------------------------------------------------------------------------------------
// Core: the reverb bus plus what the voices exchange (pitch-modulation source, global noise)

const NOISE_RELOAD = 0x20000
const EMPTY = new Float32Array(0)

/** The shared object of one player's SPU: reverb bus, the per-voice modulation outputs and the noise generator. */
export class SpuCore extends SpuReverb {
  /** `modOut[i][k]`: ADSR-scaled output of voice i at DSP step k of the block, kept only while voice i+1 uses pmod. */
  readonly modOut: (Float32Array | undefined)[] = []
  readonly wantMod: boolean[] = []
  private noiseOn = false
  private nShift = 0
  private nStep = 0
  private timer = 0
  private level = 0
  private readonly noiseBuf: Float32Array
  private noiseFilled = 0

  constructor(sampleRate: number, maxBlock: number) {
    super(sampleRate, maxBlock)
    this.noiseBuf = new Float32Array(this.sendL.length)
  }

  /** Voice `source` must publish its output for the pmod voice after it (or stop doing so). */
  requestMod(source: number, on: boolean): Float32Array {
    this.wantMod[source] = on
    if (on && !this.modOut[source]) this.modOut[source] = new Float32Array(this.sendL.length)
    return this.modOut[source] ?? EMPTY
  }

  /** A key-on of a noise voice: the single NOISE clock takes its shift (0..15) and step (0..3). */
  setNoise(shift: number, step: number): void {
    this.noiseOn = true
    this.nShift = shift & 15
    this.nStep = step & 3
  }

  private stepNoise(): number {
    this.timer -= 4 + this.nStep
    const l = this.level
    const parity = ((l >> 15) ^ (l >> 12) ^ (l >> 11) ^ (l >> 10) ^ 1) & 1
    if (this.timer < 0) {
      this.level = ((l << 1) | parity) & 0xffff
      this.timer += NOISE_RELOAD >> this.nShift
      if (this.timer < 0) this.timer += NOISE_RELOAD >> this.nShift
    }
    const v = this.level
    return (v >= 0x8000 ? v - 0x10000 : v) / 32768
  }

  /** Noise output at DSP step `k` of the current block (generated on demand, shared by every noise voice). */
  noiseAt(k: number): number {
    while (this.noiseFilled <= k && this.noiseFilled < this.noiseBuf.length) this.noiseBuf[this.noiseFilled++] = this.stepNoise()
    return this.noiseBuf[k < this.noiseBuf.length ? k : this.noiseBuf.length - 1]!
  }

  override render(L: Float32Array, R: Float32Array, n: number): void {
    // the LFSR runs on every step of the block, whichever voices asked for it
    if (this.noiseOn && this.steps > 0) this.noiseAt(this.steps - 1)
    this.noiseFilled = 0
    super.render(L, R, n)
  }

  override reset(): void {
    super.reset()
    this.noiseOn = false
    this.timer = 0
    this.level = 0
    this.noiseFilled = 0
    for (const m of this.modOut) m?.fill(0)
  }
}

// ---------------------------------------------------------------------------------------------
// Voice

const PH_ATTACK = 0
const PH_DECAY = 1
const PH_SUSTAIN = 2
const PH_RELEASE = 3

const REL_NONE = 0
const REL_SOFT = 1
const REL_HARD = 2
const REL_DECLICK = 3

const LEVEL_MAX = 0x7fff
/** Level drop per DSP step of the note-cut ramp (~8 ms) and of the retrigger declick (~1.5 ms). */
const HARD_RELEASE_STEP = 96
const DECLICK_STEP = 512

export class SpuVoice extends SamplerVoice<PsxSampleInstrument> {
  private readonly core: SpuCore
  // envelope state
  private level = 0
  private phase = PH_ATTACK
  private relKind = REL_NONE
  /** Steps until the next level update. */
  private ctr = 1
  // the current rate: cycles between updates, level step and its mode
  private rCycles = 1
  private rStep = 0
  private rExp = false
  private rDec = false
  private sustainTarget = LEVEL_MAX
  // instrument parameters (read by envParams)
  private atk = 0
  private atkExp = false
  private dec = 0
  private slv = 15
  private srate = 0
  private sInc = false
  private sExp = false
  private rel = 0
  private relExp = false
  // pitch modulation / noise / modulation source
  private usePmod = false
  private useNoise = false
  private modIn: Float32Array = EMPTY
  private modOut: Float32Array | null = null

  constructor(args: VoiceArgs, core: SpuCore) {
    super(args, core, { dspRate: SPU_DSP_RATE, interp: 'gauss', target: 'psx', pitchMax: 0x4000, linearGain: 0.22, auxId: '_reverb' })
    this.core = core
  }

  /** Current 15-bit envelope level (0..0x7FFF), pitch register and ADSR phase (diagnostics and tests). */
  get envelopeLevel(): number {
    return this.level
  }
  get pitchRegister(): number {
    return this.playback.pitch
  }
  get adsrPhase(): number {
    return this.phase
  }

  protected instOf(inst: Instrument | undefined): PsxSampleInstrument | null {
    return inst && inst.kind === 'psx-sample' ? inst : null
  }

  protected sendLevelOf(c: ChannelControl, e: PsxSampleInstrument): number {
    return (c.echo ?? e.reverb) ? 1 : 0
  }

  protected envParams(e: PsxSampleInstrument): void {
    const a = e.adsr
    this.atk = a.attack
    this.atkExp = a.attackExp
    this.dec = a.decay
    this.slv = a.sustainLevel
    this.srate = a.sustainRate
    this.sInc = a.sustainDir === 'inc'
    this.sExp = a.sustainExp
    this.rel = a.release
    this.relExp = a.releaseExp
    this.sustainTarget = Math.min((a.sustainLevel + 1) * 0x800, 0x8000)
    const pm = !!e.pmod && this.args.index > 0
    if (pm !== this.usePmod) {
      this.usePmod = pm
      this.playback.pitchOffset = 0
      if (this.args.index > 0) this.modIn = this.core.requestMod(this.args.index - 1, pm)
    }
    this.useNoise = !!e.noise
  }

  /** Install the rate of the current phase: psx-spx shift (0..31) and step (-8..+7). */
  private setRate(shift: number, step: number, exp: boolean, dec: boolean): void {
    this.rCycles = 1 << Math.max(0, shift - 11)
    this.rStep = step * 2 ** Math.max(0, 11 - shift)
    this.rExp = exp
    this.rDec = dec
    this.ctr = 1
  }

  private enterAttack(): void {
    this.phase = PH_ATTACK
    this.setRate(this.atk >> 2, 7 - (this.atk & 3), this.atkExp, false)
  }

  private enterDecay(): void {
    this.phase = PH_DECAY
    this.setRate(this.dec, -8, true, true)
    // a sustain level of 15 (0x8000) is above the full level: no decay at all
    if (this.level <= this.sustainTarget) this.enterSustain()
  }

  private enterSustain(): void {
    this.phase = PH_SUSTAIN
    const r = this.srate
    this.setRate(r >> 2, this.sInc ? 7 - (r & 3) : -8 + (r & 3), this.sExp, !this.sInc)
  }

  protected envStart(e: PsxSampleInstrument): void {
    this.level = 0
    this.relKind = REL_NONE
    this.enterAttack()
    if (e.noise) this.core.setNoise(e.noise.shift, e.noise.step)
  }

  protected envRelease(c: ChannelControl, e: PsxSampleInstrument | null): void {
    if (this.relKind === REL_DECLICK) return
    if (!(c.release && e)) this.relKind = REL_HARD
    else if (this.phase !== PH_RELEASE) this.relKind = REL_SOFT
    if (this.phase !== PH_RELEASE) {
      this.phase = PH_RELEASE
      this.setRate(this.rel, -8, this.relExp, true)
    }
  }

  protected envGain(): number {
    return this.level / LEVEL_MAX
  }

  protected envSounding(): boolean {
    return this.level > 0
  }

  protected beginDeclick(): void {
    this.relKind = REL_DECLICK
  }

  protected envReset(): void {
    this.level = 0
    this.phase = PH_ATTACK
    this.relKind = REL_NONE
    this.ctr = 1
    this.playback.pitchOffset = 0
    if (this.usePmod && this.args.index > 0) this.core.requestMod(this.args.index - 1, false)
    this.usePmod = false
    this.useNoise = false
    this.modIn = EMPTY
  }

  protected onSampleEnd(): void {
    // end flag of a one-shot: the SPU mutes the voice (a noise voice ignores its sample data)
    if (this.useNoise) return
    this.level = 0
    this.active = false
    this.keyed = false
  }

  protected envStep(): void {
    if (this.relKind >= REL_HARD) {
      // note cut / declick: fast linear ramp
      const lv = this.level - (this.relKind === REL_DECLICK ? DECLICK_STEP : HARD_RELEASE_STEP)
      if (lv <= 0) {
        this.level = 0
        if (this.relKind === REL_DECLICK) this.finishDeclick()
        else {
          this.active = false
          this.keyed = false
        }
        return
      }
      this.level = lv
      return
    }
    if (--this.ctr > 0) return
    let lv = this.level
    let cyc = this.rCycles
    let st = this.rStep
    if (this.rExp) {
      if (this.rDec) st = (st * lv) >> 15
      else if (lv > 0x6000) cyc *= 4
    }
    this.ctr = cyc
    lv += st
    if (lv > LEVEL_MAX) lv = LEVEL_MAX
    else if (lv < 0) lv = 0
    this.level = lv
    switch (this.phase) {
      case PH_ATTACK:
        if (lv >= LEVEL_MAX) this.enterDecay()
        break
      case PH_DECAY:
        if (lv <= this.sustainTarget) this.enterSustain()
        break
      case PH_RELEASE:
        if (lv <= 3) {
          this.level = 0
          this.active = false
          this.keyed = false
        }
        break
      default:
    }
  }

  // ---- per-step hooks (kept small: they run for every DSP step of every sounding voice) ------------

  protected override preStep(): void {
    if (this.usePmod) {
      const pb = this.playback
      const p = pb.pitch
      let off = Math.round(p * this.modIn[this.clock.k]!)
      if (p + off > this.pitchMax) off = this.pitchMax - p
      pb.pitchOffset = off
    }
  }

  protected override postSample(s: number): number {
    if (this.useNoise) s = this.core.noiseAt(this.clock.k)
    const m = this.modOut
    if (m !== null) m[this.clock.k] = s * (this.level / LEVEL_MAX)
    return s
  }

  override render(buf: Float32Array, from: number, to: number): void {
    // publish this voice's output for the pmod voice after it
    const i = this.args.index
    const m = this.core.wantMod[i] ? (this.core.modOut[i] ?? null) : null
    if (m !== null) m.fill(0)
    this.modOut = m
    super.render(buf, from, to)
  }
}

const cores = new SharedBus((a) => new SpuCore(a.sampleRate, a.maxBlock))

registerVoice('ps1', 'sample', (a): ChipVoice => new SpuVoice(a, cores.get(a)))

registerMixProfile('ps1', {
  outputGain: 1,
  filters: () => []
})

markChipPlayable('ps1')
