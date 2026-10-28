import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createSong, getChipProfile, resolvePreset, missingPresetSample, validateInstrument, aicaAttackSeconds, aicaFallSeconds } from '../../../src/core'
import { aicaRamUsage } from '../../../src/core/chips/dreamcast'
import { writeWav } from '../../../src/core/codecs/wav'
import { AicaVoice } from '../../../src/core/synth/chips/aica'
import { AicaDspBus, AICA_DSP_INFO, dspRamBytes } from '../../../src/core/synth/chips/aicaDsp'
import { ALFO_DB, LFO_HZ, PLFO_CENTS, aicaQuantizePan, aicaTlGain, flvToHz } from '../../../src/core/synth/chips/aicaTables'
import { createVoice, isChipPlayable } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { interleave, mixProfileFor, quantizeStereo } from '../../../src/core/synth/mixer'
import { SongPlayer } from '../../../src/core/synth/player'
import { type RenderResult, renderSong } from '../../../src/core/synth/render'
import { aicaByteSize, generateRaw, pcmToBase64, resolveSlot, snrDb } from '../../../src/core/synth/samplegen'
import { ADPCM_STEP_MAX, decodeAicaAdpcm, encodeAicaAdpcm } from '../../../src/core/synth/samplegen/aicaAdpcm'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import { midiToHz } from '../../../src/core/synth/tables'
import { DREAMCAST_BASELINE_PRESETS } from '../../../src/core/instruments/presets/dreamcast'
import { DC_DSP_PRESETS, type AicaSampleInstrument, type DreamcastConfig, type SampleSlot, type Song } from '../../../src/core/types'
import { put } from './fixtures'

const SR = 44100

// ---------------------------------------------------------------------------------------------
// helpers

function dcSong(presets: string[], patternLength = 16, voices: 16 | 32 | 64 = 16): Song {
  const s = createSong({ chip: 'dreamcast', patternLength, authenticity: 'relaxed', chipConfig: { voices } as never })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  for (const id of presets) {
    const inst = resolvePreset('dreamcast', id)
    const slot = missingPresetSample(s, inst)
    if (slot) s.samples.push(slot)
    s.instruments.push(inst)
  }
  return s
}

/** A looping sine sample at 440 Hz (44100 samples = 440 whole cycles), base note A4. */
function sineSlot(id = 'sine'): SampleSlot {
  const pcm = new Int16Array(SR)
  for (let i = 0; i < SR; i++) pcm[i] = Math.round(Math.sin((2 * Math.PI * 440 * i) / SR) * 20000)
  return { id, name: id, source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(pcm) }, loopStart: 0 }
}

/** A looping deterministic noise sample (flat spectrum). */
function noiseSlot(id = 'noise'): SampleSlot {
  const pcm = new Int16Array(16384)
  let x = 12345
  for (let i = 0; i < pcm.length; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    pcm[i] = (x >>> 16) - 32768 >> 1
  }
  return { id, name: id, source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(pcm) }, loopStart: 0 }
}

function aica(over: Partial<AicaSampleInstrument> = {}): AicaSampleInstrument {
  return { kind: 'aica-sample', name: 'i', sample: 'sine', baseNote: 69, format: 'pcm16', aeg: { ar: 31, d1r: 0, d2r: 0, rr: 20, dl: 0 }, send: 0, ...over }
}

/** A one-instrument song around a sample slot. */
function oneInst(inst: AicaSampleInstrument, slot: SampleSlot = sineSlot()): Song {
  const s = createSong({ chip: 'dreamcast', patternLength: 16, authenticity: 'relaxed' })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  s.samples.push(slot)
  s.instruments.push(inst)
  return s
}

function voiceOf(song: Song, index = 0, sampleRate = SR): AicaVoice {
  return createVoice({ song, channel: song.channels[index]!, index, sampleRate, maxBlock: 4096 }) as AicaVoice
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

function releaseControl(midi: number, soft: boolean): ReturnType<typeof newChannelControl> {
  const c = newChannelControl()
  c.release = soft
  c.freqHz = midiToHz(midi)
  c.note = midi
  c.inst = 0
  return c
}

function renderVoice(v: AicaVoice, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let off = 0; off < n; off += 4096) v.render(out.subarray(off, Math.min(n, off + 4096)), 0, Math.min(4096, n - off))
  return out
}

function renderNote(song: Song, midi: number, seconds: number, over: Partial<ReturnType<typeof newChannelControl>> = {}): Float32Array {
  const v = voiceOf(song)
  v.control(noteControl(midi, 1, over), song.instruments[0])
  return renderVoice(v, Math.round(seconds * SR))
}

/** Frame-by-frame trace of a voice (one DSP step per frame at 44.1 kHz). */
function trace(v: AicaVoice, frames: number, read: (v: AicaVoice) => number): number[] {
  const buf = new Float32Array(1)
  const out: number[] = []
  for (let i = 0; i < frames; i++) {
    v.render(buf, 0, 1)
    out.push(read(v))
  }
  return out
}

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

function measureHz(x: Float32Array, sr: number): number {
  const cross = crossings(x)
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

/** Power of `x` around `hz` (Goertzel over a few bins in +-15%). */
function bandPower(x: Float32Array, hz: number, sr = SR): number {
  let total = 0
  for (let b = -3; b <= 3; b++) {
    const f = hz * (1 + b * 0.05)
    const w = (2 * Math.PI * f) / sr
    const c = 2 * Math.cos(w)
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < x.length; i++) {
      const s0 = x[i]! + c * s1 - s2
      s2 = s1
      s1 = s0
    }
    total += s1 * s1 + s2 * s2 - c * s1 * s2
  }
  return total / (x.length * x.length)
}

// ---------------------------------------------------------------------------------------------

