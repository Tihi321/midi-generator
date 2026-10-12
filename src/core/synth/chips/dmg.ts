// Game Boy DMG voices: pulse (duty, hardware volume envelope, optional frequency sweep), the 32 x 4-bit
// wave channel (4 output levels) and the LFSR noise channel (15-bit / 7-bit) with envelope.
// Outputs are raw 0..15 DAC values. Accuracy notes: periods are quantised to the 11-bit registers, the
// envelope runs at 64 Hz steps (pace/64 s) and the sweep at 128 Hz (pace/128 s); length counters, the
// wave-RAM first-sample quirk and zombie-mode volume writes are not emulated.

import { registerVoice, type ChipVoice } from './types'
import { BlipVoice } from './blipVoice'
import type { ChannelControl } from '../sequencer'
import type { GbEnvelope, Instrument } from '../../types'
import { GbLfsr } from '../lfsr'
import { GB_CLOCK, GB_DUTY, GB_NOISE_CLOCKS, gbPulsePeriod, gbWavePeriod, noisePeriodIndex } from '../tables'

class Envelope {
  level = 0
  dir = 1
  /** Absolute frame of the next envelope step (Infinity = off). */
  next = Infinity
  interval = 0

  start(env: GbEnvelope | undefined, now: number, sampleRate: number): void {
    const e = env ?? { init: 15, dir: 'down' as const, pace: 0 }
    this.level = Math.max(0, Math.min(15, Math.round(e.init)))
    this.dir = e.dir === 'up' ? 1 : -1
    this.interval = (Math.max(0, Math.min(7, Math.round(e.pace))) * sampleRate) / 64
    this.next = this.interval > 0 ? now + this.interval : Infinity
  }

  /** Perform one envelope step (call when `next` is due). */
  step(): void {
    const nl = this.level + this.dir
    if (nl < 0 || nl > 15) {
      this.next = Infinity
      return
    }
    this.level = nl
    this.next += this.interval
  }
}

export class GbPulseVoice extends BlipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.25 / 15
  private readonly cpf: number
  private readonly env = new Envelope()
  private duty = 2
  private x = 0
  private step = 0
  private next = Infinity
  private vol = 0
  private enabled = false
  private sweepPace = 0
  private sweepStep = 0
  private sweepUp = true
  private sweepNext = Infinity
  private sweepInterval = 0
  private envSpec: GbEnvelope | undefined

  constructor(sampleRate: number, maxBlock: number) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / GB_CLOCK
  }

  private stepLen(): number {
    return (2048 - this.x) * 4 * this.cpf
  }
  private out(): number {
    return this.enabled && GB_DUTY[this.duty]![this.step]! ? this.env.level * this.vol : 0
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const gp = inst?.kind === 'gb-pulse' ? inst : undefined
    this.duty = c.timbre >= 0 ? c.timbre & 3 : (gp?.duty ?? 2)
    this.vol = c.vol
    const sweeping = this.sweepPace > 0 && this.sweepStep > 0 && this.enabled
    if (c.trigger) {
      this.envSpec = gp?.env
      this.x = gbPulsePeriod(c.freqHz)
      this.step = 0
      this.next = this.pos + this.stepLen()
      this.env.start(this.envSpec, this.pos, this.sampleRate)
      this.enabled = true
      this.sweepPace = gp?.sweep ? Math.max(0, Math.min(7, Math.round(gp.sweep.pace))) : 0
      this.sweepStep = gp?.sweep ? Math.max(0, Math.min(7, Math.round(gp.sweep.step))) : 0
      this.sweepUp = gp?.sweep ? gp.sweep.dir === 'up' : true
      this.sweepInterval = (this.sweepPace * this.sampleRate) / 128
      this.sweepNext = this.sweepPace > 0 && this.sweepStep > 0 ? this.pos + this.sweepInterval : Infinity
    } else if (!sweeping) {
      this.x = gbPulsePeriod(c.freqHz)
    }
    if (this.next === Infinity) this.next = this.pos + this.stepLen()
    if (!c.gate && c.vol <= 0) this.vol = 0
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    for (;;) {
      const t = Math.min(this.next, this.env.next, this.sweepNext)
      if (!(t < end)) break
      if (t === this.next) {
        this.step = (this.step + 1) & 7
        this.next = t + this.stepLen()
      }
      if (t === this.env.next) this.env.step()
      if (t === this.sweepNext) {
        const delta = this.x >> this.sweepStep
        const nx = this.sweepUp ? this.x + delta : this.x - delta
        if (nx > 2047) {
          this.enabled = false
          this.sweepNext = Infinity
        } else {
          this.x = Math.max(0, nx)
          this.sweepNext = t + this.sweepInterval
        }
      }
      this.setLevel(t, this.out())
    }
  }

  override reset(): void {
    super.reset()
    this.duty = 2
    this.x = 0
    this.step = 0
    this.next = Infinity
    this.vol = 0
    this.enabled = false
    this.sweepNext = Infinity
    this.sweepPace = 0
    this.sweepStep = 0
    this.env.next = Infinity
    this.env.level = 0
  }
}

