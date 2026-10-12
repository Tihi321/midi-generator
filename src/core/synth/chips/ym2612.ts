// YM2612 (OPN2) FM voice, one instance per FM channel (F1..F6), plus the Genesis mix profile.
//
// Model (aims for the right sound, not cycle accuracy):
//  - 4 operators, the 8 algorithms, OP1 self-feedback (average of its last two outputs, 0..7).
//  - Sine through a log-sin table (1024 entries) and an exponential table; attenuation is added in the log
//    domain (10-bit envelope level, 0.09375 dB per unit, plus TL << 3, plus carrier volume, plus LFO AM).
//    Operator output is +-4095, the modulation input is out >> 1 on the 10-bit phase (max +-2 cycles).
//  - 32-bit integer phase accumulators (top 10 bits = table index). The phase increment follows the chip's
//    fnum/block/detune/multiplier arithmetic and is scaled from the chip's native 53.267 kHz to the output rate.
//  - Envelope per operator: attack (exponential), decay to SL, sustain (SR), release (RR), key scaling, the real
//    rate/shift/increment tables, run at the chip's EG rate (native / 3 = 17.76 kHz) in chunks of 8 frames.
//    SSG-EG: basic repeat/alternate/hold behaviour.
//  - Global LFO (GenesisConfig.lfo 1..8 -> 3.98 .. 72.2 Hz; 0 = off): AMS depth 0/1.4/5.9/11.8 dB on operators
//    with `am`, PMS depth 0..80 cents on the pitch. The LFO setting is read when the voice is created.
//  - Output of a channel is the sum of its carriers, clipped to 14 bits. Optional 9-bit DAC "ladder" grit
//    (quantises each channel to 9 bits and opens a one-step gap at the zero crossing); on unless the chip config
//    has `dacLadder: false`.
//  - Volume: the sequencer volume (cell volume x vol macro x tremolo) becomes an attenuation added to the
//    carriers' TL: -20 log10(vol) dB, i.e. v15 = 0 dB, v8 = -5.5 dB. Pan is applied by the mixer (hard L/C/R).
//  - Key on/off from ChannelControl: trigger/gate = key on, !gate = key off. 'rel' (release) uses the operators'
//    RR; 'off' / cut (release false) uses a fast release (~7 ms) instead of an abrupt cut.
//  - Not emulated: timer/CSM, per-operator frequency mode of channel 3, exact 12-bit EG counter edge cases,
//    the "ladder" DC offset of real silicon, real LFO PM table (we use a plain triangle in cents).
//  Allocation-free in render; fully deterministic.

import { registerMixProfile, type Filter } from '../mixer'
import { registerVoice, type ChipVoice, type VoiceArgs } from './types'
import type { ChannelControl } from '../sequencer'
import type { FmInstrument, Instrument } from '../../types'

const CHUNK = 8
const MAX_ATT = 1023

// ---------------------------------------------------------------------------------------------
// Tables

/** Attenuation (1/256 log2 units) of |sin| for each of the 1024 phase steps. */
const LOGSIN = new Int16Array(1024)
for (let i = 0; i < 1024; i++) LOGSIN[i] = Math.round(-Math.log2(Math.abs(Math.sin(((i + 0.5) * 2 * Math.PI) / 1024))) * 256)
/** 4095 * 2^(-i/256). */
const EXP = new Int16Array(256)
for (let i = 0; i < 256; i++) EXP[i] = Math.round(4095 * Math.pow(2, -i / 256))

// Envelope increments: 19 rows of 8 steps (rates are 0..63; row = rate class, step = EG counter phase).
// prettier-ignore
const EG_INC = new Int8Array([
  0, 1, 0, 1, 0, 1, 0, 1,   0, 1, 0, 1, 1, 1, 0, 1,   0, 1, 1, 1, 0, 1, 1, 1,   0, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1,   1, 1, 1, 2, 1, 1, 1, 2,   1, 2, 1, 2, 1, 2, 1, 2,   1, 2, 2, 2, 1, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2,   2, 2, 2, 4, 2, 2, 2, 4,   2, 4, 2, 4, 2, 4, 2, 4,   2, 4, 4, 4, 2, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4,   4, 4, 4, 8, 4, 4, 4, 8,   4, 8, 4, 8, 4, 8, 4, 8,   4, 8, 8, 8, 4, 8, 8, 8,
  8, 8, 8, 8, 8, 8, 8, 8
])
const EG_SHIFT = new Uint8Array(64)
const EG_SEL = new Uint8Array(64)
for (let r = 0; r < 64; r++) {
  const g = r >> 2
  EG_SHIFT[r] = g >= 11 ? 0 : 11 - g
  EG_SEL[r] = g < 12 ? r & 3 : g === 15 ? 16 : 4 * (g - 11) + (r & 3)
}