describe('aica sample formats', () => {
  const slot: SampleSlot = { id: 'pad', name: 'pad', source: { kind: 'recipe', recipe: 'strings', params: {} } }

  it('pcm16 is the generated sample bit-exact', () => {
    const raw = generateRaw('strings', {})
    const r = resolveSlot(slot, 'aica16')
    expect(Buffer.compare(Buffer.from(r.pcm.buffer, r.pcm.byteOffset, r.pcm.byteLength), Buffer.from(raw.pcm.buffer, raw.pcm.byteOffset, raw.pcm.byteLength))).toBe(0)
    expect(r.sampleRate).toBe(raw.sampleRate)
    expect(r.loopStart).toBe(raw.loopStart)
    expect(aicaByteSize('pcm16', r.pcm.length)).toBe(r.pcm.length * 2)
  })

  it('pcm8 keeps the top 8 bits: error within one 8-bit step, values are multiples of 256', () => {
    const raw = generateRaw('strings', {})
    const r = resolveSlot(slot, 'aica8')
    expect(r.pcm.length).toBe(raw.pcm.length)
    let worst = 0
    for (let i = 0; i < raw.pcm.length; i++) {
      expect(r.pcm[i]! % 256 === 0).toBe(true)
      worst = Math.max(worst, Math.abs(r.pcm[i]! - raw.pcm[i]!))
    }
    expect(worst).toBeLessThanOrEqual(256)
    expect(snrDb(raw.pcm, r.pcm)).toBeGreaterThan(30)
    expect(aicaByteSize('pcm8', r.pcm.length)).toBe(r.pcm.length)
  })

  it('adpcm round trip: SNR above 20 dB, half a byte per sample, loop kept, deterministic', () => {
    const raw = generateRaw('strings', {})
    const r = resolveSlot(slot, 'aica-adpcm')
    expect(r.pcm.length).toBe(raw.pcm.length)
    expect(r.loopStart).toBe(raw.loopStart)
    expect(snrDb(raw.pcm, r.pcm)).toBeGreaterThan(20)
    expect(aicaByteSize('adpcm', r.pcm.length)).toBe(Math.ceil(r.pcm.length / 2))
    const again = encodeAicaAdpcm(raw.pcm)
    expect(Buffer.compare(Buffer.from(again.decoded.buffer), Buffer.from(r.pcm.buffer))).toBe(0)
    expect(again.bytes.length).toBe(Math.ceil(raw.pcm.length / 2))
  })

  it('the ADPCM decoder follows the documented step table on hand-made codes', () => {
    // step 127: code 0 = +((1 * 127) >> 3) = +15, next step 127 * 57 >> 6 = 113 -> clamped to 127
    // code 7 = +((15 * 127) >> 3) = +238 (253 in all), next step (127 * 153) >> 6 = 303
    // code 0xF = -((15 * 303) >> 3) = -568, next step (303 * 153) >> 6 = 724, code 0 = +((1 * 724) >> 3) = +90
    const out = decodeAicaAdpcm(Uint8Array.from([0x70, 0x0f]), 4)
    expect(Array.from(out)).toEqual([15, 253, -315, -225])
    // the step never leaves 127..24576 and the signal saturates at 16 bits
    const loud = decodeAicaAdpcm(new Uint8Array(200).fill(0x77), 400)
    expect(loud.every((v) => v >= -32768 && v <= 32767)).toBe(true)
    expect(Math.max(...loud)).toBe(32767)
    expect(ADPCM_STEP_MAX).toBe(24576)
  })

  it('the encoder tracks a step edge and a silent input without blowing up', () => {
    const edge = new Int16Array(400)
    edge.fill(12000, 200)
    const enc = encodeAicaAdpcm(edge)
    expect(Math.abs(enc.decoded[399]! - 12000)).toBeLessThan(400)
    const sil = encodeAicaAdpcm(new Int16Array(100))
    expect(peak(Float32Array.from(sil.decoded))).toBeLessThan(40)
  })
})

describe('chip registration', () => {
  it('is playable, validates presets and renders non-silent audio on every format', () => {
    expect(isChipPlayable('dreamcast')).toBe(true)
    for (const format of ['pcm16', 'pcm8', 'adpcm'] as const) {
      const song = oneInst(aica({ format }))
      expect(validateInstrument(song.instruments[0]!)).toEqual([])
      const out = renderNote(song, 69, 0.3)
      expect(peak(out)).toBeGreaterThan(0.1)
      const hz = measureHz(out.subarray(2000), SR)
      expect(hz / 440, format).toBeGreaterThan(0.985)
      expect(hz / 440, format).toBeLessThan(1.015)
    }
  })

  it('plays each format through its own pipeline (the target follows the instrument)', () => {
    const slot: SampleSlot = { id: 'sine', name: 'sine', source: { kind: 'recipe', recipe: 'strings', params: {} }, loopStart: 0 }
    const render = (format: 'pcm16' | 'adpcm'): Float32Array => renderNote(oneInst(aica({ format, baseNote: 60 }), slot), 60, 0.2)
    const a = render('pcm16')
    const b = render('adpcm')
    expect(bytesEqual(a, b)).toBe(false)
    expect(peak(a)).toBeGreaterThan(0.05)
    expect(peak(b)).toBeGreaterThan(0.05)
    expect(snrDb(a, b)).toBeGreaterThan(12)
  })
})

describe('pitch (OCT / FNS)', () => {
  it('plays the base note, +-12 and +-24 in tune', () => {
    const song = oneInst(aica())
    for (const note of [69, 57, 45, 81, 93]) {
      const hz = measureHz(renderNote(song, note, 0.5).subarray(2000), SR)
      expect(hz / midiToHz(note), `note ${note}`).toBeGreaterThan(0.99)
      expect(hz / midiToHz(note), `note ${note}`).toBeLessThan(1.01)
    }
  })

  it('quantises the pitch to OCT and a 10-bit FNS (error below half an FNS step)', () => {
    const song = oneInst(aica())
    const v = voiceOf(song)
    for (let semis = -30; semis <= 40; semis += 0.37) {
      const f = midiToHz(69) * 2 ** (semis / 12)
      v.control(noteControl(69, 1, { freqHz: f, trigger: semis === -30 }), song.instruments[0])
      const want = f / midiToHz(69)
      expect(v.octave).toBeGreaterThanOrEqual(-8)
      expect(v.octave).toBeLessThanOrEqual(7)
      expect(v.fnsRegister).toBeGreaterThanOrEqual(0)
      expect(v.fnsRegister).toBeLessThanOrEqual(1023)
      const got = v.pitchRegister / 0x1000
      expect(Math.abs(got / want - 1), `semis ${semis}`).toBeLessThan(0.5 / 1024 + 1e-9)
      expect(v.pitchRegister).toBeCloseTo((1024 + v.fnsRegister) * 4 * 2 ** v.octave, 6)
    }
  })

  it('a native-rate note is OCT 0, FNS 0; an octave up is OCT 1, FNS 0', () => {
    const song = oneInst(aica())
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    expect([v.octave, v.fnsRegister, v.pitchRegister]).toEqual([0, 0, 0x1000])
    v.control(noteControl(81, 1, { trigger: false }), song.instruments[0])
    expect([v.octave, v.fnsRegister, v.pitchRegister]).toEqual([1, 0, 0x2000])
  })
})

