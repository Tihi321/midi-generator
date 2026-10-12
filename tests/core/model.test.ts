import { describe, expect, it } from 'vitest'
import {
  cloneSong, createSong, findInstrumentIndex, getPattern, instrumentUsage, nextFreePattern, patternAt, patternKey,
  peekPattern, requireChannel, requireInstrument, requireOrder, rowSeconds, songRows, songSeconds, songTicks, summarizeSong,
  tickSeconds, normalizeCell, cellsEqual, isCellEmpty
} from '../../src/core/model'
import { CHIP_IDS } from '../../src/core/types'
import { songWithPresets } from './helpers'

describe('createSong', () => {
  it('builds channels from the chip profile for every chip', () => {
    const counts: Record<string, string> = {
      nes: 'P1,P2,TR,NO',
      gb: 'P1,P2,WV,NO',
      genesis: 'F1,F2,F3,F4,F5,F6,S1,S2,S3,NO',
      snes: 'V1,V2,V3,V4,V5,V6,V7,V8',
      pce: 'C1,C2,C3,C4,C5,C6'
    }
    for (const chip of CHIP_IDS) {
      const s = createSong({ chip })
      expect(s.channels.map((c) => c.id).join(',')).toBe(counts[chip])
      expect(s.orders).toEqual([s.channels.map(() => 0)])
      expect(s.chipConfig.chip).toBe(chip)
      expect(s.loop).toEqual({ order: 0 })
    }
  })
  it('applies options and config variants', () => {
    const s = createSong({ chip: 'nes', name: 'T', bpm: 90, key: 'Bb', scale: 'minor', moods: ['sad'], patternLength: 32, chipConfig: { dpcm: true } as never })
    expect(s.channels.map((c) => c.id)).toContain('DM')
    expect(s.timing.bpm).toBe(90)
    expect(s.meta.key).toBe('A#')
    expect(s.patternLength).toBe(32)
    const g = createSong({ chip: 'genesis', chipConfig: { fm6Dac: true } as never })
    expect(g.channels.find((c) => c.id === 'F6')!.kind).toBe('sample')
    const sn = createSong({ chip: 'snes', chipConfig: { echo: { delay: 2 } } as never })
    expect((sn.chipConfig as { echo: { delay: number; fir: number[] } }).echo.delay).toBe(2)
    expect((sn.chipConfig as { echo: { delay: number; fir: number[] } }).echo.fir).toHaveLength(8)
  })
  it('rejects invalid options with a helpful message', () => {
    expect(() => createSong({ chip: 'nes', bpm: 5 })).toThrow(/bpm/)
    expect(() => createSong({ chip: 'nes', patternLength: 0 })).toThrow(/pattern length/)
    expect(() => createSong({ chip: 'nes', key: 'H' })).toThrow(/key/)
    expect(() => createSong({ chip: 'zx' as never })).toThrow(/Valid chips/)
  })
})

describe('lookups', () => {
  const song = createSong({ chip: 'nes' })
  it('finds channels by id, name and index', () => {
    expect(requireChannel(song, 'p1').id).toBe('P1')
    expect(requireChannel(song, 'Triangle').id).toBe('TR')
    expect(requireChannel(song, 3).id).toBe('NO')
    expect(requireChannel(song, '2').id).toBe('TR')
  })
  it('lists valid channels on failure', () => {
    expect(() => requireChannel(song, 'XX')).toThrow(/P1.*P2.*TR.*NO/s)
    expect(() => requireChannel(song, 9)).toThrow(/not found/)
  })
  it('finds instruments by index and name slug', () => {
    const { song: s } = songWithPresets('nes', [{ ref: 'lead' }, { ref: 'bass', kind: 'triangle' }])
    expect(findInstrumentIndex(s, 0)).toBe(0)
    expect(findInstrumentIndex(s, '@1')).toBe(1)
    expect(findInstrumentIndex(s, 'Bass')).toBe(1)
    expect(requireInstrument(s, '@lead').name).toBe('lead')
    expect(() => requireInstrument(s, 'nope')).toThrow(/@0 "lead".*@1 "bass"/)
    expect(() => requireInstrument(s, 7)).toThrow(/not found/)
  })
  it('validates order numbers', () => {
    expect(requireOrder(song, 0)).toBe(0)
    expect(() => requireOrder(song, 1)).toThrow(/0\.\.0/)
  })
})

