// NEC PC Engine HuC6280 PSG: six wavetable channels (32 samples x 5 bits). Channels 5 and 6 can be switched
// to the noise generator (instrument `noise: true`).
//
// Accuracy notes:
//  - Pitch is quantised to the 12-bit frequency divider: period N = round(3579545 / (32 * f)), clamped to
//    1..4095; the wave pointer advances every N chip clocks (f = clock / (32 * N)).
//  - Volume is quantised to the 5-bit channel volume (0..31) and applied linearly (the hardware uses 1.5 dB
//    steps). Pan is quantised to the 4-bit left/right levels by the mix profile (see `pceQuantizePan`).
//  - The timbre macro / Wxx picks the wave index (clamped to the instrument's wave count); the switch takes
//    effect at the next wave step and a new note restarts the wave at sample 0.
//  - Noise: 5-bit noise divider (higher index = higher pitch, period 64 * (32 - nf) clocks) driving a 15-bit
//    LFSR; the output is full-swing +-. The noise frequency comes from the note semitone & 31 (like the
//    FamiTracker-style fixed-arp noise drums). Noise is ignored on C1..C4 (the voice plays the wave).
//  - Not emulated: the LFO, DDA mode, the master volume register and the 6-bit DAC nonlinearity.

import { registerVoice, type ChipVoice, type VoiceArgs } from './types'
import { BlipVoice } from './blipVoice'
import { registerMixProfile, type Filter } from '../mixer'
import type { ChannelControl } from '../sequencer'
import type { Instrument } from '../../types'
import { GbLfsr } from '../lfsr'

export const PCE_CLOCK = 3579545

const DEFAULT_WAVE: readonly number[] = Array.from({ length: 32 }, (_, i) =>
  Math.max(0, Math.min(31, Math.round(15.5 + 15.5 * Math.sin((2 * Math.PI * i) / 32))))
)

/** Frequency divider (1..4095) for a pitch. */
export function pcePeriod(freqHz: number): number {
  const n = Math.round(PCE_CLOCK / (32 * Math.max(1, freqHz)))
  return Math.max(1, Math.min(4095, n))
}
export function pceFreq(period: number): number {
  return PCE_CLOCK / (32 * period)
}
/** 5-bit channel volume 0..31 from a 0..1 volume. */
export function pceVolume(v: number): number {
  return Math.max(0, Math.min(31, Math.round(v * 31)))
}
/** 4-bit left/right levels (0..15) for a -1..1 pan. */
export function pcePanLevels(pan: number): { l: number; r: number } {
  const p = Math.max(-1, Math.min(1, pan))
  return { l: Math.round(15 * Math.min(1, 1 - p)), r: Math.round(15 * Math.min(1, 1 + p)) }
}
/** Pan quantised to the hardware's 16 levels per side, expressed as -1..1 for the mixer. */
export function pceQuantizePan(pan: number): number {
  const { l, r } = pcePanLevels(pan)
  return l < 15 ? 1 - l / 15 : r < 15 ? -(1 - r / 15) : 0
}
/** Noise divider index 0..31 (higher = faster) from a semitone value. */
export function pceNoiseIndex(semis: number): number {
  return Math.round(semis) & 31
}

export class PceWaveVoice extends BlipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.16 / 15.5
  private readonly cpf: number
  private waves: readonly (readonly number[])[] = [DEFAULT_WAVE]
  private waveIx = 0
  private noiseMode = false
  private readonly lfsr = new GbLfsr()
  private period = 255
  private noiseClocks = 64
  private step = 0
  private next = Infinity
  private vol = 0
  private on = false

  constructor(
    sampleRate: number,
    maxBlock: number,
    private readonly canNoise: boolean
  ) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / PCE_CLOCK
  }

  private stepLen(): number {
    return (this.noiseMode ? this.noiseClocks : this.period) * this.cpf
  }

  private out(): number {
    if (!this.on || this.vol <= 0) return 0
    if (this.noiseMode) return (this.lfsr.out ? 15.5 : -15.5) * (this.vol / 31)
    const w = this.waves[this.waveIx] ?? DEFAULT_WAVE
    return ((w[this.step & 31] ?? 0) - 15.5) * (this.vol / 31)
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const pi = inst?.kind === 'pce-wave' ? inst : undefined
    if (pi && pi.waves.length > 0) this.waves = pi.waves
    this.noiseMode = this.canNoise && !!pi?.noise
    const wi = c.timbre >= 0 ? Math.round(c.timbre) : 0
    this.waveIx = Math.max(0, Math.min(this.waves.length - 1, wi))
    this.period = pcePeriod(c.freqHz)
    this.noiseClocks = 64 * (32 - pceNoiseIndex(c.semis))
    this.vol = pceVolume(c.vol)
    this.on = c.gate || c.vol > 0
    if (c.trigger) {
      this.step = 0
      if (this.noiseMode) this.lfsr.reset()
      this.next = this.pos + this.stepLen()
    } else if (this.next === Infinity) this.next = this.pos + this.stepLen()
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    while (this.next < end) {
      const t = this.next
      if (this.noiseMode) this.lfsr.clock()
      else this.step = (this.step + 1) & 31
      this.setLevel(t, this.out())
      this.next = t + this.stepLen()
    }
  }

  override reset(): void {
    super.reset()
    this.lfsr.reset()
    this.waveIx = 0
    this.noiseMode = false
    this.step = 0
    this.next = Infinity
    this.vol = 0
    this.on = false
  }
}

/** One-pole low-pass (the PCE's analogue output stage), per channel and on the master. */
class OutputLowPass implements Filter {
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

registerVoice('pce', 'pce-wave', (a: VoiceArgs): ChipVoice => new PceWaveVoice(a.sampleRate, a.maxBlock, a.channel.id === 'C5' || a.channel.id === 'C6'))
registerMixProfile('pce', {
  outputGain: 1.6,
  filters: (sr) => [new OutputLowPass(sr, Math.min(11000, sr * 0.45))],
  quantizePan: pceQuantizePan
})