/** Detune deltas (phase-increment units) for DT 1..3 by key code 0..31. */
// prettier-ignore
const DT_TAB = new Uint8Array([
  0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 8, 8,
  1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 16, 16, 16,
  2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 20, 22, 22, 22, 22
])

/** Carrier operators per algorithm as a bit mask over OP1..OP4 (bit i = OPi+1). */
const CARRIER_MASK = [8, 8, 8, 8, 10, 14, 14, 15]

const LFO_HZ = [0, 3.98, 5.56, 6.02, 6.37, 6.88, 9.63, 48.1, 72.2]
const AMS_UNITS = [0, 15, 63, 126]
const PMS_CENTS = [0, 3.4, 6.7, 10, 14, 20, 40, 80]
const CENTS_TO_K = Math.log(2) / 1200

export const YM_CLOCK_NTSC = 7670454
export const YM_CLOCK_PAL = 7600489

/** fnum / block / key code the chip would use for a frequency. */
export function fmFnumBlock(freqHz: number, fs: number): { fnum: number; block: number; kc: number } {
  const x = (freqHz * 2097152) / fs
  let block = 0
  let fnum = Math.round(x)
  while (fnum > 2047 && block < 7) {
    block++
    fnum = Math.round(x / (1 << block))
  }
  fnum = fnum < 1 ? 1 : fnum > 2047 ? 2047 : fnum
  const f11 = (fnum >> 10) & 1
  const n3 = f11 ? ((fnum >> 9) | (fnum >> 8) | (fnum >> 7)) & 1 : (fnum >> 9) & (fnum >> 8) & (fnum >> 7) & 1
  return { fnum, block, kc: (block << 2) | (f11 << 1) | n3 }
}

/** The envelope rate (0..63) for a 5-bit rate and key scaling. */
function egRate(r: number, ksr: number): number {
  if (r === 0) return 0
  const v = 2 * r + ksr
  return v > 63 ? 63 : v
}

const ST_OFF = 0
const ST_ATT = 1
const ST_DEC = 2
const ST_SUS = 3
const ST_REL = 4

/** Signed operator output (+-4095) for a phase word (top 10 bits), a modulation offset and a total attenuation << 2. */
function opOut(phase: number, mod: number, att: number): number {
  const idx = ((phase >>> 22) + mod) & 1023
  const x = LOGSIN[idx]! + att
  const v = EXP[x & 255]! >> (x >> 8)
  return idx & 512 ? -v : v
}

