import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PRESET_BANKS, SNES_PRESETS, createSong, getChipProfile, missingPresetSample, resolvePreset, validateInstrument } from '../../../src/core'
import { writeWav } from '../../../src/core/codecs/wav'
import { EchoBus, SpcVoice, SNES_RATE_PERIODS } from '../../../src/core/synth/chips/spc700'
import { createVoice } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { interleave, quantizeStereo } from '../../../src/core/synth/mixer'
import { SongPlayer } from '../../../src/core/synth/player'
import { type RenderResult, renderSong } from '../../../src/core/synth/render'
import { generateSample, pcmToBase64 } from '../../../src/core/synth/samplegen'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import { midiToHz } from '../../../src/core/synth/tables'
import type { Song } from '../../../src/core/types'
import { put } from './fixtures'

const SR = 44100

function snesSong(presets: string[], patternLength = 16): Song {
  const s = createSong({ chip: 'snes', patternLength, authenticity: 'relaxed' })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  for (const id of presets) {
    const inst = resolvePreset('snes', id)
    const slot = missingPresetSample(s, inst)
    if (slot) s.samples.push(slot)
    s.instruments.push(inst)
  }
  return s
}

function voiceOf(song: Song, index = 0, sampleRate = SR): SpcVoice {
  return createVoice({ song, channel: song.channels[index]!, index, sampleRate, maxBlock: 4096 }) as SpcVoice
}

function noteControl(midi: number, vol = 1, over: Partial<ReturnType<typeof newChannelControl>> = {}): ReturnType<typeof newChannelControl> {
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = vol
  c.rawVol = vol
  c.semis = midi
  c.freqHz = midiToHz(midi)
  c.note = midi
  c.inst = 0
  Object.assign(c, over)
  return c
}

function renderNote(song: Song, midi: number, seconds: number, sampleRate = SR): Float32Array {
  const v = voiceOf(song, 0, sampleRate)
  v.control(noteControl(midi), song.instruments[0])
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let off = 0; off < out.length; off += 4096) v.render(out.subarray(off, Math.min(out.length, off + 4096)), 0, Math.min(4096, out.length - off))
  return out
}

/** Frequency from interpolated rising zero crossings of the mean-removed signal. */
function measureHz(x: Float32Array, sr: number): number {
  let mean = 0
  for (const v of x) mean += v
  mean /= x.length
  const cross: number[] = []
  for (let i = 1; i < x.length; i++) {
    const a = x[i - 1]! - mean
    const b = x[i]! - mean
    if (a < 0 && b >= 0) cross.push(i - 1 + -a / (b - a))
  }
  if (cross.length < 3) return 0
  return ((cross.length - 1) * sr) / (cross.at(-1)! - cross[0]!)
}

function peak(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

function rms(x: Float32Array): number {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / Math.max(1, x.length))
}

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
}

describe('snes presets', () => {
  const bank = PRESET_BANKS.snes
  it('has 20-30 unique snes.* presets, each with its recipe slot', () => {
    expect(bank).toBe(SNES_PRESETS)
    expect(bank.length).toBeGreaterThanOrEqual(20)
    expect(bank.length).toBeLessThanOrEqual(30)
    expect(new Set(bank.map((p) => p.id)).size).toBe(bank.length)
    for (const p of bank) {
      expect(p.id.startsWith('snes.')).toBe(true)
      expect(p.channelKinds).toEqual(['sample'])
      expect(p.sample?.source.kind, p.id).toBe('recipe')
      expect(p.instrument.kind).toBe('snes-sample')
    }
  })

  it('every preset resolves, validates and its base note matches its sample', () => {
    for (const p of bank) {
      const inst = resolvePreset('snes', p.id)
      expect(validateInstrument(inst), p.id).toEqual([])
      expect(inst.presetId).toBe(p.id)
      if (inst.kind !== 'snes-sample') throw new Error('kind')
      const src = p.sample!.source
      if (src.kind !== 'recipe') throw new Error('recipe')
      const g = generateSample(src.recipe, src.params)
      expect(inst.baseNote, p.id).toBe(g.baseNote)
      expect(g.brrBytes!, p.id).toBeLessThan(12000)
    }
  })

  it('role lookup finds sample presets and covers the planned roles', () => {
    const roles = new Set(bank.map((p) => p.role))
    for (const r of ['strings', 'choir', 'organ', 'flute', 'brass', 'pad', 'pluck', 'bell', 'bass', 'lead', 'kick', 'snare', 'hihat', 'openhat', 'crash', 'tom', 'clap']) expect(roles.has(r as never), r).toBe(true)
    expect(resolvePreset('snes', 'kick', 'sample').presetId).toBe('snes.kick.drum')
    expect(resolvePreset('snes', 'hat').presetId).toBe('snes.hat.closed')
  })

  it('missingPresetSample adds the slot once and re-uses it', () => {
    const song = createSong({ chip: 'snes' })
    const a = resolvePreset('snes', 'snes.brass.section')
    const slot = missingPresetSample(song, a)!
    expect(slot.id).toBe('brass')
    song.samples.push(slot)
    expect(missingPresetSample(song, resolvePreset('snes', 'snes.brass.stab'))).toBeUndefined()
    // same id but different content: a suffixed slot and the instrument points at it
    song.samples[0] = { ...slot, source: { kind: 'recipe', recipe: 'brass', params: { bright: 0.1 } } }
    const b = resolvePreset('snes', 'snes.brass.stab')
    const s2 = missingPresetSample(song, b)!
    expect(s2.id).toBe('brass-2')
    expect(b.kind === 'snes-sample' && b.sample).toBe('brass-2')
  })
})

