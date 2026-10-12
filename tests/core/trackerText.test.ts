import { describe, expect, it } from 'vitest'
import { TrackerTextError, formatTrackerText, parseTrackerText, trackerToDiffs } from '../../src/core/codecs/trackerText'
import { createCellsCommand } from '../../src/core/commands'
import { type Cell, EFFECT_CODES, type Song } from '../../src/core/types'
import { cellsEqual, createSong, getPattern } from '../../src/core/model'
import { songWithPresets, rng } from './helpers'

function nesSong(opts: Partial<Parameters<typeof createSong>[0]> = {}): Song {
  return songWithPresets(
    'nes',
    [{ ref: 'lead' }, { ref: 'arp' }, { ref: 'bass', kind: 'triangle' }, { ref: 'kick', kind: 'noise' }, { ref: 'snare', kind: 'noise' }, { ref: 'hat' }],
    { patternLength: 32, ...opts }
  ).song
}

const EXAMPLE = `channels: P1 | P2 | TR | NO
 0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass | C-4 @kick
 4 | G-5           | .            | .         | C-4 @snare
 6 | A-5 4A2       | ===          | A-3       | C-4 @hat v6`

describe('parseTrackerText', () => {
  it('parses the plan example', () => {
    const song = nesSong()
    const r = parseTrackerText(EXAMPLE, song)
    expect(r.channels).toEqual(['P1', 'P2', 'TR', 'NO'])
    expect(r.rows.map((x) => x.row)).toEqual([0, 4, 6])
    expect(r.rows[0]!.cells).toEqual([
      { note: 76, inst: 0, vol: 12 },
      { note: 60, inst: 1, fx: [{ code: '0', param: 0x37 }] },
      { note: 45, inst: 2 },
      { note: 60, inst: 3 }
    ])
    expect(r.rows[1]!.cells).toEqual([{ note: 79 }, null, null, { note: 60, inst: 4 }])
    expect(r.rows[2]!.cells).toEqual([
      { note: 81, fx: [{ code: '4', param: 0xa2 }] },
      { note: 'off' },
      { note: 57 },
      { note: 60, inst: 5, vol: 6 }
    ])
  })
  it('recognises tokens by shape in any order, with all note spellings', () => {
    const song = nesSong()
    const r = parseTrackerText('channels: P1\n0 | v9 @lead 4A2 C#5 W01\n1 | Db5 @1\n2 | off\n3 | rel\n4 | ...\n5 | ---\n6 | @arp\n7 | 100', song)
    const cells = r.rows.map((x) => x.cells[0])
    expect(cells[0]).toEqual({ note: 73, inst: 0, vol: 9, fx: [{ code: '4', param: 0xa2 }, { code: 'W', param: 1 }] })
    expect(cells[1]).toEqual({ note: 73, inst: 1 })
    expect(cells[2]).toEqual({ note: 'off' })
    expect(cells[3]).toEqual({ note: 'rel' })
    expect(cells[4]).toBeNull()
    expect(cells[5]).toBeNull()
    expect(cells[6]).toEqual({ inst: 1 })
    expect(cells[7]).toEqual({ fx: [{ code: '1', param: 0 }] })
  })
  it('treats Db4 as a note and DB4 as an effect', () => {
    const song = nesSong()
    const r = parseTrackerText('channels: P1\n0 | Db4\n1 | DB4', song)
    expect(r.rows[0]!.cells[0]).toEqual({ note: 61 })
    expect(r.rows[1]!.cells[0]).toEqual({ fx: [{ code: 'D', param: 0xb4 }] })
  })
  it('numbers rows automatically, supports comments, headers and the instruments line', () => {
    const song = nesSong()
    const r = parseTrackerText('# comment\n// another\nchannels: P1 | TR\ninstruments: 0=lead 2=bass\nC-4 @lead | .\n.|A-2\n 8 | E-4 | .\n.|.', song)
    expect(r.rows.map((x) => x.row)).toEqual([0, 1, 8, 9])
    expect(r.declaredInstruments).toEqual([{ index: 0, name: 'lead' }, { index: 2, name: 'bass' }])
  })
  it('defaults to all channels when there is no header and accepts a leading and trailing pipe', () => {
    const song = nesSong()
    const r = parseTrackerText('| 0 | C-5 | . | . | . |', song)
    expect(r.channels).toEqual(['P1', 'P2', 'TR', 'NO'])
    expect(r.rows[0]!.cells[0]).toEqual({ note: 72 })
  })
  it('selects channel columns by name or id', () => {
    const song = nesSong()
    const r = parseTrackerText('channels: noise | Pulse 1\n0 | C-4 @kick | E-5', song)
    expect(r.channels).toEqual(['NO', 'P1'])
    expect(r.rows[0]!.cells).toEqual([{ note: 60, inst: 3 }, { note: 76 }])
  })
})

