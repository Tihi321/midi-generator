// NES 2A03 voices: two pulse channels, the triangle and the noise channel (DPCM = Phase 4, silent for now).
// Outputs are the raw 0..15 DAC values; the mixer applies the nonlinear (or linear) mix model.
// Accuracy notes: pulse/triangle pitch is quantised to the 11-bit timer period, pulse periods < 8 are muted,
// triangle has no volume control (any non-zero volume = on; it freezes in place when silent), noise uses the
// 16-entry period table and the 15-bit / 93-step LFSR. The hardware sweep unit, length counters and the
// frame-sequencer envelope are not emulated (volume comes from the sequencer macros).

import { registerVoice, type ChipVoice, type VoiceArgs } from './types'
import { BlipVoice } from './blipVoice'
import type { ChannelControl } from '../sequencer'
import type { Instrument } from '../../types'
import { NesLfsr } from '../lfsr'
import {
  NES_DUTY,
  NES_NOISE_PERIODS_NTSC,
  NES_NOISE_PERIODS_PAL,
  NES_TRI_SEQ,
  nesCpuHz,
  nesPulsePeriod,
  nesTriPeriod,
  noisePeriodIndex
} from '../tables'

function cpuOf(song: VoiceArgs['song']): number {
  return nesCpuHz(song.chipConfig.chip === 'nes' ? song.chipConfig.region : 'ntsc')
}

export class NesPulseVoice extends BlipVoice {
  readonly mixGroup = 'pulse' as const
  readonly linearGain = 0.00752
  private readonly cpf: number
  private duty = 2
  private step = 0
  private period = 0
  private next = Infinity
  private amp = 0

  constructor(sampleRate: number, maxBlock: number, cpuHz: number) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / cpuHz
    this.cpuHz = cpuHz
  }
  private readonly cpuHz: number

  private out(): number {
    return this.period >= 8 && NES_DUTY[this.duty]![this.step]! ? this.amp : 0
  }
  private stepLen(): number {
    return (this.period + 1) * 2 * this.cpf
  }

  control(c: ChannelControl, _inst: Instrument | undefined): void {
    this.duty = c.timbre >= 0 ? c.timbre & 3 : 2
    this.period = nesPulsePeriod(c.freqHz, this.cpuHz)
    this.amp = c.vol > 0 ? Math.round(c.vol * 15) : 0
    if (c.trigger || this.next === Infinity) {
      this.step = 0
      this.next = this.pos + this.stepLen()
    }
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    while (this.next < end) {
      const t = this.next
      this.step = (this.step + 1) & 7
      this.setLevel(t, this.out())
      this.next = t + this.stepLen()
    }
  }

  override reset(): void {
    super.reset()
    this.duty = 2
    this.step = 0
    this.period = 0
    this.next = Infinity
    this.amp = 0
  }
}

export class NesTriangleVoice extends BlipVoice {
  readonly mixGroup = 'tri' as const
  readonly linearGain = 0.00851
  private readonly cpf: number
  private readonly cpuHz: number
  private step = 0
  private period = 0
  private next = Infinity
  private on = false

  constructor(sampleRate: number, maxBlock: number, cpuHz: number) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / cpuHz
    this.cpuHz = cpuHz
  }

  control(c: ChannelControl, _inst: Instrument | undefined): void {
    this.period = nesTriPeriod(c.freqHz, this.cpuHz)
    this.on = c.vol > 0
    if (this.next === Infinity) this.next = this.pos + (this.period + 1) * this.cpf
  }

  protected run(end: number): void {
    while (this.next < end) {
      const t = this.next
      if (this.on && this.period >= 2) {
        this.step = (this.step + 1) & 31
        this.setLevel(t, NES_TRI_SEQ[this.step]!)
      }
      this.next = t + (this.period + 1) * this.cpf
    }
  }

  override reset(): void {
    super.reset()
    this.step = 0
    this.period = 0
    this.next = Infinity
    this.on = false
  }
}

export class NesNoiseVoice extends BlipVoice {
  readonly mixGroup = 'noise' as const
  readonly linearGain = 0.00494
  private readonly cpf: number
  private readonly periods: readonly number[]
  private readonly lfsr = new NesLfsr()
  private period = 4
  private next = Infinity
  private amp = 0

  constructor(sampleRate: number, maxBlock: number, region: 'ntsc' | 'pal', cpuHz: number) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / cpuHz
    this.periods = region === 'pal' ? NES_NOISE_PERIODS_PAL : NES_NOISE_PERIODS_NTSC
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    this.period = this.periods[noisePeriodIndex(c.semis)]!
    const short = c.timbre >= 0 ? c.timbre >= 1 : inst?.kind === 'nes-noise' && inst.noiseMode === 'periodic'
    this.lfsr.short = short
    this.amp = c.vol > 0 ? Math.round(c.vol * 15) : 0
    if (this.next === Infinity) this.next = this.pos + this.period * this.cpf
    this.setLevel(this.pos, this.lfsr.out * this.amp)
  }

  protected run(end: number): void {
    while (this.next < end) {
      const t = this.next
      this.lfsr.clock()
      this.setLevel(t, this.lfsr.out * this.amp)
      this.next = t + this.period * this.cpf
    }
  }

  override reset(): void {
    super.reset()
    this.lfsr.reset()
    this.lfsr.short = false
    this.next = Infinity
    this.amp = 0
    this.period = 4
  }
}

registerVoice('nes', 'pulse', (a): ChipVoice => new NesPulseVoice(a.sampleRate, a.maxBlock, cpuOf(a.song)))
registerVoice('nes', 'triangle', (a): ChipVoice => new NesTriangleVoice(a.sampleRate, a.maxBlock, cpuOf(a.song)))
registerVoice('nes', 'noise', (a): ChipVoice => {
  const region = a.song.chipConfig.chip === 'nes' ? a.song.chipConfig.region : 'ntsc'
  return new NesNoiseVoice(a.sampleRate, a.maxBlock, region, cpuOf(a.song))
})
// TODO(Phase 4): registerVoice('nes', 'dpcm', ...) (sample playback).