describe('sample voice pitch', () => {
  it('plays base note, +-12 and the 14-bit limit in tune', () => {
    const song = snesSong(['snes.lead.square'])
    const base = 72
    for (const [note, expected] of [[base, midiToHz(base)], [base - 12, midiToHz(base - 12)], [base - 24, midiToHz(base - 24)], [base + 12, midiToHz(base + 12)]] as const) {
      const hz = measureHz(renderNote(song, note, 0.5).subarray(4410), SR)
      expect(hz / expected, `note ${note}`).toBeGreaterThan(0.985)
      expect(hz / expected, `note ${note}`).toBeLessThan(1.015)
    }
  })

  it('clamps the pitch register at 0x3FFF (4 octaves above native)', () => {
    const song = snesSong(['snes.lead.square'])
    const v = voiceOf(song)
    v.control(noteControl(72 + 40), song.instruments[0])
    expect(v.pitchRegister).toBe(0x3fff)
    const w = voiceOf(song)
    w.control(noteControl(72), song.instruments[0])
    const g = generateSample('lead', { wave: 'square' })
    expect(w.pitchRegister).toBe(Math.round((g.sampleRate / 32000) * 0x1000))
  })

  it('Gaussian interpolation preserves DC in a looping sample', () => {
    const song = createSong({ chip: 'snes', patternLength: 16, authenticity: 'relaxed' })
    song.orders = [song.channels.map(() => 0)]
    song.samples.push({ id: 'dc', name: 'dc', source: { kind: 'pcm', sampleRate: 32000, data: pcmToBase64(new Int16Array(512).fill(9000)) }, loopStart: 0 })
    song.instruments.push({ kind: 'snes-sample', name: 'dc', sample: 'dc', baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: false })
    const out = renderNote(song, 62, 0.5)
    const body = out.subarray(8000)
    const mean = body.reduce((a, b) => a + b, 0) / body.length
    expect(mean).toBeGreaterThan(0.05)
    expect(Math.sqrt(body.reduce((a, b) => a + (b - mean) ** 2, 0) / body.length) / mean).toBeLessThan(0.03)
  })
})

/** f0 by normalised autocorrelation with parabolic refinement. */
function autocorrHz(x: Float32Array, sr: number, minHz: number, maxHz: number): number {
  const minLag = Math.floor(sr / maxHz)
  const maxLag = Math.ceil(sr / minHz)
  const n = x.length - maxLag - 1
  const r = new Float64Array(maxLag + 2)
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0
    for (let i = 0; i < n; i++) s += x[i]! * x[i + lag]!
    r[lag] = s
  }
  let best = minLag
  for (let lag = minLag; lag <= maxLag; lag++) if (r[lag]! > r[best]!) best = lag
  const a = r[best - 1]!
  const b = r[best]!
  const c = r[best + 1]!
  const d = a - 2 * b + c
  return sr / (best + (d === 0 ? 0 : (0.5 * (a - c)) / d))
}

