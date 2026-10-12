// Piano roll logic: notes derived from tracker cells, hit testing, and gestures (draw / move / resize /
// delete) turned into cell diffs. Pure, no DOM. Time is the "linear row": order * patternLength + row, so the
// roll shows the whole song as one strip. A note lasts from its row until the next note, note-off or release
// on that channel (or the end of the song).
//
// Every gesture returns CellDiff[] that the caller runs as ONE createCellsCommand (one undo step).

import { type Cell, type CellDiff, type Song, MIDI_MAX, MIDI_MIN, cloneCell, normalizeCell, patternAt, patternNumberAt, songChannelDefs } from '../../core'

export interface RollNote {
  channel: number
  /** First linear row. */
  start: number
  /** End (exclusive linear row), always > start. */
  end: number
  pitch: number
  inst?: number
  vol?: number
  /** What ends the note: another note, a note-off cell, a release cell, or the end of the song. */
  endsWith: 'note' | 'off' | 'rel' | 'end'
}

export function totalRows(song: Song): number {
  return song.orders.length * song.patternLength
}

export function linearRow(song: Song, order: number, row: number): number {
  return order * song.patternLength + row
}

export function splitRow(song: Song, lin: number): { order: number; row: number } {
  return { order: Math.floor(lin / song.patternLength), row: lin % song.patternLength }
}

export function cellAtRow(song: Song, channel: number, lin: number): Cell | null {
  const { order, row } = splitRow(song, lin)
  return patternAt(song, order, channel)?.rows[row] ?? null
}

/** Derive the notes of the given channels (default all), sorted by start row then channel. */
export function deriveNotes(song: Song, channels?: readonly number[]): RollNote[] {
  const total = totalRows(song)
  const list = channels ?? song.channels.map((_, i) => i)
  const out: RollNote[] = []
  for (const ch of list) {
    let open: RollNote | null = null
    for (let lin = 0; lin < total; lin++) {
      const note = cellAtRow(song, ch, lin)?.note
      if (note === undefined) continue
      if (open) {
        open.end = lin
        open.endsWith = typeof note === 'number' ? 'note' : note
        out.push(open)
        open = null
      }
      if (typeof note === 'number') {
        const cell = cellAtRow(song, ch, lin)!
        open = { channel: ch, start: lin, end: total, pitch: note, endsWith: 'end', ...(cell.inst !== undefined ? { inst: cell.inst } : {}), ...(cell.vol !== undefined ? { vol: cell.vol } : {}) }
      }
    }
    if (open) out.push(open)
  }
  return out.sort((a, b) => a.start - b.start || a.channel - b.channel)
}

// ---------------------------------------------------------------- geometry

export interface RollGeometry {
  /** Pixels per row. */
  rowW: number
  /** Pixels per semitone. */
  noteH: number
  /** Highest pitch shown (top edge). */
  maxPitch: number
  /** Width of the piano-key gutter and height of the ruler on top. */
  keysW: number
  headerH: number
}

export const DEFAULT_GEOMETRY: RollGeometry = { rowW: 14, noteH: 12, maxPitch: 96, keysW: 44, headerH: 18 }

export function rowToX(g: RollGeometry, row: number): number {
  return g.keysW + row * g.rowW
}
export function xToRowF(g: RollGeometry, x: number): number {
  return (x - g.keysW) / g.rowW
}
export function pitchToY(g: RollGeometry, pitch: number): number {
  return g.headerH + (g.maxPitch - pitch) * g.noteH
}
export function yToPitch(g: RollGeometry, y: number): number {
  return g.maxPitch - Math.floor((y - g.headerH) / g.noteH)
}

/** Pitch range shown: the chip's range for the channels plus margins, widened to include existing notes. */
export function pitchRange(song: Song, channels: readonly number[], notes: readonly RollNote[]): { min: number; max: number } {
  const defs = songChannelDefs(song)
  let min = Infinity
  let max = -Infinity
  for (const c of channels) {
    const d = defs[c]
    if (!d) continue
    min = Math.min(min, d.noteMin)
    max = Math.max(max, d.noteMax)
  }
  for (const n of notes) {
    min = Math.min(min, n.pitch)
    max = Math.max(max, n.pitch)
  }
  if (!Number.isFinite(min)) {
    min = 36
    max = 96
  }
  return { min: Math.max(MIDI_MIN, min - 2), max: Math.min(MIDI_MAX, max + 2) }
}

