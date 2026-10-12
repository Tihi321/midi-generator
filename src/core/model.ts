// Core song model helpers. Pure TypeScript: no DOM, no Electron, no node:* APIs.
//
// Conventions
//  - MIDI note numbers: C-4 = 60. Patterns are per channel (`${channelId}:${n}`) and sparse in song.patterns.
//  - orders[orderRow][channelIndex] = pattern number. A missing pattern key is an empty pattern.
//  - Timing: row = 60 / (bpm * rowsPerBeat) seconds, split into `speed` ticks. With a groove, row i lasts
//    groove[i % groove.length] ticks of that same tick length (tick = 60 / (bpm * rowsPerBeat * speed)).
//  - Lookups accept an id, a name or an index; failures list the valid values.

import type {
  Cell,
  ChannelState,
  ChipConfig,
  ChipId,
  Effect,
  Instrument,
  Pattern,
  PatternKey,
  PitchClass,
  Song,
  Timing
} from './types'
import { normalizePitchClass } from './notes'
import { chipChannels, defaultChipConfig, getChipProfile } from './chips'
import { instrumentSlug } from './instruments/types'

export * from './types'

export const MAX_PATTERN_LENGTH = 256
export const MAX_PATTERN_NUMBER = 255
export const MAX_ORDERS = 256
export const DEFAULT_PATTERN_LENGTH = 64

let idCounter = 0
export function createId(prefix: string): string {
  idCounter = (idCounter + 1) % 1_000_000
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// ---------------------------------------------------------------- patterns and cells

export function patternKey(channelId: string, n: number): PatternKey {
  return `${channelId}:${n}`
}

export function parsePatternKey(key: string): { channelId: string; pattern: number } {
  const i = key.lastIndexOf(':')
  return { channelId: key.slice(0, i), pattern: Number(key.slice(i + 1)) }
}

export function createEmptyPattern(rows: number): Pattern {
  return { rows: new Array<Cell | null>(rows).fill(null) }
}

/** Existing pattern or undefined (never creates). */
export function peekPattern(song: Song, channelId: string, n: number): Pattern | undefined {
  return song.patterns.get(patternKey(channelId, n))
}

/** Existing pattern, or a new empty one stored in the song (use for writes). */
export function getPattern(song: Song, channelId: string, n: number): Pattern {
  const key = patternKey(channelId, n)
  let p = song.patterns.get(key)
  if (!p) {
    p = createEmptyPattern(song.patternLength)
    song.patterns.set(key, p)
  }
  return p
}

/** The pattern an order row plays on a channel (by index or id); undefined when it is empty/missing. */
export function patternAt(song: Song, order: number, channel: number | string): Pattern | undefined {
  const ci = typeof channel === 'number' ? channel : song.channels.findIndex((c) => c.id === channel)
  const ch = song.channels[ci]
  const n = song.orders[order]?.[ci]
  if (!ch || n === undefined) return undefined
  return peekPattern(song, ch.id, n)
}

/** Pattern number an order row assigns to a channel. */
export function patternNumberAt(song: Song, order: number, channelIndex: number): number | undefined {
  return song.orders[order]?.[channelIndex]
}

export function cloneEffect(e: Effect): Effect {
  return { code: e.code, param: e.param }
}

export function cloneCell(c: Cell): Cell {
  const out: Cell = {}
  if (c.note !== undefined) out.note = c.note
  if (c.inst !== undefined) out.inst = c.inst
  if (c.vol !== undefined) out.vol = c.vol
  if (c.fx && c.fx.length > 0) out.fx = c.fx.map(cloneEffect)
  return out
}

export function isCellEmpty(c: Cell | null | undefined): boolean {
  return !c || (c.note === undefined && c.inst === undefined && c.vol === undefined && (!c.fx || c.fx.length === 0))
}

/** Clone a cell dropping undefined/empty fields; null when nothing is left. */
export function normalizeCell(c: Cell | null | undefined): Cell | null {
  if (isCellEmpty(c)) return null
  return cloneCell(c!)
}

export function cellsEqual(a: Cell | null | undefined, b: Cell | null | undefined): boolean {
  const na = normalizeCell(a)
  const nb = normalizeCell(b)
  if (!na || !nb) return !na && !nb
  if (na.note !== nb.note || na.inst !== nb.inst || na.vol !== nb.vol) return false
  const fa = na.fx ?? []
  const fb = nb.fx ?? []
  return fa.length === fb.length && fa.every((e, i) => e.code === fb[i]!.code && e.param === fb[i]!.param)
}

export function clonePattern(p: Pattern): Pattern {
  return { rows: p.rows.map((c) => (c ? cloneCell(c) : null)) }
}

export function cloneSong(song: Song): Song {
  const patterns = new Map<PatternKey, Pattern>()
  for (const [k, v] of song.patterns) patterns.set(k, clonePattern(v))
  return {
    format: 1,
    id: song.id,
    name: song.name,
    chip: song.chip,
    chipConfig: structuredClone(song.chipConfig),
    authenticity: song.authenticity,
    meta: { ...song.meta, moods: [...song.meta.moods], tags: [...song.meta.tags] },
    timing: { ...song.timing, ...(song.timing.groove ? { groove: [...song.timing.groove] } : {}) },
    patternLength: song.patternLength,
    channels: song.channels.map((c) => ({ ...c })),
    orders: song.orders.map((r) => [...r]),
    patterns,
    instruments: song.instruments.map((i) => structuredClone(i)),
    samples: song.samples.map((s) => structuredClone(s)),
    loop: song.loop ? { ...song.loop } : null,
    references: song.references.map((r) => ({ ...r }))
  }
}

/** Overwrite `target` in place with a deep copy of `source` (used by the replace-song command). */
export function replaceSongContents(target: Song, source: Song): void {
  const c = cloneSong(source)
  target.id = c.id
  target.name = c.name
  target.chip = c.chip
  target.chipConfig = c.chipConfig
  target.authenticity = c.authenticity
  target.meta = c.meta
  target.timing = c.timing
  target.patternLength = c.patternLength
  target.channels = c.channels
  target.orders = c.orders
  target.patterns = c.patterns
  target.instruments = c.instruments
  target.samples = c.samples
  target.loop = c.loop
  target.references = c.references
}

// ---------------------------------------------------------------- creation

export interface CreateSongOptions {
  chip: ChipId
  name?: string
  bpm?: number
  key?: PitchClass | string
  scale?: string
  moods?: string[]
  tags?: string[]
  patternLength?: number
  chipConfig?: Partial<ChipConfig>
  authenticity?: 'strict' | 'relaxed'
  speed?: number
  rowsPerBeat?: number
  beatsPerBar?: number
  groove?: number[]
}

export function assertPatternLength(n: number): void {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PATTERN_LENGTH) {
    throw new Error(`Invalid pattern length ${n}: use an integer 1..${MAX_PATTERN_LENGTH} (64 = 4 bars at 4/4 with 4 rows per beat).`)
  }
}