describe('pitched presets are in tune', () => {
  const pitched = ['snes.strings.ensemble', 'snes.choir.aah', 'snes.organ.drawbar', 'snes.flute.breathy', 'snes.brass.section', 'snes.pad.warm', 'snes.pluck.pizz', 'snes.pluck.harp', 'snes.pluck.guitar', 'snes.arp.epiano', 'snes.bass.synth', 'snes.bass.pick', 'snes.lead.saw']
  for (const id of pitched) {
    it(id + ' sounds at its base note and an octave above', () => {
      const song = snesSong([id])
      const base = (song.instruments[0] as { baseNote: number }).baseNote
      for (const note of [base, base + 12]) {
        const x = renderNote(song, note, 0.7)
        const target = midiToHz(note)
        const hz = autocorrHz(x.subarray(Math.round(0.08 * SR), Math.round(0.5 * SR)), SR, target * 0.7, target * 1.4)
        expect(hz / target, id + ' note ' + note).toBeGreaterThan(0.98)
        expect(hz / target, id + ' note ' + note).toBeLessThan(1.02)
      }
    })
  }
})

describe('envelopes', () => {
  function envTrace(song: Song, seconds: number, ctlOver: Partial<ReturnType<typeof newChannelControl>> = {}): number[] {
    const sr = 32000
    const v = voiceOf(song, 0, sr)
    v.control(noteControl(60, 1, ctlOver), song.instruments[0])
    const buf = new Float32Array(1)
    const trace: number[] = []
    for (let i = 0; i < seconds * sr; i++) {
      v.render(buf, 0, 1)
      trace.push(v.envelopeLevel)
    }
    return trace
  }
  const organSong = (env: object): Song => {
    const s = snesSong(['snes.organ.drawbar'])
    Object.assign(s.instruments[0]!, { env })
    return s
  }

  it('attack time follows the rate table', () => {
    for (const ar of [8, 11, 13]) {
      const trace = envTrace(organSong({ adsr: [ar, 7, 7, 0] }), 0.5)
      const reached = trace.findIndex((e) => e >= 0x7e0)
      const expected = 63 * SNES_RATE_PERIODS[ar * 2 + 1]!
      expect(reached, `AR ${ar}`).toBeGreaterThan(expected * 0.9)
      expect(reached, `AR ${ar}`).toBeLessThan(expected * 1.1 + 20)
    }
    // AR 15 is instant (two steps)
    expect(envTrace(organSong({ adsr: [15, 7, 7, 0] }), 0.01).findIndex((e) => e >= 0x7e0)).toBeLessThan(4)
  })

  it('decays to the sustain level and holds it with sustain rate 0', () => {
    const trace = envTrace(organSong({ adsr: [15, 7, 3, 0] }), 1)
    const end = trace.at(-1)!
    expect(end >> 8).toBe(3)
    expect(Math.abs(end - trace[trace.length - 4000]!)).toBeLessThanOrEqual(1)
  })

  it('sustain rate decays exponentially', () => {
    const trace = envTrace(organSong({ adsr: [15, 7, 7, 20] }), 1.5)
    expect(trace[16000]!).toBeLessThan(trace[4000]!)
    expect(trace[40000]!).toBeLessThan(trace[16000]!)
  })

  it('GAIN modes: direct level, linear increase, exponential decrease', () => {
    const direct = envTrace(organSong({ gain: { mode: 'direct', rate: 64 } }), 0.05)
    expect(direct.at(-1)).toBe(1024)
    const inc = envTrace(organSong({ gain: { mode: 'linear-inc', rate: 20 } }), 0.2)
    expect(inc[100]!).toBeGreaterThan(0)
    expect(inc[3000]!).toBeGreaterThan(inc[100]!)
    const dec = envTrace(organSong({ gain: { mode: 'exp-dec', rate: 20 } }), 0.5)
    expect(dec[0]!).toBeGreaterThan(1900)
    expect(dec.at(-1)!).toBeLessThan(dec[1000]!)
  })

  it('release: off drops at 8 per step, rel decays softly, gate-off rate difference is audible', () => {
    const sr = 32000
    const song = organSong({ adsr: [15, 7, 7, 0] })
    const run = (release: boolean): number[] => {
      const v = voiceOf(song, 0, sr)
      v.control(noteControl(60), song.instruments[0])
      const buf = new Float32Array(1)
      for (let i = 0; i < 2000; i++) v.render(buf, 0, 1)
      const off = newChannelControl()
      off.trigger = false
      off.gate = false
      off.release = release
      off.freqHz = midiToHz(60)
      off.note = 60
      off.inst = 0
      v.control(off, song.instruments[0])
      const tr: number[] = []
      for (let i = 0; i < 16000; i++) {
        v.render(buf, 0, 1)
        tr.push(v.envelopeLevel)
      }
      return tr
    }
    const hard = run(false)
    expect(hard.findIndex((e) => e === 0)).toBeGreaterThan(200)
    expect(hard.findIndex((e) => e === 0)).toBeLessThan(300)
    const soft = run(true)
    expect(soft[255]!).toBeGreaterThan(1000)
    expect(soft.findIndex((e) => e === 0)).toBeGreaterThan(2000)
  })

  it('a retrigger on a sounding voice declicks through a fast release, then restarts', () => {
    const sr = 32000
    const song = organSong({ adsr: [15, 7, 7, 0] })
    const v = voiceOf(song, 0, sr)
    v.control(noteControl(60), song.instruments[0])
    const buf = new Float32Array(1)
    for (let i = 0; i < 2000; i++) v.render(buf, 0, 1)
    v.control(noteControl(64), song.instruments[0])
    const levels: number[] = []
    for (let i = 0; i < 100; i++) {
      v.render(buf, 0, 1)
      levels.push(v.envelopeLevel)
    }
    expect(Math.min(...levels.slice(0, 40))).toBeLessThan(200)
    expect(levels.at(-1)!).toBeGreaterThan(1500)
  })
})