describe('AEG', () => {
  const held = (aeg: Partial<AicaSampleInstrument['aeg']>): Song => oneInst(aica({ aeg: { ar: 31, d1r: 0, d2r: 0, rr: 20, dl: 0, ...aeg } }))

  it('the rate tables follow the documented anchors', () => {
    expect(aicaAttackSeconds(1)).toBeCloseTo(8.1, 2)
    expect(aicaFallSeconds(1)).toBeCloseTo(118.2, 1)
    expect(aicaFallSeconds(3)).toBeCloseTo(59.1, 1) // two register steps = one halving
    expect(aicaFallSeconds(2)).toBeCloseTo(88.65, 1)
    expect(aicaAttackSeconds(31)).toBe(0)
    expect(aicaAttackSeconds(0)).toBe(Infinity)
  })

  it('attack time follows the rate table; AR 31 is instant', () => {
    for (const ar of [14, 17, 20]) {
      const song = held({ ar })
      const v = voiceOf(song)
      v.control(noteControl(69), song.instruments[0])
      const t = trace(v, Math.round(SR * 1), (x) => x.attenuation)
      const reached = t.findIndex((a) => a === 0)
      const want = aicaAttackSeconds(ar) * SR
      expect(reached, `AR ${ar}`).toBeGreaterThan(want * 0.95)
      expect(reached, `AR ${ar}`).toBeLessThan(want * 1.05 + 3)
    }
    const song = held({ ar: 31 })
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    expect(trace(v, 3, (x) => x.attenuation)[0]).toBe(0)
  })

  it('the attack rises in the attenuation domain (fast at first in dB, level reached at the table time)', () => {
    const song = held({ ar: 16 })
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    const t = trace(v, Math.round(aicaAttackSeconds(16) * SR) + 20, (x) => x.attenuation)
    expect(t[0]!).toBeGreaterThan(1000)
    expect(t.at(-1)!).toBe(0)
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeLessThanOrEqual(t[i - 1]!)
  })

  it('D2R decays 96 dB in the documented time (D1 skipped with DL 0)', () => {
    for (const d2r of [16, 20, 24]) {
      const song = held({ d2r })
      const v = voiceOf(song)
      v.control(noteControl(69), song.instruments[0])
      const t = trace(v, Math.round(SR * 2), (x) => x.attenuation)
      const gone = t.findIndex((a) => a >= 1023)
      const want = aicaFallSeconds(d2r) * SR
      expect(gone, `D2R ${d2r}`).toBeGreaterThan(want * 0.97)
      expect(gone, `D2R ${d2r}`).toBeLessThan(want * 1.03 + 3)
    }
  })

  it('D1R falls to the DL level (3 dB per step) and D2R 0 holds it', () => {
    const song = held({ d1r: 22, dl: 10, d2r: 0 })
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    const t = trace(v, SR, (x) => x.attenuation)
    const end = t.at(-1)!
    expect(end).toBeGreaterThanOrEqual(10 * 32)
    expect(end).toBeLessThan(10 * 32 + 5)
    expect(Math.abs(end - t[t.length - 5000]!)).toBeLessThan(0.01)
    expect(Math.abs(end * 0.09375 - 30)).toBeLessThan(0.5) // 30 dB
  })

  it('D1R 0 and D2R 0 hold full level; the voice stays active', () => {
    const song = held({})
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    const t = trace(v, 20000, (x) => x.attenuation)
    expect(Math.max(...t)).toBe(0)
  })

  it('release (^^^) uses RR, a hard off cuts in about 6 ms, then the voice is idle', () => {
    for (const [soft, rr] of [[true, 18], [true, 22]] as const) {
      const song = held({ rr })
      const v = voiceOf(song)
      v.control(noteControl(69), song.instruments[0])
      trace(v, 500, (x) => x.attenuation)
      v.control(releaseControl(69, soft), song.instruments[0])
      const t = trace(v, SR, (x) => x.attenuation)
      const gone = t.findIndex((a) => a >= 1023)
      const want = aicaFallSeconds(rr) * SR
      expect(gone, `RR ${rr}`).toBeGreaterThan(want * 0.97)
      expect(gone, `RR ${rr}`).toBeLessThan(want * 1.03 + 3)
    }
    const song = held({ rr: 18 })
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    trace(v, 500, (x) => x.attenuation)
    v.control(releaseControl(69, false), song.instruments[0])
    const t = trace(v, 1000, (x) => x.attenuation)
    const gone = t.findIndex((a) => a >= 1023)
    expect(gone).toBeGreaterThan(200)
    expect(gone).toBeLessThan(300)
    expect(peak(renderVoice(v, 2000))).toBe(0)
  })

  it('key rate scaling speeds up higher notes', () => {
    const time = (note: number, krs: number | undefined): number => {
      const song = oneInst(aica({ aeg: { ar: 31, d1r: 0, d2r: 12, rr: 20, dl: 0, ...(krs !== undefined ? { krs } : {}) } }))
      const v = voiceOf(song)
      v.control(noteControl(note), song.instruments[0])
      return trace(v, SR * 3, (x) => x.attenuation).findIndex((a) => a >= 1023)
    }
    expect(time(81, undefined)).toBe(time(57, undefined))
    expect(time(81, 4)).toBeLessThan(time(57, 4))
    expect(time(81, 15)).toBe(time(81, undefined))
  })

  it('a retrigger on a sounding voice declicks quickly, then restarts at full level', () => {
    const song = held({})
    const v = voiceOf(song)
    v.control(noteControl(69), song.instruments[0])
    trace(v, 2000, (x) => x.attenuation)
    v.control(noteControl(72), song.instruments[0])
    const t = trace(v, 100, (x) => x.attenuation)
    expect(Math.max(...t.slice(0, 40))).toBeGreaterThan(900)
    expect(t.at(-1)!).toBe(0)
  })

  it('AR 0 never sounds; a one-shot sample that ends silences the slot', () => {
    const song = held({ ar: 0 })
    expect(peak(renderNote(song, 69, 0.2))).toBe(0)
    const shot = oneInst(aica(), { ...sineSlot('s'), loopStart: undefined, source: { kind: 'pcm', sampleRate: SR, data: pcmToBase64(new Int16Array(500).fill(9000)) } })
    shot.instruments[0] = aica({ sample: 's' })
    const out = renderNote(shot, 69, 0.1)
    expect(peak(out.subarray(1000))).toBe(0)
    expect(peak(out.subarray(0, 400))).toBeGreaterThan(0.1)
  })
})

