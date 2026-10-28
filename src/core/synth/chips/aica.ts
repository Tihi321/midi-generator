// Dreamcast AICA voices: 16, 32 or 64 slots playing PCM16 / PCM8 / 4-bit ADPCM samples at the AICA's 44.1 kHz step with
// linear interpolation, on the shared sampler core (`../sampler/`). This file is what is AICA-specific:
//  - pitch from the OCT (-8..7) and 10-bit FNS registers (a note is quantised to what those registers can express);
//  - the AEG in the attenuation domain: AR (an exponential approach to full level), D1R down to the DL level, D2R, RR,
//    with the documented rate tables and optional key rate scaling (tables in aicaTables.ts);
//  - an LFO per slot (documented frequency table, saw / square / triangle / noise) for pitch (PLFOS) and amplitude (ALFOS);
//  - an optional resonant 2-pole low-pass per slot with its own envelope (FLV0..FLV4, FAR / FD1R / FD2R / FRR, Q);
//  - TL volume steps, DIPAN pan steps (mix profile) and the IMXL send level into the DSP bus (aicaDsp.ts, `_dsp` stem).
//
// The sample target depends on the instrument's `format` (pcm16 / pcm8 / adpcm), but the sampler base takes a single
// target; `startNote` swaps the (protected, readonly) `target` field before delegating, and the cache is warmed per format.
//
// Speed: an idle slot only advances its clock (no envelope, LFO, filter or catmull); the LFO runs in `preStep` and the
// filter in `postSample`, both skipped by a flag when the instrument has none. Keep those two methods small: the base
// class' hooked step is inlined into the render loop and V8's inlining gets unstable when they grow.

import type { AicaAeg, AicaFilter, AicaLfo, AicaLfoWave, AicaSampleInstrument, Instrument, Song } from '../../types'
import { registerMixProfile } from '../mixer'
import type { ChannelControl } from '../sequencer'
import { type SampleTarget, tryResolveSampleSlot } from '../samplegen/bank'
import { aicaTargetFor } from '../samplegen/aicaAdpcm'
import { SharedBus } from '../sampler/bus'
import { SamplerVoice } from '../sampler/voice'
import { midiToHz } from '../tables'
import { AicaDspBus, AICA_DSP_RATE } from './aicaDsp'
import {
  AEG_GAIN,
  AEG_MAX,
  ALFO_DB,
  FLV_MAX,
  IMXL_GAIN,
  LFO_HZ,
  PLFO_CENTS,
  aicaAttackTime6,
  aicaFallTime6,
  aicaKeyScale,
  aicaQFactor,
  aicaQuantizePan,
  aicaRate6,
  aicaTlGain,
  flvToHz
} from './aicaTables'
import { type ChipVoice, type VoiceArgs, markChipPlayable, registerVoice } from './types'
import '../samplegen/aicaAdpcm' // registers the 'aica16' / 'aica8' / 'aica-adpcm' sample targets

// AEG phases
const PH_ATTACK = 0
const PH_D1 = 1
const PH_D2 = 2
const PH_RELEASE = 3
const PH_DECLICK = 4

/** Attenuation units added per step by the retrigger declick (32 steps to silence) and the hard key-off cut (256 steps). */
const DECLICK_INC = 32
const CUT_INC = 4
/** A retrigger declicks only while the voice is above this attenuation (about -90 dB). */
const AUDIBLE = 960

const LFO_NONE = 0
const LFO_SAW = 1
const LFO_SQUARE = 2
const LFO_TRI = 3
const LFO_NOISE = 4
const WAVES: Record<AicaLfoWave, number> = { saw: LFO_SAW, square: LFO_SQUARE, tri: LFO_TRI, noise: LFO_NOISE }

/** Filter envelope phases. */
const FP_ATTACK = 0
const FP_D1 = 1
const FP_D2 = 2
const FP_RELEASE = 3
/** DSP steps between recomputations of the filter coefficients (the cutoff moves slowly). */
const FILTER_UPDATE = 8
/** A FLV move that finishes on the next step (rate 31 of the attack table). */
const INSTANT = 1e9

