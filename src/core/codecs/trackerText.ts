// LLM-friendly tracker text: the main format for reading and writing patterns.
//
//   # Song | order 0 | 120 BPM ...            (comment lines start with # or //)
//   channels: P1 | P2 | TR | NO                (optional; default = all channels in song order)
//   instruments: 0=lead 1=arp 2=bass           (optional, informational)
//    0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass | C-4 @kick
//    4 | G-5           | .            | .         | C-4 @snare
//
// Rows are `N | cell | cell ...` (N = row number, optional: without it rows count up from 0 or from the last
// row number). Tokens inside a cell are recognised by shape, in any order:
//   notes C-4 C#4 Db4 · off === · release ^^^ · empty . ... --- · instrument @3 @name · volume v12
//   effects: three characters, code + two hex digits (047, 4A2, W02). Write hex digits in UPPERCASE:
//   "Db4" is D-flat 4, while "DB4" would be the break effect D with parameter B4.

import type { Cell, ChannelState, Effect, Song } from '../types'
import { looksLikeNote, parseNote } from '../notes'
import { instrumentSlug } from '../instruments/types'
import { findChannelIndex, normalizeCell, patternNumberAt } from '../model'
import { chipChannels, getChipProfile } from '../chips'
import { channelDefFor, validateCellForChannel } from '../chips/validate'
import type { CellDiff } from '../commands'
import { cellTokens, formatProblemList, parseEffectToken, resolveInstrumentToken } from './common'

export interface TrackerIssue {
  /** 1-based line in the input. */
  line: number
  channel?: string
  /** 1-based column (character offset in the line) when known. */
  col?: number
  message: string
}

export class TrackerTextError extends Error {
  readonly issues: TrackerIssue[]
  constructor(issues: TrackerIssue[]) {
    super(
      formatProblemList(
        'Invalid tracker text',
        issues.map((i) => `Line ${i.line}${i.channel ? `, channel ${i.channel}` : ''}${i.col !== undefined ? `, col ${i.col}` : ''}: ${i.message}`)
      )
    )
    this.name = 'TrackerTextError'
    this.issues = issues
  }
}

export interface TrackerRow {
  row: number
  /** 1-based input line. */
  line: number
  /** One entry per parsed channel column; null = empty cell. */
  cells: (Cell | null)[]
}

export interface ParsedTracker {
  /** Channel ids of the columns, in order. */
  channels: string[]
  rows: TrackerRow[]
  /** Names declared in the `instruments:` header (informational). */
  declaredInstruments: { index: number; name: string }[]
}

export interface ParseTrackerOptions {
  /** Check chip rules per cell and report violations as errors. Default: song.authenticity === 'strict'. */
  strict?: boolean
  /** Rows beyond this are an error. Default: song.patternLength. */
  patternLength?: number
}

const EMPTY_RE = /^(?:\.{1,3}|-{1,3}|_{1,3})$/

interface TokenCtx {
  song: Song
  declared: Map<string, number>
}

