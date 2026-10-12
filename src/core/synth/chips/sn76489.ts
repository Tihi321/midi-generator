// SN76489 PSG (Sega Genesis / Master System flavour): three square tone channels (S1..S3) and one noise channel (NO).
//
// Tone: 10-bit divider N (1..1023). The output flips every N * 16 master clocks, so f = clock / (32 N) with
// clock 3579545 Hz (NTSC) / 3546893 Hz (PAL); the lowest note is N = 1023 = 109.4 Hz (just below A-2 = 110 Hz).
// N = 1 holds the output high (the chip's "sample playback" trick), and a note too low for the divider is clamped
// to 109 Hz. A divider change takes effect at the next flip, like the real down-counter.
// Volume: 4-bit attenuation in 2 dB steps (0 = full, 15 = off). The sequencer's linear volume (cell volume x
// vol macro x tremolo, 0..1) is rounded to the nearest 2 dB step, so v15 = 0 dB, v12 = -2 dB, v8 = -6 dB ...
//
// Noise: one 16-bit LFSR (src/core/synth/lfsr.ts, Sega taps) clocked at one of three fixed rates
// (clock / 512, / 1024, / 2048 = 6991, 3496, 1748 Hz) or, in "tone 3" mode, at a rate that follows a pitch.
// The register is reset to 0x8000 on every note trigger, so each drum hit is identical (as with a Genesis
// sound driver that rewrites the noise register).
// Mapping from the NO note (documented in the LLM guide):
//   note >= 48 (C-3 and up): rate = note mod 3  ->  0 (C-4, D#4, F#4 ...) 6991 Hz (bright hat),
//                                                   1 (C#4, E-4 ...) 3496 Hz (snare), 2 (D-4, F-4 ...) 1748 Hz (dull).
//   note <  48 (below C-3):  pitched mode, the register is clocked at 16 x the note frequency so PERIODIC noise
//                            (16-step cycle) sounds at exactly the note's pitch; white noise is a rumble.
// Mode: white unless timbre/Wxx = 1 (periodic) or the instrument says noiseMode 'periodic'.
// Both voices output a zero-centred signal (+-amplitude) through the band-limited BlipVoice.

import { registerVoice, type ChipVoice, type VoiceArgs } from './types'
import { BlipVoice } from './blipVoice'
import type { ChannelControl } from '../sequencer'
import type { Instrument } from '../../types'
import { Sn76489Lfsr } from '../lfsr'

export const SN_CLOCK_NTSC = 3579545
export const SN_CLOCK_PAL = 3546893

/** Linear amplitude of attenuation step 0..15 (2 dB per step, 15 = off). */
export const SN_AMP: readonly number[] = Array.from({ length: 16 }, (_, n) => (n >= 15 ? 0 : Math.pow(10, (-2 * n) / 20)))

/** Attenuation step (0..15) the PSG uses for a linear volume 0..1 (15 = silent). */
export function psgAttenuation(vol: number): number {
  if (!(vol > 0)) return 15
  const n = Math.round(-10 * Math.log10(vol))
  return n > 15 ? 15 : n < 0 ? 0 : n
}

/** 10-bit divider for a frequency (clamped to the register range). */
export function psgDivider(freqHz: number, clock: number): number {
  const n = Math.round(clock / (32 * freqHz))
  return n < 1 ? 1 : n > 1023 ? 1023 : n
}

/** Frequency a divider produces. */
export function psgFreq(divider: number, clock: number): number {
  return clock / (32 * divider)
}

/** Noise clock rate (LFSR shifts per second) the NO channel uses for a note, see the header comment. */
export function psgNoiseRate(note: number, clock: number): number {
  const n = Math.round(note)
  if (n >= 48) return clock / (512 << (n % 3))
  const f = 440 * Math.pow(2, (n - 69) / 12)
  return Math.min(clock / 32, 16 * f)
}

function clockOf(song: VoiceArgs['song']): number {
  return song.chipConfig.chip === 'genesis' && song.chipConfig.region === 'pal' ? SN_CLOCK_PAL : SN_CLOCK_NTSC
}

export class PsgSquareVoice extends BlipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.07
  private readonly clock: number
  private div = 1023
  private amp = 0
  private high = true
  private next = Infinity

  constructor(sampleRate: number, maxBlock: number, clock: number) {
    super(sampleRate, maxBlock)
    this.clock = clock
  }

  private half(): number {
    return (this.div * 16 * this.sampleRate) / this.clock
  }
  private out(): number {
    return this.high ? this.amp : -this.amp
  }

  control(c: ChannelControl, _inst: Instrument | undefined): void {
    this.div = psgDivider(c.freqHz, this.clock)
    this.amp = SN_AMP[psgAttenuation(c.vol)]!
    if (c.trigger || this.next === Infinity) {
      this.high = true
      this.next = this.pos + this.half()
    }
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    if (this.div <= 1) {
      // N = 1: the output stays high, no toggling
      this.high = true
      this.setLevel(this.pos, this.out())
      while (this.next < end) this.next += this.half()
      return
    }
    while (this.next < end) {
      const t = this.next
      this.high = !this.high
      this.setLevel(t, this.out())
      this.next = t + this.half()
    }
  }

  override reset(): void {
    super.reset()
    this.div = 1023
    this.amp = 0
    this.high = true
    this.next = Infinity
  }
}

export class PsgNoiseVoice extends BlipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.05
  private readonly clock: number
  private readonly lfsr = new Sn76489Lfsr()
  private step = 1000
  private amp = 0
  private next = Infinity

  constructor(sampleRate: number, maxBlock: number, clock: number) {
    super(sampleRate, maxBlock)
    this.clock = clock
  }

  private out(): number {
    return this.lfsr.out ? this.amp : -this.amp
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const periodic = c.timbre >= 0 ? c.timbre >= 1 : inst?.kind === 'psg-noise' && inst.noiseMode === 'periodic'
    const rate = psgNoiseRate(c.semis, this.clock)
    this.step = Math.max(0.3, this.sampleRate / rate)
    this.amp = SN_AMP[psgAttenuation(c.vol)]!
    if (c.trigger) this.lfsr.reset()
    this.lfsr.white = !periodic
    if (c.trigger || this.next === Infinity) this.next = this.pos + this.step
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    while (this.next < end) {
      const t = this.next
      this.lfsr.clock()
      this.setLevel(t, this.out())
      this.next = t + this.step
    }
  }

  override reset(): void {
    super.reset()
    this.lfsr.reset()
    this.lfsr.white = true
    this.step = 1000
    this.amp = 0
    this.next = Infinity
  }
}

registerVoice('genesis', 'psg-square', (a): ChipVoice => new PsgSquareVoice(a.sampleRate, a.maxBlock, clockOf(a.song)))
registerVoice('genesis', 'psg-noise', (a): ChipVoice => new PsgNoiseVoice(a.sampleRate, a.maxBlock, clockOf(a.song)))
