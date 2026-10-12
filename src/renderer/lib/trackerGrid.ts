// Tracker grid logic: column layout, cursor navigation, selection, clipboard, transpose and per-field cell
// edits. Pure functions over the core Song (no DOM, no React), so they run in Vitest. Every function that
// edits returns CellDiff[]: the caller runs them as ONE createCellsCommand (one undo step).

import {
  type Cell,
  type CellDiff,
  type Effect,
  type EffectCode,
  type NoteValue,
  type Song,
  MIDI_MAX,
  MIDI_MIN,
  cloneCell,
  describeNote,
  normalizeCell,
  patternAt,
  patternNumberAt,
  transposeNote
} from '../../core'

// ---------------------------------------------------------------- column layout (in monospace characters)

export type FieldKind = 'note' | 'inst0' | 'inst1' | 'vol' | 'fxcode' | 'fxhi' | 'fxlo'

export interface Field {
  kind: FieldKind
  /** Effect column index for fx fields. */
  fx?: number
  /** Start column (characters from the left edge of the grid) and width. */
  startCh: number
  widthCh: number
}

export interface ChannelLayout {
  startCh: number
  widthCh: number
  fields: Field[]
}

export interface GridLayout {
  /** Width of the row-number gutter. */
  gutterCh: number
  channels: ChannelLayout[]
  totalCh: number
}

export const GUTTER_CH = 3

/** Characters of one channel with `fx` effect columns: " C-4 01 F 4A2 " (leading and trailing space). */
export function channelWidth(fxColumns: number): number {
  return 1 + 3 + 1 + 2 + 1 + 1 + fxColumns * 4 + 1
}

export function fieldCount(fxColumns: number): number {
  return 4 + 3 * fxColumns
}

export function buildLayout(fxColumns: readonly number[]): GridLayout {
  let x = GUTTER_CH
  const channels: ChannelLayout[] = []
  for (const fxc of fxColumns) {
    const start = x
    const fields: Field[] = []
    let p = start + 1
    fields.push({ kind: 'note', startCh: p, widthCh: 3 })
    p += 4
    fields.push({ kind: 'inst0', startCh: p, widthCh: 1 })
    fields.push({ kind: 'inst1', startCh: p + 1, widthCh: 1 })
    p += 3
    fields.push({ kind: 'vol', startCh: p, widthCh: 1 })
    p += 2
    for (let k = 0; k < fxc; k++) {
      fields.push({ kind: 'fxcode', fx: k, startCh: p, widthCh: 1 })
      fields.push({ kind: 'fxhi', fx: k, startCh: p + 1, widthCh: 1 })
      fields.push({ kind: 'fxlo', fx: k, startCh: p + 2, widthCh: 1 })
      p += 4
    }
    const width = channelWidth(fxc)
    channels.push({ startCh: start, widthCh: width, fields })
    x += width
  }
  return { gutterCh: GUTTER_CH, channels, totalCh: x }
}

export function layoutForSong(song: Song): GridLayout {
  return buildLayout(song.channels.map((c) => c.fxColumns))
}

/** Channel and field under a character column (nearest field inside a channel); null in the gutter. */
export function fieldAt(layout: GridLayout, ch: number): { channel: number; field: number } | null {
  for (let c = 0; c < layout.channels.length; c++) {
    const cl = layout.channels[c]!
    if (ch < cl.startCh || ch >= cl.startCh + cl.widthCh) continue
    let best = 0
    let bestD = Infinity
    cl.fields.forEach((f, i) => {
      const d = ch < f.startCh ? f.startCh - ch : ch >= f.startCh + f.widthCh ? ch - (f.startCh + f.widthCh - 1) : 0
      if (d < bestD) {
        bestD = d
        best = i
      }
    })
    return { channel: c, field: best }
  }
  return null
}

// ---------------------------------------------------------------- cursor

export interface GridCursor {
  order: number
  row: number
  channel: number
  /** Index into the channel's fields. */
  field: number
}

export type NavKey = 'left' | 'right' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'home' | 'end' | 'tabNext' | 'tabPrev'

export const PAGE_ROWS = 16

export function clampCursor(song: Song, c: GridCursor): GridCursor {
  const order = Math.max(0, Math.min(song.orders.length - 1, c.order))
  const row = Math.max(0, Math.min(song.patternLength - 1, c.row))
  const channel = Math.max(0, Math.min(song.channels.length - 1, c.channel))
  const fc = fieldCount(song.channels[channel]?.fxColumns ?? 1)
  return { order, row, channel, field: Math.max(0, Math.min(fc - 1, c.field)) }
}

/** Rows are one continuous list across the order list: moving past the end of a pattern enters the next order. */
function moveRows(song: Song, c: GridCursor, delta: number): GridCursor {
  const total = song.orders.length * song.patternLength
  const lin = Math.max(0, Math.min(total - 1, c.order * song.patternLength + c.row + delta))
  return { ...c, order: Math.floor(lin / song.patternLength), row: lin % song.patternLength }
}

