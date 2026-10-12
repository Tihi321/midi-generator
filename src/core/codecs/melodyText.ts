// Melody string: one channel written compactly, lengths in rows.
//
//   "@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2"
//
//   @name / @n   instrument for the following notes        vN       volume 0..15 for the following notes
//   E5 F#5 Db4   note (octave 0..9; C-4 style names also work)   :N   length in rows (default 1)
//   r  ===       rest = note off                           ^^^      release
//   ~:N          tie: hold the previous note for N more rows
//   {A4 C5 E5}:8 chord = lowest note plus a 0xy arpeggio (intervals up to 15 semitones)
//   !4A2         effect(s) on that note (three characters each: !4A2!W02)
//
// Notes only create cells where they start; a note sounds until the next note, rest or release.
// After a chord, the next plain note gets an explicit 000 so the arpeggio stops.

import type { Cell, Effect, Song } from '../types'
import { formatNoteCompact, looksLikeNote, parseNote } from '../notes'
import { findChannelIndex, normalizeCell } from '../model'
import { chipChannels, getChipProfile } from '../chips'
import { validateCellForChannel } from '../chips/validate'
import { chordToArp } from '../theory/chords'
import type { CellDiff } from '../commands'
import { formatEffect, formatProblemList, instrumentRefText, parseEffectToken, placementsToDiffs, resolveInstrumentToken } from './common'

export interface MelodyIssue {
  /** 1-based character column in the melody string. */
  col: number
  token: string
  message: string
}

export class MelodyTextError extends Error {
  readonly issues: MelodyIssue[]
  constructor(issues: MelodyIssue[]) {
    super(formatProblemList('Invalid melody', issues.map((i) => `col ${i.col}, "${i.token}": ${i.message}`)))
    this.name = 'MelodyTextError'
    this.issues = issues
  }
}

export interface ParseMelodyOptions {
  /** Row of the first note within the target pattern (default 0). */
  startRow?: number
  /** Continue into following order rows instead of failing when the melody is longer than the pattern. */
  wrap?: boolean
  /** Length of notes without ":N" (default 1). */
  defaultLength?: number
  /** Check chip rules per cell (default: song.authenticity === 'strict'). */
  strict?: boolean
}

export interface MelodyPlacement {
  /** 0 = the target order, 1 = the next order row (wrap). */
  orderOffset: number
  row: number
  cell: Cell
}

export interface ParsedMelody {
  channel: string
  placements: MelodyPlacement[]
  /** Rows the melody covers, including trailing ties and rests. */
  totalRows: number
  /** Number of order rows the melody touches (>1 only with wrap). */
  orderSpan: number
  warnings: string[]
}

interface Tok {
  text: string
  col: number
}

function tokenize(text: string): Tok[] {
  const out: Tok[] = []
  const re = /\{[^}]*\}\S*|\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push({ text: m[0], col: m.index + 1 })
  return out
}

