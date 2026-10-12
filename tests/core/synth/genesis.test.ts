import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeWav } from '../../../src/core/codecs/wav'
import { createSong } from '../../../src/core/model'
import { GENESIS_PRESETS, resolvePreset } from '../../../src/core/instruments/presets'
import { validateInstrument } from '../../../src/core/instruments/validate'
import { genesisChannels } from '../../../src/core/chips/genesis'
import { ROLE_CHANNELS, ROLE_FALLBACKS } from '../../../src/core/instruments/roles'
import { createVoice } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { fmFnumBlock, Ym2612Voice } from '../../../src/core/synth/chips/ym2612'
import { psgDivider, psgFreq, psgNoiseRate, SN_CLOCK_NTSC } from '../../../src/core/synth/chips/sn76489'
import { Sn76489Lfsr, lfsrPeriod } from '../../../src/core/synth/lfsr'
import { interleave, quantizeStereo } from '../../../src/core/synth/mixer'
import { SongPlayer } from '../../../src/core/synth/player'
import { renderSong, type RenderResult } from '../../../src/core/synth/render'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import { midiToHz } from '../../../src/core/synth/tables'
import type { Cell, FmInstrument, FmOp, Instrument, MacroInstrument, Song } from '../../../src/core/types'

const SR = 44100

// ---------------------------------------------------------------------------------------------
// helpers

function op(p: Partial<FmOp> = {}): FmOp {
  return { ar: 31, dr: 0, sr: 0, rr: 15, sl: 0, tl: 127, ks: 0, ml: 1, dt: 0, ...p }
}
function fm(alg: number, fb: number, ops: [Partial<FmOp>, Partial<FmOp>, Partial<FmOp>, Partial<FmOp>], extra: Partial<FmInstrument> = {}): FmInstrument {
  return { kind: 'fm', name: 'test', alg, fb, ams: 0, pms: 0, ops: [op(ops[0]), op(ops[1]), op(ops[2]), op(ops[3])], ...extra }
}
/** Algorithm 7 with only OP4 audible: a single sine carrier. */
const SINE = fm(7, 0, [{}, {}, {}, { tl: 0 }])

function genesisSong(inst: Instrument[], cfg: Record<string, unknown> = {}): Song {
  const s = createSong({ chip: 'genesis', patternLength: 16, authenticity: 'relaxed', chipConfig: { dacLadder: false, ...cfg } as never })
  s.instruments = inst
  return s
}

interface NoteOpts {
  seconds?: number
  gateSec?: number
  vol?: number
  channel?: string
  cfg?: Record<string, unknown>
}

/** Render one note of instrument `inst` through a voice; returns the mono raw output. */
function renderNote(inst: Instrument, midi: number, o: NoteOpts = {}): Float32Array {
  const song = genesisSong([inst], o.cfg)
  const channel = song.channels.find((c) => c.id === (o.channel ?? 'F1'))!
  const voice = createVoice({ song, channel, index: song.channels.indexOf(channel), sampleRate: SR, maxBlock: 4096 })
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = o.vol ?? 1
  c.rawVol = c.vol
  c.semis = midi
  c.freqHz = midiToHz(midi)
  c.inst = 0
  c.note = midi
  voice.control(c, inst)
  c.trigger = false
  const n = Math.round((o.seconds ?? 0.5) * SR)
  const gateN = o.gateSec === undefined ? n : Math.round(o.gateSec * SR)
  const out = new Float32Array(n)
  const tmp = new Float32Array(4096)
  const TICK = 735
  for (let off = 0; off < n; off += TICK) {
    if (off >= gateN && c.gate) {
      c.gate = false
      c.release = true
    }
    voice.control(c, inst)
    const len = Math.min(TICK, n - off)
    for (let a = 0; a < len; a += 4096) {
      const l = Math.min(4096, len - a)
      voice.render(tmp, 0, l)
      out.set(tmp.subarray(0, l), off + a)
    }
  }
  return out
}

