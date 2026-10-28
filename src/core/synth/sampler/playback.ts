// Sample playback shared by the sample chips: a read pointer over decoded PCM16, a 4-sample history and a
// 12-bit-fraction pitch counter (0x1000 = one source sample per DSP step). `advance()` moves the counter and
// reports when a one-shot ran past its end so the owner applies its own end rule (SNES: envelope to 0 and key off).
// `interpolate()` returns the current output in -1..1.

import { GAUSS } from '../samplegen/gauss'

export type Interpolation = 'gauss' | 'linear' | 'none'

const INTERP_NONE = 0
const INTERP_LINEAR = 1
const INTERP_GAUSS = 2

export class SamplePlayback {
  pcm: Int16Array = new Int16Array(0)
  len = 0
  /** Loop start in samples, -1 for a one-shot. */
  loopStart = -1
  /** Read pointer (next PCM sample to enter the history). */
  rp = 0
  h0 = 0
  h1 = 0
  h2 = 0
  h3 = 0
  /** 12-bit fractional position (0..0xfff) after the last advance. */
  cnt = 0
  /** Pitch register: source samples per DSP step in 1/0x1000. */
  pitch = 0x1000
  /** Added to `pitch` for one advance; a pitch modulator or LFO writes it every step (0 = off). */
  pitchOffset = 0
  private readonly mode: number
  private ended = false

  constructor(interp: Interpolation) {
    this.mode = interp === 'gauss' ? INTERP_GAUSS : interp === 'linear' ? INTERP_LINEAR : INTERP_NONE
  }

  /** Install a sample (the read pointer is untouched: call `restart()` to begin playing it). */
  load(pcm: Int16Array, loopStart: number | undefined): void {
    this.pcm = pcm
    this.len = pcm.length
    this.loopStart = loopStart !== undefined && loopStart < pcm.length ? loopStart : -1
  }

  /** Start from the beginning with a cleared history. */
  restart(): void {
    this.rp = 0
    this.h0 = this.h1 = this.h2 = this.h3 = 0
    this.cnt = 0
    this.ended = false
  }

  private nextSample(): number {
    if (this.rp >= this.len) {
      if (this.loopStart >= 0) this.rp = this.loopStart
      else {
        this.ended = true
        return 0
      }
    }
    return this.pcm[this.rp++]!
  }

  /** One DSP step: advance by `pitch + pitchOffset`. Returns true when a one-shot ended during this step. */
  advance(): boolean {
    this.ended = false
    let cnt = this.cnt + this.pitch + this.pitchOffset
    while (cnt >= 0x1000) {
      cnt -= 0x1000
      this.h0 = this.h1
      this.h1 = this.h2
      this.h2 = this.h3
      this.h3 = this.nextSample()
    }
    this.cnt = cnt
    return this.ended
  }

  /** Interpolated output of the current history, -1..1. */
  interpolate(): number {
    if (this.mode !== INTERP_GAUSS) return this.interpolateSimple()
    const g = (this.cnt >> 4) & 255
    return (GAUSS[255 - g]! * this.h0 + GAUSS[511 - g]! * this.h1 + GAUSS[256 + g]! * this.h2 + GAUSS[g]! * this.h3) / 2048 / 32768
  }

  /** The non-gauss modes, kept out of `interpolate` so the gauss path stays small enough to inline. */
  private interpolateSimple(): number {
    if (this.mode === INTERP_LINEAR) return (this.h1 + (this.h2 - this.h1) * (this.cnt / 4096)) / 32768
    return this.h1 / 32768
  }
}