describe('volume and pan', () => {
  it('cell volume goes through the 0.375 dB TL steps', () => {
    expect(aicaTlGain(1)).toBe(1)
    expect(aicaTlGain(0)).toBe(0)
    expect(aicaTlGain(0.5)).toBeCloseTo(0.5, 1)
    const g = aicaTlGain(0.3)
    expect(Math.abs(20 * Math.log10(g) - 20 * Math.log10(0.3))).toBeLessThanOrEqual(0.19)
    expect(aicaTlGain(g)).toBe(g)
  })

  it('pan is quantised to 16 steps per side by the mix profile', () => {
    const q = mixProfileFor('dreamcast').quantizePan!
    expect(q).toBe(aicaQuantizePan)
    expect(q(0)).toBe(0)
    expect(q(1)).toBe(1)
    expect(q(-1)).toBe(-1)
    const levels = new Set<number>()
    for (let p = 0; p <= 1; p += 0.001) levels.add(q(p))
    expect(levels.size).toBe(16)
    expect(q(0.3)).toBeCloseTo(Math.round(0.3 * 15) / 15, 10)
  })
})

describe('LFO', () => {
  const lfo = (over: Partial<NonNullable<AicaSampleInstrument['lfo']>>): AicaSampleInstrument['lfo'] => ({
    freq: 20,
    pitchWave: 'tri',
    pitchDepth: 0,
    ampWave: 'tri',
    ampDepth: 0,
    reset: true,
    ...over
  })

  it('the tables have 32 / 8 entries and are monotonic', () => {
    expect(LFO_HZ).toHaveLength(32)
    expect(PLFO_CENTS).toHaveLength(8)
    expect(ALFO_DB).toHaveLength(8)
    for (const t of [LFO_HZ, PLFO_CENTS, ALFO_DB]) for (let i = 1; i < t.length; i++) expect(t[i]!).toBeGreaterThan(t[i - 1]!)
  })

  it('pitch depth sets the measured vibrato range', () => {
    for (const depth of [3, 5]) {
      const song = oneInst(aica({ lfo: lfo({ pitchDepth: depth }) }))
      const out = renderNote(song, 69, 1)
      const cross = crossings(out.subarray(4410))
      const cents: number[] = []
      for (let i = 1; i < cross.length; i++) cents.push(1200 * Math.log2(SR / (cross[i]! - cross[i - 1]!) / 440))
      const hi = Math.max(...cents)
      const lo = Math.min(...cents)
      expect(hi, `depth ${depth}`).toBeGreaterThan(PLFO_CENTS[depth]! * 0.85)
      expect(hi, `depth ${depth}`).toBeLessThan(PLFO_CENTS[depth]! * 1.15)
      expect(lo, `depth ${depth}`).toBeLessThan(-PLFO_CENTS[depth]! * 0.85)
      expect(lo, `depth ${depth}`).toBeGreaterThan(-PLFO_CENTS[depth]! * 1.15)
    }
    // depth 0 is a steady pitch
    const flat = oneInst(aica({ lfo: lfo({ pitchDepth: 0 }) }))
    const cross = crossings(renderNote(flat, 69, 0.5).subarray(4410))
    const per = cross.slice(1).map((c, i) => c - cross[i]!)
    expect(Math.max(...per) - Math.min(...per)).toBeLessThan(0.2)
  })

  it('amplitude depth sets the measured tremolo range in dB', () => {
    for (const depth of [4, 5]) {
      const song = oneInst(aica({ lfo: lfo({ ampDepth: depth }) }))
      const out = renderNote(song, 69, 1).subarray(4410)
      let hi = 0
      let lo = Infinity
      for (let o = 0; o + 220 <= out.length; o += 110) {
        const p = peak(out.subarray(o, o + 220))
        hi = Math.max(hi, p)
        lo = Math.min(lo, p)
      }
      const db = 20 * Math.log10(hi / lo)
      expect(db, `depth ${depth}`).toBeGreaterThan(ALFO_DB[depth]! * 0.85)
      expect(db, `depth ${depth}`).toBeLessThan(ALFO_DB[depth]! * 1.15)
    }
  })

  it('every wave shape runs, the noise LFO is deterministic, and reset restarts the phase', () => {
    for (const wave of ['saw', 'square', 'tri', 'noise'] as const) {
      const song = oneInst(aica({ lfo: lfo({ pitchWave: wave, pitchDepth: 4 }) }))
      const a = renderNote(song, 69, 0.4)
      const b = renderNote(song, 69, 0.4)
      expect(bytesEqual(a, b), wave).toBe(true)
      expect(peak(a), wave).toBeGreaterThan(0.1)
    }
    // reset: a second note on the same voice restarts the LFO phase (same pitch modulation per step since key-on)
    const offsets = (reset: boolean): number[][] => {
      const sg = oneInst(aica({ lfo: lfo({ pitchWave: 'saw', pitchDepth: 5, freq: 18, reset }), aeg: { ar: 31, d1r: 0, d2r: 0, rr: 31, dl: 0 } }))
      const v = voiceOf(sg)
      const read = (x: AicaVoice): number => (x as unknown as { playback: { pitchOffset: number } }).playback.pitchOffset
      const runs: number[][] = []
      for (let n = 0; n < 2; n++) {
        v.control(noteControl(69), sg.instruments[0])
        runs.push(trace(v, 3000, read))
        v.control(releaseControl(69, false), sg.instruments[0])
        trace(v, 1500, read)
      }
      return runs
    }
    const withReset = offsets(true)
    // the first frame of a fresh voice takes no DSP step (clock phase 0), so the runs line up one frame apart
    expect(withReset[0]!.slice(1, 2900)).toEqual(withReset[1]!.slice(0, 2899))
    expect(Math.max(...withReset[0]!) - Math.min(...withReset[0]!)).toBeGreaterThan(10)
    const free = offsets(false)
    expect(free[0]!.slice(1, 2900)).not.toEqual(free[1]!.slice(0, 2899))
  })
})

