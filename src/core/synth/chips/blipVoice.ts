// Shared base for voices that describe their output as level changes at chip-clock resolution.

import { BlipBuffer } from '../blip'
import type { ChannelControl } from '../sequencer'
import type { Instrument } from '../../types'
import type { ChipVoice, MixGroup } from './types'

export abstract class BlipVoice implements ChipVoice {
  abstract readonly mixGroup: MixGroup
  abstract readonly linearGain: number
  protected readonly blip: BlipBuffer
  /** Absolute frames rendered so far (also the time of the next control() call). */
  protected pos = 0
  protected level = 0

  constructor(
    protected readonly sampleRate: number,
    maxBlock: number
  ) {
    this.blip = new BlipBuffer(maxBlock)
  }

  protected setLevel(t: number, v: number): void {
    if (v !== this.level) {
      this.blip.addDelta(t, v - this.level)
      this.level = v
    }
  }

  abstract control(c: ChannelControl, inst: Instrument | undefined): void

  /** Generate every event with time < end (absolute frames). */
  protected abstract run(end: number): void

  render(buf: Float32Array, from: number, to: number): void {
    const n = to - from
    this.run(this.pos + n)
    this.blip.readSamples(buf, from, n)
    this.pos += n
  }

  reset(): void {
    this.blip.reset(0)
    this.pos = 0
    this.level = 0
  }
}
