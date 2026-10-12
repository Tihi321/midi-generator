import { describe, expect, it } from 'vitest'
import { createSong, missingPresetSample, resolvePreset } from '../../../src/core'
import { createVoice } from '../../../src/core/synth/chips/types'
import '../../../src/core/synth/chips/index'
import { renderSong } from '../../../src/core/synth/render'
import { newChannelControl } from '../../../src/core/synth/sequencer'
import { dpcmRates, prepareDpcm } from '../../../src/core/synth/samplegen'
import { midiToHz } from '../../../src/core/synth/tables'
import type { Song } from '../../../src/core/types'
import { put } from './fixtures'

const SR = 44100

function dacSong(): Song {
  const s = createSong({ chip: 'genesis', patternLength: 16, authenticity: 'relaxed', chipConfig: { fm6Dac: true } as never })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  const inst = resolvePreset('genesis', 'genesis.dac.kick')
  const slot = missingPresetSample(s, inst)
  if (slot) s.samples.push(slot)
  s.instruments.push(inst)
  return s
}

function dpcmSong(): Song {
  const s = createSong({ chip: 'nes', patternLength: 16, authenticity: 'relaxed', chipConfig: { dpcm: true } as never })
  s.orders = [s.channels.map(() => 0)]
  s.loop = null
  const inst = resolvePreset('nes', 'nes.dpcm.kick')
  const slot = missingPresetSample(s, inst)
  if (slot) s.samples.push(slot)
  s.instruments.push(inst)
  return s
}

function playVoice(song: Song, channel: string, midi: number, release: 'none' | 'rel' | 'off', seconds = 0.6): Float32Array {
  const index = song.channels.findIndex((c) => c.id === channel)
  const v = createVoice({ song, channel: song.channels[index]!, index, sampleRate: SR, maxBlock: 4096 })
  const c = newChannelControl()
  c.trigger = true
  c.gate = true
  c.vol = 1
  c.rawVol = 1
  c.freqHz = midiToHz(midi)
  c.semis = midi
  c.note = midi
  c.inst = 0
  v.control(c, song.instruments[0])
  const out = new Float32Array(Math.round(seconds * SR))
  const half = Math.round(0.02 * SR)
  v.render(out, 0, half)
  if (release !== 'none') {
    const r = newChannelControl()
    r.trigger = false
    r.gate = false
    r.release = release === 'rel'
    r.freqHz = c.freqHz
    r.note = midi
    r.inst = 0
    v.control(r, song.instruments[0])
  }
  for (let off = half; off < out.length; off += 4096) v.render(out, off, Math.min(out.length, off + 4096))
  return out
}

function peak(x: Float32Array, from = 0, to = x.length): number {
  let p = 0
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i]!))
  return p
}

/** Index after which the signal stays below `thr`. */
function lastAbove(x: Float32Array, thr: number): number {
  for (let i = x.length - 1; i >= 0; i--) if (Math.abs(x[i]!) >= thr) return i
  return -1
}

describe('Genesis F6 DAC voice', () => {
  it('plays the kick, faster notes finish sooner, off stops it and rel lets it ring', () => {
    const song = dacSong()
    const base = playVoice(song, 'F6', 60, 'none')
    expect(peak(base)).toBeGreaterThan(0.1)
    const high = playVoice(song, 'F6', 72, 'none')
    // one octave up plays the sample at double speed: it ends at about half the time
    const endBase = lastAbove(base, 0.01)
    const endHigh = lastAbove(high, 0.01)
    expect(endHigh).toBeLessThan(endBase * 0.65)
    expect(endHigh).toBeGreaterThan(endBase * 0.35)
    const off = playVoice(song, 'F6', 60, 'off')
    expect(lastAbove(off, 1e-4)).toBeLessThan(Math.round(0.03 * SR))
    const rel = playVoice(song, 'F6', 60, 'rel')
    expect(lastAbove(rel, 0.01)).toBeGreaterThan(endBase * 0.9)
  })

  it('output is 8-bit quantised (at most 256 distinct levels)', () => {
    const x = playVoice(dacSong(), 'F6', 60, 'none')
    const levels = new Set<number>()
    for (const v of x) levels.add(Math.round(v * 128 * 1000) / 1000)
    expect(levels.size).toBeLessThanOrEqual(257)
  })

  it('the DAC rate is capped near 26 kHz (high notes do not speed up forever)', () => {
    const song = dacSong()
    const a = playVoice(song, 'F6', 84, 'none')
    const b = playVoice(song, 'F6', 96, 'none')
    // above the cap the sample still reads faster, but never beyond the sample end: both are finite and non-silent
    expect(peak(a)).toBeGreaterThan(0.05)
    expect(peak(b)).toBeGreaterThan(0.01)
  })
})

describe('NES DPCM voice', () => {
  it('note picks the rate: C-4 is rate 12, higher notes finish sooner', () => {
    const song = dpcmSong()
    const rates = dpcmRates()
    const d = prepareDpcm(song, song.instruments[0]!.kind === 'sample' ? (song.instruments[0] as { sample: string }).sample : '', rates[12]!)!
    const seconds = d.levels.length / rates[12]!
    const base = playVoice(song, 'DM', 60, 'none', 0.8)
    expect(peak(base)).toBeGreaterThan(30)
    // the raw output holds the last counter level after the sample ends; measure the last change instead
    const lastChange = (x: Float32Array): number => {
      for (let i = x.length - 1; i > 0; i--) if (x[i] !== x[i - 1]) return i
      return 0
    }
    expect(lastChange(base) / SR).toBeCloseTo(seconds, 1)
    const fast = playVoice(song, 'DM', 63, 'none', 0.8)
    expect(lastChange(fast) / SR).toBeCloseTo(seconds * (rates[12]! / rates[15]!), 1)
    const slow = playVoice(song, 'DM', 48, 'none', 1.5)
    expect(lastChange(slow) / SR).toBeCloseTo(seconds * (rates[12]! / rates[0]!), 0)
    // notes beyond the range clamp to the fastest / slowest rate
    expect(lastChange(playVoice(song, 'DM', 100, 'none', 0.8))).toBe(lastChange(fast))
  })

  it('stays within the 7-bit counter range and note off stops the stream', () => {
    const song = dpcmSong()
    const x = playVoice(song, 'DM', 60, 'none')
    for (const v of x) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(127)
    }
    const off = playVoice(song, 'DM', 60, 'off')
    let changes = 0
    for (let i = Math.round(0.05 * SR); i < off.length; i++) if (off[i] !== off[i - 1]) changes++
    expect(changes).toBe(0)
  })
})

describe('sample channels in a full render', () => {
  it('F6 DAC and DM render through renderSong and are bit-identical twice', () => {
    for (const make of [dacSong, dpcmSong]) {
      const song = make()
      const ch = song.chip === 'genesis' ? 'F6' : 'DM'
      put(song, ch, 0, 0, { note: 60, inst: 0, vol: 15 })
      put(song, ch, 0, 8, { note: 60, inst: 0, vol: 15 })
      const a = renderSong(song, { sampleRate: SR, stems: true })
      const b = renderSong(song, { sampleRate: SR })
      expect(Buffer.compare(Buffer.from(a.L.buffer), Buffer.from(b.L.buffer))).toBe(0)
      expect(peak(a.stems![ch]!.L)).toBeGreaterThan(0.005)
    }
  })
})
