import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROLES, PCE_PRESETS, PRESET_BANKS, createSong, getChipProfile, resolvePreset, validateInstrument } from '../../../src/core'
import { writeWav } from '../../../src/core/codecs/wav'
import { MOODS } from '../../../src/core/theory/moods'
import { SongPlayer } from '../../../src/core/synth/player'
import { renderSong, type RenderResult } from '../../../src/core/synth/render'
import { interleave, quantizeStereo } from '../../../src/core/synth/mixer'
import { createVoice } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { PCE_CLOCK, pceFreq, pceNoiseIndex, pcePanLevels, pcePeriod, pceQuantizePan, pceVolume } from '../../../src/core/synth/chips/huc6280'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import { midiToHz } from '../../../src/core/synth/tables'
import type { Instrument, PceWaveInstrument, Song } from '../../../src/core/types'
import { put } from './fixtures'

const SR = 44100
const BLOCK = 4096

const sine = Array.from({ length: 32 }, (_, i) => Math.round(15.5 + 15.5 * Math.sin((2 * Math.PI * (i + 0.5)) / 32)))
const square = Array.from({ length: 32 }, (_, i) => (i < 16 ? 31 : 0))

function waveInst(waves: number[][], extra: Partial<PceWaveInstrument> = {}): PceWaveInstrument {
  return { kind: 'pce-wave', name: 'w', waves, macros: {}, ...extra }
}

function pceSong(patternLength = 16): Song {
  const s = createSong({ chip: 'pce', patternLength, authenticity: 'relaxed' })
  s.orders = [s.channels.map(() => 0)]
  return s
}

function renderVoice(inst: Instrument, channelId: string, midi: number, vol = 1, seconds = 0.5, timbre = -1): Float32Array {
  const song = pceSong()
  song.instruments = [inst]
  const index = song.channels.findIndex((c) => c.id === channelId)
  const voice = createVoice({ song, channel: song.channels[index]!, index, sampleRate: SR, maxBlock: BLOCK })
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = vol
  c.rawVol = vol
  c.semis = midi
  c.freqHz = midiToHz(midi)
  c.inst = 0
  c.note = midi
  c.timbre = timbre
  voice.control(c, inst)
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const tmp = new Float32Array(BLOCK)
  for (let off = 0; off < n; off += BLOCK) {
    const len = Math.min(BLOCK, n - off)
    voice.render(tmp, 0, len)
    out.set(tmp.subarray(0, len), off)
  }
  return out.subarray(Math.round(0.05 * SR))
}

/** Interpolated rising zero crossings of the mean-removed signal. */
function crossings(x: Float32Array): number[] {
  let mean = 0
  for (const v of x) mean += v
  mean /= x.length
  const cross: number[] = []
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1]! - mean
    const b = x[i]! - mean
    if (a < 0 && b >= 0) cross.push(i - 1 + -a / (b - a))
  }
  return cross
}
function measureHz(x: Float32Array): number {
  const c = crossings(x)
  return c.length < 3 ? 0 : ((c.length - 1) * SR) / (c.at(-1)! - c[0]!)
}
function peak(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}
function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
}

describe('HuC6280 register maths', () => {
  it('period = clock / (32 f), 12 bits', () => {
    expect(pcePeriod(440)).toBe(Math.round(PCE_CLOCK / (32 * 440)))
    expect(pcePeriod(1)).toBe(4095)
    expect(pcePeriod(1e9)).toBe(1)
    expect(pceFreq(254)).toBeCloseTo(PCE_CLOCK / (32 * 254), 6)
  })
  it('volume has 32 steps', () => {
    const levels = new Set<number>()
    for (let i = 0; i <= 1000; i++) levels.add(pceVolume(i / 1000))
    expect(levels.size).toBe(32)
    expect(pceVolume(0)).toBe(0)
    expect(pceVolume(1)).toBe(31)
  })
  it('pan has 16 levels per side', () => {
    expect(pcePanLevels(0)).toEqual({ l: 15, r: 15 })
    expect(pcePanLevels(-1)).toEqual({ l: 15, r: 0 })
    expect(pcePanLevels(1)).toEqual({ l: 0, r: 15 })
    expect(pceQuantizePan(0)).toBe(0)
    expect(pceQuantizePan(1)).toBe(1)
    expect(pceQuantizePan(-1)).toBe(-1)
    const values = new Set<number>()
    for (let i = -1000; i <= 1000; i++) values.add(pceQuantizePan(i / 1000))
    expect(values.size).toBe(31)
    expect(pceQuantizePan(0.5)).toBeCloseTo(1 - 8 / 15, 9)
    expect(pceQuantizePan(-0.5)).toBeCloseTo(-(1 - 8 / 15), 9)
    expect(pceNoiseIndex(60)).toBe(28)
  })
})