export class GbWaveVoice extends BlipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.25 / 15
  private readonly cpf: number
  private wave: readonly number[] = new Array<number>(32).fill(0)
  private x = 0
  private step = 0
  private next = Infinity
  private shift = 0
  private on = false

  constructor(sampleRate: number, maxBlock: number) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / GB_CLOCK
  }

  private out(): number {
    return this.on ? (this.wave[this.step]! & 15) >> this.shift : 0
  }
  private stepLen(): number {
    return (2048 - this.x) * 2 * this.cpf
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const gw = inst?.kind === 'gb-wave' ? inst : undefined
    if (gw && gw.wave.length === 32) this.wave = gw.wave
    this.x = gbWavePeriod(c.freqHz)
    // hardware output levels: 100% / 50% / 25% / mute; the quieter of the instrument level and the volume wins
    const instShift = gw ? [-1, 0, 1, 2][gw.level]! : 0
    const v = c.vol
    const volShift = v > 0.75 ? 0 : v > 0.375 ? 1 : v > 0.1 ? 2 : -1
    this.on = instShift >= 0 && volShift >= 0 && (c.gate || c.vol > 0)
    this.shift = Math.max(instShift, volShift)
    if (c.trigger || this.next === Infinity) {
      if (c.trigger) this.step = 0
      this.next = this.pos + this.stepLen()
    }
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    while (this.next < end) {
      const t = this.next
      this.step = (this.step + 1) & 31
      this.setLevel(t, this.out())
      this.next = t + this.stepLen()
    }
  }

  override reset(): void {
    super.reset()
    this.x = 0
    this.step = 0
    this.next = Infinity
    this.on = false
    this.shift = 0
  }
}

export class GbNoiseVoice extends BlipVoice {
  readonly mixGroup = 'direct' as const
  readonly linearGain = 0.25 / 15
  private readonly cpf: number
  private readonly env = new Envelope()
  private readonly lfsr = new GbLfsr()
  private clocks = GB_NOISE_CLOCKS[0]!
  private next = Infinity
  private vol = 0
  private enabled = false

  constructor(sampleRate: number, maxBlock: number) {
    super(sampleRate, maxBlock)
    this.cpf = sampleRate / GB_CLOCK
  }

  private out(): number {
    return this.enabled ? this.lfsr.out * this.env.level * this.vol : 0
  }

  control(c: ChannelControl, inst: Instrument | undefined): void {
    const gn = inst?.kind === 'gb-noise' ? inst : undefined
    this.clocks = GB_NOISE_CLOCKS[noisePeriodIndex(c.semis)]!
    this.lfsr.width7 = c.timbre >= 0 ? c.timbre >= 1 : !!gn?.short
    this.vol = c.vol
    if (c.trigger) {
      this.lfsr.reset()
      this.env.start(gn?.env, this.pos, this.sampleRate)
      this.enabled = true
      this.next = this.pos + this.clocks * this.cpf
    } else if (this.next === Infinity) this.next = this.pos + this.clocks * this.cpf
    this.setLevel(this.pos, this.out())
  }

  protected run(end: number): void {
    for (;;) {
      const t = Math.min(this.next, this.env.next)
      if (!(t < end)) break
      if (t === this.next) {
        this.lfsr.clock()
        this.next = t + this.clocks * this.cpf
      }
      if (t === this.env.next) this.env.step()
      this.setLevel(t, this.out())
    }
  }

  override reset(): void {
    super.reset()
    this.lfsr.reset()
    this.lfsr.width7 = false
    this.next = Infinity
    this.vol = 0
    this.enabled = false
    this.env.next = Infinity
    this.env.level = 0
  }
}

registerVoice('gb', 'pulse', (a): ChipVoice => new GbPulseVoice(a.sampleRate, a.maxBlock))
registerVoice('gb', 'wave', (a): ChipVoice => new GbWaveVoice(a.sampleRate, a.maxBlock))
registerVoice('gb', 'noise', (a): ChipVoice => new GbNoiseVoice(a.sampleRate, a.maxBlock))
