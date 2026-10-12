// Helpers shared by the text codecs: issue lists, instrument references, cell <-> text pieces.

import type { Cell, Effect, EffectCode, Song } from '../types'
import { EFFECT_CODES } from '../types'
import { instrumentSlug } from '../instruments/types'
import { formatNote, formatNoteCompact, parseNote } from '../notes'
import { describeInstruments, findInstrumentIndex } from '../model'
import type { CellDiff } from '../commands'

export const MAX_REPORTED = 12

/** Build the standard multi-line error text: title, up to 12 bullet lines and a "more" line. */
export function formatProblemList(title: string, lines: string[]): string {
  const total = lines.length
  const shown = lines.slice(0, MAX_REPORTED).map((l) => `- ${l}`)
  const more = total > MAX_REPORTED ? `\n- ...and ${total - MAX_REPORTED} more problem(s).` : ''
  return `${title} (${total} problem${total === 1 ? '' : 's'}):\n${shown.join('\n')}${more}`
}

export function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

export function formatEffect(e: Effect): string {
  return `${e.code}${hex2(e.param)}`
}

const EFFECT_RE = /^([0-9A-Za-z])([0-9A-Fa-f]{2})$/

/** Parse a three-character effect token ("047", "4A2", "W02"); null when it is not one. */
export function parseEffectToken(tok: string): Effect | null {
  const m = EFFECT_RE.exec(tok)
  if (!m) return null
  const code = m[1]!.toUpperCase() as EffectCode
  if (!EFFECT_CODES.includes(code)) return null
  return { code, param: parseInt(m[2]!, 16) }
}

/** `@name` text for an instrument: the slug when it is unique and cannot be mistaken for an index. */
export function instrumentRefText(song: Song, index: number, mode: 'name' | 'index' = 'name'): string {
  if (mode === 'index') return `@${index}`
  const inst = song.instruments[index]
  if (!inst) return `@${index}`
  const slug = instrumentSlug(inst.name)
  if (slug === '' || /^\d/.test(slug)) return `@${index}`
  const dupes = song.instruments.filter((x) => instrumentSlug(x.name) === slug).length
  return dupes === 1 ? `@${slug}` : `@${index}`
}

/** Resolve "3", "@3", "lead" or "@lead" to an instrument index, or an error message. */
export function resolveInstrumentToken(song: Song, token: string, extra?: Map<string, number>): { index: number } | { error: string } {
  const body = token.startsWith('@') ? token.slice(1) : token
  if (body === '') return { error: `"${token}": missing instrument after "@". Use @0..@${Math.max(0, song.instruments.length - 1)} or @name.` }
  const i = findInstrumentIndex(song, body)
  if (i >= 0) return { index: i }
  const viaHeader = extra?.get(instrumentSlug(body))
  if (viaHeader !== undefined && viaHeader < song.instruments.length) return { index: viaHeader }
  if (/^\d+$/.test(body)) {
    return { error: `"${token}": instrument @${body} does not exist. Instruments: ${describeInstruments(song)}.` }
  }
  return { error: `"${token}": no instrument named "${body}". Instruments: ${describeInstruments(song)}.` }
}

/** Cell -> tracker tokens in canonical order (note, instrument, volume, effects). */
export function cellTokens(song: Song, cell: Cell, instMode: 'name' | 'index' = 'name'): string[] {
  const out: string[] = []
  if (cell.note !== undefined) out.push(cell.note === 'off' ? '===' : cell.note === 'rel' ? '^^^' : formatNote(cell.note))
  if (cell.inst !== undefined) out.push(instrumentRefText(song, cell.inst, instMode))
  if (cell.vol !== undefined) out.push(`v${cell.vol}`)
  for (const e of cell.fx ?? []) out.push(formatEffect(e))
  return out
}

export { formatNote, formatNoteCompact, parseNote }

/** A cell positioned relative to a target order row (wrap writes into following orders). */
export interface Placement {
  orderOffset: number
  row: number
  cell: Cell
}

/**
 * Turn placements for one channel into cell diffs: each order row used maps to that order's pattern for
 * the channel. Throws when the song has too few order rows.
 */
export function placementsToDiffs(song: Song, channelId: string, placements: Placement[], orderSpan: number, startOrder: number): CellDiff[] {
  const ci = song.channels.findIndex((c) => c.id === channelId)
  const needed = startOrder + orderSpan
  if (startOrder < 0 || startOrder >= song.orders.length) {
    throw new Error(`Order ${startOrder} not found. The song has ${song.orders.length} order row(s): use 0..${song.orders.length - 1}.`)
  }
  if (needed > song.orders.length) {
    throw new Error(
      `The pattern data spans ${orderSpan} order row(s) from order ${startOrder}, but the song has only ${song.orders.length}; add ${needed - song.orders.length} more order row(s) first (set_orders / insert_order).`
    )
  }
  return placements.map((p) => ({
    channel: channelId,
    pattern: song.orders[startOrder + p.orderOffset]![ci]!,
    row: p.row,
    cell: p.cell
  }))
}