export function moveCursor(song: Song, cur: GridCursor, key: NavKey): GridCursor {
  const c = clampCursor(song, cur)
  const nch = song.channels.length
  switch (key) {
    case 'left': {
      if (c.field > 0) return { ...c, field: c.field - 1 }
      if (c.channel === 0) return c
      const channel = c.channel - 1
      return { ...c, channel, field: fieldCount(song.channels[channel]!.fxColumns) - 1 }
    }
    case 'right': {
      if (c.field < fieldCount(song.channels[c.channel]!.fxColumns) - 1) return { ...c, field: c.field + 1 }
      if (c.channel >= nch - 1) return c
      return { ...c, channel: c.channel + 1, field: 0 }
    }
    case 'up':
      return moveRows(song, c, -1)
    case 'down':
      return moveRows(song, c, 1)
    case 'pageUp':
      return moveRows(song, c, -PAGE_ROWS)
    case 'pageDown':
      return moveRows(song, c, PAGE_ROWS)
    case 'home':
      return { ...c, row: 0 }
    case 'end':
      return { ...c, row: song.patternLength - 1 }
    case 'tabNext':
      return { ...c, channel: (c.channel + 1) % nch, field: 0 }
    case 'tabPrev':
      return { ...c, channel: (c.channel - 1 + nch) % nch, field: 0 }
  }
}

/** Move down by `step` rows after an entry (stays put when there is nowhere to go). */
export function advance(song: Song, cur: GridCursor, step: number): GridCursor {
  return step === 0 ? cur : moveRows(song, clampCursor(song, cur), step)
}

// ---------------------------------------------------------------- selection

export interface GridPoint {
  order: number
  row: number
  channel: number
}

/** Rectangle of whole cells inside one order (inclusive bounds, normalised). */
export interface Selection {
  order: number
  row1: number
  row2: number
  ch1: number
  ch2: number
}

/** Selection between an anchor and the cursor; null when they are in different orders. */
export function selectionBetween(a: GridPoint, b: GridPoint): Selection | null {
  if (a.order !== b.order) return null
  return { order: a.order, row1: Math.min(a.row, b.row), row2: Math.max(a.row, b.row), ch1: Math.min(a.channel, b.channel), ch2: Math.max(a.channel, b.channel) }
}

export function wholePattern(song: Song, order: number, channel?: number): Selection {
  return { order, row1: 0, row2: song.patternLength - 1, ch1: channel ?? 0, ch2: channel ?? song.channels.length - 1 }
}

export function inSelection(sel: Selection | null, order: number, row: number, channel: number): boolean {
  return !!sel && sel.order === order && row >= sel.row1 && row <= sel.row2 && channel >= sel.ch1 && channel <= sel.ch2
}

// ---------------------------------------------------------------- reading cells

export function readCell(song: Song, order: number, channel: number, row: number): Cell | null {
  return patternAt(song, order, channel)?.rows[row] ?? null
}

function diffFor(song: Song, order: number, channel: number, row: number, cell: Cell | null): CellDiff | null {
  const pattern = patternNumberAt(song, order, channel)
  if (pattern === undefined || row < 0 || row >= song.patternLength || channel < 0 || channel >= song.channels.length) return null
  return { channel, pattern, row, cell: normalizeCell(cell) }
}

// ---------------------------------------------------------------- clipboard

export interface Clip {
  rows: number
  channels: number
  /** cells[row][channel] */
  cells: (Cell | null)[][]
}

export function copySelection(song: Song, sel: Selection): Clip {
  const cells: (Cell | null)[][] = []
  for (let r = sel.row1; r <= sel.row2; r++) {
    const line: (Cell | null)[] = []
    for (let c = sel.ch1; c <= sel.ch2; c++) {
      const cell = readCell(song, sel.order, c, r)
      line.push(cell ? cloneCell(cell) : null)
    }
    cells.push(line)
  }
  return { rows: sel.row2 - sel.row1 + 1, channels: sel.ch2 - sel.ch1 + 1, cells }
}

/** Paste a clip with its top-left corner at (row, channel) of `order`. Cells that fall outside are dropped. */
export function pasteDiffs(song: Song, order: number, row: number, channel: number, clip: Clip): CellDiff[] {
  const diffs: CellDiff[] = []
  for (let r = 0; r < clip.rows; r++) {
    for (let c = 0; c < clip.channels; c++) {
      const cell = clip.cells[r]?.[c] ?? null
      const d = diffFor(song, order, channel + c, row + r, cell ? cloneCell(cell) : null)
      if (d) diffs.push(d)
    }
  }
  return diffs
}

export function clearSelectionDiffs(song: Song, sel: Selection): CellDiff[] {
  const diffs: CellDiff[] = []
  for (let r = sel.row1; r <= sel.row2; r++) {
    for (let c = sel.ch1; c <= sel.ch2; c++) {
      if (!readCell(song, sel.order, c, r)) continue
      const d = diffFor(song, sel.order, c, r, null)
      if (d) diffs.push(d)
    }
  }
  return diffs
}