describe('filter (FEG)', () => {
  const flvFor = (hz: number): number => Math.round((Math.log2(hz / 20) / 9.965784) * 8191)
  const filt = (over: Partial<NonNullable<AicaSampleInstrument['filter']>>): AicaSampleInstrument['filter'] => ({
    q: 0,
    flv: [8191, 8191, 8191, 8191, 8191],
    far: 31,
    fd1r: 0,
    fd2r: 0,
    frr: 31,
    ...over
  })
  const noiseNote = (f: AicaSampleInstrument['filter'] | undefined, seconds = 0.6): Float32Array => {
    const song = oneInst(aica({ sample: 'noise', baseNote: 60, ...(f ? { filter: f } : {}) }), noiseSlot())
    return renderNote(song, 60, seconds)
  }

  it('flvToHz is an exponential 20 Hz .. 20 kHz scale', () => {
    expect(flvToHz(0)).toBeCloseTo(20, 6)
    expect(flvToHz(8191)).toBeGreaterThan(19900)
    expect(flvToHz(flvFor(1000))).toBeCloseTo(1000, -1)
  })

  it('a low cutoff removes high-frequency energy; an open filter leaves the sound nearly alone', () => {
    const dry = noiseNote(undefined).subarray(4410)
    const open = noiseNote(filt({})).subarray(4410)
    const low = noiseNote(filt({ flv: Array(5).fill(flvFor(800)) as never })).subarray(4410)
    const hf = (x: Float32Array): number => bandPower(x, 8000)
    expect(hf(low) / hf(dry)).toBeLessThan(0.01)
    expect(hf(open) / hf(dry)).toBeGreaterThan(0.5)
    // the low-pass passes the lows
    expect(bandPower(low, 300) / bandPower(dry, 300)).toBeGreaterThan(0.5)
  })

  it('a high Q makes a resonance peak at the cutoff', () => {
    const fl = Array(5).fill(flvFor(2000)) as never
    const flat = noiseNote(filt({ q: 0, flv: fl })).subarray(4410)
    const res = noiseNote(filt({ q: 24, flv: fl })).subarray(4410)
    expect(bandPower(res, 2000) / bandPower(flat, 2000)).toBeGreaterThan(10)
    expect(bandPower(res, 300) / bandPower(flat, 300)).toBeLessThan(2)
  })

  it('the filter envelope sweeps: FLV0 closed -> FLV1 open over FAR, bright energy grows', () => {
    const out = noiseNote(filt({ flv: [flvFor(150), 8191, 8191, 8191, 8191], far: 8 }), 1.2)
    const early = out.subarray(0, 4410)
    const late = out.subarray(out.length - 4410)
    expect(bandPower(late, 8000) / bandPower(early, 8000)).toBeGreaterThan(20)
  })

  it('FD1R decays the cutoff from FLV1 to FLV2 and the release goes to FLV4', () => {
    const song = oneInst(aica({ sample: 'noise', baseNote: 60, aeg: { ar: 31, d1r: 0, d2r: 0, rr: 31, dl: 0 }, filter: filt({ flv: [8191, 8191, 3000, 3000, 6000], fd1r: 20, frr: 20 }) }), noiseSlot())
    const v = voiceOf(song)
    v.control(noteControl(60), song.instruments[0])
    const lv = trace(v, SR / 2, (x) => x.filterLevel)
    expect(lv[0]!).toBeGreaterThan(8000)
    expect(lv.at(-1)!).toBe(3000)
    v.control(releaseControl(60, true), song.instruments[0])
    const rel = trace(v, 100, (x) => x.filterLevel)
    expect(rel.at(-1)!).toBeGreaterThan(3000)
  })

  it('is skipped without a filter field and stable at extreme settings', () => {
    const bright = noiseNote(filt({ q: 31, flv: Array(5).fill(8191) as never }))
    expect(peak(bright)).toBeLessThan(10)
    expect(Number.isFinite(rms(bright))).toBe(true)
    const nofilter = noiseNote(undefined)
    expect(peak(nofilter)).toBeGreaterThan(0.1)
  })
})

