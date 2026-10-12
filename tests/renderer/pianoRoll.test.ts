import { describe, expect, it } from 'vitest'
import { type CellDiff, type Song, createCellsCommand, createSetOrdersCommand, createSong } from '../../src/core'
import {
  DEFAULT_GEOMETRY,
  type RollNote,
  cellAtRow,
  deleteNoteDiffs,
  deriveNotes,
  drawNoteDiffs,
  gestureDiffs,
  gesturePreview,
  hitZone,
  linearRow,
  maxResizeEnd,
  moveNoteDiffs,
  noteAt,
  pitchRange,
  pitchToY,
  resizeNoteDiffs,
  rowToX,
  splitRow,
  totalRows,
  xToRowF,
  yToPitch
} from '../../src/renderer/lib/pianoRoll'

type Entry = [ch: number, lin: number, cell: NonNullable<ReturnType<typeof cellAtRow>>]

function make(entries: Entry[] = [], orders = 1): Song {
  const song = createSong({ chip: 'nes', patternLength: 16 })
  song.instruments.push({ name: 'a', kind: 'nes-pulse', macros: {} })
  if (orders > 1) {
    createSetOrdersCommand(song, Array.from({ length: orders }, (_, o) => song.channels.map(() => o))).apply(song)
  }
  put(song, entries)
  return song
}

function put(song: Song, entries: Entry[]): void {
  const diffs: CellDiff[] = entries.map(([channel, lin, cell]) => {
    const { order, row } = splitRow(song, lin)
    return { channel, pattern: song.orders[order]![channel]!, row, cell }
  })
  if (diffs.length > 0) createCellsCommand(song, diffs).apply(song)
}

/** Run diffs the way the UI does and report whether it was a single command. */
function run(song: Song, diffs: CellDiff[]): () => void {
  const cmd = createCellsCommand(song, diffs)
  cmd.apply(song)
  return () => cmd.invert(song)
}

const notesOf = (song: Song, ch = 0): Array<Pick<RollNote, 'start' | 'end' | 'pitch' | 'endsWith'>> =>
  deriveNotes(song, [ch]).map(({ start, end, pitch, endsWith }) => ({ start, end, pitch, endsWith }))

describe('deriveNotes', () => {
  it('a note lasts until the next note, a note-off, a release or the end', () => {
    const song = make([
      [0, 0, { note: 60, inst: 0, vol: 12 }],
      [0, 4, { note: 62 }],
      [0, 6, { note: 'off' }],
      [0, 8, { note: 64 }],
      [0, 10, { note: 'rel' }],
      [0, 12, { note: 65 }]
    ])
    expect(notesOf(song)).toEqual([
      { start: 0, end: 4, pitch: 60, endsWith: 'note' },
      { start: 4, end: 6, pitch: 62, endsWith: 'off' },
      { start: 8, end: 10, pitch: 64, endsWith: 'rel' },
      { start: 12, end: 16, pitch: 65, endsWith: 'end' }
    ])
    expect(deriveNotes(song, [0])[0]).toMatchObject({ inst: 0, vol: 12 })
  })

  it('spans orders as one strip and keeps channels apart', () => {
    const song = make([[0, 14, { note: 60 }], [0, 20, { note: 'off' }], [1, 3, { note: 70 }]], 2)
    expect(totalRows(song)).toBe(32)
    expect(notesOf(song, 0)).toEqual([{ start: 14, end: 20, pitch: 60, endsWith: 'off' }])
    expect(deriveNotes(song).map((n) => [n.channel, n.pitch])).toEqual([[1, 70], [0, 60]])
    expect(linearRow(song, 1, 4)).toBe(20)
    expect(splitRow(song, 20)).toEqual({ order: 1, row: 4 })
  })

  it('ignores cells without notes', () => {
    expect(deriveNotes(make([[0, 3, { vol: 4 }]]))).toEqual([])
  })
})

describe('geometry and hit testing', () => {
  const g = { ...DEFAULT_GEOMETRY, maxPitch: 84 }
  it('maps rows and pitches to pixels and back', () => {
    expect(xToRowF(g, rowToX(g, 7))).toBeCloseTo(7)
    expect(yToPitch(g, pitchToY(g, 60) + 1)).toBe(60)
    expect(yToPitch(g, pitchToY(g, 60) + g.noteH - 1)).toBe(60)
    expect(yToPitch(g, pitchToY(g, 61) + 1)).toBe(61)
  })

  it('finds the note under a cell, preferring the later-starting one', () => {
    const song = make([[0, 0, { note: 60 }], [0, 4, { note: 'off' }], [1, 2, { note: 60 }]])
    const notes = deriveNotes(song)
    expect(noteAt(notes, 2, 60, [0])?.channel).toBe(0)
    expect(noteAt(notes, 2, 60)?.channel).toBe(1)
    expect(noteAt(notes, 4, 60, [0])).toBeUndefined()
    expect(noteAt(notes, 2, 61)).toBeUndefined()
  })

  it('has a resize zone at the right edge', () => {
    const n: RollNote = { channel: 0, start: 0, end: 8, pitch: 60, endsWith: 'off' }
    expect(hitZone(n, 4, 0.5)).toBe('body')
    expect(hitZone(n, 7.8, 0.5)).toBe('resize')
    const short: RollNote = { channel: 0, start: 0, end: 1, pitch: 60, endsWith: 'off' }
    expect(hitZone(short, 0.2, 2)).toBe('body')
    expect(hitZone(short, 0.9, 2)).toBe('resize')
  })

  it('shows the chip range plus margins and widens for notes outside it', () => {
    const song = make()
    const r = pitchRange(song, [0], [])
    expect(r.min).toBeLessThan(r.max)
    const wide = pitchRange(song, [0], [{ channel: 0, start: 0, end: 1, pitch: 126, endsWith: 'off' }])
    expect(wide.max).toBeGreaterThanOrEqual(126)
    expect(wide.max).toBeLessThanOrEqual(127)
  })
})

