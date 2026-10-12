import { describe, expect, it } from 'vitest'
import { type CellDiff, type Song, createCellsCommand, createSetOrdersCommand, createSong } from '../../src/core'
import {
  buildLayout,
  channelWidth,
  clampCursor,
  clearField,
  clearSelectionDiffs,
  copySelection,
  fieldAt,
  fieldCount,
  formatCellParts,
  inSelection,
  layoutForSong,
  moveCursor,
  noteEntry,
  pasteDiffs,
  readCell,
  rowHighlight,
  selectionBetween,
  setFxCode,
  setFxParam,
  setInst,
  setVol,
  specialNoteEntry,
  transposeDiffs
} from '../../src/renderer/lib/trackerGrid'

function songWith(cells: Array<[ch: number, row: number, cell: NonNullable<ReturnType<typeof readCell>>]> = []): Song {
  const song = createSong({ chip: 'nes', patternLength: 16 })
  song.instruments.push({ name: 'a', kind: 'nes-pulse', macros: {} })
  if (cells.length > 0) {
    createCellsCommand(song, cells.map(([channel, row, cell]) => ({ channel, pattern: 0, row, cell }))).apply(song)
  }
  return song
}

function apply(song: Song, diffs: CellDiff[]): void {
  createCellsCommand(song, diffs).apply(song)
}

describe('column layout', () => {
  it('lays out note, instrument (2 digits), volume and one 3-char effect per column', () => {
    const l = buildLayout([1, 2])
    const c0 = l.channels[0]!
    expect(c0.fields.map((f) => f.kind)).toEqual(['note', 'inst0', 'inst1', 'vol', 'fxcode', 'fxhi', 'fxlo'])
    expect(c0.widthCh).toBe(channelWidth(1))
    expect(l.channels[1]!.fields).toHaveLength(fieldCount(2))
    expect(l.channels[1]!.startCh).toBe(c0.startCh + c0.widthCh)
    expect(l.totalCh).toBe(l.gutterCh + channelWidth(1) + channelWidth(2))
    // fields never overlap and stay inside their channel
    for (const ch of l.channels) {
      let prevEnd = ch.startCh
      for (const f of ch.fields) {
        expect(f.startCh).toBeGreaterThanOrEqual(prevEnd)
        prevEnd = f.startCh + f.widthCh
      }
      expect(prevEnd).toBeLessThanOrEqual(ch.startCh + ch.widthCh)
    }
  })

  it('finds the field under a character column', () => {
    const l = layoutForSong(songWith())
    const c1 = l.channels[1]!
    expect(fieldAt(l, 0)).toBeNull()
    expect(fieldAt(l, c1.fields[0]!.startCh)).toEqual({ channel: 1, field: 0 })
    expect(fieldAt(l, c1.fields[3]!.startCh)).toEqual({ channel: 1, field: 3 })
    // the separator between fields snaps to the nearest one
    expect(fieldAt(l, c1.fields[0]!.startCh + 3)?.channel).toBe(1)
  })
})

describe('cursor navigation', () => {
  const song = songWith()
  song.orders.push([1, 1, 1, 1])
  const at = (order: number, row: number, channel: number, field: number) => ({ order, row, channel, field })

  it('moves between fields and wraps to the next channel', () => {
    const last = fieldCount(song.channels[0]!.fxColumns) - 1
    expect(moveCursor(song, at(0, 0, 0, 0), 'right')).toEqual(at(0, 0, 0, 1))
    expect(moveCursor(song, at(0, 0, 0, last), 'right')).toEqual(at(0, 0, 1, 0))
    expect(moveCursor(song, at(0, 0, 1, 0), 'left')).toEqual(at(0, 0, 0, last))
    expect(moveCursor(song, at(0, 0, 0, 0), 'left')).toEqual(at(0, 0, 0, 0))
  })

  it('moves rows and crosses into the next / previous order', () => {
    expect(moveCursor(song, at(0, 3, 0, 0), 'down').row).toBe(4)
    expect(moveCursor(song, at(0, 15, 0, 0), 'down')).toEqual(at(1, 0, 0, 0))
    expect(moveCursor(song, at(1, 0, 0, 0), 'up')).toEqual(at(0, 15, 0, 0))
    expect(moveCursor(song, at(0, 0, 0, 0), 'up')).toEqual(at(0, 0, 0, 0))
    expect(moveCursor(song, at(1, 15, 0, 0), 'down')).toEqual(at(1, 15, 0, 0))
  })

  it('pages, goes home/end and tabs between channels', () => {
    // a page is 16 rows, i.e. exactly one 16-row pattern here
    expect(moveCursor(song, at(0, 2, 0, 0), 'pageDown')).toEqual(at(1, 2, 0, 0))
    expect(moveCursor(song, at(1, 2, 0, 0), 'pageUp')).toEqual(at(0, 2, 0, 0))
    expect(moveCursor(song, at(0, 5, 0, 0), 'home').row).toBe(0)
    expect(moveCursor(song, at(0, 5, 0, 0), 'end').row).toBe(15)
    expect(moveCursor(song, at(0, 5, 0, 4), 'tabNext')).toEqual(at(0, 5, 1, 0))
    expect(moveCursor(song, at(0, 5, 3, 4), 'tabNext')).toEqual(at(0, 5, 0, 0))
    expect(moveCursor(song, at(0, 5, 0, 4), 'tabPrev')).toEqual(at(0, 5, 3, 0))
  })

  it('clamps out-of-range cursors', () => {
    expect(clampCursor(song, at(9, 99, 9, 99))).toEqual(at(1, 15, 3, fieldCount(song.channels[3]!.fxColumns) - 1))
  })
})

