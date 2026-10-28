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
  clearSampleCache,
  generateSample,
  listRecipes,
  normalizeRecipeParams,
  pcmToBase64,
  resolveSampleSlot,
  resolveSlot,
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
      // the 44.1 kHz synthwave loops are tuned to a native rate within a few percent of 44.1 kHz (up to 48 kHz)
      expect(g.sampleRate).toBeLessThan(49000)
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

// ---------------------------------------------------------------------------------------------
// Synthwave recipes (PS1 / Dreamcast, 44.1 kHz)

const SYNTH_RECIPES = ['supersaw', 'sawlead', 'syncsaw', 'junopad', 'analogbass', 'fmbass', 'synthpluck', 'synthbrass', 'dxepiano', 'dxbell', 'linnkick', '808kick', 'linnsnare', 'gatedsnare', 'linnclap', 'linnhat', 'linnopenhat', 'linntom', 'linncrash']
const SYNTH_LOOPS = ['supersaw', 'sawlead', 'syncsaw', 'junopad', 'analogbass', 'fmbass', 'synthbrass']

const peak01 = (pcm: Int16Array): number => Math.max(...pcm.map(Math.abs)) / 32767

describe('synthwave recipes', () => {
  it('are all registered, with a role, and the loops flag matches the default output', () => {
    const ids = listRecipes().map((r) => r.id)
    for (const id of SYNTH_RECIPES) expect(ids, id).toContain(id)
    for (const id of SYNTH_RECIPES) {
      const r = listRecipes().find((x) => x.id === id)!
      expect(r.loops, id).toBe(SYNTH_LOOPS.includes(id))
      expect(generateRaw(id).loopStart !== undefined, id).toBe(r.loops)
    }
    // the first recipes (and therefore the SNES output) are unchanged
    expect(ids.slice(0, 20)).toEqual(['strings', 'choir', 'organ', 'flute', 'brass', 'pad', 'bass', 'lead', 'harp', 'pluck', 'guitar', 'koto', 'bell', 'epiano', 'kick', 'snare', 'hat', 'openhat', 'crash', 'tom'])
  })

  it('are deterministic (also after a cache clear), seeded, and peak between 0.5 and 0.95', () => {
    for (const id of SYNTH_RECIPES) {
      const a = generateRaw(id)
      clearSampleCache()
      const b = generateRaw(id, { seed: 0 })
      expect(Buffer.compare(Buffer.from(a.pcm.buffer, a.pcm.byteOffset, a.pcm.byteLength), Buffer.from(b.pcm.buffer, b.pcm.byteOffset, b.pcm.byteLength)), id).toBe(0)
      expect(peak01(a.pcm), id).toBeGreaterThan(0.5)
      expect(peak01(a.pcm), id).toBeLessThan(0.95)
      expect(a.pcm.length % 16, id).toBe(0)
      if (listRecipes().find((r) => r.id === id)!.params.some((p) => p.key === 'seed')) {
        const s1 = generateRaw(id, { seed: 11 })
        const s2 = generateRaw(id, { seed: 12 })
        expect(Array.from(s1.pcm).join() === Array.from(s2.pcm).join(), id + ' seed').toBe(false)
      }
    }
  })

  it('loops are multiples of 112 (whole BRR and PS-X blocks), at most 16k samples, seamless and tuned near 44.1 kHz', () => {
    for (const id of SYNTH_LOOPS) {
      const g = generateRaw(id)
      const ls = g.loopStart!
      const loopLen = g.pcm.length - ls
      expect(ls % 112, id).toBe(0)
      expect(loopLen % 112, id).toBe(0)
      expect(loopLen, id).toBeLessThanOrEqual(16384)
      expect(g.sampleRate, id).toBeGreaterThan(40000)
      expect(g.sampleRate, id).toBeLessThan(48000)
      // the step across the loop point (and from the intro into the loop) is no bigger than the steepest step inside the loop
      let maxStep = 0
      for (let i = ls + 1; i < g.pcm.length; i++) maxStep = Math.max(maxStep, Math.abs(g.pcm[i]! - g.pcm[i - 1]!))
      expect(Math.abs(g.pcm[ls]! - g.pcm[g.pcm.length - 1]!), id + ' seam').toBeLessThan(1.25 * maxStep)
      if (ls > 0) expect(Math.abs(g.pcm[ls]! - g.pcm[ls - 1]!), id + ' intro join').toBeLessThan(1.25 * maxStep)
      // no DC in the loop
      let mean = 0
      for (let i = ls; i < g.pcm.length; i++) mean += g.pcm[i]!
      expect(Math.abs(mean / loopLen) / 32767, id).toBeLessThan(0.02)
    }
  })

  it('go through the SNES, PS1 and AICA targets with their loop alignment kept (no resampling of the 112 grid)', () => {
    for (const id of SYNTH_RECIPES) {
      const raw = generateRaw(id)
      const slot: SampleSlot = { id, name: id, source: { kind: 'recipe', recipe: id, params: {} } }
      const snes = generateSample(id)
      expect(snes.pcm.length % 16, id).toBe(0)
      const psx = resolveSlot(slot, 'psx')
      expect(psx.pcm.length % 28, id).toBe(0)
      if (raw.loopStart !== undefined) {
        expect(psx.loopStart, id).toBe(raw.loopStart)
        expect(psx.pcm.length, id).toBe(raw.pcm.length)
        expect(psx.sampleRate, id).toBe(raw.sampleRate)
        expect(snes.loopStart, id).toBe(raw.loopStart)
      } else {
        expect(psx.loopStart, id).toBeUndefined()
        expect(psx.pcm.length - raw.pcm.length, id).toBeLessThan(28)
      }
      // the 4-bit codec keeps the sound: a usable SNR against the raw sample
      const n = Math.min(raw.pcm.length, psx.pcm.length)
      expect(snrDb(raw.pcm.subarray(0, n), psx.pcm.subarray(0, n)), id).toBeGreaterThan(8)
      for (const target of ['aica16', 'aica8', 'aica-adpcm']) {
        const a = resolveSlot(slot, target)
        expect(a.pcm.length, id + ' ' + target).toBe(raw.pcm.length)
        expect(a.loopStart, id + ' ' + target).toBe(raw.loopStart)
      }
    }
  })

  it('the gated snare is exactly its gate long and ends silent; the 808 boom is long and slow', () => {
    for (const gate of [0.15, 0.28, 0.4]) {
      const g = generateRaw('gatedsnare', { gate })
      expect(g.pcm.length).toBe(Math.ceil(Math.round(gate * g.sampleRate) / 16) * 16)
      expect(Math.abs(g.pcm[g.pcm.length - 1]!) / 32767).toBeLessThan(0.01)
    }
    const k = generateRaw('808kick')
    expect(k.pcm.length / k.sampleRate).toBeGreaterThan(0.85)
    // energy in the second half of the boom is still there (a long decay)
    const half = k.pcm.length >> 1
    let late = 0
    let total = 0
    for (let i = 0; i < k.pcm.length; i++) {
      total += k.pcm[i]! ** 2
      if (i >= half) late += k.pcm[i]! ** 2
    }
    expect(late / total).toBeGreaterThan(0.002)
  })

  it('validate their parameters like the other recipes', () => {
    expect(() => normalizeRecipeParams('supersaw', { voices: 12 })).toThrow(/3..9/)
    expect(() => normalizeRecipeParams('gatedsnare', { gate: 1 })).toThrow(/0.15..0.4/)
    expect(() => normalizeRecipeParams('analogbass', { pluck: 'yes' })).toThrow(/true or false/)
    expect(() => normalizeRecipeParams('linnkick', { rate: 99999 })).toThrow(/4000..48000/)
    expect(normalizeRecipeParams('supersaw', { voices: 5 })['voices']).toBe(5)
    // a looped recipe with loop:false is a one-shot
    expect(generateRaw('supersaw', { loop: false }).loopStart).toBeUndefined()
  })
})