describe('draw', () => {
  it('writes the note at the start and a note-off at the end', () => {
    const song = make()
    run(song, drawNoteDiffs(song, 0, 64, 4, 3, 0))
    expect(notesOf(song)).toEqual([{ start: 4, end: 7, pitch: 64, endsWith: 'off' }])
    expect(cellAtRow(song, 0, 4)).toEqual({ note: 64, inst: 0 })
    expect(cellAtRow(song, 0, 7)).toEqual({ note: 'off' })
  })

  it('is one undo step that restores the song', () => {
    const song = make()
    const undo = run(song, drawNoteDiffs(song, 0, 64, 4, 3, 0))
    undo()
    expect(deriveNotes(song)).toEqual([])
    expect(cellAtRow(song, 0, 7)).toBeNull()
  })

  it('clips at the end of the song and leaves no note-off there', () => {
    const song = make()
    run(song, drawNoteDiffs(song, 0, 60, 14, 8))
    expect(notesOf(song)).toEqual([{ start: 14, end: 16, pitch: 60, endsWith: 'end' }])
  })

  it('overwrites notes inside the drawn span and cuts the note it starts in', () => {
    const song = make([[0, 0, { note: 60 }], [0, 6, { note: 62 }], [0, 12, { note: 'off' }]])
    run(song, drawNoteDiffs(song, 0, 70, 4, 6))
    expect(notesOf(song)).toEqual([
      { start: 0, end: 4, pitch: 60, endsWith: 'note' },
      { start: 4, end: 10, pitch: 70, endsWith: 'off' }
    ])
    // the old note-off at 12 stays (harmless) and the 62 inside the span is gone
    expect(cellAtRow(song, 0, 6)).toBeNull()
  })

  it('does not put a note-off over a note that starts exactly at the end', () => {
    const song = make([[0, 8, { note: 67 }]])
    run(song, drawNoteDiffs(song, 0, 60, 4, 4))
    expect(notesOf(song)).toEqual([
      { start: 4, end: 8, pitch: 60, endsWith: 'note' },
      { start: 8, end: 16, pitch: 67, endsWith: 'end' }
    ])
  })

  it('ignores out-of-range requests', () => {
    const song = make()
    expect(drawNoteDiffs(song, 0, 60, 99, 2)).toEqual([])
    expect(drawNoteDiffs(song, 0, 5, 0, 2)).toEqual([])
  })
})

describe('move', () => {
  it('moves in time and pitch, carrying instrument/volume and the note-off', () => {
    const song = make([[0, 2, { note: 60, inst: 0, vol: 9 }], [0, 6, { note: 'off' }]])
    const note = deriveNotes(song)[0]!
    run(song, moveNoteDiffs(song, note, 3, 2))
    expect(notesOf(song)).toEqual([{ start: 5, end: 9, pitch: 62, endsWith: 'off' }])
    expect(cellAtRow(song, 0, 5)).toEqual({ note: 62, inst: 0, vol: 9 })
    expect(cellAtRow(song, 0, 2)).toBeNull()
    expect(cellAtRow(song, 0, 6)).toBeNull()
  })

  it('a pitch-only move keeps the other fields', () => {
    const song = make([[0, 0, { note: 60, inst: 0, fx: [{ code: '4', param: 0x37 }] }], [0, 4, { note: 'rel' }]])
    run(song, moveNoteDiffs(song, deriveNotes(song)[0]!, 0, 5))
    expect(cellAtRow(song, 0, 0)).toEqual({ note: 65, inst: 0, fx: [{ code: '4', param: 0x37 }] })
    expect(cellAtRow(song, 0, 4)).toEqual({ note: 'rel' })
  })

  it('moving away from a note that followed another keeps the previous note short (note-off fills the gap)', () => {
    const song = make([[0, 0, { note: 60 }], [0, 4, { note: 64 }], [0, 8, { note: 'off' }]])
    const second = deriveNotes(song)[1]!
    run(song, moveNoteDiffs(song, second, 6, 0))
    expect(notesOf(song)).toEqual([
      { start: 0, end: 4, pitch: 60, endsWith: 'off' },
      { start: 10, end: 14, pitch: 64, endsWith: 'off' }
    ])
  })

  it('rejects moves outside the song and no-op moves', () => {
    const song = make([[0, 2, { note: 60 }]])
    const note = deriveNotes(song)[0]!
    expect(moveNoteDiffs(song, note, -5, 0)).toEqual([])
    expect(moveNoteDiffs(song, note, 99, 0)).toEqual([])
    expect(moveNoteDiffs(song, note, 0, 100)).toEqual([])
    expect(moveNoteDiffs(song, note, 0, 0)).toEqual([])
  })

  it('is a single undo step', () => {
    const song = make([[0, 2, { note: 60 }], [0, 6, { note: 'off' }]])
    const before = JSON.stringify(notesOf(song))
    const undo = run(song, moveNoteDiffs(song, deriveNotes(song)[0]!, 4, 1))
    expect(JSON.stringify(notesOf(song))).not.toBe(before)
    undo()
    expect(JSON.stringify(notesOf(song))).toBe(before)
  })
})