describe('DSP', () => {
  function dspSong(preset: (typeof DC_DSP_PRESETS)[number], over: Partial<DreamcastConfig['dsp']> = {}): Song {
    const s = createSong({ chip: 'dreamcast' })
    Object.assign((s.chipConfig as DreamcastConfig).dsp, { preset, mix: 1, time: 0.5, feedback: 0.5, delayMs: 100 }, over)
    return s
  }
  function impulse(song: Song, frames = SR * 2): { L: Float32Array; R: Float32Array } {
    const bus = new AicaDspBus(SR, 4096)
    bus.configure(song)
    const L = new Float32Array(frames)
    const R = new Float32Array(frames)
    const bl = new Float32Array(4096)
    const br = new Float32Array(4096)
    for (let off = 0; off < frames; off += 4096) {
      const n = Math.min(4096, frames - off)
      if (off === 0) bus.sendL[0] = 1
      bus.steps = n
      bus.render(bl, br, n)
      L.set(bl.subarray(0, n), off)
      R.set(br.subarray(0, n), off)
    }
    return { L, R }
  }

  it('every preset has a description and a RAM size; off is silent, the others have a tail', () => {
    for (const p of DC_DSP_PRESETS) {
      expect(AICA_DSP_INFO[p], p).toBeTruthy()
      const bytes = dspRamBytes((dspSong(p).chipConfig as DreamcastConfig).dsp)
      if (p === 'off') expect(bytes).toBe(0)
      else expect(bytes, p).toBeGreaterThanOrEqual(16 * 1024)
      const r = impulse(dspSong(p))
      if (p === 'off') {
        expect(peak(r.L)).toBe(0)
        expect(peak(r.R)).toBe(0)
      } else {
        const tail = r.L.subarray(Math.round(0.3 * SR))
        expect(rms(r.L) + rms(r.R), p).toBeGreaterThan(1e-5)
        if (p !== 'chorus') expect(peak(tail) + peak(r.R.subarray(Math.round(0.3 * SR))), p).toBeGreaterThan(1e-4)
      }
    }
  })

  it('an impulse gives the identical response twice (and across block sizes)', () => {
    for (const p of DC_DSP_PRESETS) {
      const a = impulse(dspSong(p))
      const b = impulse(dspSong(p))
      expect(bytesEqual(a.L, b.L), p).toBe(true)
      expect(bytesEqual(a.R, b.R), p).toBe(true)
    }
  })

  it('delay repeats after delayMs (+-1 ms) and each repeat is feedback times quieter; echo ping-pongs', () => {
    const ms = 100
    const D = Math.round((ms / 1000) * SR)
    const r = impulse(dspSong('delay', { delayMs: ms, feedback: 0.5 }))
    let first = 0
    for (let i = 0; i < r.L.length; i++) if (Math.abs(r.L[i]!) > Math.abs(r.L[first]!)) first = i
    expect(Math.abs(first - D)).toBeLessThanOrEqual(Math.round(0.001 * SR))
    // the right channel got nothing from a left-only impulse
    expect(peak(r.R)).toBe(0)
    const second = first + D
    const peak2 = peak(r.L.subarray(second - 6, second + 6))
    expect(peak2 / Math.abs(r.L[first]!)).toBeGreaterThan(0.3)
    expect(peak2 / Math.abs(r.L[first]!)).toBeLessThan(0.6)
    // echo: the first repeat is on the left at delayMs, the next one on the right after another delay
    const e = impulse(dspSong('echo', { delayMs: ms, feedback: 0.5 }))
    expect(peak(e.L.subarray(D - 6, D + 6))).toBeGreaterThan(0.1)
    expect(peak(e.R.subarray(D - 6, D + 6))).toBeLessThan(1e-6)
    expect(peak(e.R.subarray(2 * D - 6, 2 * D + 6))).toBeGreaterThan(0.05)
  })

  it('the time parameter lengthens the reverb tail', () => {
    const tailEnergy = (time: number): number => {
      const r = impulse(dspSong('hall', { time }), SR * 3)
      return rms(r.L.subarray(SR * 1.5))
    }
    expect(tailEnergy(1)).toBeGreaterThan(tailEnergy(0.2) * 3)
  })

  it('a bus configured for another preset clears its state; mix 0 is silent', () => {
    const bus = new AicaDspBus(SR, 1024)
    bus.configure(dspSong('hall', { mix: 0 }))
    const L = new Float32Array(1024)
    const R = new Float32Array(1024)
    bus.sendL[0] = 1
    bus.steps = 1024
    bus.render(L, R, 1024)
    expect(peak(L)).toBe(0)
  })

  it('a note with a send makes a _dsp stem, with send 0 or Exx 00 the stem is silent; the dry stem never changes with the preset', () => {
    const make = (send: number, preset: (typeof DC_DSP_PRESETS)[number], fx = false): Song => {
      const s = oneInst(aica({ send, aeg: { ar: 31, d1r: 0, d2r: 14, rr: 20, dl: 0 } }))
      ;(s.chipConfig as DreamcastConfig).dsp.preset = preset
      put(s, 'V1', 0, 0, { note: 69, inst: 0, vol: 15, ...(fx ? { fx: [{ code: 'E' as const, param: 0 }] } : {}) })
      return s
    }
    const on = renderSong(make(12, 'chorus-hall'), { sampleRate: SR, stems: true })
    expect(Object.keys(on.stems!)).toContain('_dsp')
    expect(rms(on.stems!['_dsp']!.L)).toBeGreaterThan(0.002)
    expect(peak(on.stems!['V1']!.L)).toBeGreaterThan(0.05)
    const none = renderSong(make(0, 'chorus-hall'), { sampleRate: SR, stems: true })
    expect(peak(none.stems!['_dsp']!.L)).toBeLessThan(1e-6)
    const off = renderSong(make(12, 'chorus-hall', true), { sampleRate: SR, stems: true })
    expect(peak(off.stems!['_dsp']!.L)).toBeLessThan(1e-6)
    // Exx 01 switches a send-0 instrument on
    const s2 = make(0, 'hall')
    put(s2, 'V1', 0, 0, { note: 69, inst: 0, vol: 15, fx: [{ code: 'E', param: 1 }] })
    expect(rms(renderSong(s2, { sampleRate: SR, stems: true }).stems!['_dsp']!.L)).toBeGreaterThan(0.002)
    // the chorus is wet only: the dry stem is the same with the DSP off
    const dryOff = renderSong(make(12, 'off'), { sampleRate: SR, stems: true })
    expect(bytesEqual(on.stems!['V1']!.L, dryOff.stems!['V1']!.L)).toBe(true)
    expect(peak(dryOff.stems!['_dsp']!.L)).toBe(0)
  })

  it('the chorus keeps the pitch centre of the sound it processes', () => {
    const bus = new AicaDspBus(SR, 4096)
    bus.configure(dspSong('chorus'))
    const frames = SR
    const out = new Float32Array(frames)
    const bl = new Float32Array(4096)
    const br = new Float32Array(4096)
    for (let off = 0; off < frames; off += 4096) {
      const n = Math.min(4096, frames - off)
      for (let k = 0; k < n; k++) bus.sendL[k] = Math.sin((2 * Math.PI * 440 * (off + k)) / SR)
      bus.steps = n
      bus.render(bl, br, n)
      out.set(bl.subarray(0, n), off)
    }
    const hz = measureHz(out.subarray(8000), SR)
    expect(hz / 440).toBeGreaterThan(0.985)
    expect(hz / 440).toBeLessThan(1.015)
  })

  it('stems plus the _dsp stem add up to the master (linear model)', () => {
    const s = demoSong()
    const r = renderSong(s, { sampleRate: SR, stems: true })
    expect(peak(r.L)).toBeLessThan(0.95)
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
  const s = dcSong(['dreamcast.strings.ensemble', 'dreamcast.bass.synth', 'dreamcast.pluck.harp', 'dreamcast.kick.drum', 'dreamcast.snare.drum', 'dreamcast.hat.closed', 'dreamcast.lead.saw'], 16)
  s.timing.bpm = 120
  // a filter envelope on the bass and vibrato on the lead, as the synthwave presets will use them
  const bass = s.instruments[1] as AicaSampleInstrument
  bass.filter = { q: 14, flv: [2500, 6500, 3800, 3000, 2000], far: 24, fd1r: 16, fd2r: 6, frr: 18 }
  const lead = s.instruments[6] as AicaSampleInstrument
  lead.lfo = { freq: 17, pitchWave: 'tri', pitchDepth: 2, ampWave: 'saw', ampDepth: 0, reset: true }
  lead.send = 8
  const pad = s.instruments[0] as AicaSampleInstrument
  pad.format = 'adpcm'
  pad.send = 12
  ;(s.chipConfig as DreamcastConfig).dsp.preset = 'chorus-hall'
  for (const [r, n] of [[0, 57], [8, 60]] as const) put(s, 'V2', 0, r, { note: n, inst: 0, vol: 11 })
  put(s, 'V2', 0, 14, { note: 'rel' })
  for (const [r, n] of [[0, 33], [4, 33], [8, 36], [12, 31]] as const) put(s, 'V1', 0, r, { note: n, inst: 1, vol: 14 })
  const arp = [69, 72, 76, 72, 69, 72, 76, 81]
  arp.forEach((n, i) => put(s, 'V3', 0, i * 2, { note: n, inst: 2, vol: 10, fx: i === 0 ? [{ code: 'X', param: 0x30 }] : undefined }))
  for (const r of [0, 6, 10]) put(s, 'V13', 0, r, { note: 60, inst: 3, vol: 15 })
  for (const r of [4, 12]) put(s, 'V14', 0, r, { note: 60, inst: 4, vol: 13 })
  for (let r = 0; r < 16; r += 2) put(s, 'V15', 0, r, { note: 60, inst: 5, vol: 7 })
  put(s, 'V4', 0, 0, { note: 81, inst: 6, vol: 12, fx: [{ code: 'X', param: 0xd0 }] })
  put(s, 'V4', 0, 8, { note: 76 })
  put(s, 'V4', 0, 14, { note: 'off' })
  return s
}

describe('RAM budget', () => {
  it('accepts the demo song and reports its usage by format', () => {
    const song = demoSong()
    const issues = getChipProfile('dreamcast').validate(song)
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    const u = aicaRamUsage(song)
    expect(u.budget).toBe(2 * 1024 * 1024)
    expect(u.dspBytes).toBe(128 * 1024)
    expect(u.samples.find((s) => s.format === 'adpcm')).toBeDefined()
    expect(u.total).toBe(u.sampleBytes + u.dspBytes)
    for (const s of u.samples) expect(s.bytes).toBe(aicaByteSize(s.format, s.length))
  })

  it('rejects an oversized song with the fixes, and adpcm brings it back under', () => {
    const big = createSong({ chip: 'dreamcast', patternLength: 16 })
    for (let i = 0; i < 2; i++) {
      big.samples.push({ id: `b${i}`, name: `b${i}`, source: { kind: 'pcm', sampleRate: 44100, data: pcmToBase64(new Int16Array(600000)) } })
      big.instruments.push(aica({ sample: `b${i}`, format: 'pcm16' }))
    }
    const err = getChipProfile('dreamcast').validate(big).find((i) => /AICA RAM budget exceeded/.test(i.message))
    expect(err).toBeDefined()
    expect(err!.severity).toBe('error')
    expect(err!.message).toMatch(/adpcm/)
    expect(err!.message).toMatch(/DSP preset/)
    for (const inst of big.instruments) (inst as AicaSampleInstrument).format = 'adpcm'
    expect(getChipProfile('dreamcast').validate(big).filter((i) => i.severity === 'error')).toEqual([])
    // a nearly full RAM warns
    ;(big.instruments[0] as AicaSampleInstrument).format = 'pcm16'
    ;(big.instruments[1] as AicaSampleInstrument).format = 'pcm8'
    ;(big.chipConfig as DreamcastConfig).dsp.preset = 'off'
    const w = getChipProfile('dreamcast').validate(big)
    expect(w.some((i) => /nearly full/.test(i.message) && i.severity === 'warning')).toBe(true)
  })

  it('the DSP ring buffers are 0 for off, 16 KB chorus, 32 / 64 / 128 KB reverbs, delay lines by time', () => {
    const d = (preset: (typeof DC_DSP_PRESETS)[number], delayMs = 300): number => dspRamBytes({ preset, mix: 0.3, time: 0.5, feedback: 0.3, chorusRate: 0.3, chorusDepth: 0.3, delayMs })
    expect([d('off'), d('chorus'), d('room'), d('plate'), d('hall'), d('chorus-hall')]).toEqual([0, 16, 32, 64, 128, 128].map((k) => k * 1024))
    expect(d('delay', 1000)).toBeGreaterThan(d('delay', 100))
    expect(d('chorus-delay', 100)).toBe(16 * 1024 + d('delay', 100))
  })
})

describe('determinism and block parity', () => {
  it('two renders are bit-identical, stems included', () => {
    const a = renderSong(demoSong(), { sampleRate: SR, stems: true })
    const b = renderSong(demoSong(), { sampleRate: SR, stems: true })
    expect(bytesEqual(a.L, b.L)).toBe(true)
    expect(bytesEqual(a.R, b.R)).toBe(true)
    expect(bytesEqual(a.stems!['_dsp']!.L, b.stems!['_dsp']!.L)).toBe(true)
    expect(peak(a.L)).toBeGreaterThan(0.05)
    expect(rms(a.stems!['_dsp']!.L)).toBeGreaterThan(0.001)
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

  it('renders at 48 kHz; setSong hot-swaps instruments and formats', () => {
    const r = renderSong(demoSong(), { sampleRate: 48000 })
    expect(peak(r.L)).toBeGreaterThan(0.05)
    const p = new SongPlayer(demoSong(), SR)
    p.process(new Float32Array(2000), new Float32Array(2000))
    const edited = demoSong()
    edited.samples.push({ id: 'extra', name: 'extra', source: { kind: 'recipe', recipe: 'bell', params: {} } })
    edited.instruments.push(aica({ sample: 'extra', baseNote: 72, format: 'pcm8', send: 6 }))
    put(edited, 'V5', 0, 6, { note: 72, inst: 7, vol: 12 })
    p.setSong(edited)
    const L = new Float32Array(SR)
    p.process(L, new Float32Array(SR))
    expect(peak(L)).toBeGreaterThan(0.05)
  })

  it('a muted slot does not feed the DSP', () => {
    const s = oneInst(aica({ send: 15 }))
    put(s, 'V1', 0, 0, { note: 69, inst: 0, vol: 15 })
    const p = new SongPlayer(s, SR)
    p.setMute(0, true)
    const L = new Float32Array(SR)
    p.process(L, new Float32Array(SR))
    expect(peak(L)).toBe(0)
  })
})

describe('baseline bank', () => {
  it('every mapped Dreamcast preset resolves to a playing voice with its mapped AEG', () => {
    for (const p of DREAMCAST_BASELINE_PRESETS) {
      const inst = resolvePreset('dreamcast', p.id)
      expect(validateInstrument(inst), p.id).toEqual([])
      if (inst.kind !== 'aica-sample') throw new Error('kind')
      expect(inst.format).toBe('pcm16')
    }
    const song = dcSong(['dreamcast.lead.saw'])
    expect(peak(renderNote(song, (song.instruments[0] as AicaSampleInstrument).baseNote, 0.3))).toBeGreaterThan(0.05)
  })
})

describe('performance', () => {
  it('a 64-voice song with 32 voices sounding renders 20 s in under 25% of real time (wall-clock sensitive)', () => {
    const s = createSong({ chip: 'dreamcast', patternLength: 64, authenticity: 'relaxed', chipConfig: { voices: 64 } as never })
    s.timing.bpm = 192
    s.orders = [0, 1, 2, 3].map(() => s.channels.map(() => 0))
    s.loop = null
    for (const id of ['dreamcast.strings.ensemble', 'dreamcast.bass.synth', 'dreamcast.lead.saw']) {
      const inst = resolvePreset('dreamcast', id)
      const slot = missingPresetSample(s, inst)
      if (slot && !s.samples.some((x) => x.id === slot.id)) s.samples.push(slot)
      s.instruments.push(inst)
    }
    ;(s.instruments[1] as AicaSampleInstrument).filter = { q: 12, flv: [3000, 7000, 4500, 4000, 2000], far: 20, fd1r: 14, fd2r: 6, frr: 18 }
    ;(s.instruments[2] as AicaSampleInstrument).lfo = { freq: 17, pitchWave: 'tri', pitchDepth: 2, ampWave: 'tri', ampDepth: 2, reset: false }
    ;(s.instruments[0] as AicaSampleInstrument).send = 12
    for (let v = 1; v <= 32; v++) {
      const inst = v % 3
      for (let row = 0; row < 64; row += 16) put(s, `V${v}`, 0, row, { note: 36 + ((v * 5 + row) % 36), inst, vol: 8 })
    }
    const t0 = performance.now()
    const r = renderSong(s, { sampleRate: SR })
    const ms = performance.now() - t0
    const seconds = r.L.length / SR
    expect(seconds).toBeGreaterThan(19)
    expect(peak(r.L)).toBeGreaterThan(0.05)
    expect(ms, `render took ${ms.toFixed(0)} ms for ${seconds.toFixed(1)} s of audio`).toBeLessThan(seconds * 1000 * 0.25)
  }, 30000)
})

describe('golden hash', () => {
  const goldenPath = join(__dirname, 'golden-dreamcast.json')
  const update = process.env.UPDATE_GOLDEN === '1'
  const hashOf = (r: RenderResult): string => {
    const q = quantizeStereo(r.L, r.R)
    const inter = interleave(q.L, q.R)
    return createHash('sha256').update(Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength)).digest('hex')
  }
  it('dreamcast demo song (UPDATE_GOLDEN=1 regenerates)', () => {
    const golden: Record<string, string> = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>) : {}
    const r = renderSong(demoSong(), { sampleRate: SR })
    const h = hashOf(r)
    if (update) {
      golden['dreamcast'] = h
      writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n')
      return
    }
    if (golden['dreamcast'] !== h) {
      const dir = join(process.cwd(), '.claude', 'temp')
      mkdirSync(dir, { recursive: true })
      const q = quantizeStereo(r.L, r.R)
      const file = join(dir, 'golden-dreamcast-actual.wav')
      writeFileSync(file, writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R] }))
      throw new Error(`Golden hash mismatch for dreamcast: expected ${golden['dreamcast']}, got ${h}. Listen to ${file}; run with UPDATE_GOLDEN=1 if the change is intended.`)
    }
    expect(h).toBe(golden['dreamcast'])
  })
})
