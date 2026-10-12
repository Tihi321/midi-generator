import { describe, expect, it } from 'vitest'
import { createSong } from '../../src/core'
import { assetMatches, motifRange, parseList, saveArgs } from '../../src/renderer/lib/assetForm'
import type { AssetMeta } from '../../src/tools'

const form = { kind: 'song' as const, name: '  Hero  ', tags: 'boss, Fast;  ', moods: 'heroic', notes: ' warm ', instrument: 2 }

describe('library form helpers', () => {
  it('parseList splits on commas, semicolons and newlines', () => {
    expect(parseList('a, b;c\n d ,, ')).toEqual(['a', 'b', 'c', 'd'])
    expect(parseList('')).toEqual([])
  })

  it('save_as_asset arguments per kind', () => {
    const song = createSong({ chip: 'nes', patternLength: 32 })
    expect(saveArgs(form, song, null, 0)).toEqual({ name: 'Hero', kind: 'song', tags: ['boss', 'Fast'], moods: ['heroic'], notes: 'warm' })
    expect(saveArgs({ ...form, kind: 'instrument', notes: '' }, song, null, 0)).toEqual({ name: 'Hero', kind: 'instrument', tags: ['boss', 'Fast'], moods: ['heroic'], instrument: 2 })
  })

  it('a motif uses the tracker selection, else the cursor order', () => {
    const song = createSong({ chip: 'nes', patternLength: 32 })
    const sel = { order: 0, row1: 4, row2: 11, ch1: 0, ch2: 1 }
    expect(motifRange(song, sel, 0)).toMatchObject({ fromOrder: 0, toOrder: 0, fromRow: 4, toRow: 12, channels: ['P1', 'P2'] })
    expect(saveArgs({ ...form, kind: 'motif' }, song, sel, 0)).toMatchObject({ kind: 'motif', fromRow: 4, toRow: 12, channels: ['P1', 'P2'] })
    const whole = motifRange(song, null, 0)
    expect(whole).toMatchObject({ fromOrder: 0, toOrder: 0, fromRow: 0, toRow: 32 })
    expect(whole.channels).toBeUndefined()
    expect(whole.label).toMatch(/Order 0, all rows/)
  })

  it('card filtering by kind, chip and every word of the query', () => {
    const a = { id: 'a', name: 'Hero Theme', kind: 'song', chip: 'gb', tags: ['boss'], moods: ['Heroic'] } as unknown as AssetMeta
    expect(assetMatches(a, '', '', '')).toBe(true)
    expect(assetMatches(a, 'song', 'gb', 'hero boss')).toBe(true)
    expect(assetMatches(a, 'motif', '', '')).toBe(false)
    expect(assetMatches(a, '', 'nes', '')).toBe(false)
    expect(assetMatches(a, '', '', 'hero shop')).toBe(false)
    expect(assetMatches(a, '', '', 'heroic')).toBe(true)
  })
})