describe('resize', () => {
  it('moves the note-off', () => {
    const song = make([[0, 2, { note: 60 }], [0, 6, { note: 'off' }]])
    run(song, resizeNoteDiffs(song, deriveNotes(song)[0]!, 10))
    expect(notesOf(song)).toEqual([{ start: 2, end: 10, pitch: 60, endsWith: 'off' }])
    expect(cellAtRow(song, 0, 6)).toBeNull()
  })

  it('keeps a release as a release and never goes below one row', () => {
    const song = make([[0, 2, { note: 60 }], [0, 6, { note: 'rel' }]])
    run(song, resizeNoteDiffs(song, deriveNotes(song)[0]!, 0))
    expect(notesOf(song)).toEqual([{ start: 2, end: 3, pitch: 60, endsWith: 'rel' }])
  })

  it('stops at the next note', () => {
    const song = make([[0, 0, { note: 60 }], [0, 4, { note: 'off' }], [0, 8, { note: 64 }]])
    const note = deriveNotes(song)[0]!
    expect(maxResizeEnd(song, note)).toBe(8)
    run(song, resizeNoteDiffs(song, note, 14))
    expect(notesOf(song)).toEqual([
      { start: 0, end: 8, pitch: 60, endsWith: 'note' },
      { start: 8, end: 16, pitch: 64, endsWith: 'end' }
    ])
  })

  it('shortening a note that ran to the end writes a note-off', () => {
    const song = make([[0, 10, { note: 60 }]])
    run(song, resizeNoteDiffs(song, deriveNotes(song)[0]!, 12))
    expect(notesOf(song)).toEqual([{ start: 10, end: 12, pitch: 60, endsWith: 'off' }])
    expect(resizeNoteDiffs(song, deriveNotes(song)[0]!, 12)).toEqual([])
  })
})

describe('delete', () => {
  it('removes the note and its note-off', () => {
    const song = make([[0, 2, { note: 60, inst: 0, fx: [{ code: '4', param: 0x37 }] }], [0, 6, { note: 'off' }]])
    run(song, deleteNoteDiffs(song, deriveNotes(song)[0]!))
    expect(deriveNotes(song)).toEqual([])
    // note, instrument and volume go (like deleting in the tracker's note column); effects stay
    expect(cellAtRow(song, 0, 2)).toEqual({ fx: [{ code: '4', param: 0x37 }] })
    expect(cellAtRow(song, 0, 6)).toBeNull()
  })

  it('keeps the previous note from growing into the gap', () => {
    const song = make([[0, 0, { note: 60 }], [0, 4, { note: 64 }], [0, 8, { note: 'off' }]])
    run(song, deleteNoteDiffs(song, deriveNotes(song)[1]!))
    expect(notesOf(song)).toEqual([{ start: 0, end: 4, pitch: 60, endsWith: 'off' }])
  })
})

describe('gestures', () => {
  it('draw gesture: inclusive end, either drag direction', () => {
    const song = make()
    run(song, gestureDiffs(song, { kind: 'draw', channel: 1, pitch: 66, start: 8, end: 5, inst: 0 }))
    expect(notesOf(song, 1)).toEqual([{ start: 5, end: 9, pitch: 66, endsWith: 'off' }])
  })

  it('previews what the gesture would do', () => {
    const song = make([[0, 2, { note: 60 }], [0, 6, { note: 'off' }]])
    const note = deriveNotes(song)[0]!
    expect(gesturePreview(song, { kind: 'move', note, dRows: 2, dPitch: -1 })).toEqual({ channel: 0, start: 4, end: 8, pitch: 59 })
    expect(gesturePreview(song, { kind: 'resize', note, end: 12 })).toEqual({ channel: 0, start: 2, end: 12, pitch: 60 })
    expect(gesturePreview(song, { kind: 'draw', channel: 2, pitch: 70, start: 3, end: 5 })).toEqual({ channel: 2, start: 3, end: 6, pitch: 70 })
    expect(gesturePreview(song, { kind: 'move', note, dRows: -9, dPitch: 0 })).toBeNull()
  })
})