/** The note under (row, pitch): row is a whole linear row. Later-starting notes win on overlaps. */
export function noteAt(notes: readonly RollNote[], row: number, pitch: number, channels?: readonly number[]): RollNote | undefined {
  let hit: RollNote | undefined
  for (const n of notes) {
    if (n.pitch !== pitch || row < n.start || row >= n.end) continue
    if (channels && !channels.includes(n.channel)) continue
    if (!hit || n.start >= hit.start) hit = n
  }
  return hit
}

/** 'resize' near the right edge of a note, 'body' elsewhere. `rowF` is the fractional row under the pointer. */
export function hitZone(note: RollNote, rowF: number, edgeRows: number): 'resize' | 'body' {
  const len = note.end - note.start
  const edge = Math.min(edgeRows, len * 0.4)
  return rowF > note.end - edge ? 'resize' : 'body'
}

// ---------------------------------------------------------------- edits on an overlay

/** Pending cell changes on top of the song; turned into CellDiff[] at the end. */
class Overlay {
  private readonly changes = new Map<string, { channel: number; lin: number; cell: Cell | null }>()
  constructor(private readonly song: Song) {}

  get(channel: number, lin: number): Cell | null {
    const hit = this.changes.get(`${channel}:${lin}`)
    return hit ? hit.cell : cellAtRow(this.song, channel, lin)
  }

  set(channel: number, lin: number, cell: Cell | null): void {
    this.changes.set(`${channel}:${lin}`, { channel, lin, cell: normalizeCell(cell) })
  }

  diffs(): CellDiff[] {
    const out: CellDiff[] = []
    for (const { channel, lin, cell } of this.changes.values()) {
      const { order, row } = splitRow(this.song, lin)
      const pattern = patternNumberAt(this.song, order, channel)
      if (pattern === undefined) continue
      out.push({ channel, pattern, row, cell })
    }
    return out
  }
}

function withoutNote(cell: Cell | null): Cell | null {
  if (!cell) return null
  const c = cloneCell(cell)
  delete c.note
  return normalizeCell(c)
}

function withNote(cell: Cell | null, note: Cell['note'], inst?: number, vol?: number): Cell {
  const c = cell ? cloneCell(cell) : {}
  c.note = note
  if (inst !== undefined) c.inst = inst
  if (vol !== undefined) c.vol = vol
  return c
}

/** True when a pitched note is still sounding just before `lin` on the channel. */
function soundingBefore(ov: Overlay, channel: number, lin: number): boolean {
  for (let i = lin - 1; i >= 0; i--) {
    const n = ov.get(channel, i)?.note
    if (n === undefined) continue
    return typeof n === 'number'
  }
  return false
}

function place(ov: Overlay, song: Song, channel: number, start: number, end: number, pitch: number, inst: number | undefined, vol: number | undefined, endKind: 'off' | 'rel'): void {
  const total = totalRows(song)
  for (let lin = start + 1; lin < Math.min(end, total); lin++) {
    const c = ov.get(channel, lin)
    if (c && c.note !== undefined) ov.set(channel, lin, withoutNote(c))
  }
  ov.set(channel, start, withNote(ov.get(channel, start), pitch, inst, vol))
  if (end < total) {
    const c = ov.get(channel, end)
    if (!c || c.note === undefined) ov.set(channel, end, withNote(c, endKind))
  }
}

/**
 * Take a note out: its note, instrument and volume go (a move also takes the effects along, see
 * moveNoteDiffs); a previous note that ran into it gets a note-off so it does not grow into the gap.
 */
function remove(ov: Overlay, note: RollNote, takeEverything = false): void {
  const start = ov.get(note.channel, note.start)
  let rest: Cell | null = null
  if (start && !takeEverything) {
    rest = cloneCell(start)
    delete rest.note
    delete rest.inst
    delete rest.vol
  }
  if (soundingBefore(ov, note.channel, note.start)) ov.set(note.channel, note.start, withNote(rest, 'off'))
  else ov.set(note.channel, note.start, rest)
  if (note.endsWith === 'off' || note.endsWith === 'rel') {
    const c = ov.get(note.channel, note.end)
    if (c && c.note === note.endsWith) ov.set(note.channel, note.end, withoutNote(c))
  }
}

function endKind(note: RollNote): 'off' | 'rel' {
  return note.endsWith === 'rel' ? 'rel' : 'off'
}

