import { describe, expect, it } from 'vitest'
import {
  PROJECT_FORMAT, PROJECT_MIGRATIONS, PROJECT_VERSION, ProjectError, migrateProject, parseProject, projectToSong, serializeProject, songToProject
} from '../../src/core/codecs/project'
import { cellsEqual, createSong, getPattern } from '../../src/core/model'
import { createCellsCommand, createInstrumentCommand, createSetOrdersCommand } from '../../src/core/commands'
import { type Song } from '../../src/core/types'
import { resolvePreset } from '../../src/core/instruments'
import { songWithPresets } from './helpers'

function sameSong(a: Song, b: Song): void {
  const strip = (s: Song): unknown => ({ ...s, patterns: undefined })
  expect(strip(b)).toEqual(strip(a))
  const keys = (s: Song): string[] =>
    [...s.patterns.entries()].filter(([, p]) => p.rows.some((c) => c)).map(([k]) => k).sort()
  expect(keys(b)).toEqual(keys(a))
  for (const k of keys(a)) {
    const pa = a.patterns.get(k as never)!
    const pb = b.patterns.get(k as never)!
    expect(pb.rows).toHaveLength(pa.rows.length)
    pa.rows.forEach((c, i) => expect(cellsEqual(c, pb.rows[i]), `${k} row ${i}`).toBe(true))
  }
}

function richSong(): Song {
  const { song } = songWithPresets('nes', [{ ref: 'lead' }, { ref: 'arp' }, { ref: 'bass', kind: 'triangle' }, { ref: 'kick', kind: 'noise' }], {
    name: 'Rich', bpm: 133, key: 'F#', scale: 'minor', moods: ['battle'], tags: ['demo'], groove: [7, 5], patternLength: 32
  })
  song.meta.notes = 'hello'
  song.channels[0]!.muted = true
  song.channels[1]!.trim = -2
  song.references.push({ assetId: 'a1', note: 'n' })
  createCellsCommand(song, [
    { channel: 'P1', pattern: 0, row: 0, cell: { note: 60, inst: 0, vol: 12 } },
    { channel: 'P1', pattern: 0, row: 7, cell: { note: 'off' } },
    { channel: 'P1', pattern: 1, row: 3, cell: { note: 'rel', fx: [{ code: '4', param: 0xa2 }, { code: 'W', param: 1 }] } },
    { channel: 'TR', pattern: 0, row: 31, cell: { inst: 2 } },
    { channel: 'NO', pattern: 2, row: 0, cell: { note: 60, inst: 3, fx: [{ code: 'F', param: 0x20 }] } }
  ]).apply(song)
  createSetOrdersCommand(song, [[0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 2]], { loop: { order: 1 } }).apply(song)
  return song
}