describe('pitch', () => {
  for (const [name, midi] of [['A-4', 69], ['C-3', 48], ['C-6', 84]] as const) {
    it(`${name} on a sine wave is within the divider quantisation`, () => {
      const f = midiToHz(midi)
      const got = measureHz(renderVoice(waveInst([sine]), 'C1', midi))
      const quantised = pceFreq(pcePeriod(f))
      expect(Math.abs(got - quantised) / quantised).toBeLessThan(0.002)
      expect(Math.abs(got - f) / f).toBeLessThan(0.01)
    })
  }
  it('works on every channel C1..C6', () => {
    for (const id of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) {
      expect(measureHz(renderVoice(waveInst([sine]), id, 57)), id).toBeGreaterThan(215)
    }
  })
})

describe('wave reproduction', () => {
  it('a square wave swings between the 5-bit extremes with 50% duty', () => {
    const x = renderVoice(waveInst([square]), 'C1', 57)
    let hi = 0
    let max = -99
    let min = 99
    for (const v of x) {
      if (v > 0) hi++
      max = Math.max(max, v)
      min = Math.min(min, v)
    }
    // raw voice units: (31 - 15.5) = +15.5 and (0 - 15.5) = -15.5; band-limiting overshoots a little
    expect(max).toBeGreaterThan(15)
    expect(max).toBeLessThan(20.5)
    expect(min).toBeLessThan(-15)
    expect(min).toBeGreaterThan(-20.5)
    expect(hi / x.length).toBeGreaterThan(0.45)
    expect(hi / x.length).toBeLessThan(0.55)
  })
  it('a 25% pulse wave has 25% duty', () => {
    const pulse = Array.from({ length: 32 }, (_, i) => (i < 8 ? 31 : 0))
    const x = renderVoice(waveInst([pulse]), 'C1', 57)
    let hi = 0
    for (const v of x) if (v > 0) hi++
    expect(hi / x.length).toBeGreaterThan(0.22)
    expect(hi / x.length).toBeLessThan(0.28)
  })
  it('the timbre index picks the wave (clamped)', () => {
    const inst = waveInst([sine, square])
    const a = renderVoice(inst, 'C1', 57, 1, 0.3, 0)
    const b = renderVoice(inst, 'C1', 57, 1, 0.3, 1)
    const c = renderVoice(inst, 'C1', 57, 1, 0.3, 9)
    expect(peak(b)).toBeGreaterThan(peak(a) * 1.1)
    expect(bytesEqual(b, c)).toBe(true)
    expect(bytesEqual(a, b)).toBe(false)
  })
})

describe('volume', () => {
  it('amplitude follows the 5-bit volume steps', () => {
    const base = peak(renderVoice(waveInst([square]), 'C1', 57, 1))
    for (const v of [0.25, 0.5, 0.8]) {
      const p = peak(renderVoice(waveInst([square]), 'C1', 57, v))
      expect(p / base).toBeCloseTo(pceVolume(v) / 31, 1)
    }
    expect(peak(renderVoice(waveInst([square]), 'C1', 57, 0))).toBe(0)
  })
})

describe('noise', () => {
  const noiseInst = waveInst([sine], { noise: true })
  const intervalSpread = (x: Float32Array): number => {
    const c = crossings(x)
    const d = c.slice(1).map((v, i) => v - c[i]!)
    const mean = d.reduce((a, b) => a + b, 0) / d.length
    return Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / d.length) / mean
  }
  it('C5 and C6 produce noise: irregular, not periodic', () => {
    for (const id of ['C5', 'C6']) {
      const x = renderVoice(noiseInst, id, 60)
      expect(peak(x), id).toBeGreaterThan(5)
      expect(intervalSpread(x), id).toBeGreaterThan(0.3)
    }
  })
  it('noise:true is ignored on C1..C4 (plays the wave)', () => {
    for (const id of ['C1', 'C2', 'C3', 'C4']) {
      const x = renderVoice(noiseInst, id, 57)
      expect(intervalSpread(x), id).toBeLessThan(0.02)
      expect(measureHz(x), id).toBeGreaterThan(215)
    }
  })
  it('a higher noise index changes faster', () => {
    const rate = (note: number): number => crossings(renderVoice(noiseInst, 'C5', note)).length
    expect(rate(31)).toBeGreaterThan(rate(8) * 2)
  })
  it('the noise sequence is deterministic', () => {
    expect(bytesEqual(renderVoice(noiseInst, 'C6', 60), renderVoice(noiseInst, 'C6', 60))).toBe(true)
  })
})