describe('patterns', () => {
  it('getPattern creates, peekPattern does not', () => {
    const s = createSong({ chip: 'gb', patternLength: 16 })
    expect(peekPattern(s, 'P1', 0)).toBeUndefined()
    expect(patternAt(s, 0, 'P1')).toBeUndefined()
    const p = getPattern(s, 'P1', 0)
    expect(p.rows).toHaveLength(16)
    expect(s.patterns.has(patternKey('P1', 0))).toBe(true)
    expect(patternAt(s, 0, 0)).toBe(p)
    expect(patternAt(s, 5, 0)).toBeUndefined()
  })
  it('nextFreePattern skips used numbers', () => {
    const s = createSong({ chip: 'nes' })
    expect(nextFreePattern(s, 'P1')).toBe(1)
    getPattern(s, 'P1', 1)
    expect(nextFreePattern(s, 'P1')).toBe(2)
  })
  it('cell helpers normalize', () => {
    expect(isCellEmpty({})).toBe(true)
    expect(normalizeCell({ fx: [] })).toBeNull()
    expect(cellsEqual({ note: 60 }, { note: 60, fx: [] })).toBe(true)
    expect(cellsEqual({ note: 60 }, { note: 61 })).toBe(false)
  })
  it('cloneSong is deep', () => {
    const { song } = songWithPresets('nes', [{ ref: 'lead' }])
    getPattern(song, 'P1', 0).rows[0] = { note: 60, inst: 0 }
    const c = cloneSong(song)
    c.patterns.get('P1:0')!.rows[0]!.note = 61
    c.instruments[0]!.name = 'x'
    expect(song.patterns.get('P1:0')!.rows[0]!.note).toBe(60)
    expect(song.instruments[0]!.name).toBe('lead')
  })
  it('instrumentUsage counts cells', () => {
    const { song } = songWithPresets('nes', [{ ref: 'lead' }])
    const p = getPattern(song, 'P1', 0)
    p.rows[1] = { note: 60, inst: 0 }
    p.rows[5] = { note: 62, inst: 0 }
    expect(instrumentUsage(song, 0).count).toBe(2)
    expect(instrumentUsage(song, 1).count).toBe(0)
  })
})

describe('timing', () => {
  it('computes rows, ticks and seconds', () => {
    const s = createSong({ chip: 'nes', bpm: 120, patternLength: 64 })
    expect(rowSeconds(s.timing)).toBeCloseTo(0.125, 10)
    expect(tickSeconds(s.timing)).toBeCloseTo(0.125 / 6, 10)
    expect(songRows(s)).toBe(64)
    expect(songTicks(s)).toBe(64 * 6)
    expect(songSeconds(s)).toBeCloseTo(8, 8)
    s.orders.push([1, 1, 1, 1])
    expect(songSeconds(s)).toBeCloseTo(16, 8)
  })
  it('uses the groove for tick counts', () => {
    const s = createSong({ chip: 'nes', patternLength: 16, groove: [7, 5] })
    expect(songTicks(s)).toBe(16 * 6)
    const t = createSong({ chip: 'nes', patternLength: 16, groove: [8, 4] })
    expect(songTicks(t)).toBe(16 * 6)
  })
  it('summarizes the song', () => {
    const { song } = songWithPresets('gb', [{ ref: 'lead' }])
    getPattern(song, 'P1', 0).rows[0] = { note: 60 }
    const sum = summarizeSong(song)
    expect(sum.chip).toBe('gb')
    expect(sum.channels.find((c) => c.id === 'P1')!.notes).toBe(1)
    expect(sum.instruments[0]!.name).toBe('lead')
    expect(sum.bars).toBe(2)
  })
})