function goertzel(x: Float32Array, hz: number, from = 0, to = x.length): number {
  const n = to - from
  const w = (2 * Math.PI * hz) / SR
  const coeff = 2 * Math.cos(w)
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < n; i++) {
    const win = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    const s = x[from + i]! * win + coeff * s1 - s2
    s2 = s1
    s1 = s
  }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n)
}

/** sqrt(sum of harmonic powers 2..8) / fundamental power sqrt. */
function thd(x: Float32Array, f0: number, from: number, to: number): number {
  const p1 = goertzel(x, f0, from, to)
  let h = 0
  for (let k = 2; k <= 8; k++) h += goertzel(x, f0 * k, from, to)
  return Math.sqrt(h / p1)
}

function rms(x: Float32Array, from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) s += x[i]! * x[i]!
  return Math.sqrt(s / Math.max(1, to - from))
}

function measureHz(x: Float32Array, from = 0): number {
  let mean = 0
  for (let i = from; i < x.length; i++) mean += x[i]!
  mean /= x.length - from
  const cross: number[] = []
  for (let i = from + 1; i < x.length; i++) {
    const a = x[i - 1]! - mean
    const b = x[i]! - mean
    if (a < 0 && b >= 0) cross.push(i - 1 + -a / (b - a))
  }
  if (cross.length < 3) return 0
  return ((cross.length - 1) * SR) / (cross.at(-1)! - cross[0]!)
}

/** Time (s) until the envelope of |x| first exceeds `frac` of its peak. */
function riseTime(x: Float32Array, frac: number): number {
  const w = 64
  const env: number[] = []
  for (let i = 0; i + w <= x.length; i += w) env.push(rms(x, i, i + w))
  const peak = Math.max(...env)
  const k = env.findIndex((e) => e >= frac * peak)
  return (k * w) / SR
}

/** Time (s) from `start` until the rms drops below `frac` of its value at `start`. */
function fallTime(x: Float32Array, start: number, frac: number): number {
  const w = 64
  const ref = rms(x, start - 2 * w, start)
  for (let i = start; i + w <= x.length; i += w) if (rms(x, i, i + w) < frac * ref) return (i - start) / SR
  return Infinity
}

// ---------------------------------------------------------------------------------------------
// FM voice

