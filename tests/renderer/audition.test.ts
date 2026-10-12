import { describe, expect, it } from 'vitest'
import { SongPlayer, createSong, resolvePreset } from '../../src/core'
import { auditionChannel, auditionNote, buildAuditionSong } from '../../src/renderer/lib/audition'
import { createStarterSong, starterInstruments } from '../../src/renderer/lib/newSong'
import { graphPoint } from '../../src/renderer/lib/macroGraph'

describe('starter songs', () => {
  it('NES and GB songs start with preset instruments the channels can play', () => {
    for (const chip of ['nes', 'gb'] as const) {
      const song = createStarterSong({ chip, name: ' Hello ', bpm: 140, key: 'D', scale: 'minor', moods: ['sad'], patternLength: 32 })
      expect(song.name).toBe('Hello')
      expect(song.timing.bpm).toBe(140)
      expect(song.meta.key).toBe('D')
      expect(song.meta.moods).toEqual(['sad'])
      expect(song.patternLength).toBe(32)
      expect(song.instruments.length).toBeGreaterThan(1)
      const names = song.instruments.map((i) => i.name)
      expect(new Set(names).size).toBe(names.length)
    }
  })

  it('chips without presets yet start with an empty instrument list', () => {
    const song = createSong({ chip: 'genesis' })
    expect(starterInstruments(song).every((i) => i.kind)).toBe(true)
  })
})

describe('audition', () => {
  it('picks a channel that accepts the instrument kind', () => {
    const song = createStarterSong({ chip: 'nes', name: 'a', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 16 })
    const tri = song.instruments.findIndex((i) => i.kind === 'nes-tri')
    expect(tri).toBeGreaterThanOrEqual(0)
    expect(song.channels[auditionChannel(song, tri, 0)]!.id).toBe('TR')
    expect(auditionChannel(song, 0, 1)).toBe(1)
    expect(auditionChannel(song, 99, 0)).toBe(-1)
  })

  it('clamps the pitch to the channel range', () => {
    const song = createSong({ chip: 'nes' })
    expect(auditionNote(song, 0, 2)).toBeGreaterThanOrEqual(12)
    expect(auditionNote(song, 0, 60)).toBe(60)
  })

  it('builds a one-shot song that actually makes sound', () => {
    const song = createStarterSong({ chip: 'nes', name: 'a', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 64 })
    const aud = buildAuditionSong(song, 0, 0, 69)!
    expect(aud.loop).toBeNull()
    expect(aud.orders).toHaveLength(1)
    expect(song.patterns.size).toBe(0) // the live song is untouched
    const player = new SongPlayer(aud, 44100)
    const L = new Float32Array(4410)
    const R = new Float32Array(4410)
    player.process(L, R)
    expect(L.some((v) => Math.abs(v) > 0.01)).toBe(true)
  })

  it('returns null for an instrument no channel can play', () => {
    const song = createSong({ chip: 'nes' })
    song.instruments.push(resolvePreset('gb', 'lead'))
    expect(buildAuditionSong(song, 0, 0, 60)).toBeNull()
  })
})

describe('macro graph pointer mapping', () => {
  it('maps x to a bar index and y to a value', () => {
    // 10 bars of 8 px, values 0..15 over an 84 px tall graph
    expect(graphPoint(0, 0, 10, 8, 0, 15)).toEqual({ index: 0, value: 15 })
    expect(graphPoint(79, 84, 10, 8, 0, 15)).toEqual({ index: 9, value: 0 })
    expect(graphPoint(1000, 42, 10, 8, 0, 15).index).toBe(9)
    expect(graphPoint(-5, -5, 10, 8, 0, 15)).toEqual({ index: 0, value: 15 })
    // negative range: the middle is zero
    expect(graphPoint(4, 42, 10, 8, -24, 24).value).toBe(0)
  })
})