export function assertTiming(t: Partial<Timing>): void {
  if (t.bpm !== undefined && (typeof t.bpm !== 'number' || !(t.bpm >= 20 && t.bpm <= 400))) {
    throw new Error(`Invalid bpm ${t.bpm}: use 20..400.`)
  }
  if (t.speed !== undefined && (!Number.isInteger(t.speed) || t.speed < 1 || t.speed > 31)) {
    throw new Error(`Invalid speed ${t.speed}: use an integer 1..31 (ticks per row, default 6).`)
  }
  if (t.rowsPerBeat !== undefined && (!Number.isInteger(t.rowsPerBeat) || t.rowsPerBeat < 1 || t.rowsPerBeat > 16)) {
    throw new Error(`Invalid rowsPerBeat ${t.rowsPerBeat}: use an integer 1..16 (default 4).`)
  }
  if (t.beatsPerBar !== undefined && (!Number.isInteger(t.beatsPerBar) || t.beatsPerBar < 1 || t.beatsPerBar > 16)) {
    throw new Error(`Invalid beatsPerBar ${t.beatsPerBar}: use an integer 1..16 (default 4).`)
  }
  if (t.groove !== undefined && (!Array.isArray(t.groove) || t.groove.length === 0 || t.groove.some((g) => !Number.isInteger(g) || g < 1 || g > 31))) {
    throw new Error('Invalid groove: use a non-empty array of integers 1..31, e.g. [7, 5] for swing.')
  }
}

export function requireKey(key: string): PitchClass {
  const pc = normalizePitchClass(key)
  if (!pc) throw new Error(`Invalid key "${key}": use a note name such as C, F#, Bb (sharps are normalised, Bb -> A#).`)
  return pc
}

