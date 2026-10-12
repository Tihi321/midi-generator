import { describe, expect, it } from 'vitest'
import {
  GAUSS,
  brrByteSize,
  brrRoundTrip,
  dacQuantize,
  decodeBrr,
  decodeDpcm,
  dpcmRates,
  encodeBrr,
  encodeDpcm,
  gaussInterpolate,
  generateRaw,
  generateSample,
  listRecipes,
  normalizeRecipeParams,
  pcmToBase64,
  resolveSampleSlot,
  sampleByteSize,
  snrDb
} from '../../src/core/synth/samplegen'
import type { SampleSlot } from '../../src/core/types'

function sine(n: number, hz: number, rate: number, amp = 20000): Int16Array {
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(amp * Math.sin((2 * Math.PI * hz * i) / rate))
  return out
}

describe('Gaussian table', () => {
  it('has 512 monotone entries and every tap set sums to unity (DC preserved)', () => {
    expect(GAUSS.length).toBe(512)
    // the tail is recomputed from the unity-gain identity, so allow +-2 rounding wobble
    for (let i = 1; i < 512; i++) expect(GAUSS[i]!).toBeGreaterThanOrEqual(GAUSS[i - 1]! - 2)
    expect(GAUSS[0]).toBe(0)
    expect(GAUSS[511]!).toBeGreaterThan(1290)
    for (let g = 0; g < 256; g++) {
      const sum = GAUSS[255 - g]! + GAUSS[511 - g]! + GAUSS[256 + g]! + GAUSS[g]!
      expect(Math.abs(sum - 2048)).toBeLessThanOrEqual(1)
      expect(gaussInterpolate(1000, 1000, 1000, 1000, g)).toBeGreaterThan(999)
      expect(gaussInterpolate(1000, 1000, 1000, 1000, g)).toBeLessThan(1001)
    }
  })
})

describe('BRR', () => {
  it('round trips a sine with a high SNR', () => {
    const src = sine(4096, 440, 32000)
    const rt = brrRoundTrip(src)
    expect(rt.pcm.length).toBe(4096)
    expect(rt.bytes).toBe(brrByteSize(4096))
    expect(snrDb(src, rt.pcm)).toBeGreaterThan(24)
  })

  it('round trips noise above a modest SNR (4 bits cannot do much better)', () => {
    let s = 12345
    const noise = new Int16Array(4096)
    for (let i = 0; i < noise.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      noise[i] = ((s >>> 16) & 0x7fff) - 16384
    }
    expect(snrDb(noise, brrRoundTrip(noise).pcm)).toBeGreaterThan(13)
  })

  it('decodeBrr reproduces the encoder\'s decoded output and sets end/loop flags', () => {
    const src = sine(1024, 300, 32000)
    const e = encodeBrr(src, { loopStart: 256 })
    const d = decodeBrr(e.bytes)
    expect(Array.from(d.pcm)).toEqual(Array.from(e.decoded))
    expect(d.loops).toBe(true)
    expect(e.bytes.length).toBe(64 * 9)
    expect(e.bytes[e.bytes.length - 9]! & 3).toBe(3)
    // loop start block uses filter 0
    expect((e.bytes[16 * 9]! >> 2) & 3).toBe(0)
    expect(encodeBrr(src).loopStart).toBeUndefined()
  })

  it('aligns loop points to 16 samples', () => {
    const e = encodeBrr(sine(512, 300, 32000), { loopStart: 37 })
    expect(e.loopStart).toBe(32)
    const s = generateSample('strings')
    expect(s.loopStart! % 16).toBe(0)
    expect(s.pcm.length % 16).toBe(0)
    expect((s.pcm.length - s.loopStart!) % 16).toBe(0)
  })
})