describe('parseTrackerText errors', () => {
  const messageOf = (text: string, song = nesSong()): TrackerTextError => {
    try {
      parseTrackerText(text, song)
    } catch (e) {
      expect(e).toBeInstanceOf(TrackerTextError)
      return e as TrackerTextError
    }
    throw new Error('expected an error')
  }

  it('reports volume on the triangle exactly like the plan', () => {
    const e = messageOf('channels: P1 | P2 | TR | NO\n 0 | . | . | . | .\n 4 | . | . | A-2 v12 | .')
    expect(e.issues).toEqual([{ line: 3, channel: 'TR', message: '"v12": triangle has no volume on NES; remove it' }])
    expect(e.message).toBe(
      'Invalid tracker text (1 problem):\n- Line 3, channel TR: "v12": triangle has no volume on NES; remove it'
    )
  })
  it('snapshot: several problems at once', () => {
    const e = messageOf(
      [
        'channels: P1 | TR',
        '0 | C-1 | A-2',
        '1 | C-4 C-5 | .',
        '2 | @nope | E-3 @lead',
        '3 | xyz | .',
        '4 | v99 | .',
        '40 | C-4 | .',
        '5 | C-4 | . | .',
        '5 | C-4 | .'
      ].join('\n')
    )
    expect(e.message).toMatchInlineSnapshot(`
      "Invalid tracker text (8 problems):
      - Line 2, channel P1: "C-1": note C-1 is below P1's lowest note A-1 on NES; transpose +12 or move to TR
      - Line 3, channel P1: "C-5": the cell already has a note (C-4); put one note per cell (a chip channel plays one note at a time; use an arpeggio effect like 047 for chords).
      - Line 4, channel P1: "@nope": no instrument named "nope". Instruments: @0 "lead", @1 "arp", @2 "bass", @3 "kick", @4 "snare", @5 "hat".
      - Line 4, channel TR: "@lead": instrument @0 "lead" is kind nes-pulse, which TR (Triangle) cannot play; TR accepts nes-tri; move this part to P1/P2 or pick a nes-tri instrument
      - Line 5, channel P1: unrecognized token "xyz". Use a note (C-4, C#4, Db4), === (note off), ^^^ (release), @instrument, vNN volume (v0..v15), an effect of three characters like 047 or W02, or . for empty.
      - Line 6, channel P1: "v99": volume must be v0..v15.
      - Line 7: row 40 is outside the pattern (rows 0..31); 9 row(s) too many.
      - Line 8: expected 2 cell column(s) separated by "|" (P1 | TR), optionally preceded by a row number, but found 4. Use "." for an empty cell."
    `)
  })
  it('explains header problems', () => {
    expect(messageOf('channels: P1 | ZZ\n0 | . | .').message).toContain('unknown channel "ZZ"')
    expect(messageOf('0 | . | . | . | .\nchannels: P1').message).toContain('must come before the first row')
    expect(messageOf('channels: P1 | P1\n0 | . | .').message).toContain('listed twice')
  })
  it('first column must be a row number when the column count is one too many', () => {
    const e = messageOf('channels: P1\nabc | C-4')
    expect(e.message).toContain('the first column must be a row number')
  })
  it('reports duplicate rows and effect-column overflow', () => {
    expect(messageOf('channels: P1\n3 | C-4\n3 | D-4').message).toContain('row 3 appears twice')
    expect(messageOf('channels: P1\n0 | C-4 047 4A2 W01').message).toContain('effect column')
  })
  it('caps the report at 12 issues', () => {
    const lines = ['channels: P1']
    for (let i = 0; i < 20; i++) lines.push(`${i} | bad${i}`)
    const e = messageOf(lines.join('\n'))
    expect(e.issues).toHaveLength(20)
    expect(e.message.split('\n').filter((l) => l.startsWith('- Line'))).toHaveLength(12)
    expect(e.message).toContain('...and 8 more problem(s).')
  })
  it('chip rules are skipped in relaxed mode (the validator reports them as warnings)', () => {
    const song = nesSong({ authenticity: 'relaxed' })
    const r = parseTrackerText('channels: TR\n0 | A-2 v12', song)
    expect(r.rows[0]!.cells[0]).toEqual({ note: 45, vol: 12 })
    expect(() => parseTrackerText('channels: TR\n0 | A-2 v12', song, { strict: true })).toThrow(/no volume/)
  })
})