describe('YM2612 voice', () => {
  it('algorithm 7 with a single carrier is a clean sine', () => {
    const x = renderNote(SINE, 69, { seconds: 0.6 })
    const from = Math.round(0.1 * SR)
    expect(rms(x, from, x.length)).toBeGreaterThan(1000) // audible (raw units, 4095 = full)
    expect(thd(x, 440, from, x.length)).toBeLessThan(0.003)
  })

  it('the 9-bit DAC ladder adds only subtle grit', () => {
    const clean = renderNote(SINE, 69, { seconds: 0.6 })
    const x = renderNote(SINE, 69, { seconds: 0.6, cfg: { dacLadder: true } })
    const t = thd(x, 440, Math.round(0.1 * SR), x.length)
    expect(t).toBeGreaterThan(thd(clean, 440, Math.round(0.1 * SR), clean.length) * 2)
    expect(t).toBeLessThan(0.05)
  })

  it('more OP1 feedback gives more harmonic energy', () => {
    const levels = [0, 2, 4, 6, 7].map((fb) => {
      const x = renderNote(fm(7, fb, [{ tl: 0 }, {}, {}, {}]), 57, { seconds: 0.5 })
      return thd(x, midiToHz(57), Math.round(0.1 * SR), x.length)
    })
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]!)
    expect(levels[0]!).toBeLessThan(0.003)
    expect(levels.at(-1)!).toBeGreaterThan(0.3)
  })

  it('modulation (algorithm 0) adds harmonics compared with the bare carrier', () => {
    const plain = renderNote(SINE, 57, { seconds: 0.5 })
    const modulated = renderNote(fm(0, 0, [{ tl: 20 }, { tl: 127 }, { tl: 127 }, { tl: 0 }]), 57, { seconds: 0.5 })
    const from = Math.round(0.1 * SR)
    // algorithm 0: OP1 modulates OP2 ... only OP4 is a carrier, OP3 is silent so no modulation: same as plain
    expect(thd(modulated, midiToHz(57), from, modulated.length)).toBeLessThan(0.01)
    const real = renderNote(fm(0, 0, [{ tl: 0 }, { tl: 0 }, { tl: 0 }, { tl: 0 }]), 57, { seconds: 0.5 })
    expect(thd(real, midiToHz(57), from, real.length)).toBeGreaterThan(thd(plain, midiToHz(57), from, plain.length))
  })

  it('attack rate scales the attack time', () => {
    const t = (ar: number): number => riseTime(renderNote(fm(7, 0, [{}, {}, {}, { tl: 0, ar }]), 57, { seconds: 1.5 }), 0.7)
    const fast = t(31)
    const mid = t(20)
    const slow = t(12)
    expect(fast).toBeLessThan(0.004)
    expect(mid).toBeGreaterThan(fast)
    expect(slow).toBeGreaterThan(mid * 1.5)
  })

  it('release rate scales the release time', () => {
    const t = (rr: number): number => {
      const x = renderNote(fm(7, 0, [{}, {}, {}, { tl: 0, rr }]), 57, { seconds: 3, gateSec: 0.3 })
      return fallTime(x, Math.round(0.3 * SR), 0.1)
    }
    const fast = t(15)
    const mid = t(9)
    const slow = t(4)
    expect(fast).toBeLessThan(mid)
    expect(mid).toBeLessThan(slow)
    expect(slow).toBeLessThan(3)
  })

  it('note-off without release uses a fast cut, release uses the operator RR', () => {
    const inst = fm(7, 0, [{}, {}, {}, { tl: 0, rr: 2 }])
    const song = genesisSong([inst])
    const voice = createVoice({ song, channel: song.channels[0]!, index: 0, sampleRate: SR, maxBlock: 4096 })
    const run = (release: boolean): number => {
      voice.reset()
      const c = newChannelControl()
      Object.assign(c, { trigger: true, gate: true, vol: 1, rawVol: 1, semis: 57, freqHz: midiToHz(57), inst: 0, note: 57 })
      voice.control(c, inst)
      const buf = new Float32Array(735)
      voice.render(buf, 0, 735)
      voice.render(buf, 0, 735)
      c.trigger = false
      c.gate = false
      c.release = release
      voice.control(c, inst)
      voice.render(buf, 0, 735)
      voice.render(buf, 0, 735)
      return rms(buf, 0, 735)
    }
    expect(run(false)).toBeLessThan(run(true) * 0.05)
  })

  it('the multiplier changes the pitch ratio (ML 0 = x0.5)', () => {
    const f = (ml: number): number => measureHz(renderNote(fm(7, 0, [{}, {}, {}, { tl: 0, ml }]), 57, { seconds: 0.5 }), Math.round(0.1 * SR))
    const base = f(1)
    expect(Math.abs(base / midiToHz(57) - 1)).toBeLessThan(0.005)
    expect(f(2) / base).toBeCloseTo(2, 2)
    expect(f(3) / base).toBeCloseTo(3, 2)
    expect(f(0) / base).toBeCloseTo(0.5, 2)
    expect(f(15) / base).toBeCloseTo(15, 1)
  })

  it('detune nudges the pitch slightly', () => {
    const f = (dt: number): number => measureHz(renderNote(fm(7, 0, [{}, {}, {}, { tl: 0, dt }]), 69, { seconds: 0.8 }), Math.round(0.1 * SR))
    const base = f(0)
    expect(f(3)).toBeGreaterThan(base)
    expect(f(-3)).toBeLessThan(base)
    expect(Math.abs(f(3) / base - 1)).toBeLessThan(0.02)
  })

  it('pitch detection on FM: A-4, C-3, C-1 and C-6', () => {
    for (const midi of [24, 48, 69, 84]) {
      const hz = midiToHz(midi)
      const x = renderNote(SINE, midi, { seconds: midi < 40 ? 1.2 : 0.5 })
      const got = measureHz(x, Math.round(0.1 * SR))
      expect(Math.abs(got / hz - 1), `midi ${midi}`).toBeLessThan(0.004)
    }
  })

  it('carrier volume: v8 is about 5.5 dB below v15 and v0 is silent', () => {
    const full = rms(renderNote(SINE, 57, { vol: 1 }), 4000, 20000)
    const half = rms(renderNote(SINE, 57, { vol: 8 / 15 }), 4000, 20000)
    expect(20 * Math.log10(half / full)).toBeCloseTo(-5.5, 0)
    expect(rms(renderNote(SINE, 57, { vol: 0 }), 4000, 20000)).toBe(0)
  })

  it('sustain level and SR shape the decay', () => {
    const x = renderNote(fm(7, 0, [{}, {}, {}, { tl: 0, ar: 31, dr: 20, sl: 8, sr: 0 }]), 57, { seconds: 2 })
    const early = rms(x, 100, 400)
    const late = rms(x, Math.round(1.5 * SR), Math.round(1.8 * SR))
    // SL 8 = 24 dB down, SR 0 holds it
    expect(20 * Math.log10(late / early)).toBeLessThan(-18)
    expect(20 * Math.log10(late / early)).toBeGreaterThan(-30)
  })

  it('LFO amplitude modulation (AMS) only affects operators with AM and needs the global LFO', () => {
    const am = fm(7, 0, [{}, {}, {}, { tl: 0, am: true }], { ams: 3 })
    const dev = (cfg: Record<string, unknown>): number => {
      const x = renderNote(am, 57, { seconds: 1, cfg })
      const lo: number[] = []
      for (let i = 4000; i + 2205 < x.length; i += 441) lo.push(rms(x, i, i + 2205))
      return Math.max(...lo) / Math.max(1e-9, Math.min(...lo))
    }
    expect(dev({ lfo: 0 })).toBeLessThan(1.05)
    expect(dev({ lfo: 3 })).toBeGreaterThan(1.5)
  })

  it('LFO vibrato (PMS) bends the pitch', () => {
    const pm = fm(7, 0, [{}, {}, {}, { tl: 0 }], { pms: 7 })
    const x = renderNote(pm, 69, { seconds: 1, cfg: { lfo: 5 } })
    const seg = (a: number, b: number): number => measureHz(x.subarray(Math.round(a * SR), Math.round(b * SR)))
    const hz: number[] = []
    for (let t = 0.1; t < 0.9; t += 0.05) hz.push(seg(t, t + 0.05))
    expect(Math.max(...hz) / Math.min(...hz)).toBeGreaterThan(1.02)
  })

  it('SSG-EG repeating sawtooth keeps retriggering the envelope', () => {
    const x = renderNote(fm(7, 0, [{}, {}, {}, { tl: 0, ar: 31, dr: 24, sl: 15, sr: 31, ssg: 8 }]), 57, { seconds: 0.5 })
    const win: number[] = []
    for (let i = 2000; i + 100 < x.length; i += 100) win.push(rms(x, i, i + 100))
    // a decaying-then-restarting envelope: many local maxima
    let peaks = 0
    for (let i = 1; i < win.length - 1; i++) if (win[i]! > win[i - 1]! * 1.3 && win[i]! >= win[i + 1]!) peaks++
    expect(peaks).toBeGreaterThan(2)
  })

  it('fnum/block follow the chip arithmetic', () => {
    const fs = 7670454 / 144
    const a4 = fmFnumBlock(440, fs)
    expect(a4.fnum).toBeGreaterThanOrEqual(1024)
    expect(a4.fnum).toBeLessThanOrEqual(2047)
    expect((a4.fnum * (1 << a4.block) * fs) / 2 ** 21).toBeCloseTo(440, 0)
  })
})

