// The DSP-rate -> output-rate resampler shared by every sample chip: the chip's DSP produces one value per
// DSP step (32 kHz on the SNES, 44.1 kHz on the PS1 and Dreamcast) and the output is a Catmull-Rom cubic of the
// last four steps. The voice loop (`SamplerVoice.render`) and the stereo bus resampler (`resampleStereo`) both use
// this state, so a bus and its voices stay on one clock.

/** Catmull-Rom cubic through y1..y2 at t in [0, 1) with y0 and y3 as the outer taps. */
export function catmull(y0: number, y1: number, y2: number, y3: number, t: number): number {
  return ((((-0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3) * t + (y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3)) * t + (-0.5 * y0 + 0.5 * y2)) * t) + y1
}

export class DspClock {
  /** DSP steps per output frame. */
  readonly inc: number
  /** Position between the last two DSP steps, [0, 1). */
  frac = 0
  /** The last four DSP outputs (a3 is the newest); `b0..b3` is the right channel of a stereo bus. */
  a0 = 0
  a1 = 0
  a2 = 0
  a3 = 0
  b0 = 0
  b1 = 0
  b2 = 0
  b3 = 0
  /** DSP steps taken in the current block (index of the send slot a voice writes to). */
  k = 0

  constructor(dspRate: number, sampleRate: number) {
    this.inc = dspRate / sampleRate
  }

  reset(): void {
    this.frac = 0
    this.a0 = this.a1 = this.a2 = this.a3 = 0
    this.b0 = this.b1 = this.b2 = this.b3 = 0
    this.k = 0
  }

  /** Resample `steps` stereo DSP outputs (outL/outR[0..steps)) to `n` output frames; past `steps` the input is 0. */
  resampleStereo(outL: Float32Array, outR: Float32Array, steps: number, L: Float32Array, R: Float32Array, n: number): void {
    let k = 0
    let frac = this.frac
    let a0 = this.a0
    let a1 = this.a1
    let a2 = this.a2
    let a3 = this.a3
    let b0 = this.b0
    let b1 = this.b1
    let b2 = this.b2
    let b3 = this.b3
    const inc = this.inc
    for (let i = 0; i < n; i++) {
      while (frac >= 1) {
        frac -= 1
        a0 = a1
        a1 = a2
        a2 = a3
        b0 = b1
        b1 = b2
        b2 = b3
        a3 = k < steps ? outL[k]! : 0
        b3 = k < steps ? outR[k]! : 0
        k++
      }
      L[i] = catmull(a0, a1, a2, a3, frac)
      R[i] = catmull(b0, b1, b2, b3, frac)
      frac += inc
    }
    this.frac = frac
    this.a0 = a0
    this.a1 = a1
    this.a2 = a2
    this.a3 = a3
    this.b0 = b0
    this.b1 = b1
    this.b2 = b2
    this.b3 = b3
  }
}
