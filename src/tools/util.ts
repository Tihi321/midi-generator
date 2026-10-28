// Helpers shared by the tool definitions: strict schemas, result text, file names.

import { z } from 'zod'
import type { ToolResult } from '../shared/tools'
import { PRESET_BANKS, findChannelIndex, isChipPlayable, requireChannelIndex } from '../core'
import type { ChipId, Song } from '../core'
import { type ToolContext, textResult } from './registry'
import type { SongSession } from './session'

/** Strict object: unknown argument names are reported instead of silently ignored. */
export const obj = z.strictObject

export function ok(text: string): ToolResult {
  return textResult(text)
}

/** Human-readable text first, then ONE JSON object as the last text item (the machine-readable part for other apps). */
export function okJson(text: string, data: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text }, { type: 'text', text: JSON.stringify(data) }] }
}

export function plural(n: number, word: string, pluralForm = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralForm}`
}

/** File stem without folder or extension. */
export function pathStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

/** Replace the extension (or add one) so that `name` ends with `.ext`. */
export function withExtension(name: string, ext: string): string {
  const re = new RegExp(`\\.${ext}$`, 'i')
  if (re.test(name)) return name
  const stripped = name.replace(/\.[a-z0-9]{1,5}$/i, '')
  return `${stripped}.${ext}`
}

/** A file-name-safe version of a song name. */
export function safeFileName(name: string): string {
  return name.trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'song'
}

// ---------------------------------------------------------------- song tools: session, targets, chips

/** The song session behind a tool call (the registry types it as the generic ToolSession). */
export function songSession(ctx: Pick<ToolContext, 'session'>): SongSession {
  const s = ctx.session as unknown as Partial<SongSession>
  if (!s || typeof s.song !== 'object' || typeof s.execute !== 'function' || !s.cursor) {
    throw new Error('These tools need a SongSession (the live song) as the tool context session.')
  }
  return s as SongSession
}

export const CHANNEL_DESC = 'Channel id ("P1", "TR", "NO", "F1", ...), name or 0-based index. See get_song / list_chips for the channels of the song.'
export const ORDER_DESC = 'Order row (0-based position in the order list). Default: the editor cursor\'s order row (usually 0).'

export const channelRef = z.union([z.string().min(1), z.number().int().min(0)])
export const instrumentRef = z.union([z.string().min(1), z.number().int().min(0)])

/** Order row to work on: the argument, else the cursor's order. Validates the range. */
export function pickOrder(session: SongSession, order: number | undefined): number {
  const o = order ?? session.cursor.order
  if (!Number.isInteger(o) || o < 0 || o >= session.song.orders.length) {
    throw new Error(`Order ${o} not found. The song has ${session.song.orders.length} order row(s): use 0..${session.song.orders.length - 1} (set_orders / insert_order add more).`)
  }
  return o
}

/** Channel index to work on: the argument, else the cursor's channel. */
export function pickChannel(session: SongSession, channel: string | number | undefined): number {
  if (channel === undefined) return session.cursor.channel
  return requireChannelIndex(session.song, channel)
}

/** Channel indices from an optional list (default: all channels). Throws with the valid ids. */
export function pickChannels(song: Song, channels: Array<string | number> | undefined): number[] {
  if (!channels || channels.length === 0) return song.channels.map((_, i) => i)
  const out: number[] = []
  for (const c of channels) {
    const i = findChannelIndex(song, c)
    if (i < 0) requireChannelIndex(song, c) // throws with the list of channels
    if (!out.includes(i)) out.push(i)
  }
  return out
}

/** True when the chip has a preset bank and its voices make sound (the PS1 and Dreamcast voice modules call markChipPlayable). */
export function chipIsPlayable(chip: ChipId): boolean {
  return PRESET_BANKS[chip].length > 0 && isChipPlayable(chip)
}

export function chipNotReadyNote(chip: ChipId): string {
  return `Note: the ${chip.toUpperCase()} sound engine and preset bank are not available yet in this build (coming); the song can be edited and saved but renders as silence. NES and Game Boy are fully supported.`
}

/** Pattern numbers the order rows use for a channel, grouped: where else a pattern is used. */
export function otherUsers(song: Song, channelIndex: number, pattern: number, exceptOrder: number): number[] {
  const out: number[] = []
  song.orders.forEach((row, o) => {
    if (o !== exceptOrder && row[channelIndex] === pattern) out.push(o)
  })
  return out
}

/** More channels than this (PS1 24 voices, Dreamcast 32 / 64) and the tools summarise instead of listing every channel. */
export const MANY_CHANNELS = 16

/** Channel ids as text: all of them, or "V1..V64 (64 channels)" when the list is long and consecutive. */
export function channelIdsText(ids: string[]): string {
  if (ids.length <= MANY_CHANNELS) return ids.join(', ')
  return `${ids[0]}..${ids[ids.length - 1]} (${ids.length} channels)`
}

export function describeOrderRow(song: Song, order: number): string {
  const row = song.orders[order]
  if (!row) return `(no order ${order})`
  if (song.channels.length <= MANY_CHANNELS) return song.channels.map((c, i) => `${c.id}:${row[i]}`).join(' ')
  // many channels: runs of 3 or more consecutive channels with the same pattern become "V4-V64:0"
  const parts: string[] = []
  for (let i = 0; i < song.channels.length; ) {
    let end = i + 1
    while (end < song.channels.length && row[end] === row[i]) end++
    if (end - i >= 3) parts.push(`${song.channels[i]!.id}-${song.channels[end - 1]!.id}:${row[i]}`)
    else for (let k = i; k < end; k++) parts.push(`${song.channels[k]!.id}:${row[k]}`)
    i = end
  }
  return parts.join(' ')
}
