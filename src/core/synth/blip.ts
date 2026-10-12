// Minimal Blip_Buffer: band-limited step synthesis.
//
// Voices describe their output as a piecewise-constant signal. Whenever the level changes they call
// `addDelta(t, delta)` with t in (fractional) absolute output frames; the buffer adds a windowed-sinc
// band-limited impulse (16 taps, 32 sub-sample phases) so that the running sum of the buffer is the
// band-limited step response. Every phase of the kernel is normalised to sum to 1, so a unit delta
// integrates to exactly 1 (a DC step settles at its target level).
//
// The buffer introduces a constant latency of 8 frames. Positions are absolute: `base` is the
// absolute frame index of the next frame returned by `readSamples`, so the result does not depend
// on how the output is split into blocks.

export const BLIP_TAPS = 16
export const BLIP_PHASES = 32
const LATENCY = BLIP_TAPS / 2
const CUTOFF = 0.92 // fraction of Nyquist

export const BLIP_KERNEL: Float64Array = (() => {
  const k = new Float64Array(BLIP_PHASES * BLIP_TAPS)
  for (let p = 0; p < BLIP_PHASES; p++) {
    const f = p / BLIP_PHASES
    let sum = 0
    for (let i = 0; i < BLIP_TAPS; i++) {
      const x = i - (LATENCY - 1) - f
      const arg = Math.PI * CUTOFF * x
      const sinc = Math.abs(x) < 1e-9 ? CUTOFF : Math.sin(arg) / (Math.PI * x)
      const wx = x / LATENCY
      const w = Math.abs(wx) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * wx) + 0.08 * Math.cos(2 * Math.PI * wx)
      const v = sinc * w
      k[p * BLIP_TAPS + i] = v
      sum += v
    }
    for (let i = 0; i < BLIP_TAPS; i++) k[p * BLIP_TAPS + i]! /= sum
  }
  return k
})()

export class BlipBuffer {
  private readonly buf: Float64Array
  private readonly tmp = new Float64Array(BLIP_TAPS + 1)
  private acc = 0
  /** Absolute frame index of the next frame `readSamples` returns. */
  base = 0
  readonly capacity: number

  /** `capacity` = the largest block (frames) passed to `readSamples`. */
  constructor(capacity: number) {
    this.capacity = capacity
    this.buf = new Float64Array(capacity + BLIP_TAPS + 2)
  }

  /** Add a level change of `delta` at absolute fractional frame `t` (t >= base). */
  addDelta(t: number, delta: number): void {
    if (delta === 0) return
    const whole = Math.floor(t)
    const frac = t - whole
    let idx = whole - this.base
    let phase = Math.floor(frac * BLIP_PHASES)
    if (idx < 0) {
      idx = 0
      phase = 0
    }
    const k = phase * BLIP_TAPS
    const o = idx + 1
    const buf = this.buf
    for (let i = 0; i < BLIP_TAPS; i++) buf[o + i]! += BLIP_KERNEL[k + i]! * delta
  }

  /** Writes `count` frames of the integrated signal into out[off..off+count) and advances `base`. */
  readSamples(out: Float32Array, off: number, count: number): void {
    const buf = this.buf
    let acc = this.acc
    for (let j = 0; j < count; j++) {
      acc += buf[j]!
      out[off + j] = acc
    }
    this.acc = acc
    const tmp = this.tmp
    for (let j = 0; j <= BLIP_TAPS; j++) tmp[j] = buf[count + j]!
    buf.fill(0, 0, count + BLIP_TAPS + 1)
    for (let j = 0; j <= BLIP_TAPS; j++) buf[j] = tmp[j]!
    this.base += count
  }

  /** Current integrated level (after the last read). */
  get level(): number {
    return this.acc
  }

  reset(base = 0): void {
    this.buf.fill(0)
    this.acc = 0
    this.base = base
  }
}