const DEFAULT_AEG: AicaAeg = { ar: 31, d1r: 0, d2r: 0, rr: 20, dl: 0 }

/** Units per DSP step of an attenuation swing of `units` that takes `seconds` (0 seconds = instant, Infinity = never). */
function perStep(units: number, seconds: number): number {
  if (seconds === Infinity) return 0
  if (seconds <= 0) return INSTANT
  return units / (seconds * AICA_DSP_RATE)
}

export class AicaVoice extends SamplerVoice<AicaSampleInstrument> {
  // ---- AEG (attenuation units 0..1023, 0 = full level) ----------------------------------------
  private att = AEG_MAX
  private phase = PH_ATTACK
  private aeg: AicaAeg = DEFAULT_AEG
  /** Attack: attenuation is multiplied by this every step (an exponential approach to 0). */
  private attMul = 0
  private d1Inc = 0
  private d2Inc = 0
  private relInc = 0
  private relCur = 0
  private dlLevel = 0

  // ---- pitch registers --------------------------------------------------------------------------
  private oct = 0
  private fns = 0

  // ---- LFO ----------------------------------------------------------------------------------------
  private lfoOn = false
  private lfoPhase = 0
  private lfoInc = 0
  private pitchWave = LFO_NONE
  private ampWave = LFO_NONE
  /** Pitch deviation per unit of the LFO wave, as a fraction of the pitch register. */
  private pitchK = 0
  /** Peak attenuation of the amplitude LFO in nepers. */
  private ampNeper = 0
  private ampMul = 1
  private lfsr = 1
  private noiseValue = 0

  // ---- filter -------------------------------------------------------------------------------------
  private filtOn = false
  private fphase = FP_ATTACK
  private fCur = 0
  private fTarget = 0
  private fRate = 0
  private fHold = true
  private fCount = 0
  private fk = 1
  private fl1 = 0
  private fl2 = 0
  private fl3 = 0
  private ic1 = 0
  private ic2 = 0
  private flt: AicaFilter | null = null
  private fd1Rate = 0
  private fd2Rate = 0
  private frRate = 0

  constructor(args: VoiceArgs, dsp: AicaDspBus) {
    super(args, dsp, { dspRate: AICA_DSP_RATE, interp: 'linear', target: 'aica16', pitchMax: 0x1000 * 128, linearGain: 0.25, auxId: '_dsp' })
    this.warmFormats(args.song)
    this.lfsr = ((args.index + 1) * 0x9e37) & 0xffff || 1
  }

  /** Diagnostics and tests. */
  get attenuation(): number {
    return this.att
  }
  get pitchRegister(): number {
    return this.playback.pitch
  }
  get octave(): number {
    return this.oct
  }
  get fnsRegister(): number {
    return this.fns
  }
  /** The filter's current FLV level (0..8191). */
  get filterLevel(): number {
    return this.fCur
  }

  // ---- sample target per format --------------------------------------------------------------------

  private warmFormats(song: Song): void {
    for (const inst of song.instruments) {
      const e = this.instOf(inst)
      if (e && e.format !== 'pcm16') tryResolveSampleSlot(song, e.sample, aicaTargetFor(e.format))
    }
  }

  override setSong(song: Song): void {
    super.setSong(song)
    this.warmFormats(song)
  }

  protected override startNote(inst: AicaSampleInstrument): void {
    ;(this as unknown as { target: SampleTarget }).target = aicaTargetFor(inst.format)
    super.startNote(inst)
  }

  // ---- identity / pitch ----------------------------------------------------------------------------

  protected instOf(inst: Instrument | undefined): AicaSampleInstrument | null {
    return inst && inst.kind === 'aica-sample' ? inst : null
  }