describe('trackerToDiffs', () => {
  it('merges non-empty cells into the order patterns and replaces with clearing', () => {
    const song = nesSong()
    song.orders = [[0, 0, 0, 0], [1, 2, 3, 4]]
    const parsed = parseTrackerText('channels: P1 | TR\n0 | E-5 @lead | A-2 @bass\n2 | . | A-3', song)
    const merge = trackerToDiffs(song, parsed, { order: 1 }, 'merge')
    expect(merge).toEqual([
      { channel: 'P1', pattern: 1, row: 0, cell: { note: 76, inst: 0 } },
      { channel: 'TR', pattern: 3, row: 0, cell: { note: 45, inst: 2 } },
      { channel: 'TR', pattern: 3, row: 2, cell: { note: 57 } }
    ])
    createCellsCommand(song, merge).apply(song)
    expect(song.patterns.get('P1:1')!.rows[0]).toEqual({ note: 76, inst: 0 })
    const parsed2 = parseTrackerText('channels: P1\n5 | C-5', song)
    const replace = trackerToDiffs(song, parsed2, { pattern: 1 }, 'replace')
    expect(replace).toHaveLength(32 + 1)
    createCellsCommand(song, replace).apply(song)
    expect(song.patterns.get('P1:1')!.rows[0]).toBeNull()
    expect(song.patterns.get('P1:1')!.rows[5]).toEqual({ note: 72 })
    expect(() => trackerToDiffs(song, parsed2, { order: 9 })).toThrow(/Order 9 not found/)
  })
})