describe('selection', () => {
  it('is the rectangle between anchor and cursor, only inside one order', () => {
    const sel = selectionBetween({ order: 0, row: 6, channel: 2 }, { order: 0, row: 2, channel: 1 })
    expect(sel).toEqual({ order: 0, row1: 2, row2: 6, ch1: 1, ch2: 2 })
    expect(selectionBetween({ order: 0, row: 1, channel: 0 }, { order: 1, row: 1, channel: 0 })).toBeNull()
    expect(inSelection(sel, 0, 4, 2)).toBe(true)
    expect(inSelection(sel, 0, 7, 2)).toBe(false)
    expect(inSelection(sel, 1, 4, 2)).toBe(false)
    expect(inSelection(null, 0, 0, 0)).toBe(false)
  })
})

describe('clipboard, clear and transpose produce diffs that run as one command', () => {
  it('copies a selection and pastes it elsewhere (including empty rows)', () => {
    const song = songWith([
      [0, 0, { note: 60, inst: 0 }],
      [0, 2, { note: 'off' }],
      [1, 1, { note: 64, vol: 9 }]
    ])
    const clip = copySelection(song, { order: 0, row1: 0, row2: 2, ch1: 0, ch2: 1 })
    expect(clip.rows).toBe(3)
    expect(clip.channels).toBe(2)
    expect(clip.cells[1]![0]).toBeNull()
    const diffs = pasteDiffs(song, 0, 8, 0, clip)
    expect(diffs).toHaveLength(6)
    apply(song, diffs)
    expect(readCell(song, 0, 0, 8)).toEqual({ note: 60, inst: 0 })
    expect(readCell(song, 0, 0, 10)).toEqual({ note: 'off' })
    expect(readCell(song, 0, 1, 9)).toEqual({ note: 64, vol: 9 })
    // the clip is a copy: editing the song later does not change it
    apply(song, [{ channel: 0, pattern: 0, row: 0, cell: { note: 72 } }])
    expect(clip.cells[0]![0]).toEqual({ note: 60, inst: 0 })
  })

  it('drops pasted cells that fall past the pattern end or the last channel', () => {
    const song = songWith([[0, 0, { note: 60 }], [0, 1, { note: 62 }]])
    const clip = copySelection(song, { order: 0, row1: 0, row2: 1, ch1: 0, ch2: 1 })
    const diffs = pasteDiffs(song, 0, 15, 3, clip)
    expect(diffs).toHaveLength(1)
    expect(diffs[0]).toMatchObject({ channel: 3, row: 15 })
  })

  it('clears only the cells that hold something', () => {
    const song = songWith([[0, 0, { note: 60 }], [1, 3, { note: 62 }]])
    const diffs = clearSelectionDiffs(song, { order: 0, row1: 0, row2: 7, ch1: 0, ch2: 1 })
    expect(diffs).toHaveLength(2)
    apply(song, diffs)
    expect(readCell(song, 0, 0, 0)).toBeNull()
    expect(readCell(song, 0, 1, 3)).toBeNull()
  })

  it('transposes pitched notes by semitones, clamped to the tracker range, leaving off/rel alone', () => {
    const song = songWith([[0, 0, { note: 60, inst: 0 }], [0, 1, { note: 'off' }], [0, 2, { note: 127 }], [0, 3, { note: 12 }]])
    const sel = { order: 0, row1: 0, row2: 3, ch1: 0, ch2: 0 }
    const up = transposeDiffs(song, sel, 12)
    expect(up).toHaveLength(3 - 1) // 127 is already at the top
    apply(song, up)
    expect(readCell(song, 0, 0, 0)).toEqual({ note: 72, inst: 0 })
    expect(readCell(song, 0, 0, 1)).toEqual({ note: 'off' })
    expect(readCell(song, 0, 0, 2)).toEqual({ note: 127 })
    expect(readCell(song, 0, 0, 3)).toEqual({ note: 24 })
    expect(transposeDiffs(song, sel, 0)).toEqual([])
  })

  it('a paste is a single undo step', () => {
    const song = songWith([[0, 0, { note: 60 }]])
    const clip = copySelection(song, { order: 0, row1: 0, row2: 0, ch1: 0, ch2: 0 })
    const cmd = createCellsCommand(song, pasteDiffs(song, 0, 4, 1, clip))
    cmd.apply(song)
    expect(readCell(song, 0, 1, 4)).toEqual({ note: 60 })
    cmd.invert(song)
    expect(readCell(song, 0, 1, 4)).toBeNull()
  })

  it('works through the order list: the diff targets the pattern that order plays', () => {
    const song = songWith()
    createSetOrdersCommand(song, [[0, 0, 0, 0], [1, 2, 3, 4]]).apply(song)
    apply(song, pasteDiffs(song, 1, 0, 2, { rows: 1, channels: 1, cells: [[{ note: 65 }]] }))
    expect(readCell(song, 1, 2, 0)).toEqual({ note: 65 })
    expect(song.patterns.has('TR:3')).toBe(true)
  })
})