function demoSong(): Song {
  const s = pceSong(16)
  s.orders = [s.channels.map(() => 0), s.channels.map(() => 1)]
  s.loop = { order: 1 }
  const inst = (id: string): Instrument => resolvePreset('pce', id)
  s.instruments = [inst('lead.bright'), inst('bass.sine'), inst('pad.soft'), inst('arp.wave'), inst('hat.noise'), inst('snare.noise'), inst('kick.drop')]
  put(s, 'C1', 0, 0, { note: 36, inst: 1, vol: 15 })
  put(s, 'C1', 0, 8, { note: 43 })
  put(s, 'C2', 0, 0, { note: 72, inst: 0, vol: 13, fx: [{ code: '4', param: 0x42 }] })
  put(s, 'C2', 0, 6, { note: 76 })
  put(s, 'C2', 0, 10, { note: 79, fx: [{ code: 'X', param: 0x20 }] })
  put(s, 'C3', 0, 0, { note: 60, inst: 2, vol: 10, fx: [{ code: 'X', param: 0xe0 }] })
  put(s, 'C4', 0, 0, { note: 60, inst: 3, fx: [{ code: '0', param: 0x47 }] })
  put(s, 'C4', 0, 8, { note: 'off' })
  for (let r = 0; r < 16; r += 2) put(s, 'C5', 0, r, { note: 60, inst: 4, vol: 8 })
  put(s, 'C6', 0, 4, { note: 60, inst: 5 })
  put(s, 'C6', 0, 12, { note: 60, inst: 5 })
  put(s, 'C4', 1, 0, { note: 36, inst: 6, fx: [{ code: 'W', param: 0 }] })
  put(s, 'C2', 1, 0, { note: 84, inst: 0 })
  put(s, 'C1', 1, 0, { note: 41, inst: 1, vol: 12 })
  put(s, 'C1', 1, 8, { note: 'rel' })
  put(s, 'C5', 1, 0, { note: 60, inst: 4 })
  return s
}

describe('determinism and block parity', () => {
  it('two renders are bit-identical and audible', () => {
    const a = renderSong(demoSong(), { sampleRate: SR })
    const b = renderSong(demoSong(), { sampleRate: SR })
    expect(bytesEqual(a.L, b.L)).toBe(true)
    expect(bytesEqual(a.R, b.R)).toBe(true)
    expect(peak(a.L)).toBeGreaterThan(0.05)
    for (const v of a.L) expect(Number.isFinite(v) && Math.abs(v) <= 1).toBe(true)
  })
  it('128-frame blocks give exactly the offline render (one-shot)', () => {
    const song = demoSong()
    song.loop = null
    const ref = renderSong(song, { sampleRate: SR })
    const L = new Float32Array(ref.L.length)
    const R = new Float32Array(ref.R.length)
    const player = new SongPlayer(song, SR)
    for (let off = 0; off < L.length; off += 128) {
      const end = Math.min(L.length, off + 128)
      player.process(L.subarray(off, end), R.subarray(off, end))
    }
    expect(bytesEqual(L, ref.L)).toBe(true)
    expect(bytesEqual(R, ref.R)).toBe(true)
  })
  it('Xxx pans through 4-bit quantisation (hard left / right, quantised middle)', () => {
    const song = pceSong()
    song.instruments = [waveInst([square])]
    put(song, 'C1', 0, 0, { note: 57, inst: 0, fx: [{ code: 'X', param: 0 }] })
    put(song, 'C2', 0, 0, { note: 57, inst: 0, fx: [{ code: 'X', param: 255 }] })
    put(song, 'C3', 0, 0, { note: 57, inst: 0, fx: [{ code: 'X', param: 0x40 }] })
    const r = renderSong(song, { sampleRate: SR, stems: true, tailSec: 0 })
    const n = SR / 2
    expect(peak(r.stems!.C1!.L.subarray(0, n))).toBeGreaterThan(0.01)
    expect(peak(r.stems!.C1!.R.subarray(0, n))).toBe(0)
    expect(peak(r.stems!.C2!.R.subarray(0, n))).toBeGreaterThan(0.01)
    expect(peak(r.stems!.C2!.L.subarray(0, n))).toBe(0)
    const l = peak(r.stems!.C3!.L.subarray(0, n))
    const rr = peak(r.stems!.C3!.R.subarray(0, n))
    expect(l).toBeGreaterThan(rr)
    expect(rr).toBeGreaterThan(0.005)
  })
})