  protected sendLevelOf(c: ChannelControl, e: AicaSampleInstrument): number {
    const send = c.echo === undefined ? e.send : c.echo ? (e.send > 0 ? e.send : 10) : 0
    return IMXL_GAIN[send] ?? 0
  }

  /** The pitch register for the note: OCT (-8..7) and a 10-bit FNS mantissa, so the pitch is quantised like the hardware's. */
  protected override calcPitch(e: AicaSampleInstrument): number {
    const fine = e.fine ?? 0
    const ratio = this.baseRatio * (this.freqHz / midiToHz(e.baseNote)) * (fine ? Math.pow(2, fine / 1200) : 1)
    let oct = Math.floor(Math.log2(ratio))
    if (oct < -8) oct = -8
    else if (oct > 7) oct = 7
    let fns = Math.round((ratio / 2 ** oct - 1) * 1024)
    if (fns > 1023) {
      if (oct < 7) {
        oct++
        fns = 0
      } else fns = 1023
    } else if (fns < 0) fns = 0
    this.oct = oct
    this.fns = fns
    return (1024 + fns) * 4 * 2 ** oct
  }

  override control(c: ChannelControl, inst: Instrument | undefined): void {
    super.control(c, inst)
    // TL volume steps and the DIPAN pan steps (the send uses the same pan)
    if (this.vol > 0) this.vol = aicaTlGain(this.vol)
    const p = aicaQuantizePan(c.pan)
    this.panL = p > 0 ? 1 - p : 1
    this.panR = p < 0 ? 1 + p : 1
  }

  // ---- envelope ------------------------------------------------------------------------------------

  protected envParams(e: AicaSampleInstrument): void {
    this.aeg = e.aeg
  }

  protected envStart(e: AicaSampleInstrument): void {
    const g = e.aeg
    const ks = aicaKeyScale(g.krs, this.oct)
    const arRate = aicaRate6(g.ar, ks)
    const attack = aicaAttackTime6(arRate)
    this.phase = PH_ATTACK
    this.dlLevel = g.dl << 5
    this.d1Inc = perStep(AEG_MAX, aicaFallTime6(aicaRate6(g.d1r, ks)))
    this.d2Inc = perStep(AEG_MAX, aicaFallTime6(aicaRate6(g.d2r, ks)))
    // a release rate of 0 would hold the note forever: treat it as the slowest rate
    this.relInc = perStep(AEG_MAX, aicaFallTime6(aicaRate6(Math.max(1, g.rr), ks)))
    if (attack === 0) {
      this.att = 0
      this.phase = this.dlLevel > 0 ? PH_D1 : PH_D2
      this.attMul = 0
    } else if (attack === Infinity) {
      // AR 0: the attenuation never moves, the slot stays silent
      this.att = AEG_MAX
      this.attMul = 1
      this.active = false
      this.keyed = false
    } else {
      this.att = AEG_MAX
      this.attMul = Math.exp(-Math.log(AEG_MAX) / (attack * AICA_DSP_RATE))
    }
    this.startLfo(e.lfo)
    this.startFilter(e.filter, ks)
  }

  protected envRelease(c: ChannelControl, e: AicaSampleInstrument | null): void {
    if (this.phase === PH_DECLICK) return
    this.phase = PH_RELEASE
    this.relCur = c.release && e ? this.relInc : CUT_INC
    if (this.filtOn) this.fegRelease()
  }

  protected envGain(): number {
    return AEG_GAIN[this.att | 0]! * this.ampMul
  }

  protected envSounding(): boolean {
    return this.att < AUDIBLE
  }

  protected beginDeclick(): void {
    this.phase = PH_DECLICK
  }

  protected envReset(): void {
    this.att = AEG_MAX
    this.phase = PH_ATTACK
    this.ampMul = 1
    this.lfoOn = false
    this.filtOn = false
    this.lfoPhase = 0
    this.noiseValue = 0
    this.lfsr = ((this.args.index + 1) * 0x9e37) & 0xffff || 1
    this.ic1 = 0
    this.ic2 = 0
    this.playback.pitchOffset = 0
  }