describe('per-field cell edits', () => {
  it('enters notes with the current instrument and keeps volume and effects', () => {
    expect(noteEntry(null, 60, 2)).toEqual({ note: 60, inst: 2 })
    expect(noteEntry({ vol: 9, fx: [{ code: '4', param: 0x37 }], inst: 1 }, 62)).toEqual({ note: 62, inst: 1, vol: 9, fx: [{ code: '4', param: 0x37 }] })
    expect(specialNoteEntry({ note: 60, inst: 1 }, 'rel')).toEqual({ note: 'rel', inst: 1 })
  })

  it('sets and clears instrument and volume', () => {
    expect(setInst(null, 5)).toEqual({ inst: 5 })
    expect(setInst({ inst: 5 }, undefined)).toBeNull()
    expect(setVol({ note: 60 }, 12)).toEqual({ note: 60, vol: 12 })
  })

  it('edits effect code and parameter per column', () => {
    let c = setFxCode(null, 0, 'W')
    expect(c.fx).toEqual([{ code: 'W', param: 0 }])
    c = setFxParam(c, 0, 0x21)!
    expect(c.fx).toEqual([{ code: 'W', param: 0x21 }])
    c = setFxCode(c, 0, '4')
    expect(c.fx).toEqual([{ code: '4', param: 0x21 }])
    // a second column appends after the first
    c = setFxCode(c, 1, 'A')
    expect(c.fx).toEqual([{ code: '4', param: 0x21 }, { code: 'A', param: 0 }])
    // a parameter without a code does nothing
    expect(setFxParam({ note: 60 }, 0, 3)).toEqual({ note: 60 })
  })

  it('clears a field: note clears note+inst+vol, others their own value', () => {
    const cell = { note: 60, inst: 1, vol: 5, fx: [{ code: '4' as const, param: 1 }] }
    const l = buildLayout([1]).channels[0]!.fields
    expect(clearField(cell, l[0])).toEqual({ fx: [{ code: '4', param: 1 }] })
    expect(clearField(cell, l[1])).toEqual({ note: 60, vol: 5, fx: [{ code: '4', param: 1 }] })
    expect(clearField(cell, l[3])).toEqual({ note: 60, inst: 1, fx: [{ code: '4', param: 1 }] })
    expect(clearField(cell, l[4])).toEqual({ note: 60, inst: 1, vol: 5 })
    expect(clearField(null, l[0])).toBeNull()
  })
})

describe('display', () => {
  it('formats cells like a tracker', () => {
    expect(formatCellParts(null, 2)).toEqual({ note: '---', inst: '..', vol: '.', fx: ['...', '...'] })
    expect(formatCellParts({ note: 60, inst: 10, vol: 15, fx: [{ code: '4', param: 0xa2 }] }, 2)).toEqual({ note: 'C-4', inst: '0A', vol: 'F', fx: ['4A2', '...'] })
    expect(formatCellParts({ note: 'off' }, 1).note).toBe('===')
    expect(formatCellParts({ note: 'rel' }, 1).note).toBe('^^^')
    expect(formatCellParts({ note: 61 }, 1).note).toBe('C#4')
  })

  it('highlights beat and bar rows', () => {
    expect(rowHighlight(0, 4, 4)).toBe('bar')
    expect(rowHighlight(16, 4, 4)).toBe('bar')
    expect(rowHighlight(4, 4, 4)).toBe('beat')
    expect(rowHighlight(5, 4, 4)).toBe('')
  })
})