export function createSong(opts: CreateSongOptions): Song {
  const profile = getChipProfile(opts.chip)
  const base = defaultChipConfig(opts.chip)
  const chipConfig = { ...base, ...(opts.chipConfig ?? {}), chip: opts.chip } as ChipConfig
  if (chipConfig.chip === 'snes' && opts.chipConfig && 'echo' in opts.chipConfig && opts.chipConfig.echo) {
    chipConfig.echo = { ...(base as typeof chipConfig).echo, ...opts.chipConfig.echo }
  }
  const patternLength = opts.patternLength ?? DEFAULT_PATTERN_LENGTH
  assertPatternLength(patternLength)
  const timing: Timing = {
    bpm: opts.bpm ?? 120,
    speed: opts.speed ?? 6,
    rowsPerBeat: opts.rowsPerBeat ?? 4,
    beatsPerBar: opts.beatsPerBar ?? 4,
    ...(opts.groove ? { groove: [...opts.groove] } : {})
  }
  assertTiming(timing)
  const defs = profile.channels(chipConfig)
  const channels: ChannelState[] = defs.map((d) => ({ id: d.id, name: d.name, kind: d.kind, fxColumns: d.fxColumns }))
  return {
    format: 1,
    id: createId('song'),
    name: opts.name ?? 'Untitled',
    chip: opts.chip,
    chipConfig,
    authenticity: opts.authenticity ?? 'strict',
    meta: {
      key: opts.key ? requireKey(opts.key) : 'C',
      scale: opts.scale ?? 'major',
      moods: [...(opts.moods ?? [])],
      tags: [...(opts.tags ?? [])]
    },
    timing,
    patternLength,
    channels,
    orders: [channels.map(() => 0)],
    patterns: new Map(),
    instruments: [],
    samples: [],
    loop: { order: 0 },
    references: []
  }
}

/** Channel layout a chip + config would create (ids only). */
export function channelIdsFor(chip: ChipId, cfg?: ChipConfig): string[] {
  return chipChannels(chip, cfg).map((d) => d.id)
}

// ---------------------------------------------------------------- lookups

/** Resolve a channel by id ("P1"), name ("Pulse 1") or index; case-insensitive. */
export function findChannelIndex(song: Song, ref: string | number): number {
  if (typeof ref === 'number') return ref >= 0 && ref < song.channels.length ? ref : -1
  const lower = ref.trim().toLowerCase()
  let i = song.channels.findIndex((c) => c.id.toLowerCase() === lower)
  if (i >= 0) return i
  i = song.channels.findIndex((c) => c.name.toLowerCase() === lower)
  if (i >= 0) return i
  if (/^\d+$/.test(lower)) {
    const n = Number(lower)
    if (n < song.channels.length) return n
  }
  return -1
}

export function requireChannelIndex(song: Song, ref: string | number): number {
  const i = findChannelIndex(song, ref)
  if (i < 0) {
    const avail = song.channels.map((c, k) => `${k}:${c.id} (${c.name})`).join(', ')
    throw new Error(`Channel ${JSON.stringify(ref)} not found. Channels of ${song.chip} (index:id): ${avail}.`)
  }
  return i
}

export function requireChannel(song: Song, ref: string | number): ChannelState {
  return song.channels[requireChannelIndex(song, ref)]!
}

/** Resolve an instrument by index (3, "3", "@3") or name slug ("lead", "@lead"); -1 when not found. */
export function findInstrumentIndex(song: Song, ref: string | number): number {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref >= 0 && ref < song.instruments.length ? ref : -1
  let s = ref.trim()
  if (s.startsWith('@')) s = s.slice(1)
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    return n < song.instruments.length ? n : -1
  }
  const slug = instrumentSlug(s)
  let i = song.instruments.findIndex((x) => x.name === s)
  if (i >= 0) return i
  i = song.instruments.findIndex((x) => instrumentSlug(x.name) === slug)
  return i
}

export function describeInstruments(song: Song): string {
  if (song.instruments.length === 0) return '(none: add one with add_instrument first)'
  return song.instruments.map((x, i) => `@${i} "${x.name}"`).join(', ')
}

export function requireInstrumentIndex(song: Song, ref: string | number): number {
  const i = findInstrumentIndex(song, ref)
  if (i < 0) throw new Error(`Instrument ${JSON.stringify(ref)} not found. Instruments: ${describeInstruments(song)}.`)
  return i
}

export function requireInstrument(song: Song, ref: string | number): Instrument {
  return song.instruments[requireInstrumentIndex(song, ref)]!
}

/** Validate an order row number; returns it. */
export function requireOrder(song: Song, order: number): number {
  if (!Number.isInteger(order) || order < 0 || order >= song.orders.length) {
    throw new Error(`Order ${order} not found. The song has ${song.orders.length} order row(s): use 0..${song.orders.length - 1}.`)
  }
  return order
}

export function assertPatternNumber(n: number): void {
  if (!Number.isInteger(n) || n < 0 || n > MAX_PATTERN_NUMBER) {
    throw new Error(`Invalid pattern number ${n}: use an integer 0..${MAX_PATTERN_NUMBER}.`)
  }
}

