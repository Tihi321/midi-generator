// Drum steps: a legend plus a step string, like the grid format for pixels.
//
//   { "channel": "NO", "legend": { "K": "@kick", "S": "@snare", "h": "hat v6" }, "steps": "K.h.S.h.K.KhS.h.", "repeat": 4 }
//
// Legend values are space-separated tokens: an instrument (@name or @3) or a role (kick, snare, hat,
// openhat, crash, tom, clap: the tool layer adds a preset instrument for it when none exists), an optional
// note (C-4) and an optional volume (vN). "off" writes a note-off. In the steps, every character is one row
// ('.' = nothing); spaces and "|" are ignored so steps can be grouped. `repeat` repeats the whole string.

import type { Cell, ChannelKind, Role, Song } from '../types'
import { formatNote, looksLikeNote, parseNote } from '../notes'
import { findChannelIndex, normalizeCell } from '../model'
import { chipChannels, getChipProfile } from '../chips'
import { validateCellForChannel } from '../chips/validate'
import { parseRole } from '../instruments/roles'
import { DRUM_LEGEND } from '../theory/drums'
import type { CellDiff } from '../commands'
import { type Placement, formatProblemList, instrumentRefText, placementsToDiffs, resolveInstrumentToken } from './common'

export interface DrumSpec {
  channel: string | number
  legend: Record<string, string>
  steps: string
  /** Times the steps are repeated (default 1). */
  repeat?: number
  /** First row within the pattern (default 0). */
  startRow?: number
  /** Rows per step character (default 1). */
  rowsPerStep?: number
}

export interface DrumIssue {
  message: string
}

export class DrumTextError extends Error {
  readonly issues: DrumIssue[]
  constructor(issues: DrumIssue[]) {
    super(formatProblemList('Invalid drum pattern', issues.map((i) => i.message)))
    this.name = 'DrumTextError'
    this.issues = issues
  }
}

export interface DrumNeed {
  /** Legend character. */
  key: string
  role: Role
  /** Rows where it is used (relative to the first step). */
  uses: number
}

export interface ParsedDrums {
  channel: string
  placements: Placement[]
  /** Rows covered (steps x repeat x rowsPerStep). */
  totalRows: number
  orderSpan: number
  /**
   * Roles that have no instrument in the song yet. When non-empty, add instruments (resolvePreset) and
   * parse again: the cells for those legend entries carry no instrument.
   */
  needs: DrumNeed[]
}

export interface ParseDrumOptions {
  wrap?: boolean
  strict?: boolean
}

interface LegendEntry {
  note?: number | 'off'
  inst?: number
  vol?: number
  role?: Role
}

/** Default note for a drum role on a channel kind (the triangle plays pitched kicks/toms). */
export function defaultDrumNote(role: Role, kind: ChannelKind | undefined): number {
  if (kind === 'triangle') return role === 'tom' ? 48 : 36
  return 60
}

function parseLegendValue(key: string, value: string, song: Song, kind: ChannelKind | undefined, errors: string[]): LegendEntry {
  const entry: LegendEntry = {}
  const errorsBefore = errors.length
  const tokens = value.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    errors.push(`Legend "${key}" is empty; use "@instrument", a role like "kick", or "off".`)
    return entry
  }
  for (const tok of tokens) {
    const lower = tok.toLowerCase()
    if (tok.startsWith('@')) {
      const r = resolveInstrumentToken(song, tok)
      if ('error' in r) errors.push(`Legend "${key}": ${r.error}`)
      else entry.inst = r.index
    } else if (lower === 'off' || tok === '===') {
      entry.note = 'off'
    } else if (/^[vV]\d{1,2}$/.test(tok)) {
      const v = Number(tok.slice(1))
      if (v > 15) errors.push(`Legend "${key}": volume ${tok} must be v0..v15.`)
      else entry.vol = v
    } else if (looksLikeNote(tok)) {
      const n = parseNote(tok)
      if (n === null) errors.push(`Legend "${key}": note ${tok} is outside the MIDI range.`)
      else entry.note = n
    } else {
      const role = parseRole(tok)
      if (role) entry.role = role
      else {
        errors.push(
          `Legend "${key}": "${tok}" is not an instrument (@name or @3), a role (kick, snare, hat, openhat, crash, tom, clap), a note (C-4), a volume (v8) or "off".`
        )
      }
    }
  }
  if (entry.role && entry.inst === undefined) {
    // Use an existing instrument that has this role, preferring one the channel can play.
    const candidates = song.instruments.map((x, i) => ({ x, i })).filter(({ x }) => x.role === entry.role)
    if (candidates.length > 0) entry.inst = candidates[0]!.i
  }
  if (entry.note === undefined && entry.inst !== undefined) {
    entry.note = defaultDrumNote(song.instruments[entry.inst]?.role ?? entry.role ?? 'kick', kind)
  } else if (entry.note === undefined && entry.role) {
    entry.note = defaultDrumNote(entry.role, kind)
  } else if (entry.note === undefined && entry.inst === undefined && !entry.role && errors.length === errorsBefore) {
    errors.push(`Legend "${key}" must name an instrument (@name), a role, or "off".`)
  }
  return entry
}