  protected onSampleEnd(): void {
    // a one-shot ran out: the slot goes silent
    this.att = AEG_MAX
    this.active = false
    this.keyed = false
  }

  protected envStep(): void {
    let a = this.att
    switch (this.phase) {
      case PH_ATTACK:
        a *= this.attMul
        if (a < 1) {
          a = 0
          this.phase = this.dlLevel > 0 ? PH_D1 : PH_D2
        }
        break
      case PH_D1:
        a += this.d1Inc
        if (a >= this.dlLevel) this.phase = PH_D2
        break
      case PH_D2:
        a += this.d2Inc
        break
      case PH_RELEASE:
        a += this.relCur
        break
      default:
        a += DECLICK_INC
        if (a >= AEG_MAX) {
          this.att = AEG_MAX
          this.finishDeclick()
          return
        }
    }
    if (a >= AEG_MAX) {
      a = AEG_MAX
      this.active = false
      this.keyed = false
    }
    this.att = a
  }

  // ---- idle fast path ------------------------------------------------------------------------------

  override render(buf: Float32Array, from: number, to: number): void {
    const clock = this.clock
    if (!this.active && clock.a0 === 0 && clock.a1 === 0 && clock.a2 === 0 && clock.a3 === 0) {
      // idle slot: advance the clock exactly like the base loop does, without a voice step or the cubic
      let frac = clock.frac
      let k = 0
      const inc = clock.inc
      for (let i = from; i < to; i++) {
        while (frac >= 1) {
          frac -= 1
          k++
        }
        buf[i] = 0
        frac += inc
      }
      clock.frac = frac
      clock.k = k
      this.bus.steps = k
      return
    }
    super.render(buf, from, to)
  }

  // ---- LFO (preStep) ---------------------------------------------------------------------------------

  private startLfo(l: AicaLfo | undefined): void {
    const pDepth = l ? l.pitchDepth : 0
    const aDepth = l ? l.ampDepth : 0
    this.pitchWave = l && pDepth > 0 ? WAVES[l.pitchWave] ?? LFO_NONE : LFO_NONE
    this.ampWave = l && aDepth > 0 ? WAVES[l.ampWave] ?? LFO_NONE : LFO_NONE
    this.lfoOn = l !== undefined && (this.pitchWave !== LFO_NONE || this.ampWave !== LFO_NONE)
    this.playback.pitchOffset = 0
    this.ampMul = 1
    if (!l || !this.lfoOn) return
    this.lfoInc = (LFO_HZ[l.freq] ?? LFO_HZ[0]!) / AICA_DSP_RATE
    this.pitchK = (Math.pow(2, PLFO_CENTS[pDepth]! / 1200) - 1)
    this.ampNeper = (ALFO_DB[aDepth]! * Math.LN10) / 20
    if (l.reset) {
      this.lfoPhase = 0
      this.noiseValue = 0
    }
  }

  /** A wave sample in -1..1 at the LFO phase. */
  private wave(kind: number): number {
    const p = this.lfoPhase
    switch (kind) {
      case LFO_SAW:
        return 2 * p - 1
      case LFO_SQUARE:
        return p < 0.5 ? 1 : -1
      case LFO_TRI:
        return p < 0.5 ? 4 * p - 1 : 3 - 4 * p
      default:
        return this.noiseValue
    }
  }

  protected override preStep(): void {
    if (!this.lfoOn) return
    let p = this.lfoPhase + this.lfoInc
    if (p >= 1) {
      p -= 1
      // seeded 16-bit LFSR, one new noise value per LFO cycle
      const l = this.lfsr
      const bit = ((l >> 15) ^ (l >> 13) ^ (l >> 12) ^ (l >> 10)) & 1
      this.lfsr = ((l << 1) | bit) & 0xffff
      this.noiseValue = this.lfsr / 32767.5 - 1
    }
    this.lfoPhase = p
    if (this.pitchWave !== LFO_NONE) this.playback.pitchOffset = this.playback.pitch * this.wave(this.pitchWave) * this.pitchK
    if (this.ampWave !== LFO_NONE) this.ampMul = Math.exp(-this.ampNeper * (this.wave(this.ampWave) + 1) * 0.5)
  }