/** Draw a new note of `len` rows (clipped to the song). Overwrites other note events inside its span. */
export function drawNoteDiffs(song: Song, channel: number, pitch: number, start: number, len: number, inst?: number, vol?: number): CellDiff[] {
  const total = totalRows(song)
  if (start < 0 || start >= total || pitch < MIDI_MIN || pitch > MIDI_MAX) return []
  const end = Math.min(total, start + Math.max(1, len))
  const ov = new Overlay(song)
  place(ov, song, channel, start, end, pitch, inst, vol, 'off')
  return ov.diffs()
}

/** Move a note by whole rows and semitones. Returns [] when the target is outside the song or pitch range. */
export function moveNoteDiffs(song: Song, note: RollNote, dRows: number, dPitch: number): CellDiff[] {
  const total = totalRows(song)
  const start = note.start + dRows
  const pitch = note.pitch + dPitch
  if (start < 0 || start >= total || pitch < MIDI_MIN || pitch > MIDI_MAX) return []
  if (dRows === 0 && dPitch === 0) return []
  const end = Math.min(total, note.end + dRows)
  const ov = new Overlay(song)
  const fx = cellAtRow(song, note.channel, note.start)?.fx
  remove(ov, note, true)
  place(ov, song, note.channel, start, end, pitch, note.inst, note.vol, endKind(note))
  if (fx && fx.length > 0) ov.set(note.channel, start, { ...(ov.get(note.channel, start) ?? {}), fx: fx.map((e) => ({ ...e })) })
  return ov.diffs()
}

/** Largest end a note can be resized to: the next note/off on the channel, or the end of the song. */
export function maxResizeEnd(song: Song, note: RollNote): number {
  const total = totalRows(song)
  if (note.endsWith === 'note') return note.end
  // the note's own note-off / release cell sits at `end`; the limit is whatever comes after it
  const from = note.endsWith === 'end' ? note.end : note.end + 1
  for (let lin = from; lin < total; lin++) {
    if (cellAtRow(song, note.channel, lin)?.note !== undefined) return lin
  }
  return total
}

/** Resize a note to a new end row (exclusive). Clamped to start+1 .. the next note. */
export function resizeNoteDiffs(song: Song, note: RollNote, newEnd: number): CellDiff[] {
  const end = Math.max(note.start + 1, Math.min(maxResizeEnd(song, note), newEnd))
  if (end === note.end) return []
  const ov = new Overlay(song)
  if (note.endsWith === 'off' || note.endsWith === 'rel') {
    const c = ov.get(note.channel, note.end)
    if (c && c.note === note.endsWith) ov.set(note.channel, note.end, withoutNote(c))
  }
  place(ov, song, note.channel, note.start, end, note.pitch, undefined, undefined, endKind(note))
  return ov.diffs()
}

/** Delete a note (and its note-off). Keeps the previous note's length: a gap is filled with a note-off. */
export function deleteNoteDiffs(song: Song, note: RollNote): CellDiff[] {
  const ov = new Overlay(song)
  remove(ov, note)
  return ov.diffs()
}

/** Gestures as plain data, so the component only tracks pointer positions. */
export type RollGesture =
  | { kind: 'draw'; channel: number; pitch: number; start: number; end: number; inst?: number }
  | { kind: 'move'; note: RollNote; dRows: number; dPitch: number }
  | { kind: 'resize'; note: RollNote; end: number }

export function gestureDiffs(song: Song, g: RollGesture): CellDiff[] {
  switch (g.kind) {
    case 'draw':
      return drawNoteDiffs(song, g.channel, g.pitch, Math.min(g.start, g.end), Math.abs(g.end - g.start) + 1, g.inst)
    case 'move':
      return moveNoteDiffs(song, g.note, g.dRows, g.dPitch)
    case 'resize':
      return resizeNoteDiffs(song, g.note, g.end)
  }
}

/** The note a gesture would show while it is being dragged (for the ghost outline). */
export function gesturePreview(song: Song, g: RollGesture): { channel: number; start: number; end: number; pitch: number } | null {
  const total = totalRows(song)
  switch (g.kind) {
    case 'draw': {
      const start = Math.min(g.start, g.end)
      return { channel: g.channel, start, end: Math.min(total, Math.max(g.start, g.end) + 1), pitch: g.pitch }
    }
    case 'move': {
      const start = g.note.start + g.dRows
      if (start < 0 || start >= total) return null
      return { channel: g.note.channel, start, end: Math.min(total, g.note.end + g.dRows), pitch: g.note.pitch + g.dPitch }
    }
    case 'resize':
      return { channel: g.note.channel, start: g.note.start, end: Math.max(g.note.start + 1, Math.min(maxResizeEnd(song, g.note), g.end)), pitch: g.note.pitch }
  }
}