export function parseDrumText(spec: DrumSpec, song: Song, opts: ParseDrumOptions = {}): ParsedDrums {
  const ci = findChannelIndex(song, spec.channel)
  if (ci < 0) {
    throw new Error(`Channel ${JSON.stringify(spec.channel)} not found. Channels: ${song.channels.map((c) => `${c.id} (${c.name})`).join(', ')}.`)
  }
  const channel = song.channels[ci]!
  const errors: string[] = []
  const repeat = spec.repeat ?? 1
  const rowsPerStep = spec.rowsPerStep ?? 1
  const startRow = spec.startRow ?? 0
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 256) errors.push('repeat must be an integer 1..256.')
  if (!Number.isInteger(rowsPerStep) || rowsPerStep < 1 || rowsPerStep > 16) errors.push('rowsPerStep must be an integer 1..16.')
  if (!Number.isInteger(startRow) || startRow < 0 || startRow >= song.patternLength) {
    errors.push(`startRow ${startRow} is outside the pattern (0..${song.patternLength - 1}).`)
  }
  if (typeof spec.steps !== 'string' || spec.steps.length === 0) errors.push('"steps" must be a non-empty string, one character per row, e.g. "K.h.S.h.".')
  if (!spec.legend || typeof spec.legend !== 'object') errors.push('"legend" must map step characters to instruments, e.g. {"K":"@kick","S":"@snare"}.')
  if (errors.length > 0) throw new DrumTextError(errors.map((message) => ({ message })))

  const profile = getChipProfile(song.chip)
  const defs = chipChannels(song.chip, song.chipConfig)
  const def = defs.find((d) => d.id === channel.id)
  const legend = new Map<string, LegendEntry>()
  for (const [k, v] of Object.entries(spec.legend)) {
    if (Array.from(k).length !== 1) {
      errors.push(`Legend key ${JSON.stringify(k)} must be exactly one character.`)
      continue
    }
    legend.set(k, parseLegendValue(k, String(v), song, def?.kind, errors))
  }
  if (errors.length > 0) throw new DrumTextError(errors.map((message) => ({ message })))
  // Prefer role instruments the channel can actually play.
  if (def) {
    for (const [k, e] of legend) {
      if (e.role && e.inst !== undefined) {
        const inst = song.instruments[e.inst]!
        if (!(def.instKinds as string[]).includes(inst.kind)) {
          const alt = song.instruments.findIndex((x) => x.role === e.role && (def.instKinds as string[]).includes(x.kind))
          if (alt >= 0) e.inst = alt
          else {
            e.inst = undefined
            legend.set(k, e)
          }
        }
      } else if (e.role && e.inst === undefined) {
        const alt = song.instruments.findIndex((x) => x.role === e.role && (def.instKinds as string[]).includes(x.kind))
        if (alt >= 0) e.inst = alt
      }
    }
  }

  const chars = Array.from(spec.steps).filter((c) => !/\s/.test(c) && c !== '|')
  const unknown = new Map<string, number>()
  const needs = new Map<string, DrumNeed>()
  const placements: Placement[] = []
  const rowsMeta: { row: number; key: string }[] = []
  chars.forEach((c, i) => {
    const entry = legend.get(c)
    if (!entry) {
      if (c === '.' || c === '-' || c === '_') return
      if (!unknown.has(c)) unknown.set(c, i)
      return
    }
    rowsMeta.push({ row: i, key: c })
  })
  if (unknown.size > 0) {
    const keys = [...legend.keys()].join(' ') || '(empty legend)'
    for (const [c, i] of unknown) {
      errors.push(`Unknown step character "${c}" at step ${i + 1}: legend keys are ${keys}; use "." for a rest.`)
    }
  }
  if (errors.length > 0) throw new DrumTextError(errors.map((message) => ({ message })))

  const stepsLen = chars.length
  const totalRows = stepsLen * repeat * rowsPerStep
  if (!opts.wrap && startRow + totalRows > song.patternLength) {
    const over = startRow + totalRows - song.patternLength
    throw new DrumTextError([
      {
        message:
          `${stepsLen} steps x repeat ${repeat} x ${rowsPerStep} row(s) = ${totalRows} rows; starting at row ${startRow} that overflows the pattern (length ${song.patternLength}) by ${over} row(s). ` +
          'Lower repeat, shorten the steps, or pass wrap:true to continue into following order rows.'
      }
    ])
  }

  for (let rep = 0; rep < repeat; rep++) {
    for (const m of rowsMeta) {
      const entry = legend.get(m.key)!
      const abs = startRow + (rep * stepsLen + m.row) * rowsPerStep
      const cell: Cell = {}
      if (entry.note !== undefined) cell.note = entry.note
      if (entry.inst !== undefined) cell.inst = entry.inst
      if (entry.vol !== undefined) cell.vol = entry.vol
      if (entry.role && entry.inst === undefined && entry.note !== 'off') {
        const need = needs.get(m.key) ?? { key: m.key, role: entry.role, uses: 0 }
        need.uses++
        needs.set(m.key, need)
      }
      placements.push({ orderOffset: Math.floor(abs / song.patternLength), row: abs % song.patternLength, cell: normalizeCell(cell)! })
    }
  }

  const strict = opts.strict ?? song.authenticity === 'strict'
  if (strict && needs.size === 0 && def) {
    const problems: DrumIssue[] = []
    const seen = new Set<string>()
    placements.forEach((p) => {
      for (const iss of validateCellForChannel(profile, song, defs, def, p.cell, { row: p.row })) {
        if (seen.has(iss.message)) continue
        seen.add(iss.message)
        problems.push({ message: iss.message })
      }
    })
    if (problems.length > 0) throw new DrumTextError(problems)
  }

  const lastAbs = startRow + Math.max(0, totalRows - 1)
  return {
    channel: channel.id,
    placements,
    totalRows,
    orderSpan: Math.floor(lastAbs / song.patternLength) + 1,
    needs: [...needs.values()]
  }
}