export class Ym2612Voice implements ChipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.2 / 4095

  private readonly fs: number
  private readonly sr: number
  private readonly egPerChunk: number
  private readonly lfoPerChunk: number
  private readonly lfoOn: boolean
  private readonly ladder: boolean

  // patch (copied from the instrument at every control())
  private alg = 0
  private fbShift = 0
  private ams = 0
  private pms = 0
  private patchReady = false
  private readonly tl = new Int32Array(4)
  private readonly slThr = new Int32Array(4)
  private readonly ssg = new Int32Array(4)
  private readonly amOn = new Uint8Array(4)
  private readonly rr5 = new Int32Array(4)
  private readonly ks = new Int32Array(4)
  private readonly ar5 = new Int32Array(4)
  private readonly dr5 = new Int32Array(4)
  private readonly sr5 = new Int32Array(4)
  private readonly ml = new Int32Array(4)
  private readonly dt = new Int32Array(4)

  // derived per control()
  private readonly rateAr = new Int32Array(4)
  private readonly rateDr = new Int32Array(4)
  private readonly rateSr = new Int32Array(4)
  private readonly rateRr = new Int32Array(4)
  private readonly stepBase = new Float64Array(4)
  private carrierMask = 8
  private volAtt = 0
  private fastRel = false

  // running state
  private readonly env = new Int32Array(4).fill(MAX_ATT)
  private readonly state = new Uint8Array(4)
  private readonly inv = new Uint8Array(4)
  private readonly phase = new Int32Array(4)
  private readonly step = new Float64Array(4)
  private readonly attX4 = new Int32Array(4).fill(MAX_ATT << 2)
  private o1a = 0
  private o1b = 0
  private keyed = false
  private egCnt = 1
  private egAcc = 0
  private lfoPhase = 0
  private chunkLeft = 0
  private idle = true

  constructor(sampleRate: number, args: { clock: number; lfo: number; ladder: boolean }) {
    this.sr = sampleRate
    this.fs = args.clock / 144
    this.egPerChunk = (CHUNK * (this.fs / 3)) / sampleRate
    const lfoHz = LFO_HZ[args.lfo] ?? 0
    this.lfoOn = args.lfo > 0 && lfoHz > 0
    this.lfoPerChunk = (CHUNK * lfoHz) / sampleRate
    this.ladder = args.ladder
  }

  // -------------------------------------------------------------------------------------------
  // control

  private loadPatch(p: FmInstrument): void {
    this.alg = p.alg & 7
    this.fbShift = p.fb > 0 ? 9 - (p.fb & 7) : 0
    this.ams = p.ams & 3
    this.pms = p.pms & 7
    this.carrierMask = CARRIER_MASK[this.alg]!
    for (let i = 0; i < 4; i++) {
      const o = p.ops[i]!
      this.tl[i] = o.tl & 127
      const sl = o.sl & 15
      this.slThr[i] = (sl === 15 ? 31 : sl) * 32
      this.ssg[i] = (o.ssg ?? 0) & 15
      this.amOn[i] = o.am ? 1 : 0
      this.rr5[i] = o.rr & 15
      this.ks[i] = o.ks & 3
      this.ar5[i] = o.ar & 31
      this.dr5[i] = o.dr & 31
      this.sr5[i] = o.sr & 31
      this.ml[i] = o.ml & 15
      this.dt[i] = o.dt < -3 ? -3 : o.dt > 3 ? 3 : o.dt | 0
    }
    this.patchReady = true
  }

  private setFreq(freqHz: number): void {
    const f = fmFnumBlock(freqHz, this.fs)
    const base = (f.fnum << f.block) / 2
    const k = (4096 * this.fs) / this.sr
    for (let i = 0; i < 4; i++) {
      const ksr = f.kc >> (3 - this.ks[i]!)
      this.rateAr[i] = egRate(this.ar5[i]!, ksr)
      this.rateDr[i] = egRate(this.dr5[i]!, ksr)
      this.rateSr[i] = egRate(this.sr5[i]!, ksr)
      const rr = this.fastRel ? 63 : Math.min(63, 4 * this.rr5[i]! + 2 + ksr)
      this.rateRr[i] = rr
      const d = this.dt[i]!
      let fc = base
      if (d !== 0) {
        const delta = DT_TAB[(Math.abs(d) - 1) * 32 + f.kc]!
        fc = d > 0 ? base + delta : Math.max(0, base - delta)
      }
      const m = this.ml[i]!
      this.stepBase[i] = (fc * (m === 0 ? 0.5 : m) * k)
    }
  }

  private keyOn(): void {
    for (let i = 0; i < 4; i++) {
      if (this.env[i]! >= 768) this.phase[i] = 0
      this.state[i] = ST_ATT
      this.inv[i] = 0
    }
    this.o1a = 0
    this.o1b = 0
    this.keyed = true
  }

  private keyOff(): void {
    for (let i = 0; i < 4; i++) if (this.state[i] !== ST_OFF) this.state[i] = ST_REL
    this.keyed = false
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    if (!inst || inst.kind !== 'fm') {
      if (this.keyed) {
        this.fastRel = true
        this.keyOff()
      }
      return
    }
    this.loadPatch(inst)
    if (c.gate || c.vol > 0) {
      const v = c.vol
      this.volAtt = v >= 1 ? 0 : v <= 0 ? MAX_ATT : Math.min(MAX_ATT, Math.round((-20 * Math.log10(v)) / 0.09375))
    }
    if (c.trigger || (c.gate && !this.keyed)) this.fastRel = false
    else if (!c.gate && this.keyed) this.fastRel = !c.release
    this.setFreq(c.freqHz)
    if (c.trigger || (c.gate && !this.keyed)) this.keyOn()
    else if (!c.gate && this.keyed) this.keyOff()
  }

  // -------------------------------------------------------------------------------------------
  // envelope / LFO update (every CHUNK frames)

  private egInc(rate: number): number {
    if (rate === 0) return 0
    const sh = EG_SHIFT[rate]!
    const cnt = this.egCnt
    if (cnt & ((1 << sh) - 1)) return 0
    return EG_INC[EG_SEL[rate]! * 8 + ((cnt >> sh) & 7)]!
  }

  private egStep(): void {
    for (let i = 0; i < 4; i++) {
      const st = this.state[i]!
      if (st === ST_OFF) continue
      let e = this.env[i]!
      switch (st) {
        case ST_ATT: {
          const r = this.rateAr[i]!
          if (r >= 62) e = 0
          else {
            const inc = this.egInc(r)
            if (inc) e += ((~e) * inc) >> 4
          }
          if (e <= 0) {
            e = 0
            this.state[i] = ST_DEC
          }
          break
        }
        case ST_DEC:
          e += this.egInc(this.rateDr[i]!)
          if (e >= this.slThr[i]!) this.state[i] = ST_SUS
          break
        case ST_SUS:
          e += this.egInc(this.rateSr[i]!)
          break
        default:
          e += this.egInc(this.rateRr[i]!)
      }
      const ssg = this.ssg[i]!
      if (ssg & 8 && st !== ST_REL && e >= 512) {
        if (ssg & 1) {
          if (this.inv[i] === 0 && ssg & 2) this.inv[i] = 1
          e = 512
        } else {
          if (ssg & 2) this.inv[i] = this.inv[i]! ^ 1
          else this.phase[i] = 0
          e = 0
          if (this.state[i] !== ST_ATT) this.state[i] = ST_ATT
        }
      }
      if (e >= MAX_ATT) {
        e = MAX_ATT
        if (this.state[i] === ST_REL || this.state[i] === ST_SUS) this.state[i] = ST_OFF
      }
      this.env[i] = e
    }
  }

  private update(): void {
    this.egAcc += this.egPerChunk
    while (this.egAcc >= 1) {
      this.egAcc -= 1
      this.egCnt = (this.egCnt + 1) & 0xfff
      if (this.egCnt === 0) this.egCnt = 1
      this.egStep()
    }
    let pmMul = 1
    let amAtt = 0
    if (this.lfoOn) {
      this.lfoPhase += this.lfoPerChunk
      if (this.lfoPhase >= 1) this.lfoPhase -= 1
      const p = this.lfoPhase
      const tri = p < 0.5 ? 4 * p - 1 : 3 - 4 * p
      pmMul = 1 + PMS_CENTS[this.pms]! * tri * CENTS_TO_K
      amAtt = Math.round(AMS_UNITS[this.ams]! * (tri + 1) * 0.5)
    }
    let silent = true
    for (let i = 0; i < 4; i++) {
      const carrier = (this.carrierMask >> i) & 1
      let a = this.env[i]!
      const ssg = this.ssg[i]!
      if (ssg & 8 && this.state[i] !== ST_REL && this.state[i] !== ST_OFF) {
        const inverted = (this.inv[i]! ^ ((ssg >> 2) & 1)) !== 0
        if (inverted) a = (512 - a) & MAX_ATT
      }
      a += this.tl[i]! << 3
      if (carrier) a += this.volAtt
      if (this.amOn[i]) a += amAtt
      if (a > MAX_ATT) a = MAX_ATT
      this.attX4[i] = a << 2
      if (carrier && a < MAX_ATT) silent = false
      this.step[i] = this.stepBase[i]! * pmMul
    }
    this.idle = silent
  }

  // -------------------------------------------------------------------------------------------
  // rendering

  render(buf: Float32Array, from: number, to: number): void {
    let i = from
    while (i < to) {
      if (this.chunkLeft === 0) {
        this.update()
        this.chunkLeft = CHUNK
      }
      const n = Math.min(to - i, this.chunkLeft)
      this.chunkLeft -= n
      if (this.idle || !this.patchReady) buf.fill(0, i, i + n)
      else this.gen(buf, i, n)
      i += n
    }
  }

  private gen(buf: Float32Array, off: number, n: number): void {
    let p0 = this.phase[0]!
    let p1 = this.phase[1]!
    let p2 = this.phase[2]!
    let p3 = this.phase[3]!
    const s0 = this.step[0]!
    const s1 = this.step[1]!
    const s2 = this.step[2]!
    const s3 = this.step[3]!
    const a0 = this.attX4[0]!
    const a1 = this.attX4[1]!
    const a2 = this.attX4[2]!
    const a3 = this.attX4[3]!
    const fb = this.fbShift
    const alg = this.alg
    const ladder = this.ladder
    let o1a = this.o1a
    let o1b = this.o1b
    for (let k = 0; k < n; k++) {
      const o1 = opOut(p0, fb ? (o1a + o1b) >> fb : 0, a0)
      o1b = o1a
      o1a = o1
      let out: number
      switch (alg) {
        case 0:
          out = opOut(p3, opOut(p2, opOut(p1, o1 >> 1, a1) >> 1, a2) >> 1, a3)
          break
        case 1:
          out = opOut(p3, opOut(p2, (o1 + opOut(p1, 0, a1)) >> 1, a2) >> 1, a3)
          break
        case 2:
          out = opOut(p3, (o1 + opOut(p2, opOut(p1, 0, a1) >> 1, a2)) >> 1, a3)
          break
        case 3:
          out = opOut(p3, (opOut(p1, o1 >> 1, a1) + opOut(p2, 0, a2)) >> 1, a3)
          break
        case 4:
          out = opOut(p1, o1 >> 1, a1) + opOut(p3, opOut(p2, 0, a2) >> 1, a3)
          break
        case 5: {
          const m = o1 >> 1
          out = opOut(p1, m, a1) + opOut(p2, m, a2) + opOut(p3, m, a3)
          break
        }
        case 6:
          out = opOut(p1, o1 >> 1, a1) + opOut(p2, 0, a2) + opOut(p3, 0, a3)
          break
        default:
          out = o1 + opOut(p1, 0, a1) + opOut(p2, 0, a2) + opOut(p3, 0, a3)
      }
      p0 = (p0 + s0) | 0
      p1 = (p1 + s1) | 0
      p2 = (p2 + s2) | 0
      p3 = (p3 + s3) | 0
      if (out > 8191) out = 8191
      else if (out < -8192) out = -8192
      if (ladder) {
        const q = (out / 32) | 0
        out = (q > 0 ? q + 1 : q < 0 ? q - 1 : 0) * 32
      }
      buf[off + k] = out
    }
    this.phase[0] = p0
    this.phase[1] = p1
    this.phase[2] = p2
    this.phase[3] = p3
    this.o1a = o1a
    this.o1b = o1b
  }

  reset(): void {
    this.env.fill(MAX_ATT)
    this.state.fill(ST_OFF)
    this.inv.fill(0)
    this.phase.fill(0)
    this.step.fill(0)
    this.attX4.fill(MAX_ATT << 2)
    this.o1a = 0
    this.o1b = 0
    this.keyed = false
    this.egCnt = 1
    this.egAcc = 0
    this.lfoPhase = 0
    this.chunkLeft = 0
    this.idle = true
    this.volAtt = 0
    this.fastRel = false
    this.patchReady = false
  }
}

registerVoice('genesis', 'fm', (a: VoiceArgs): ChipVoice => {
  const cfg = a.song.chipConfig
  const g = cfg.chip === 'genesis' ? cfg : null
  return new Ym2612Voice(a.sampleRate, {
    clock: g?.region === 'pal' ? YM_CLOCK_PAL : YM_CLOCK_NTSC,
    lfo: g?.lfo ?? 0,
    ladder: (cfg as { dacLadder?: boolean }).dacLadder !== false
  })
})

// ---------------------------------------------------------------------------------------------
// Genesis mix profile: stereo with hard L/C/R pan and a light output low-pass.

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

registerMixProfile('genesis', {
  outputGain: 1,
  filters: (sr) => [new LowPass(sr, Math.min(14000, sr * 0.45))],
  quantizePan: (p) => (p < -0.33 ? -1 : p > 0.33 ? 1 : 0)
})