// ---------------------------------------------------------------------------------------------
// PSG

function renderPsg(midi: number, vol: number, channel: string, inst: Instrument, seconds = 0.5, timbre = -1): Float32Array {
  const song = genesisSong([inst])
  const ch = song.channels.find((c) => c.id === channel)!
  const voice = createVoice({ song, channel: ch, index: song.channels.indexOf(ch), sampleRate: SR, maxBlock: 4096 })
  const c = newChannelControl()
  Object.assign(c, { trigger: true, gate: true, vol, rawVol: vol, semis: midi, freqHz: midiToHz(midi), inst: 0, note: midi, timbre })
  voice.control(c, inst)
  const n = Math.round(seconds * SR)
  const out = new Float32Array(n)
  const tmp = new Float32Array(4096)
  for (let off = 0; off < n; off += 4096) {
    const l = Math.min(4096, n - off)
    voice.render(tmp, 0, l)
    out.set(tmp.subarray(0, l), off)
  }
  return out
}

const PSG: MacroInstrument = { kind: 'psg', name: 'sq', macros: {} }
const NOISE: MacroInstrument = { kind: 'psg-noise', name: 'nz', macros: {} }

describe('SN76489 voices', () => {
  it('square pitch follows the 10-bit divider: A-4, C-3 and the lowest note A-2', () => {
    for (const midi of [69, 48, 45]) {
      const x = renderPsg(midi, 1, 'S1', PSG, 0.6)
      const div = psgDivider(midiToHz(midi), SN_CLOCK_NTSC)
      const hz = psgFreq(div, SN_CLOCK_NTSC)
      const got = measureHz(x, 4000)
      expect(Math.abs(got / hz - 1), `midi ${midi}`).toBeLessThan(0.004)
      expect(Math.abs(hz / midiToHz(midi) - 1)).toBeLessThan(0.01)
    }
  })

  it('divider limits: lowest pitch is 109.4 Hz, notes below clamp to it', () => {
    expect(psgFreq(1023, SN_CLOCK_NTSC)).toBeCloseTo(109.35, 1)
    expect(psgDivider(50, SN_CLOCK_NTSC)).toBe(1023)
    expect(psgDivider(1e6, SN_CLOCK_NTSC)).toBe(1)
  })

  it('volume has 16 steps of 2 dB, 15 = off', () => {
    const level = (vol: number): number => rms(renderPsg(69, vol, 'S2', PSG, 0.3), 4000, 12000)
    const full = level(1)
    expect(20 * Math.log10(level(Math.pow(10, -2 / 20)) / full)).toBeCloseTo(-2, 0)
    expect(20 * Math.log10(level(Math.pow(10, -6 / 20)) / full)).toBeCloseTo(-6, 0)
    expect(level(0)).toBe(0)
    expect(level(0.01)).toBe(0)
  })

  it('noise: three fixed rates, pitched mode below C-3, white vs periodic', () => {
    expect(psgNoiseRate(60, SN_CLOCK_NTSC)).toBeCloseTo(SN_CLOCK_NTSC / 512, 6)
    expect(psgNoiseRate(61, SN_CLOCK_NTSC)).toBeCloseTo(SN_CLOCK_NTSC / 1024, 6)
    expect(psgNoiseRate(62, SN_CLOCK_NTSC)).toBeCloseTo(SN_CLOCK_NTSC / 2048, 6)
    expect(psgNoiseRate(63, SN_CLOCK_NTSC)).toBeCloseTo(SN_CLOCK_NTSC / 512, 6)
    // pitched: shift rate = 16 x frequency, so periodic noise sounds at the note
    const x = renderPsg(36, 1, 'NO', NOISE, 0.6, 1)
    const hz = measureHz(x, 4000)
    expect(hz).toBeGreaterThan(midiToHz(36) * 0.9)
    expect(hz).toBeLessThan(midiToHz(36) * 1.1)
    const white = renderPsg(60, 1, 'NO', NOISE, 0.3, 0)
    const periodic = renderPsg(60, 1, 'NO', NOISE, 0.3, 1)
    expect(rms(white, 2000, 10000)).toBeGreaterThan(0)
    // periodic noise is strongly tonal at rate/16, white noise is not
    const f0 = SN_CLOCK_NTSC / 512 / 16
    expect(goertzel(periodic, f0, 2000, 12000)).toBeGreaterThan(20 * goertzel(white, f0, 2000, 12000))
  })

  it('noise is deterministic on every trigger (LFSR reset)', () => {
    const a = renderPsg(60, 1, 'NO', NOISE, 0.2)
    const b = renderPsg(60, 1, 'NO', NOISE, 0.2)
    expect(Buffer.compare(Buffer.from(a.buffer), Buffer.from(b.buffer))).toBe(0)
  })

  it('LFSR: Sega 16-bit white noise cycle and the 16-step periodic cycle', () => {
    const w = new Sn76489Lfsr()
    expect(lfsrPeriod(w)).toBe(57337)
    const p = new Sn76489Lfsr()
    p.white = false
    expect(lfsrPeriod(p)).toBe(16)
  })
})