/** Parse one cell's text. Returns the cell plus the raw token that produced each field, or errors. */
function parseCellText(
  text: string,
  ctx: TokenCtx
): { cell: Cell | null; tokens: { note?: string; inst?: string; vol?: string; fx: string[] }; errors: { message: string; col: number }[] } {
  const errors: { message: string; col: number }[] = []
  const cell: Cell = {}
  const tokens: { note?: string; inst?: string; vol?: string; fx: string[] } = { fx: [] }
  const fx: Effect[] = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const tok = m[0]
    const col = m.index
    const err = (message: string): void => {
      errors.push({ message, col })
    }
    if (EMPTY_RE.test(tok)) continue
    const lower = tok.toLowerCase()
    if (tok === '===' || lower === 'off') {
      if (cell.note !== undefined) err(`"${tok}": the cell already has a note (${tokens.note}); use one note per cell.`)
      else {
        cell.note = 'off'
        tokens.note = tok
      }
    } else if (tok === '^^^' || lower === 'rel') {
      if (cell.note !== undefined) err(`"${tok}": the cell already has a note (${tokens.note}); use one note per cell.`)
      else {
        cell.note = 'rel'
        tokens.note = tok
      }
    } else if (looksLikeNote(tok)) {
      const n = parseNote(tok)
      if (n === null) err(`"${tok}": note is outside the MIDI range; use octaves 0..9 (C-4 = middle C).`)
      else if (cell.note !== undefined) err(`"${tok}": the cell already has a note (${tokens.note}); put one note per cell (a chip channel plays one note at a time; use an arpeggio effect like 047 for chords).`)
      else {
        cell.note = n
        tokens.note = tok
      }
    } else if (tok.startsWith('@')) {
      const r = resolveInstrumentToken(ctx.song, tok, ctx.declared)
      if ('error' in r) err(r.error)
      else if (cell.inst !== undefined) err(`"${tok}": the cell already has an instrument (${tokens.inst}).`)
      else {
        cell.inst = r.index
        tokens.inst = tok
      }
    } else if (/^[vV]\d{1,2}$/.test(tok)) {
      const v = Number(tok.slice(1))
      if (v > 15) err(`"${tok}": volume must be v0..v15.`)
      else if (cell.vol !== undefined) err(`"${tok}": the cell already has a volume (${tokens.vol}).`)
      else {
        cell.vol = v
        tokens.vol = tok
      }
    } else {
      const e = parseEffectToken(tok)
      if (e) {
        fx.push(e)
        tokens.fx.push(tok)
      } else {
        err(
          `unrecognized token "${tok}". Use a note (C-4, C#4, Db4), === (note off), ^^^ (release), @instrument, vNN volume (v0..v15), ` +
            `an effect of three characters like 047 or W02, or . for empty.`
        )
      }
    }
  }
  if (fx.length > 0) cell.fx = fx
  return { cell: normalizeCell(cell), tokens, errors }
}

/** Resolve a channel column header entry to a channel index. */
function resolveColumn(song: Song, ref: string): number {
  return findChannelIndex(song, ref.trim())
}