describe('formatTrackerText', () => {
  it('formats a column-aligned pattern with a header and parses back to the same cells', () => {
    const song = nesSong()
    const parsed = parseTrackerText(EXAMPLE, song)
    createCellsCommand(song, trackerToDiffs(song, parsed)).apply(song)
    const text = formatTrackerText(song, { sparse: true })
    expect(text).toMatchInlineSnapshot(`
      "# Untitled | nes | order 0 | 120 BPM, speed 6, 4 rows/beat | 32 rows
      # legend: C-4 note (C-4 = middle C), === note off, ^^^ release, @name or @n instrument, vNN volume (0-15), three-character effects like 047 (arp), . empty
      channels: P1 | P2 | TR | NO
      instruments: 0=lead 1=arp 2=bass 3=kick 4=snare 5=hat
       0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass | C-4 @kick
       4 | G-5           | .            | .         | C-4 @snare
       6 | A-5 4A2       | ===          | A-3       | C-4 @hat v6"
    `)
    const again = parseTrackerText(text, song)
    expect(again.rows.map((r) => r.row)).toEqual([0, 4, 6])
    again.rows.forEach((r, i) => r.cells.forEach((c, k) => expect(cellsEqual(c, parsed.rows[i]!.cells[k])).toBe(true)))
  })
  it('prints dense rows, row ranges, channel subsets and index references', () => {
    const song = nesSong()
    createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 1, cell: { note: 60, inst: 0 } }]).apply(song)
    const dense = formatTrackerText(song, { header: false, channels: ['P1'], fromRow: 0, toRow: 3 })
    expect(dense).toBe(' 0 | .\n 1 | C-4 @lead\n 2 | .')
    expect(formatTrackerText(song, { header: false, channels: ['P1'], sparse: true, instrumentRefs: 'index' })).toBe(' 1 | C-4 @0')
    expect(() => formatTrackerText(song, { channels: ['QQ'] })).toThrow(/not found/)
  })
  it('falls back to @index for duplicate or digit-leading instrument names', () => {
    const song = nesSong()
    song.instruments[1]!.name = '808kick'
    song.instruments[3]!.name = 'Lead'
    createCellsCommand(song, [
      { channel: 'P1', pattern: 0, row: 0, cell: { note: 60, inst: 1 } },
      { channel: 'P1', pattern: 0, row: 1, cell: { note: 60, inst: 3 } }
    ]).apply(song)
    const text = formatTrackerText(song, { header: false, channels: ['P1'], toRow: 2 })
    expect(text).toBe(' 0 | C-4 @1\n 1 | C-4 @3')
  })

  it('round-trips randomized cells on a 10-channel chip', () => {
    const random = rng(1234)
    const song = createSong({ chip: 'genesis', patternLength: 48, authenticity: 'relaxed' })
    for (const name of ['lead', 'Slap Bass', '808kick', 'pad']) song.instruments.push({ name, kind: 'psg', macros: {} })
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!
    const makeCell = (): Cell | null => {
      const cell: Cell = {}
      const r = random()
      if (r < 0.6) cell.note = 12 + Math.floor(random() * 116)
      else if (r < 0.7) cell.note = 'off'
      else if (r < 0.75) cell.note = 'rel'
      if (random() < 0.4) cell.inst = Math.floor(random() * song.instruments.length)
      if (random() < 0.3) cell.vol = Math.floor(random() * 16)
      const nfx = Math.floor(random() * 3)
      if (nfx > 0) cell.fx = Array.from({ length: nfx }, () => ({ code: pick(EFFECT_CODES), param: Math.floor(random() * 256) }))
      return Object.keys(cell).length > 0 ? cell : null
    }
    for (let round = 0; round < 25; round++) {
      const fresh = createSong({ chip: 'genesis', patternLength: 48, authenticity: 'relaxed' })
      fresh.instruments = song.instruments
      const diffs = []
      for (const ch of fresh.channels) for (let row = 0; row < 48; row++) diffs.push({ channel: ch.id, pattern: 0, row, cell: makeCell() })
      const cmd = createCellsCommand(fresh, diffs)
      cmd.apply(fresh)
      for (const sparse of [false, true]) {
        const text = formatTrackerText(fresh, { sparse, instrumentRefs: round % 2 ? 'index' : 'name' })
        const parsed = parseTrackerText(text, fresh, { strict: false })
        for (const row of parsed.rows) {
          parsed.channels.forEach((id, k) => {
            const expected = fresh.patterns.get(`${id}:0`)?.rows[row.row] ?? null
            expect(cellsEqual(row.cells[k], expected), `${id} row ${row.row}\n${text}`).toBe(true)
          })
        }
        if (!sparse) expect(parsed.rows).toHaveLength(48)
      }
    }
    void getPattern
  })
})