/** Transpose every pitched note in the selection (clamped to C-0..G-9). */
export function transposeDiffs(song: Song, sel: Selection, semitones: number): CellDiff[] {
  const diffs: CellDiff[] = []
  if (semitones === 0) return diffs
  for (let r = sel.row1; r <= sel.row2; r++) {
    for (let c = sel.ch1; c <= sel.ch2; c++) {
      const cell = readCell(song, sel.order, c, r)
      if (!cell || typeof cell.note !== 'number') continue
      const note = transposeNote(cell.note, semitones)
      if (note === cell.note) continue
      const d = diffFor(song, sel.order, c, r, { ...cloneCell(cell), note })
      if (d) diffs.push(d)
    }
  }
  return diffs
}

// ---------------------------------------------------------------- per-field cell edits

export const FX_CODES: readonly EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'B', 'C', 'D', 'F', 'G', 'S', 'P', 'Q', 'R', 'W', 'X', 'E']

export function isEffectCode(ch: string): ch is EffectCode {
  return (FX_CODES as readonly string[]).includes(ch)
}

function fresh(cell: Cell | null): Cell {
  return cell ? cloneCell(cell) : {}
}

/** Enter a pitched note (sets the instrument too when `inst` is given). */
export function noteEntry(cell: Cell | null, midi: number, inst?: number): Cell {
  const c = fresh(cell)
  c.note = Math.max(MIDI_MIN, Math.min(MIDI_MAX, midi))
  if (inst !== undefined && inst >= 0) c.inst = inst
  return c
}

export function specialNoteEntry(cell: Cell | null, note: 'off' | 'rel'): Cell {
  const c = fresh(cell)
  c.note = note
  return c
}

export function setInst(cell: Cell | null, inst: number | undefined): Cell | null {
  const c = fresh(cell)
  if (inst === undefined) delete c.inst
  else c.inst = inst
  return normalizeCell(c)
}

export function setVol(cell: Cell | null, vol: number | undefined): Cell | null {
  const c = fresh(cell)
  if (vol === undefined) delete c.vol
  else c.vol = vol
  return normalizeCell(c)
}

/** Effect `k` of a cell (effects are a dense list: column k shows fx[k]). */
export function fxAt(cell: Cell | null, k: number): Effect | undefined {
  return cell?.fx?.[k]
}

export function setFxCode(cell: Cell | null, k: number, code: EffectCode): Cell {
  const c = fresh(cell)
  const fx = c.fx ?? []
  const idx = Math.min(k, fx.length)
  if (fx[idx]) fx[idx] = { code, param: fx[idx]!.param }
  else fx[idx] = { code, param: 0 }
  c.fx = fx
  return c
}

export function setFxParam(cell: Cell | null, k: number, param: number): Cell | null {
  const c = fresh(cell)
  const fx = c.fx
  const e = fx?.[k]
  if (!fx || !e) return normalizeCell(c)
  fx[k] = { code: e.code, param: Math.max(0, Math.min(255, param)) }
  return normalizeCell(c)
}

/** Clear what a field holds: note clears note+inst+vol (like FamiTracker), others clear their own value. */
export function clearField(cell: Cell | null, field: Field | undefined): Cell | null {
  if (!cell) return null
  const c = cloneCell(cell)
  switch (field?.kind) {
    case 'note':
      delete c.note
      delete c.inst
      delete c.vol
      break
    case 'inst0':
    case 'inst1':
      delete c.inst
      break
    case 'vol':
      delete c.vol
      break
    case 'fxcode':
    case 'fxhi':
    case 'fxlo':
      if (c.fx && field.fx !== undefined) {
        c.fx.splice(field.fx, 1)
        if (c.fx.length === 0) delete c.fx
      }
      break
    default:
      return null
  }
  return normalizeCell(c)
}

// ---------------------------------------------------------------- display text

export interface CellParts {
  note: string
  inst: string
  vol: string
  fx: string[]
}

export function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

export function noteText(note: NoteValue | undefined): string {
  if (note === undefined) return '---'
  if (note === 'off') return '==='
  if (note === 'rel') return '^^^'
  return describeNote(note).slice(0, 3).padEnd(3, ' ')
}

export function formatCellParts(cell: Cell | null, fxColumns: number): CellParts {
  const fx: string[] = []
  for (let k = 0; k < fxColumns; k++) {
    const e = cell?.fx?.[k]
    fx.push(e ? `${e.code}${hex2(e.param)}` : '...')
  }
  return {
    note: noteText(cell?.note),
    inst: cell?.inst === undefined ? '..' : hex2(cell.inst),
    vol: cell?.vol === undefined ? '.' : cell.vol.toString(16).toUpperCase(),
    fx
  }
}

/** Row highlight class: 'bar' on every bar start, 'beat' on every beat. */
export function rowHighlight(row: number, rowsPerBeat: number, beatsPerBar: number): 'bar' | 'beat' | '' {
  if (rowsPerBeat > 0 && row % (rowsPerBeat * beatsPerBar) === 0) return 'bar'
  if (rowsPerBeat > 0 && row % rowsPerBeat === 0) return 'beat'
  return ''
}