describe('echo', () => {
  function echoSong(over: Partial<{ delay: number; feedback: number; volL: number; volR: number; fir: number[] }>): Song {
    const s = createSong({ chip: 'snes' })
    const cfg = s.chipConfig as unknown as { echo: Record<string, unknown> }
    Object.assign(cfg.echo, { delay: 2, feedback: 0.5, volL: 0.5, volR: 0.5, fir: [0, 0, 0, 0, 0, 0, 0, 1] }, over)
    return s
  }

  it('an impulse repeats after delay x 16 ms with the feedback ratio', () => {
    const e = new EchoBus(32000, 4096)
    e.configure(echoSong({ delay: 2, feedback: 0.5 }))
    const N = 2 * 512
    const L = new Float32Array(4096)
    const R = new Float32Array(4096)
    e.sendL[0] = 1
    e.steps = 4096
    e.render(L, R, 4096)
    let first = 0
    for (let i = 0; i < 4096; i++) if (Math.abs(L[i]!) > Math.abs(L[first]!)) first = i
    // output latency of the resampler is a few frames at 1:1
    expect(Math.abs(first - N)).toBeLessThanOrEqual(4)
    expect(L[first]!).toBeCloseTo(0.5, 2)
    expect(L[first + N]!).toBeCloseTo(0.25, 2)
    expect(L[first + 2 * N]!).toBeCloseTo(0.125, 2)
    expect(Math.abs(R[first]!)).toBe(0)
    // 32 ms = 2 steps of 16 ms
    expect(first / 32000).toBeCloseTo(0.032, 3)
  })

  it('FIR taps shape the repeats and echo volume scales them', () => {
    const e = new EchoBus(32000, 4096)
    e.configure(echoSong({ delay: 1, feedback: 0, volL: 1, volR: 0, fir: [0, 0, 0, 0, 0, 0, 0.5, 0.5] }))
    const L = new Float32Array(2048)
    const R = new Float32Array(2048)
    e.sendL[0] = 1
    e.steps = 2048
    e.render(L, R, 2048)
    const hits = Array.from(L).flatMap((v, i) => (Math.abs(v) > 0.01 ? [i] : []))
    expect(hits.length).toBe(2)
    expect(hits[1]! - hits[0]!).toBe(1)
    expect(L[hits[0]!]).toBeCloseTo(0.5, 3)
    expect(peak(R)).toBe(0)
  })

  it('a note with echo on produces a tail in the _echo stem, with echo off the stem is silent', () => {
    const make = (echo: boolean): Song => {
      const s = snesSong(['snes.pluck.harp'], 16)
      ;(s.instruments[0] as { echo: boolean }).echo = echo
      put(s, 'V1', 0, 0, { note: 60, inst: 0, vol: 15 })
      return s
    }
    const on = renderSong(make(true), { sampleRate: SR, stems: true })
    expect(Object.keys(on.stems!)).toContain('_echo')
    expect(rms(on.stems!['_echo']!.L)).toBeGreaterThan(0.002)
    // the echo arrives after the delay (4 x 16 ms = 64 ms): the first 50 ms are silent
    expect(peak(on.stems!['_echo']!.L.subarray(0, Math.round(0.05 * SR)))).toBeLessThan(1e-6)
    expect(peak(on.stems!['_echo']!.L.subarray(Math.round(0.07 * SR), Math.round(0.4 * SR)))).toBeGreaterThan(0.01)
    const off = renderSong(make(false), { sampleRate: SR, stems: true })
    expect(peak(off.stems!['_echo']!.L)).toBeLessThan(1e-6)
    expect(peak(off.stems!['V1']!.L)).toBeGreaterThan(0.05)
  })

  it('Exx overrides the instrument per channel and a muted channel does not feed the echo', () => {
    const s = snesSong(['snes.pluck.harp'])
    ;(s.instruments[0] as { echo: boolean }).echo = true
    put(s, 'V1', 0, 0, { note: 60, inst: 0, vol: 15, fx: [{ code: 'E', param: 0 }] })
    const r = renderSong(s, { sampleRate: SR, stems: true })
    expect(peak(r.stems!['_echo']!.L)).toBeLessThan(1e-6)
    const s2 = snesSong(['snes.pluck.harp'])
    ;(s2.instruments[0] as { echo: boolean }).echo = false
    put(s2, 'V1', 0, 0, { note: 60, inst: 0, vol: 15, fx: [{ code: 'E', param: 1 }] })
    expect(peak(renderSong(s2, { sampleRate: SR, stems: true }).stems!['_echo']!.L)).toBeGreaterThan(0.01)
    const s3 = snesSong(['snes.pluck.harp'])
    put(s3, 'V1', 0, 0, { note: 60, inst: 0, vol: 15 })
    const p = new SongPlayer(s3, SR)
    p.setMute(0, true)
    const L = new Float32Array(SR)
    p.process(L, new Float32Array(SR))
    expect(peak(L)).toBe(0)
  })

  it('stems plus the echo stem add up to the master (linear model)', () => {
    const s = demoSong()
    const r = renderSong(s, { sampleRate: SR, stems: true })
    expect(peak(r.L)).toBeLessThan(0.8)
    let maxDiff = 0
    for (let i = 0; i < r.L.length; i++) {
      let sl = 0
      for (const st of Object.values(r.stems!)) sl += st.L[i]!
      maxDiff = Math.max(maxDiff, Math.abs(sl - r.L[i]!))
    }
    expect(maxDiff).toBeLessThan(1e-4)
  })
})

