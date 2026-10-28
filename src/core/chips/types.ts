// Chip profile contract: what each sound chip's channels can do, and the validation report type.
// Pure data + types; the generic validation engine lives in ./validate.ts.

import type { ChannelKind, ChipConfig, ChipId, EffectCode, Instrument, InstrumentKind, PatternKey, Song } from '../types'

export interface Issue {
  severity: 'error' | 'warning'
  channel?: string
  /** First order row that plays the pattern (when known). */
  order?: number
  pattern?: number
  row?: number
  /** Which part of the cell the problem is in (set for per-cell checks). */
  field?: 'note' | 'inst' | 'vol' | 'fx'
  /** Index into cell.fx when field is 'fx'. */
  fxIndex?: number
  message: string
}

export type PanMode = 'none' | 'hard' | '4bit' | 'full'

export interface ChannelDef {
  id: string
  name: string
  kind: ChannelKind
  /** Lowest/highest playable MIDI note. For noise channels the note only selects the period (range is informational). */
  noteMin: number
  noteMax: number
  /** True when the pitch of a note selects a noise period instead of a musical pitch. */
  noise?: boolean
  /** Instrument kinds this channel can play. */
  instKinds: InstrumentKind[]
  /** False for channels with no volume control (NES triangle, DPCM). */
  hasVolume: boolean
  /** Representable volumes (0..15 scale) when the channel quantizes them (GB wave). */
  volumeSteps?: number[]
  pan: PanMode
  effects: EffectCode[]
  /** Default number of effect columns. */
  fxColumns: 1 | 2 | 3 | 4
  /** One-line description for the LLM. */
  description: string
}

export interface ValidateScope {
  /** Only check these channel ids. */
  channels?: string[]
  /** Only check these patterns. */
  patterns?: { channel: string; pattern: number }[]
  /** Only check patterns used by these order rows. */
  orders?: number[]
  /** Also run the whole-song checks (instruments, ARAM budget). Default: true when no scope is given. */
  includeSong?: boolean
  /** SNES: sample id -> length in PCM samples (otherwise estimated from the sample slot). */
  sampleSizes?: Record<string, number>
}

/**
 * Chip-specific rule for an instrument played on a channel (a pmod voice on V1, ...). Called for every cell that
 * names an instrument; returns one LLM-readable message per problem, reported with the severity of chip rules.
 */
export type InstrumentOnChannelRule = (song: Song, def: ChannelDef, inst: Instrument, instIndex: number) => string[]

export interface ChipProfile {
  id: ChipId
  /** Short label used in messages: "NES", "Game Boy", ... */
  label: string
  name: string
  era: string
  description: string
  /** Cheat-sheet lines for the LLM (limits, idioms). */
  notes: string[]
  channels(cfg: ChipConfig): ChannelDef[]
  defaultConfig(): ChipConfig
  /** Optional per-chip rule for an instrument on a channel (see InstrumentOnChannelRule). */
  instrumentOnChannel?: InstrumentOnChannelRule
  /** Check a song against this chip. Severity follows song.authenticity (strict -> errors, relaxed -> warnings). */
  validate(song: Song, scope?: ValidateScope): Issue[]
}

export interface ChipSummary {
  id: ChipId
  name: string
  era: string
  description: string
  channels: { id: string; name: string; kind: ChannelKind; noteRange: [number, number]; hasVolume: boolean; accepts: InstrumentKind[]; effects: string; description: string }[]
  notes: string[]
}

/** Iterate every non-empty cell of the song (patterns that exist), with the order that first plays it. */
export function forEachPattern(
  song: Song,
  cb: (channelIndex: number, channelId: string, pattern: number, key: PatternKey, order: number | undefined) => void
): void {
  for (const key of song.patterns.keys()) {
    const colon = key.lastIndexOf(':')
    const channelId = key.slice(0, colon)
    const pattern = Number(key.slice(colon + 1))
    const ci = song.channels.findIndex((c) => c.id === channelId)
    if (ci < 0) continue
    let order: number | undefined
    for (let o = 0; o < song.orders.length; o++) {
      if (song.orders[o]?.[ci] === pattern) {
        order = o
        break
      }
    }
    cb(ci, channelId, pattern, key, order)
  }
}