  // ---- filter (postSample) ---------------------------------------------------------------------------

  private startFilter(f: AicaFilter | undefined, ks: number): void {
    this.filtOn = f !== undefined
    this.flt = f ?? null
    if (!f) return
    this.fphase = FP_ATTACK
    this.fCur = f.flv[0]
    this.fTarget = f.flv[1]
    this.fRate = perStep(FLV_MAX, aicaAttackTime6(aicaRate6(f.far, ks)))
    this.fd1Rate = perStep(FLV_MAX, aicaFallTime6(aicaRate6(f.fd1r, ks)))
    this.fd2Rate = perStep(FLV_MAX, aicaFallTime6(aicaRate6(f.fd2r, ks)))
    this.frRate = perStep(FLV_MAX, aicaFallTime6(aicaRate6(f.frr, ks)))
    this.fHold = false
    this.fk = 1 / aicaQFactor(f.q)
    this.fCount = 0
    this.ic1 = 0
    this.ic2 = 0
  }

  private fegRelease(): void {
    this.fphase = FP_RELEASE
    this.fTarget = this.flt!.flv[4]
    this.fRate = this.frRate
    this.fHold = false
  }

  /** Move the filter level toward the current phase's target; chain to the next phase when it is reached. */
  private fegMove(): void {
    const t = this.fTarget
    let f = this.fCur
    const r = this.fRate
    let reached = false
    if (f < t) {
      if (r > 0) {
        f += r
        if (f >= t) {
          f = t
          reached = true
        }
      }
    } else if (f > t) {
      if (r > 0) {
        f -= r
        if (f <= t) {
          f = t
          reached = true
        }
      }
    } else reached = true
    this.fCur = f
    if (!reached) return
    const flt = this.flt!
    if (this.fphase === FP_ATTACK) {
      this.fphase = FP_D1
      this.fTarget = flt.flv[2]
      this.fRate = this.fd1Rate
    } else if (this.fphase === FP_D1) {
      this.fphase = FP_D2
      this.fTarget = flt.flv[3]
      this.fRate = this.fd2Rate
    } else this.fHold = true
  }

  private filterCoefficients(): void {
    const fc = Math.min(flvToHz(this.fCur), 0.45 * AICA_DSP_RATE)
    const g = Math.tan((Math.PI * fc) / AICA_DSP_RATE)
    const a1 = 1 / (1 + g * (g + this.fk))
    this.fl1 = a1
    this.fl2 = g * a1
    this.fl3 = g * g * a1
  }

  protected override postSample(s: number): number {
    if (!this.filtOn) return s
    if (!this.fHold) this.fegMove()
    if (--this.fCount < 0) {
      this.fCount = FILTER_UPDATE - 1
      this.filterCoefficients()
    }
    // trapezoidal-integrator state-variable low-pass
    const v3 = s - this.ic2
    const v1 = this.fl1 * this.ic1 + this.fl2 * v3
    const v2 = this.ic2 + this.fl2 * this.ic1 + this.fl3 * v3
    this.ic1 = 2 * v1 - this.ic1
    this.ic2 = 2 * v2 - this.ic2
    return v2
  }
}

const dspBuses = new SharedBus((a) => new AicaDspBus(a.sampleRate, a.maxBlock))

registerVoice('dreamcast', 'sample', (a): ChipVoice => new AicaVoice(a, dspBuses.get(a)))

registerMixProfile('dreamcast', {
  outputGain: 1,
  filters: () => [],
  quantizePan: aicaQuantizePan
})

markChipPlayable('dreamcast')