const NOTE_TOKEN_RE = /^([A-Ga-g][#b-]?\d)(?::(\d+))?((?:![0-9A-Za-z]{3})*)$/
const REST_RE = /^(r|R|===|\^\^\^|~)(?::(\d+))?$/
const CHORD_RE = /^\{([^}]*)\}(?::(\d+))?((?:![0-9A-Za-z]{3})*)$/

function parseFxSuffix(s: string, err: (m: string) => void): Effect[] {
  const out: Effect[] = []
  for (const part of s.split('!').filter(Boolean)) {
    const e = parseEffectToken(part)
    if (!e) err(`"!${part}" is not an effect; write ! followed by three characters such as !4A2 or !W02.`)
    else out.push(e)
  }
  return out
}

export function parseMelodyText(text: string, song: Song, channelRef: string | number, opts: ParseMelodyOptions = {}): ParsedMelody {
  const ci = findChannelIndex(song, channelRef)
  if (ci < 0) {
    throw new Error(`Channel ${JSON.stringify(channelRef)} not found. Channels: ${song.channels.map((c) => `${c.id} (${c.name})`).join(', ')}.`)
  }
  const channel = song.channels[ci]!
  const startRow = opts.startRow ?? 0
  const defaultLength = opts.defaultLength ?? 1
  if (!Number.isInteger(startRow) || startRow < 0 || startRow >= song.patternLength) {
    throw new Error(`startRow ${startRow} is outside the pattern (0..${song.patternLength - 1}).`)
  }
  if (!Number.isInteger(defaultLength) || defaultLength < 1) throw new Error('defaultLength must be a positive integer.')

  const issues: MelodyIssue[] = []
  const warnings: string[] = []
  const events: { pos: number; cell: Cell; tok: Tok; tokens: { note?: string; inst?: string; vol?: string } }[] = []
  let pos = 0
  let instSet: number | undefined
  let instEmitted: number | undefined
  let instTok: string | undefined
  let volSet: number | undefined
  let volEmitted: number | undefined
  let volTok: string | undefined
  let arpActive = false
  let lastKind: 'note' | 'rest' | 'rel' | 'none' = 'none'

  for (const tok of tokenize(text)) {
    const err = (message: string): void => {
      issues.push({ col: tok.col, token: tok.text, message })
    }
    const t = tok.text
    if (t.startsWith('@')) {
      const r = resolveInstrumentToken(song, t)
      if ('error' in r) err(r.error.replace(/^"[^"]*": /, ''))
      else {
        instSet = r.index
        instTok = t
      }
      continue
    }
    if (/^[vV]\d{1,2}$/.test(t)) {
      const v = Number(t.slice(1))
      if (v > 15) err('volume must be v0..v15.')
      else {
        volSet = v
        volTok = t
      }
      continue
    }
    const rest = REST_RE.exec(t)
    if (rest) {
      const kind = rest[1]!
      const len = rest[2] !== undefined ? Number(rest[2]) : defaultLength
      if (len < 1) {
        err('length must be 1 or more rows.')
        continue
      }
      if (kind === '~') {
        if (lastKind === 'none') err('"~" (tie) must follow a note, rest or release; there is nothing to hold.')
        pos += len
        continue
      }
      if (kind === '^^^') {
        events.push({ pos, cell: { note: 'rel' }, tok, tokens: { note: t } })
        lastKind = 'rel'
      } else if (lastKind !== 'rest') {
        events.push({ pos, cell: { note: 'off' }, tok, tokens: { note: t } })
        lastKind = 'rest'
      }
      pos += len
      continue
    }

    // plain note or chord
    let notes: number[]
    let len = defaultLength
    let fxText: string
    let isChord = false
    const nm = NOTE_TOKEN_RE.exec(t)
    const cm = nm ? null : CHORD_RE.exec(t)
    if (nm) {
      const n = parseNote(nm[1]!)
      if (n === null) {
        err('note is outside the MIDI range; use octaves 0..9.')
        continue
      }
      notes = [n]
      if (nm[2] !== undefined) len = Number(nm[2])
      fxText = nm[3] ?? ''
    } else if (cm) {
      isChord = true
      const parts = cm[1]!.trim().split(/[\s,]+/).filter(Boolean)
      if (parts.length === 0) {
        err('empty chord; write notes inside the braces, e.g. {A4 C5 E5}.')
        continue
      }
      const ns: number[] = []
      let bad = false
      for (const p of parts) {
        const n = looksLikeNote(p) ? parseNote(p) : null
        if (n === null) {
          err(`"${p}" inside the chord is not a note (use names like A4, C#5, Db4).`)
          bad = true
        } else ns.push(n)
      }
      if (bad) continue
      notes = ns
      if (cm[2] !== undefined) len = Number(cm[2])
      fxText = cm[3] ?? ''
    } else {
      err(
        'unrecognized token. Use a note (E5, F#5, Db4) with optional :length and !effect, r (rest), ~ (tie), ^^^ (release), ' +
          '{A4 C5 E5} (chord), @instrument, or vNN (volume).'
      )
      continue
    }
    if (len < 1) {
      err('length must be 1 or more rows.')
      continue
    }
    const userFx = parseFxSuffix(fxText, err)
    const cell: Cell = {}
    const fx: Effect[] = []
    let root: number
    if (isChord && notes.length > 1) {
      try {
        const arp = chordToArp(notes)
        root = arp.root
        fx.push({ code: '0', param: arp.param })
        if (arp.dropped.length > 0) {
          warnings.push(`col ${tok.col}: chord ${t} has more than 3 notes; dropped ${arp.dropped.map(formatNoteCompact).join(', ')} (one 0xy effect holds root + 2 notes).`)
        }
        if (userFx.some((e) => e.code === '0')) err('a chord already uses the 0xy arpeggio effect; remove the extra 0xy effect.')
      } catch (e) {
        err((e as Error).message)
        continue
      }
      arpActive = true
    } else {
      root = Math.min(...notes)
      const user0 = userFx.find((e) => e.code === '0')
      if (user0) arpActive = user0.param !== 0
      else if (arpActive) {
        fx.push({ code: '0', param: 0 })
        arpActive = false
      }
    }
    fx.push(...userFx)
    cell.note = root
    if (instSet !== undefined && instSet !== instEmitted) {
      cell.inst = instSet
      instEmitted = instSet
    }
    if (volSet !== undefined && volSet !== volEmitted) {
      cell.vol = volSet
      volEmitted = volSet
    }
    if (fx.length > 0) cell.fx = fx
    events.push({ pos, cell, tok, tokens: { note: t, inst: instTok, vol: volTok } })
    lastKind = 'note'
    pos += len
  }

  const totalRows = pos
  if (!opts.wrap && startRow + totalRows > song.patternLength && issues.length === 0) {
    const over = startRow + totalRows - song.patternLength
    issues.push({
      col: 1,
      token: text.trim().slice(0, 20),
      message:
        `the melody is ${totalRows} rows long; starting at row ${startRow} it overflows the pattern (length ${song.patternLength}) by ${over} row(s). ` +
        'Shorten it, start earlier, or pass wrap:true to continue into the following order rows.'
    })
  }

  const placements: MelodyPlacement[] = events.map((e) => {
    const abs = startRow + e.pos
    return { orderOffset: Math.floor(abs / song.patternLength), row: abs % song.patternLength, cell: normalizeCell(e.cell)! }
  })

  // chip rules
  const strict = opts.strict ?? song.authenticity === 'strict'
  if (strict && issues.length === 0) {
    const profile = getChipProfile(song.chip)
    const defs = chipChannels(song.chip, song.chipConfig)
    const def = defs.find((d) => d.id === channel.id)
    if (def) {
      events.forEach((e, k) => {
        for (const iss of validateCellForChannel(profile, song, defs, def, placements[k]!.cell, { row: placements[k]!.row })) {
          const raw = iss.field === 'note' ? e.tokens.note : iss.field === 'inst' ? e.tokens.inst : iss.field === 'vol' ? e.tokens.vol : undefined
          issues.push({ col: e.tok.col, token: raw ?? e.tok.text, message: iss.message })
        }
      })
    }
  }
  if (issues.length > 0) throw new MelodyTextError(issues)

  const lastAbs = startRow + Math.max(0, totalRows - 1)
  return {
    channel: channel.id,
    placements,
    totalRows,
    orderSpan: totalRows === 0 ? 1 : Math.floor(lastAbs / song.patternLength) + 1,
    warnings
  }
}

/** Cell diffs for a parsed melody starting at `startOrder` (each wrapped order uses its own pattern for the channel). */
export function melodyToDiffs(song: Song, parsed: ParsedMelody, startOrder = 0): CellDiff[] {
  return placementsToDiffs(song, parsed.channel, parsed.placements, parsed.orderSpan, startOrder)
}

// ---------------------------------------------------------------- format

export interface FormatMelodyOptions {
  /** First order row (default 0). */
  order?: number
  /** Number of consecutive order rows to print (default 1). */
  orders?: number
  /** Print this pattern number instead of the order's (single pattern only). */
  pattern?: number
  fromRow?: number
  toRow?: number
  /** `@name` (default) or `@index`. */
  instrumentRefs?: 'name' | 'index'
}

export function formatMelodyText(song: Song, channelRef: string | number, opts: FormatMelodyOptions = {}): string {
  const ci = findChannelIndex(song, channelRef)
  if (ci < 0) throw new Error(`Channel ${JSON.stringify(channelRef)} not found. Channels: ${song.channels.map((c) => c.id).join(', ')}.`)
  const ch = song.channels[ci]!
  const order = opts.order ?? 0
  const count = opts.pattern !== undefined ? 1 : Math.max(1, opts.orders ?? 1)
  const from = Math.max(0, opts.fromRow ?? 0)
  const to = Math.min(song.patternLength, opts.toRow ?? song.patternLength)
  const instMode = opts.instrumentRefs ?? 'name'

  const cells: (Cell | null)[] = []
  for (let k = 0; k < count; k++) {
    const n = opts.pattern ?? song.orders[order + k]?.[ci]
    const pat = n === undefined ? undefined : song.patterns.get(`${ch.id}:${n}`)
    for (let r = from; r < to; r++) cells.push(normalizeCell(pat?.rows[r]))
  }
  const total = cells.length
  const evPos: number[] = []
  cells.forEach((c, i) => {
    if (c && c.note !== undefined) evPos.push(i)
  })
  if (evPos.length === 0) return total > 0 ? `r:${total}` : ''

  const out: string[] = []
  if (evPos[0]! > 0) out.push(`r:${evPos[0]}`)
  let lastInst: number | undefined
  let lastVol: number | undefined
  let arpActive = false
  const len = (n: number): string => (n === 1 ? '' : `:${n}`)
  evPos.forEach((p, k) => {
    const cell = cells[p]!
    const length = (evPos[k + 1] ?? total) - p
    if (cell.note === 'off') {
      out.push(`r${len(length)}`)
      return
    }
    if (cell.note === 'rel') {
      out.push(`^^^${len(length)}`)
      return
    }
    const note = cell.note as number
    if (cell.inst !== undefined && cell.inst !== lastInst) {
      out.push(instrumentRefText(song, cell.inst, instMode))
      lastInst = cell.inst
    }
    if (cell.vol !== undefined && cell.vol !== lastVol) {
      out.push(`v${cell.vol}`)
      lastVol = cell.vol
    }
    const fx = [...(cell.fx ?? [])]
    let body = formatNoteCompact(note)
    const arpIdx = fx.findIndex((e) => e.code === '0')
    if (arpIdx >= 0) {
      const param = fx[arpIdx]!.param
      const x = (param >> 4) & 15
      const y = param & 15
      if (param !== 0 && x > 0 && (y === 0 || y > x)) {
        const chord = [note, note + x, ...(y > 0 ? [note + y] : [])]
        if (chord.every((n) => n <= 127)) {
          body = `{${chord.map(formatNoteCompact).join(' ')}}`
          fx.splice(arpIdx, 1)
          arpActive = true
        }
      } else if (param === 0 && arpActive) {
        fx.splice(arpIdx, 1)
        arpActive = false
      } else {
        arpActive = param !== 0
      }
    }
    out.push(`${body}${len(length)}${fx.map((e) => `!${formatEffect(e)}`).join('')}`)
  })
  return out.join(' ')
}