// ---------------------------------------------------------------------------------------------
// presets

describe('genesis presets', () => {
  it('has 20-50 presets with unique genesis.* ids that resolve and validate', () => {
    expect(GENESIS_PRESETS.length).toBeGreaterThanOrEqual(20)
    expect(GENESIS_PRESETS.length).toBeLessThanOrEqual(50)
    expect(new Set(GENESIS_PRESETS.map((p) => p.id)).size).toBe(GENESIS_PRESETS.length)
    for (const p of GENESIS_PRESETS) {
      expect(p.id.startsWith('genesis.')).toBe(true)
      const inst = resolvePreset('genesis', p.id)
      expect(validateInstrument(inst), p.id).toEqual([])
      expect(inst.presetId).toBe(p.id)
    }
  })

  it('every role the mood recipes and fallbacks use resolves on the channels that play it', () => {
    const kindOf = new Map(genesisChannels({ chip: 'genesis' }).map((d) => [d.id, d.kind]))
    for (const [role, ids] of Object.entries(ROLE_CHANNELS.genesis)) {
      for (const id of ids!) {
        const kind = kindOf.get(id)!
        expect(() => resolvePreset('genesis', role, kind), `${role} on ${id}`).not.toThrow()
      }
    }
    for (const role of Object.keys(ROLE_FALLBACKS)) expect(() => resolvePreset('genesis', role, 'fm'), role).not.toThrow()
    expect(resolvePreset('genesis', 'bass', 'fm').presetId).toBe('genesis.bass.slap')
    expect(resolvePreset('genesis', 'lead', 'psg-square').presetId).toBe('genesis.lead.psg')
    expect(resolvePreset('genesis', 'hat', 'psg-noise').presetId).toBe('genesis.hihat.noise')
    expect(resolvePreset('genesis', 'kick', 'fm').presetId).toBe('genesis.kick.fm')
    expect(resolvePreset('genesis', 'kick', 'psg-noise').presetId).toBe('genesis.kick.noise')
    expect(resolvePreset('genesis', 'clap', 'psg-noise').kind).toBe('psg-noise')
  })

  it('every preset makes sound on a matching channel', () => {
    for (const p of GENESIS_PRESETS) {
      const inst = resolvePreset('genesis', p.id)
      const kind = p.channelKinds[0]!
      const chan = kind === 'fm' ? 'F1' : kind === 'psg-square' ? 'S1' : 'NO'
      const note = kind === 'psg-noise' ? 60 : p.role === 'bass' || p.role === 'kick' || p.role === 'tom' ? 48 : 60
      const x = kind === 'fm' ? renderNote(inst, note, { seconds: 0.4, channel: chan }) : renderPsg(note, 1, chan, inst, 0.4)
      expect(rms(x, 0, x.length), p.id).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------------------------
// whole songs

function put(song: Song, channelId: string, pat: number, row: number, cell: Cell): void {
  const key = `${channelId}:${pat}` as const
  let p = song.patterns.get(key)
  if (!p) {
    p = { rows: Array.from({ length: song.patternLength }, () => null) }
    song.patterns.set(key, p)
  }
  p.rows[row] = cell
}

function genesisSongFull(rows = 32, orders = 1): Song {
  const song = createSong({ chip: 'genesis', patternLength: rows, authenticity: 'relaxed', bpm: 130 })
  const names = ['genesis.bass.slap', 'genesis.lead.saw', 'genesis.choir.aah', 'genesis.strings.slow', 'genesis.brass.stab', 'genesis.epiano.tine', 'genesis.lead.psg', 'genesis.arp.psg', 'genesis.hihat.noise', 'genesis.snare.noise']
  song.instruments = names.map((n) => resolvePreset('genesis', n))
  song.orders = Array.from({ length: orders }, () => song.channels.map(() => 0))
  song.loop = { order: 0 }
  const scale = [0, 3, 5, 7, 10, 12, 15, 17]
  for (let r = 0; r < rows; r++) {
    if (r % 4 === 0) put(song, 'F1', 0, r, { note: 36 + [0, 0, 5, 7][(r >> 2) & 3]!, inst: 0, vol: 15 })
    if (r % 2 === 0) put(song, 'F2', 0, r, { note: 67 + scale[(r * 3) % 8]!, inst: 1, vol: 13 })
    if (r % 16 === 0) {
      put(song, 'F3', 0, r, { note: 55, inst: 2, vol: 10 })
      put(song, 'F4', 0, r, { note: 60 + (r >> 4), inst: 3, vol: 9, fx: [{ code: 'X', param: 0 }] })
    }
    if (r % 8 === 4) put(song, 'F5', 0, r, { note: 64, inst: 4, vol: 12, fx: [{ code: 'X', param: 255 }] })
    if (r % 4 === 2) put(song, 'F6', 0, r, { note: 72 + scale[r % 8]!, inst: 5, vol: 11 })
    if (r % 3 === 0) put(song, 'S1', 0, r, { note: 79 + scale[(r + 2) % 8]!, inst: 6, vol: 9 })
    if (r % 2 === 1) put(song, 'S2', 0, r, { note: 60, inst: 7, vol: 8, fx: [{ code: '0', param: 0x47 }] })
    if (r % 4 === 0) put(song, 'S3', 0, r, { note: 48 + scale[r % 8]!, inst: 6, vol: 7 })
    put(song, 'NO', 0, r, r % 8 === 4 ? { note: 61, inst: 9, vol: 13 } : { note: 60, inst: 8, vol: r % 2 ? 6 : 9 })
  }
  return song
}

function bytesEqual(a: Float32Array, b: Float32Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength)) === 0
}

function peak(x: Float32Array): number {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

describe('Genesis songs', () => {
  it('render deterministically and non-silently without clipping', () => {
    const a = renderSong(genesisSongFull(), { sampleRate: SR })
    const b = renderSong(genesisSongFull(), { sampleRate: SR })
    expect(bytesEqual(a.L, b.L)).toBe(true)
    expect(bytesEqual(a.R, b.R)).toBe(true)
    expect(peak(a.L)).toBeGreaterThan(0.05)
    expect(peak(a.L)).toBeLessThanOrEqual(1)
    expect(a.loopStart).not.toBeNull()
  })

  it('128-frame blocks give exactly the offline render (and so do odd block sizes)', () => {
    const song = genesisSongFull(16)
    song.loop = null
    const full = renderSong(song, { sampleRate: SR, loops: 1 })
    for (const block of [128, 333]) {
      const player = new SongPlayer(song, SR, { maxBlock: 4096 })
      const n = 20000
      const L = new Float32Array(n)
      const R = new Float32Array(n)
      for (let off = 0; off < n; off += block) {
        const end = Math.min(n, off + block)
        player.process(L.subarray(off, end), R.subarray(off, end))
      }
      expect(bytesEqual(L, full.L.subarray(0, n)), `block ${block} L`).toBe(true)
      expect(bytesEqual(R, full.R.subarray(0, n)), `block ${block} R`).toBe(true)
    }
  })

  it('hard pan puts FM channels left or right', () => {
    const song = createSong({ chip: 'genesis', patternLength: 8, authenticity: 'relaxed' })
    song.instruments = [SINE]
    song.orders = [song.channels.map(() => 0)]
    put(song, 'F1', 0, 0, { note: 60, inst: 0, fx: [{ code: 'X', param: 0 }] })
    put(song, 'F2', 0, 0, { note: 64, inst: 0, fx: [{ code: 'X', param: 255 }] })
    const r = renderSong(song, { sampleRate: SR, stems: true })
    expect(peak(r.stems!.F1!.R)).toBe(0)
    expect(peak(r.stems!.F1!.L)).toBeGreaterThan(0.05)
    expect(peak(r.stems!.F2!.L)).toBe(0)
    expect(peak(r.stems!.F2!.R)).toBeGreaterThan(0.05)
  })

  it('PSG is quieter than FM at the same volume', () => {
    const song = createSong({ chip: 'genesis', patternLength: 8, authenticity: 'relaxed' })
    song.instruments = [SINE, PSG]
    song.orders = [song.channels.map(() => 0)]
    put(song, 'F1', 0, 0, { note: 69, inst: 0 })
    put(song, 'S1', 0, 0, { note: 69, inst: 1 })
    const r = renderSong(song, { sampleRate: SR, stems: true })
    const fmRms = rms(r.stems!.F1!.L, 3000, 20000)
    const psgRms = rms(r.stems!.S1!.L, 3000, 20000)
    expect(psgRms).toBeLessThan(fmRms)
    expect(psgRms).toBeGreaterThan(fmRms * 0.2)
  })

  it('F6 in DAC mode is a sample channel (not an FM voice)', () => {
    const song = createSong({ chip: 'genesis', chipConfig: { fm6Dac: true } })
    const f6 = song.channels.find((c) => c.id === 'F6')!
    expect(f6.kind).toBe('sample')
    const song2 = createSong({ chip: 'genesis' })
    const voice = createVoice({ song: song2, channel: song2.channels[0]!, index: 0, sampleRate: SR, maxBlock: 128 })
    expect(voice).toBeInstanceOf(Ym2612Voice)
  })
})

// ---------------------------------------------------------------------------------------------
// golden hash

const goldenPath = join(__dirname, 'golden-genesis.json')

function hashOf(r: RenderResult): string {
  const q = quantizeStereo(r.L, r.R)
  const inter = interleave(q.L, q.R)
  return createHash('sha256').update(Buffer.from(inter.buffer, inter.byteOffset, inter.byteLength)).digest('hex')
}

describe('golden output hash', () => {
  const update = process.env.UPDATE_GOLDEN === '1'
  const golden: Record<string, string> = existsSync(goldenPath) ? (JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>) : {}
  const cases: [string, () => Song][] = [
    ['genesis', () => genesisSongFull(32, 2)],
    ['genesis-lfo', () => ({ ...genesisSongFull(16), chipConfig: { chip: 'genesis', region: 'pal', fm6Dac: false, lfo: 4 } as Song['chipConfig'] })]
  ]
  for (const [name, make] of cases) {
    it(`${name} (UPDATE_GOLDEN=1 regenerates)`, () => {
      const r = renderSong(make(), { sampleRate: SR })
      const h = hashOf(r)
      if (update) {
        golden[name] = h
        writeFileSync(goldenPath, JSON.stringify(golden, null, 2) + '\n')
        return
      }
      if (golden[name] !== h) {
        const dir = join(process.cwd(), '.claude', 'temp')
        mkdirSync(dir, { recursive: true })
        const q = quantizeStereo(r.L, r.R)
        const file = join(dir, `golden-${name}-actual.wav`)
        writeFileSync(file, writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R] }))
        throw new Error(`Golden hash mismatch for ${name}: expected ${golden[name]}, got ${h}. Listen to ${file}; run with UPDATE_GOLDEN=1 if the change is intended.`)
      }
      expect(h).toBe(golden[name])
    })
  }
})

// ---------------------------------------------------------------------------------------------
// performance

describe('performance', () => {
  it.skipIf(process.env.SKIP_PERF === '1')('renders 3 minutes of a 10-channel Genesis song in under 3 s', () => {
    // 130 bpm, 16 rows per bar: one 64-row pattern = 4 bars ~ 7.4 s; 25 orders ~ 184 s
    const song = genesisSongFull(64, 25)
    song.loop = null // a looping song is rendered as intro + 2 bodies; time exactly 3 minutes of audio
    const t0 = performance.now()
    const r = renderSong(song, { sampleRate: SR, tailSec: 0 })
    const dt = performance.now() - t0
    const secs = r.L.length / SR
    console.log(`genesis perf: ${secs.toFixed(1)} s of audio in ${dt.toFixed(0)} ms`)
    expect(secs).toBeGreaterThanOrEqual(180)
    expect(dt).toBeLessThan(3000)
  })
})