describe('golden hash', () => {
  const goldenPath = join(__dirname, 'golden-pce.json')
  const update = process.env.UPDATE_GOLDEN === '1'
  const hashOf = (r: RenderResult): string => {
    const q = quantizeStereo(r.L, r.R)
    const inter = interleave(q.L, q.R)
    return createHash('sha256').update(Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength)).digest('hex')
  }
  it('pce demo song (UPDATE_GOLDEN=1 regenerates)', () => {
    const golden: Record<string, string> = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>) : {}
    const r = renderSong(demoSong(), { sampleRate: SR })
    const h = hashOf(r)
    if (update) {
      golden['pce'] = h
      writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n')
      return
    }
    if (golden['pce'] !== h) {
      const dir = join(process.cwd(), '.claude', 'temp')
      mkdirSync(dir, { recursive: true })
      const q = quantizeStereo(r.L, r.R)
      const file = join(dir, 'golden-pce-actual.wav')
      writeFileSync(file, writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R] }))
      throw new Error(`Golden hash mismatch for pce: expected ${golden['pce']}, got ${h}. Listen to ${file}; run with UPDATE_GOLDEN=1 if the change is intended.`)
    }
    expect(h).toBe(golden['pce'])
  })
})

describe('pce presets', () => {
  const bank = PRESET_BANKS.pce
  it('has 15-30 unique pce.* ids', () => {
    expect(bank).toBe(PCE_PRESETS)
    expect(bank.length).toBeGreaterThanOrEqual(15)
    expect(bank.length).toBeLessThanOrEqual(30)
    expect(new Set(bank.map((p) => p.id)).size).toBe(bank.length)
    for (const p of bank) expect(p.id.startsWith('pce.')).toBe(true)
  })
  it('every preset resolves, validates and is chip-legal on its target channel', () => {
    const song = createSong({ chip: 'pce', patternLength: 16 })
    const profile = getChipProfile('pce')
    for (const p of bank) {
      const inst = resolvePreset('pce', p.id)
      expect(validateInstrument(inst), p.id).toEqual([])
      expect(inst.presetId).toBe(p.id)
      expect(inst.kind).toBe('pce-wave')
      const noise = inst.kind === 'pce-wave' && inst.noise
      song.instruments = [inst]
      song.patterns.clear()
      song.patterns.set(noise ? 'C5:0' : 'C1:0', { rows: [{ note: 60, inst: 0, vol: 15 }, ...Array.from({ length: 15 }, () => null)] })
      const issues = profile.validate(song)
      expect(issues.filter((i) => i.severity === 'error'), p.id).toEqual([])
    }
  })
  it('noise presets are refused on wave channels in strict songs', () => {
    const song = createSong({ chip: 'pce', patternLength: 16 })
    song.instruments = [resolvePreset('pce', 'hat.noise')]
    song.patterns.set('C1:0', { rows: [{ note: 60, inst: 0 }, ...Array.from({ length: 15 }, () => null)] })
    const issues = getChipProfile('pce').validate(song)
    expect(issues.some((i) => i.severity === 'error' && /only works on C5 and C6/.test(i.message))).toBe(true)
  })
  it('every role (and every mood-recipe role) resolves for wave channels', () => {
    for (const role of ROLES) expect(() => resolvePreset('pce', role, 'pce-wave'), role).not.toThrow()
    for (const mood of MOODS) {
      for (const plan of mood.chips.pce.channels) expect(() => resolvePreset('pce', plan.role, 'pce-wave'), `${mood.id}:${plan.role}`).not.toThrow()
    }
  })
  it('noise presets are only the noise drums and render noisy on C5', () => {
    const noisy = bank.filter((p) => p.instrument.kind === 'pce-wave' && p.instrument.noise)
    expect(noisy.map((p) => p.role).sort()).toEqual(['clap', 'crash', 'hihat', 'openhat', 'snare'])
    for (const p of noisy) expect(peak(renderVoice(resolvePreset('pce', p.id), 'C5', 60)), p.id).toBeGreaterThan(1)
  })
  it('every preset makes sound through the sequencer', () => {
    for (const p of bank) {
      const inst = resolvePreset('pce', p.id)
      const song = pceSong()
      song.instruments = [inst]
      const ch = inst.kind === 'pce-wave' && inst.noise ? 'C5' : 'C2'
      put(song, ch, 0, 0, { note: 60, inst: 0, vol: 15 })
      const r = renderSong(song, { sampleRate: SR, tailSec: 0 })
      expect(peak(r.L), p.id).toBeGreaterThan(0.005)
    }
  })
})