/** Smallest pattern number of the channel that no order row uses and that has no stored pattern. */
export function nextFreePattern(song: Song, channelId: string): number {
  const ci = requireChannelIndex(song, channelId)
  const used = new Set<number>()
  for (const row of song.orders) {
    const n = row[ci]
    if (n !== undefined) used.add(n)
  }
  for (let n = 0; n <= MAX_PATTERN_NUMBER; n++) {
    if (!used.has(n) && !song.patterns.has(patternKey(song.channels[ci]!.id, n))) return n
  }
  throw new Error(`Channel ${channelId} has no free pattern numbers left (max ${MAX_PATTERN_NUMBER + 1}).`)
}

/** Number of cells and the first few locations that use an instrument index. */
export function instrumentUsage(song: Song, index: number): { count: number; where: { channel: string; pattern: number; row: number }[] } {
  const where: { channel: string; pattern: number; row: number }[] = []
  let count = 0
  for (const [key, pat] of song.patterns) {
    pat.rows.forEach((c, row) => {
      if (c && c.inst === index) {
        count++
        if (where.length < 5) {
          const { channelId, pattern } = parsePatternKey(key)
          where.push({ channel: channelId, pattern, row })
        }
      }
    })
  }
  return { count, where }
}

// ---------------------------------------------------------------- timing and summary

/** Seconds per row at the nominal speed. */
export function rowSeconds(t: Timing): number {
  return 60 / (t.bpm * t.rowsPerBeat)
}

export function tickSeconds(t: Timing): number {
  return rowSeconds(t) / t.speed
}

/** Ticks a row lasts (without Fxx/Dxx/Bxx effects): `speed`, or the groove entry for that row. */
export function ticksForRow(t: Timing, rowInSong: number): number {
  if (t.groove && t.groove.length > 0) return t.groove[rowInSong % t.groove.length]!
  return t.speed
}

/** Total rows of the song (orders x patternLength), ignoring jump/break effects. */
export function songRows(song: Song): number {
  return song.orders.length * song.patternLength
}

export function songTicks(song: Song): number {
  const rows = songRows(song)
  const g = song.timing.groove
  if (!g || g.length === 0) return rows * song.timing.speed
  let sum = 0
  for (let i = 0; i < rows; i++) sum += g[i % g.length]!
  return sum
}

export function songSeconds(song: Song): number {
  return songTicks(song) * tickSeconds(song.timing)
}

export function rowsPerBar(t: Timing): number {
  return t.rowsPerBeat * t.beatsPerBar
}

export interface SongSummary {
  id: string
  name: string
  chip: ChipId
  authenticity: 'strict' | 'relaxed'
  key: PitchClass
  scale: string
  bpm: number
  speed: number
  rowsPerBeat: number
  beatsPerBar: number
  groove?: number[]
  patternLength: number
  orders: number
  rows: number
  bars: number
  ticks: number
  seconds: number
  loop: { order: number } | null
  channels: { id: string; name: string; kind: string; muted: boolean; patterns: number; notes: number }[]
  instruments: { index: number; name: string; kind: string; role?: string }[]
  samples: number
}

export function summarizeSong(song: Song): SongSummary {
  const channels = song.channels.map((c) => {
    let patterns = 0
    let notes = 0
    for (const [key, pat] of song.patterns) {
      if (parsePatternKey(key).channelId !== c.id) continue
      patterns++
      for (const cell of pat.rows) if (cell && typeof cell.note === 'number') notes++
    }
    return { id: c.id, name: c.name, kind: c.kind, muted: !!c.muted, patterns, notes }
  })
  return {
    id: song.id,
    name: song.name,
    chip: song.chip,
    authenticity: song.authenticity,
    key: song.meta.key,
    scale: song.meta.scale,
    bpm: song.timing.bpm,
    speed: song.timing.speed,
    rowsPerBeat: song.timing.rowsPerBeat,
    beatsPerBar: song.timing.beatsPerBar,
    ...(song.timing.groove ? { groove: [...song.timing.groove] } : {}),
    patternLength: song.patternLength,
    orders: song.orders.length,
    rows: songRows(song),
    bars: songRows(song) / rowsPerBar(song.timing),
    ticks: songTicks(song),
    seconds: songSeconds(song),
    loop: song.loop ? { ...song.loop } : null,
    channels,
    instruments: song.instruments.map((x, index) => ({ index, name: x.name, kind: x.kind, ...(x.role ? { role: x.role } : {}) })),
    samples: song.samples.length
  }
}
