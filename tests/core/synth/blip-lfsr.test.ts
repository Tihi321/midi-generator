import { describe, expect, it } from 'vitest'
import { BLIP_KERNEL, BLIP_PHASES, BLIP_TAPS, BlipBuffer } from '../../../src/core/synth/blip'
import { GbLfsr, NesLfsr, Sn76489Lfsr, lfsrPeriod } from '../../../src/core/synth/lfsr'

describe('blip', () => {
  it('every kernel phase sums to 1', () => {
    for (let p = 0; p < BLIP_PHASES; p++) {
      let s = 0
      for (let i = 0; i < BLIP_TAPS; i++) s += BLIP_KERNEL[p * BLIP_TAPS + i]!
      expect(Math.abs(s - 1)).toBeLessThan(1e-12)
    }
  })

  it('a DC step integrates to 1 at any sub-sample position and has no NaN', () => {
    for (const t of [0, 3.0, 10.37, 10.99, 100.5]) {
      const b = new BlipBuffer(256)
      b.addDelta(t, 1)
      const out = new Float32Array(256)
      b.readSamples(out, 0, 256)
      for (const v of out) expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(out[255]! - 1)).toBeLessThan(1e-6)
      expect(Math.abs(out[0]!)).toBeLessThan(1e-3)
    }
  })

  it('the step is band-limited around its position (transition within +-8 samples + latency)', () => {
    const b = new BlipBuffer(64)
    b.addDelta(20, 1)
    const out = new Float32Array(64)
    b.readSamples(out, 0, 64)
    expect(out[10]!).toBeLessThan(0.01) // before the kernel starts (latency 8)
    expect(Math.abs(out[40]! - 1)).toBeLessThan(1e-4)
    // the step is centred on sample 20 + 8 (latency): just before it is ~0, at it ~1
    expect(out[26]!).toBeLessThan(0.1)
    expect(out[27]!).toBeLessThan(0.25)
    expect(out[28]!).toBeGreaterThan(0.8)
  })

  it('+1 then -1 returns to zero; block splitting does not change the output', () => {
    const a = new BlipBuffer(256)
    const b = new BlipBuffer(256)
    const events: [number, number][] = [[5.25, 1], [60.75, -1], [111.5, 0.5]]
    for (const [t, d] of events) a.addDelta(t, d)
    const whole = new Float32Array(200)
    a.readSamples(whole, 0, 200)
    const parts = new Float32Array(200)
    // voices only add events that fall inside the block they are about to read
    for (let off = 0; off < 200; off += 37) {
      const n = Math.min(37, 200 - off)
      for (const [t, d] of events) if (t >= off && t < off + n) b.addDelta(t, d)
      b.readSamples(parts, off, n)
    }
    expect(Array.from(parts)).toEqual(Array.from(whole))
    expect(Math.abs(whole[199]! - 0.5)).toBeLessThan(1e-6)
  })

  it('transitions near a block boundary spill into the next block correctly', () => {
    const a = new BlipBuffer(64)
    a.addDelta(60.5, 1)
    const x = new Float32Array(64)
    const y = new Float32Array(64)
    a.readSamples(x, 0, 64)
    a.readSamples(y, 0, 64)
    expect(Math.abs(y[40]! - 1)).toBeLessThan(1e-6)
    const ref = new BlipBuffer(256)
    ref.addDelta(60.5, 1)
    const z = new Float32Array(128)
    ref.readSamples(z, 0, 128)
    expect(Array.from(x)).toEqual(Array.from(z.subarray(0, 64)))
    expect(Array.from(y)).toEqual(Array.from(z.subarray(64, 128)))
  })
})

describe('lfsr', () => {
  it('NES long mode has period 32767', () => {
    expect(lfsrPeriod(new NesLfsr())).toBe(32767)
  })
  it('NES short mode has period 93', () => {
    const l = new NesLfsr()
    l.short = true
    expect(lfsrPeriod(l)).toBe(93)
  })
  it('GB 15-bit has period 32767 and 7-bit mode 127', () => {
    expect(lfsrPeriod(new GbLfsr())).toBe(32767)
    const l = new GbLfsr()
    l.width7 = true
    // the 7-bit mode also feeds bit 6, so the sequence repeats after 127 clocks once settled
    for (let i = 0; i < 20; i++) l.clock()
    expect(lfsrPeriod(l)).toBe(127)
  })
  it('SN76489 white / periodic noise are deterministic and cyclic', () => {
    const w = new Sn76489Lfsr()
    // Sega 16-bit register, feedback = bit0 XOR bit3 into bit15 (mask 0x0009). That polynomial is not primitive:
    // from the power-on seed 0x8000 the register walks a cycle of 57337 states (not 65535). Periodic mode is 16.
    expect(lfsrPeriod(w)).toBe(57337)
    expect(lfsrPeriod(new Sn76489Lfsr())).toBe(lfsrPeriod(w))
    const p = new Sn76489Lfsr()
    p.white = false
    expect(lfsrPeriod(p)).toBe(16)
  })
})