export function parseTrackerText(text: string, song: Song, opts: ParseTrackerOptions = {}): ParsedTracker {
  const issues: TrackerIssue[] = []
  const strict = opts.strict ?? song.authenticity === 'strict'
  const patternLength = opts.patternLength ?? song.patternLength
  const profile = getChipProfile(song.chip)
  const defs = chipChannels(song.chip, song.chipConfig)

  let columns: number[] = song.channels.map((_, i) => i)
  let headerSeen = false
  let rowsStarted = false
  const declared = new Map<string, number>()
  const declaredList: { index: number; name: string }[] = []
  const rows: TrackerRow[] = []
  const seenRows = new Map<number, number>()
  let nextRow = 0

  const lines = text.split(/\r?\n/)
  for (let li = 0; li < lines.length; li++) {
    const lineNo = li + 1
    const raw = lines[li]!
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue

    const header = /^(channels?|instruments?)\s*:\s*(.*)$/i.exec(line)
    if (header) {
      const kind = header[1]!.toLowerCase()
      const body = header[2]!
      if (kind.startsWith('channel')) {
        if (rowsStarted) {
          issues.push({ line: lineNo, message: 'the "channels:" header must come before the first row.' })
          continue
        }
        if (headerSeen) {
          issues.push({ line: lineNo, message: 'duplicate "channels:" header.' })
          continue
        }
        headerSeen = true
        const refs = body.split(/[|,]/).map((s) => s.trim()).filter(Boolean)
        const cols: number[] = []
        for (const ref of refs) {
          const ci = resolveColumn(song, ref)
          if (ci < 0) {
            issues.push({
              line: lineNo,
              message: `unknown channel "${ref}" in the channels header. Channels of ${song.chip}: ${song.channels.map((c) => c.id).join(', ')}.`
            })
          } else if (cols.includes(ci)) {
            issues.push({ line: lineNo, message: `channel "${ref}" is listed twice in the channels header.` })
          } else cols.push(ci)
        }
        if (cols.length === 0 && refs.length === 0) issues.push({ line: lineNo, message: 'the "channels:" header lists no channels, e.g. "channels: P1 | P2 | TR | NO".' })
        if (cols.length > 0) columns = cols
      } else {
        for (const part of body.split(/[,\s]+/).filter(Boolean)) {
          const m = /^@?(\d+)=(.+)$/.exec(part)
          if (m) {
            declared.set(m[2]!.toLowerCase().replace(/^@/, ''), Number(m[1]))
            declaredList.push({ index: Number(m[1]), name: m[2]! })
          }
        }
      }
      continue
    }

    rowsStarted = true
    let body = line
    if (body.startsWith('|')) body = body.slice(1)
    if (body.endsWith('|')) body = body.slice(0, -1)
    const segs = body.split('|')
    const cols = columns.length
    let rowNumber: number
    let cellSegs: string[]
    if (segs.length === cols + 1) {
      const first = segs[0]!.trim()
      if (!/^\d{1,3}$/.test(first)) {
        issues.push({
          line: lineNo,
          message: `expected ${cols} cell column(s) (${columns.map((c) => song.channels[c]!.id).join(' | ')}) but found ${segs.length}; the first column must be a row number (0..${patternLength - 1}) when present.`
        })
        continue
      }
      rowNumber = Number(first)
      cellSegs = segs.slice(1)
    } else if (segs.length === cols) {
      rowNumber = nextRow
      cellSegs = segs
    } else {
      issues.push({
        line: lineNo,
        message: `expected ${cols} cell column(s) separated by "|" (${columns.map((c) => song.channels[c]!.id).join(' | ')}), optionally preceded by a row number, but found ${segs.length}. Use "." for an empty cell.`
      })
      continue
    }
    if (rowNumber >= patternLength) {
      issues.push({ line: lineNo, message: `row ${rowNumber} is outside the pattern (rows 0..${patternLength - 1}); ${rowNumber - patternLength + 1} row(s) too many.` })
      nextRow = rowNumber + 1
      continue
    }
    const prevLine = seenRows.get(rowNumber)
    if (prevLine !== undefined) {
      issues.push({ line: lineNo, message: `row ${rowNumber} appears twice (first on line ${prevLine}); merge the cells into one line.` })
      nextRow = rowNumber + 1
      continue
    }
    seenRows.set(rowNumber, lineNo)
    nextRow = rowNumber + 1

    const cells: (Cell | null)[] = []
    cellSegs.forEach((seg, k) => {
      const ci = columns[k]!
      const ch: ChannelState = song.channels[ci]!
      const r = parseCellText(seg, { song, declared })
      for (const e of r.errors) issues.push({ line: lineNo, channel: ch.id, message: e.message })
      if (r.errors.length === 0 && r.cell && strict) {
        const def = channelDefFor(profile, song, ch.id) ?? defs[ci]
        if (def) {
          for (const iss of validateCellForChannel(profile, song, defs, def, r.cell, { row: rowNumber })) {
            const tok =
              iss.field === 'note' ? r.tokens.note
              : iss.field === 'inst' ? r.tokens.inst
              : iss.field === 'vol' ? r.tokens.vol
              : iss.field === 'fx' && iss.fxIndex !== undefined ? r.tokens.fx[iss.fxIndex]
              : undefined
            issues.push({ line: lineNo, channel: ch.id, message: tok ? `"${tok}": ${iss.message}` : iss.message })
          }
        }
      }
      cells.push(r.cell)
    })
    rows.push({ row: rowNumber, line: lineNo, cells })
  }

  if (issues.length > 0) throw new TrackerTextError(issues)
  return { channels: columns.map((c) => song.channels[c]!.id), rows, declaredInstruments: declaredList }
}

// ---------------------------------------------------------------- diffs

export interface TrackerTarget {
  /** Write to the patterns this order row plays on each channel (default: order 0 when no pattern given). */
  order?: number
  /** Or write to this pattern number on every listed channel. */
  pattern?: number
}

/**
 * Cell diffs for a parsed block. merge: only non-empty cells are written (each replaces the whole cell);
 * replace: every row of the listed channels' patterns is cleared first.
 */