describe('project round trip', () => {
  it('serialises and parses a NES song', () => {
    const song = richSong()
    const text = serializeProject(song)
    const back = parseProject(text)
    sameSong(song, back)
    expect(back.patterns).toBeInstanceOf(Map)
  })
  it('stores patterns sparsely with the documented layout', () => {
    const song = richSong()
    const file = songToProject(song)
    expect(file.format).toBe(PROJECT_FORMAT)
    expect(file.version).toBe(PROJECT_VERSION)
    expect(file.song.patterns['P1:0']).toEqual([[0, 60, 0, 12], [7, 'off', null, null]])
    expect(file.song.patterns['P1:1']).toEqual([[3, 'rel', null, null, '4A2', 'W01']])
    expect(file.song.patterns['TR:0']).toEqual([[31, null, 2, null]])
    expect(file.song.patterns['NO:2']).toEqual([[0, 60, 3, null, 'F20']])
    expect(Object.keys(file.song.patterns)).toEqual(['NO:2', 'P1:0', 'P1:1', 'TR:0'])
    expect(file.samples).toEqual([])
    expect((file.song as Record<string, unknown>).samples).toBeUndefined()
  })
  it('omits empty patterns and keeps the song unchanged', () => {
    const song = createSong({ chip: 'gb', patternLength: 16 })
    getPattern(song, 'P1', 0)
    expect(Object.keys(songToProject(song).song.patterns)).toEqual([])
    expect(song.patterns.size).toBe(1)
  })
  it('round-trips every chip with its config, instruments and samples', () => {
    for (const chip of ['nes', 'gb', 'genesis', 'snes', 'pce'] as const) {
      const song = createSong({ chip, patternLength: 16 })
      if (chip === 'nes' || chip === 'gb') createInstrumentCommand(song, { op: 'add', instrument: resolvePreset(chip, 'lead') }).apply(song)
      if (chip === 'genesis') {
        song.instruments.push({
          name: 'fm', kind: 'fm', alg: 4, fb: 3, ams: 0, pms: 0,
          ops: [0, 1, 2, 3].map((i) => ({ ar: 31, dr: 5, sr: 0, rr: 7, sl: 3, tl: 20 + i, ks: 0, ml: 1, dt: 0, ssg: 0, am: false })) as never
        })
      }
      if (chip === 'snes') {
        song.samples.push(
          { id: 's1', name: 'pcm', source: { kind: 'pcm', sampleRate: 32000, data: 'AAABAAIA' }, loopStart: 0 },
          { id: 's2', name: 'rec', source: { kind: 'recipe', recipe: 'strings', params: { n: 3, a: 'b', c: true } } }
        )
        song.instruments.push(
          { name: 'str', kind: 'snes-sample', sample: 's2', baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: true, fine: 5 },
          { name: 'g', kind: 'snes-sample', sample: 's1', baseNote: 48, env: { gain: { mode: 'exp-dec', rate: 10 } }, echo: false }
        )
      }
      if (chip === 'pce') {
        song.instruments.push({ name: 'w', kind: 'pce-wave', waves: [Array.from({ length: 32 }, (_, i) => i)], noise: false, macros: { timbre: { values: [0], loop: 0 } } })
      }
      const first = song.channels[0]!.id
      createCellsCommand(song, [{ channel: first, pattern: 0, row: 2, cell: { note: 64, ...(song.instruments.length ? { inst: 0 } : {}) } }]).apply(song)
      sameSong(song, parseProject(serializeProject(song, false)))
    }
  })
})

describe('project errors', () => {
  const problems = (raw: unknown): string => {
    try {
      projectToSong(raw)
    } catch (e) {
      expect(e).toBeInstanceOf(ProjectError)
      return (e as ProjectError).message
    }
    throw new Error('expected an error')
  }
  const base = (): ReturnType<typeof songToProject> => JSON.parse(JSON.stringify(songToProject(richSong())))

  it('rejects text that is not JSON or not a project', () => {
    expect(() => parseProject('{nope')).toThrow(/not valid JSON/)
    expect(problems({ format: 'other', version: 1 })).toContain('format')
    expect(problems(null)).toContain('(root)')
  })
  it('reports schema problems with paths', () => {
    const p = base()
    ;(p.song as { timing: { bpm: unknown } }).timing.bpm = 'fast'
    expect(problems(p)).toContain('song.timing.bpm')
  })
  it('validates the cell data of sparse patterns', () => {
    const p = base()
    p.song.patterns['P1:0']!.push([99, 60, null, null], [1, 300, null, null], [2, null, 9, null], [3, null, null, 20], [4, null, null, null, 'ZZZ'])
    const msg = problems(p)
    expect(msg).toContain('row 99 is outside 0..31')
    expect(msg).toContain('note 300')
    expect(msg).toContain('instrument 9 does not exist')
    expect(msg).toContain('volume 20')
    expect(msg).toContain('effect "ZZZ" must be a string like "4A2"')
  })
  it('validates structure: channels, orders, loop, keys', () => {
    const p = base()
    p.song.patterns['XX:0'] = [[0, 60, null, null]]
    p.song.orders.push([0, 0])
    p.song.loop = { order: 9 }
    p.song.meta.key = 'H'
    const msg = problems(p)
    expect(msg).toContain('patterns["XX:0"]')
    expect(msg).toContain('orders[3]: has 2 entries but the song has 4 channels')
    expect(msg).toContain('loop.order 9')
    expect(msg).toContain('meta.key "H"')
  })
  it('refuses projects from a newer version and applies migrations for older ones', () => {
    const p = base()
    p.version = PROJECT_VERSION + 1
    expect(problems(p)).toContain('newer version')
    const old = { ...base(), version: 0 } as Record<string, unknown>
    expect(problems(old)).toContain('no migration from project version 0')
    PROJECT_MIGRATIONS[0] = (raw) => ({ ...raw, migrated: true })
    try {
      expect((migrateProject(old) as { version: number; migrated: boolean }).migrated).toBe(true)
      expect(projectToSong(old).name).toBe('Rich')
    } finally {
      delete PROJECT_MIGRATIONS[0]
    }
  })
})