function demoSong(): Song {
  const s = snesSong(['snes.strings.ensemble', 'snes.bass.synth', 'snes.pluck.harp', 'snes.kick.drum', 'snes.snare.drum', 'snes.hat.closed', 'snes.lead.saw'], 16)
  s.timing.bpm = 120
  for (const [r, n] of [[0, 57], [8, 60]] as const) put(s, 'V2', 0, r, { note: n, inst: 0, vol: 11 })
  put(s, 'V2', 0, 14, { note: 'rel' })
  for (const [r, n] of [[0, 33], [4, 33], [8, 36], [12, 31]] as const) put(s, 'V1', 0, r, { note: n, inst: 1, vol: 14 })
  const arp = [69, 72, 76, 72, 69, 72, 76, 81]
  arp.forEach((n, i) => put(s, 'V3', 0, i * 2, { note: n, inst: 2, vol: 10, fx: i === 0 ? [{ code: 'X', param: 0x30 }] : undefined }))
  for (const r of [0, 6, 10]) put(s, 'V7', 0, r, { note: 60, inst: 3, vol: 15 })
  for (const r of [4, 12]) put(s, 'V8', 0, r, { note: 60, inst: 4, vol: 13 })
  for (let r = 0; r < 16; r += 2) put(s, 'V6', 0, r, { note: 60, inst: 5, vol: 7 })
  put(s, 'V4', 0, 0, { note: 81, inst: 6, vol: 12, fx: [{ code: 'X', param: 0xd0 }] })
  put(s, 'V4', 0, 8, { note: 76 })
  put(s, 'V4', 0, 14, { note: 'off' })
  return s
}