export function drumToDiffs(song: Song, parsed: ParsedDrums, startOrder = 0): CellDiff[] {
  if (parsed.needs.length > 0) {
    throw new Error(`Drum legend needs instruments for role(s): ${parsed.needs.map((n) => n.role).join(', ')}; add them first and parse again.`)
  }
  return placementsToDiffs(song, parsed.channel, parsed.placements, parsed.orderSpan, startOrder)
}

// ---------------------------------------------------------------- format

export interface FormatDrumOptions {
  order?: number
  pattern?: number
  fromRow?: number
  toRow?: number
  instrumentRefs?: 'name' | 'index'
}

/** Read a drum pattern back as a legend + steps spec (one character per row). */
export function formatDrumText(song: Song, channelRef: string | number, opts: FormatDrumOptions = {}): DrumSpec {
  const ci = findChannelIndex(song, channelRef)
  if (ci < 0) throw new Error(`Channel ${JSON.stringify(channelRef)} not found. Channels: ${song.channels.map((c) => c.id).join(', ')}.`)
  const ch = song.channels[ci]!
  const order = opts.order ?? 0
  const n = opts.pattern ?? song.orders[order]?.[ci]
  const pat = n === undefined ? undefined : song.patterns.get(`${ch.id}:${n}`)
  const from = Math.max(0, opts.fromRow ?? 0)
  const to = Math.min(song.patternLength, opts.toRow ?? song.patternLength)
  const legend: Record<string, string> = {}
  const keyOf = new Map<string, string>()
  const used = new Set<string>()
  const roleChars = new Map<Role, string>(Object.entries(DRUM_LEGEND) as [Role, string][])
  const spare = 'ABDEFGHIJLMNOPQRTUVWXYZabdefgijklmnpqrstuvwxyz0123456789'.split('')
  let steps = ''
  for (let r = from; r < to; r++) {
    const cell = normalizeCell(pat?.rows[r])
    if (!cell || cell.note === undefined || cell.note === 'rel') {
      steps += '.'
      continue
    }
    const note = cell.note
    const inst = cell.inst
    const sig = `${inst ?? ''}|${note}|${cell.vol ?? ''}`
    let key = keyOf.get(sig)
    if (!key) {
      const role = inst !== undefined ? song.instruments[inst]?.role : undefined
      let preferred = note === 'off' ? 'x' : (role && roleChars.get(role)) || undefined
      if (!preferred || used.has(preferred)) preferred = spare.find((c) => !used.has(c) && !(Object.values(DRUM_LEGEND) as string[]).includes(c)) ?? '?'
      key = preferred
      used.add(key)
      keyOf.set(sig, key)
      const parts: string[] = []
      if (note === 'off') parts.push('off')
      else {
        if (inst !== undefined) parts.push(instrumentRefText(song, inst, opts.instrumentRefs ?? 'name'))
        const def = defaultDrumNote(role ?? 'kick', ch.kind)
        if (note !== def || inst === undefined) parts.push(formatNote(note))
        if (cell.vol !== undefined) parts.push(`v${cell.vol}`)
      }
      legend[key] = parts.join(' ')
    }
    steps += key
  }
  return { channel: ch.id, legend, steps }
}