describe('generators', () => {
  it('are deterministic and the seed changes noisy sounds', () => {
    for (const r of listRecipes()) {
      const a = generateRaw(r.id)
      const b = generateRaw(r.id, { seed: 0 })
      expect(Buffer.compare(Buffer.from(a.pcm.buffer, a.pcm.byteOffset, a.pcm.byteLength), Buffer.from(b.pcm.buffer, b.pcm.byteOffset, b.pcm.byteLength))).toBe(0)
      expect(a.pcm.length).toBeGreaterThan(0)
      expect(Math.max(...a.pcm.map(Math.abs))).toBeGreaterThan(8000)
    }
    const s1 = generateRaw('snare', { seed: 5 })
    const s2 = generateRaw('snare', { seed: 6 })
    expect(Array.from(s1.pcm.slice(100, 140))).not.toEqual(Array.from(s2.pcm.slice(100, 140)))
  })

  it('every recipe survives the SNES pipeline with sane sizes and loop alignment', () => {
    for (const r of listRecipes()) {
      const g = generateSample(r.id)
      expect(g.pcm.length % 16).toBe(0)
      expect(g.brrBytes).toBe(brrByteSize(g.pcm.length))
      expect(g.brrBytes!).toBeLessThan(16000)
      expect(r.loops ? g.loopStart !== undefined : g.loopStart === undefined, r.id).toBe(true)
      if (g.loopStart !== undefined) expect(g.loopStart % 16).toBe(0)
      expect(g.sampleRate).toBeGreaterThan(8000)
      expect(g.sampleRate).toBeLessThan(40000)
    }
  })

  it('tuned loops have the right pitch at their native rate', () => {
    const s = generateRaw('lead', { note: 69, wave: 'square' })
    // count rising zero crossings in the loop region
    const loop = s.pcm.subarray(s.loopStart ?? 0)
    let cross = 0
    for (let i = 1; i < loop.length; i++) if (loop[i - 1]! < 0 && loop[i]! >= 0) cross++
    const hz = (cross * s.sampleRate) / loop.length
    expect(hz).toBeGreaterThan(440 * 0.98)
    expect(hz).toBeLessThan(440 * 1.02)
  })

  it('validates parameters with the valid values in the message', () => {
    expect(() => normalizeRecipeParams('nope')).toThrow(/Recipes:.*strings/)
    expect(() => normalizeRecipeParams('kick', { colour: 1 })).toThrow(/Parameters:.*startHz/)
    expect(() => normalizeRecipeParams('kick', { seconds: 99 })).toThrow(/0\.03\.\.1/)
    expect(() => normalizeRecipeParams('choir', { vowel: 'x' })).toThrow(/aah, ooh, eeh/)
    expect(normalizeRecipeParams('kick', { seconds: 0.3 })['seconds']).toBe(0.3)
  })
})

describe('slots', () => {
  it('resolves recipe and user pcm slots (cached)', () => {
    const user = sine(8000, 440, 16000)
    const samples: SampleSlot[] = [
      { id: 'a', name: 'a', source: { kind: 'recipe', recipe: 'kick', params: {} } },
      { id: 'u', name: 'u', source: { kind: 'pcm', sampleRate: 16000, data: pcmToBase64(user) }, loopStart: 4000 }
    ]
    const a = resolveSampleSlot({ samples }, 'a')!
    expect(resolveSampleSlot({ samples }, 'a')).toBe(a)
    const u = resolveSampleSlot({ samples }, 'u')!
    expect(u.sampleRate).toBe(32000)
    expect(u.pcm.length).toBe(16000)
    expect(u.loopStart).toBe(8000)
    expect(resolveSampleSlot({ samples }, 'u', 'raw')!.pcm.length).toBe(8000)
    expect(resolveSampleSlot({ samples }, 'zz')).toBeUndefined()
    expect(sampleByteSize(samples[1]!)).toBe(brrByteSize(16000))
  })
})

describe('DPCM and DAC', () => {
  it('DPCM round trip follows a slow sine', () => {
    const rates = dpcmRates()
    expect(rates[0]).toBeCloseTo(4181.7, 0)
    expect(rates[15]).toBeCloseTo(33143.9, 0)
    const rate = rates[12]!
    const src = sine(4000, 150, rate, 18000)
    const enc = encodeDpcm(src, rate, rate)
    expect((enc.bytes.length - 1) % 16).toBe(0)
    const levels = decodeDpcm(enc.bytes)
    const dec = Array.from(levels.subarray(0, 4000), (v) => (v - 48) * (32768 / 44))
    // correlation with the source
    let dot = 0
    let a = 0
    let b = 0
    for (let i = 200; i < 4000; i++) {
      dot += dec[i]! * src[i]!
      a += dec[i]! ** 2
      b += src[i]! ** 2
    }
    expect(dot / Math.sqrt(a * b)).toBeGreaterThan(0.95)
    for (const v of levels) expect(v).toBeLessThanOrEqual(127)
  })

  it('DAC quantiser gives signed 8-bit values', () => {
    const q = dacQuantize(Int16Array.of(0, 256, -256, 32767, -32768, 100))
    expect(Array.from(q)).toEqual([0, 1, -1, 127, -128, 0])
  })
})