describe('determinism and block parity', () => {
  it('two renders are bit-identical', () => {
    const a = renderSong(demoSong(), { sampleRate: SR, stems: true })
    const b = renderSong(demoSong(), { sampleRate: SR, stems: true })
    expect(bytesEqual(a.L, b.L)).toBe(true)
    expect(bytesEqual(a.R, b.R)).toBe(true)
    expect(bytesEqual(a.stems!['_echo']!.L, b.stems!['_echo']!.L)).toBe(true)
    expect(peak(a.L)).toBeGreaterThan(0.05)
  })

  it('128-frame and odd blocks give exactly the offline render', () => {
    const song = demoSong()
    const ref = renderSong(song, { sampleRate: SR })
    for (const sizes of [[128], [1, 7, 333, 1000, 129]]) {
      const L = new Float32Array(ref.L.length)
      const R = new Float32Array(ref.R.length)
      const p = new SongPlayer(song, SR, { maxBlock: 256 })
      let off = 0
      let i = 0
      while (off < L.length) {
        const end = Math.min(L.length, off + sizes[i++ % sizes.length]!)
        p.process(L.subarray(off, end), R.subarray(off, end))
        off = end
      }
      expect(bytesEqual(L, ref.L), `blocks ${sizes.join(',')}`).toBe(true)
      expect(bytesEqual(R, ref.R)).toBe(true)
    }
  })

  it('renders at 48 kHz and loops with a smpl seam; setSong hot-swaps samples', () => {
    const song = demoSong()
    song.loop = { order: 0 }
    const r = renderSong(song, { sampleRate: 48000 })
    expect(r.loopStart).not.toBeNull()
    expect(peak(r.L)).toBeGreaterThan(0.05)
    const p = new SongPlayer(demoSong(), SR)
    p.process(new Float32Array(2000), new Float32Array(2000))
    const edited = demoSong()
    edited.samples.push({ id: 'extra', name: 'extra', source: { kind: 'recipe', recipe: 'bell', params: {} } })
    edited.instruments.push({ kind: 'snes-sample', name: 'x', sample: 'extra', baseNote: 72, env: { adsr: [15, 7, 7, 0] }, echo: true })
    put(edited, 'V5', 0, 6, { note: 72, inst: 7, vol: 12 })
    p.setSong(edited)
    const L = new Float32Array(SR)
    p.process(L, new Float32Array(SR))
    expect(peak(L)).toBeGreaterThan(0.05)
  })
})

describe('ARAM budget', () => {
  it('accepts the demo song and rejects an oversized one with a fix', () => {
    const profile = getChipProfile('snes')
    expect(profile.validate(demoSong()).filter((i) => i.severity === 'error')).toEqual([])
    const big = createSong({ chip: 'snes', patternLength: 16 })
    for (let i = 0; i < 3; i++) {
      big.samples.push({ id: `c${i}`, name: `c${i}`, source: { kind: 'recipe', recipe: 'crash', params: { seconds: 2, seed: i + 1 } } })
      big.instruments.push({ kind: 'snes-sample', name: `c${i}`, sample: `c${i}`, baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: false })
    }
    const issues = profile.validate(big)
    const err = issues.find((i) => /ARAM budget exceeded/.test(i.message))
    expect(err).toBeDefined()
    expect(err!.severity).toBe('error')
    expect(err!.message).toMatch(/lower the echo delay|shorten/)
  })
})

describe('golden hash', () => {
  const goldenPath = join(__dirname, 'golden-snes.json')
  const update = process.env.UPDATE_GOLDEN === '1'
  const hashOf = (r: RenderResult): string => {
    const q = quantizeStereo(r.L, r.R)
    const inter = interleave(q.L, q.R)
    return createHash('sha256').update(Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength)).digest('hex')
  }
  it('snes demo song (UPDATE_GOLDEN=1 regenerates)', () => {
    const golden: Record<string, string> = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>) : {}
    const r = renderSong(demoSong(), { sampleRate: SR })
    const h = hashOf(r)
    if (update) {
      golden['snes'] = h
      writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n')
      return
    }
    if (golden['snes'] !== h) {
      const dir = join(process.cwd(), '.claude', 'temp')
      mkdirSync(dir, { recursive: true })
      const q = quantizeStereo(r.L, r.R)
      const file = join(dir, 'golden-snes-actual.wav')
      writeFileSync(file, writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R] }))
      throw new Error(`Golden hash mismatch for snes: expected ${golden['snes']}, got ${h}. Listen to ${file}; run with UPDATE_GOLDEN=1 if the change is intended.`)
    }
    expect(h).toBe(golden['snes'])
  })
})