export function trackerToDiffs(song: Song, parsed: ParsedTracker, target: TrackerTarget = {}, mode: 'merge' | 'replace' = 'merge'): CellDiff[] {
  const diffs: CellDiff[] = []
  const order = target.pattern === undefined ? (target.order ?? 0) : undefined
  if (order !== undefined && (order < 0 || order >= song.orders.length)) {
    throw new Error(`Order ${order} not found. The song has ${song.orders.length} order row(s): use 0..${song.orders.length - 1}.`)
  }
  parsed.channels.forEach((id, k) => {
    const ci = song.channels.findIndex((c) => c.id === id)
    const pattern = target.pattern ?? patternNumberAt(song, order!, ci)!
    if (mode === 'replace') {
      for (let r = 0; r < song.patternLength; r++) diffs.push({ channel: id, pattern, row: r, cell: null })
    }
    for (const row of parsed.rows) {
      const cell = row.cells[k]
      if (cell) diffs.push({ channel: id, pattern, row: row.row, cell })
    }
  })
  return diffs
}

// ---------------------------------------------------------------- format

export interface FormatTrackerOptions {
  /** Order row whose patterns are printed (default 0). */
  order?: number
  /** Print these pattern numbers (channel id -> number) instead of the order's. */
  patterns?: Record<string, number>
  /** Channel ids/names/indices to include (default: all). */
  channels?: (string | number)[]
  /** Omit rows in which every printed channel is empty. */
  sparse?: boolean
  /** First row and one-past-last row to print. */
  fromRow?: number
  toRow?: number
  /** Print the comment/legend/channels/instruments header (default true). */
  header?: boolean
  /** `@name` (default) or `@index` instrument references. */
  instrumentRefs?: 'name' | 'index'
}

export function formatTrackerText(song: Song, opts: FormatTrackerOptions = {}): string {
  const order = opts.order ?? 0
  const colIdx = (opts.channels ?? song.channels.map((_, i) => i)).map((ref) => {
    const i = findChannelIndex(song, ref)
    if (i < 0) throw new Error(`Channel ${JSON.stringify(ref)} not found. Channels: ${song.channels.map((c) => c.id).join(', ')}.`)
    return i
  })
  const from = Math.max(0, opts.fromRow ?? 0)
  const to = Math.min(song.patternLength, opts.toRow ?? song.patternLength)
  const instMode = opts.instrumentRefs ?? 'name'

  const grid: string[][] = []
  const rowNums: number[] = []
  for (let r = from; r < to; r++) {
    const texts = colIdx.map((ci) => {
      const ch = song.channels[ci]!
      const n = opts.patterns?.[ch.id] ?? song.orders[order]?.[ci]
      const pat = n === undefined ? undefined : song.patterns.get(`${ch.id}:${n}`)
      const cell = normalizeCell(pat?.rows[r])
      return cell ? cellTokens(song, cell, instMode).join(' ') : '.'
    })
    if (opts.sparse && texts.every((t) => t === '.')) continue
    grid.push(texts)
    rowNums.push(r)
  }

  const widths = colIdx.map((_, k) => Math.max(1, ...grid.map((row) => row[k]!.length)))
  const numWidth = String(Math.max(0, song.patternLength - 1)).length
  const lines: string[] = []
  if (opts.header !== false) {
    const t = song.timing
    const swing = t.groove ? `, groove ${t.groove.join('/')}` : ''
    lines.push(`# ${song.name} | ${song.chip} | order ${order} | ${t.bpm} BPM, speed ${t.speed}, ${t.rowsPerBeat} rows/beat${swing} | ${song.patternLength} rows`)
    lines.push('# legend: C-4 note (C-4 = middle C), === note off, ^^^ release, @name or @n instrument, vNN volume (0-15), three-character effects like 047 (arp), . empty')
    lines.push(`channels: ${colIdx.map((ci) => song.channels[ci]!.id).join(' | ')}`)
    if (song.instruments.length > 0) {
      lines.push(`instruments: ${song.instruments.map((x, i) => `${i}=${instrumentSlug(x.name) || x.name.replace(/\s+/g, '_')}`).join(' ')}`)
    }
  }
  grid.forEach((texts, gi) => {
    const cells = texts.map((t, k) => (k === texts.length - 1 ? t : t.padEnd(widths[k]!)))
    lines.push(`${String(rowNums[gi]).padStart(numWidth)} | ${cells.join(' | ')}`)
  })
  return lines.join('\n')
}
