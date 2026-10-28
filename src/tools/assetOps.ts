// Shared logic of the library tools: building an asset song from a selection (song / motif / instrument),
// placing a motif or instrument asset into the open song (transposed to its key), and the text views used by
// get_asset and get_style_context. Pure TS (no DOM, no Electron).

import {
  type Cell,
  type CellDiff,
  type ChannelDef,
  type ChipId,
  type Command,
  type Instrument,
  type PitchClass,
  type RefLink,
  type SampleSlot,
  type Song,
  PITCH_CLASSES,
  analyzeSong,
  chipSupportsKind,
  cloneCell,
  cloneInstrument,
  cloneSong,
  createId,
  createInstrumentCommand,
  createSampleCommand,
  createSong,
  defaultChannelIds,
  defaultDrumNote,
  findChannelIndex,
  formatDrumText,
  formatNote,
  formatTrackerText,
  instSampleId,
  isDrumRole,
  normalizeCell,
  parseProject,
  patternKey,
  requireInstrumentIndex,
  requireScale,
  rowsPerBar,
  songChannelDefs,
  tryResolvePreset
} from '../core'
import { type SongSession } from './session'
import { clearDiffs, applyDiffs, addInstrumentWithSample, formatWarnings } from './editing'
import { renderPianoRoll } from './render'
import type { AssetData, AssetFilter, AssetKind, AssetMeta, AssetService, ToolServices } from './services'
import { otherUsers, plural } from './util'

// ---------------------------------------------------------------- ids, tags, filters

/** Folder-name-safe slug: lowercase letters, digits and dashes. */
export function slugifyAssetName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48)
      .replace(/-+$/g, '') || 'asset'
  )
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  for (const t of tags) {
    const s = String(t).trim().toLowerCase()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}

export function matchesAssetFilter(meta: AssetMeta, filter?: AssetFilter): boolean {
  if (!filter) return true
  if (filter.kind && meta.kind !== filter.kind) return false
  if (filter.chip && meta.chip !== filter.chip) return false
  if (filter.tags && filter.tags.length) {
    const have = new Set(meta.tags)
    for (const t of normalizeTags(filter.tags)) if (!have.has(t)) return false
  }
  if (filter.mood) {
    const m = filter.mood.trim().toLowerCase()
    if (!meta.moods.some((x) => x.toLowerCase() === m)) return false
  }
  const q = filter.text?.trim().toLowerCase()
  if (q) {
    const hay = [meta.name, ...meta.tags, ...meta.moods, meta.chip, meta.kind, meta.notes ?? ''].join(' ').toLowerCase()
    if (!q.split(/\s+/).every((w) => hay.includes(w))) return false
  }
  return true
}

export function requireAssets(services: ToolServices): AssetService {
  if (!services.assets) throw new Error('The asset library is not available in this environment.')
  return services.assets
}

/** An asset by id, or (when no id matches) by exact name. Throws a readable error. */
export async function resolveAsset(svc: AssetService, ref: string): Promise<AssetData> {
  const direct = await svc.get(ref)
  if (direct) return direct
  const all = await svc.list()
  const lower = ref.trim().toLowerCase()
  const byName = all.filter((a) => a.name.toLowerCase() === lower)
  if (byName.length === 1) {
    const hit = await svc.get(byName[0]!.id)
    if (hit) return hit
  }
  const hint = all.length ? `Available assets (id: name): ${all.map((a) => `${a.id}: "${a.name}"`).join(', ')}.` : 'The asset library is empty.'
  throw new Error(`Asset "${ref}" not found. ${hint} Use list_assets to see the library, or save_as_asset to add one.`)
}

export function loadAssetSong(asset: AssetData): Song {
  try {
    return parseProject(asset.project)
  } catch (e) {
    throw new Error(`Asset "${asset.id}" is damaged and cannot be opened: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
  }
}

export function metaOf(a: AssetMeta | AssetData): AssetMeta {
  const m: AssetMeta = {
    id: a.id,
    name: a.name,
    kind: a.kind,
    chip: a.chip,
    tags: a.tags,
    moods: a.moods,
    key: a.key,
    scale: a.scale,
    bpm: a.bpm,
    rowsPerBeat: a.rowsPerBeat,
    channels: a.channels,
    roles: a.roles,
    rows: a.rows
  }
  if (a.notes) m.notes = a.notes
  return m
}

// ---------------------------------------------------------------- references command

/** Replace song.references (one undo step; the "song info" of the library). */
export function createSetReferencesCommand(song: Song, next: RefLink[]): Command {
  const before = song.references.map((r) => ({ ...r }))
  const after = next.map((r) => ({ ...r }))
  return {
    type: 'set-references',
    label: 'Set style references',
    apply: (s) => {
      s.references = after.map((r) => ({ ...r }))
    },
    invert: (s) => {
      s.references = before.map((r) => ({ ...r }))
    }
  }
}

// ---------------------------------------------------------------- song facts

const PERCUSSION_KINDS = new Set(['noise', 'psg-noise', 'dpcm'])

/** Instrument indices used by the cells of the song's patterns (all patterns, not only those in the order list). */
export function usedInstrumentIndices(song: Song): number[] {
  const used = new Set<number>()
  for (const pat of song.patterns.values()) for (const c of pat.rows) if (c && c.inst !== undefined) used.add(c.inst)
  return [...used].sort((a, b) => a - b)
}

/** Channel indices that have at least one note in a pattern the order list plays. */
export function channelsWithNotes(song: Song): number[] {
  const out: number[] = []
  song.channels.forEach((ch, ci) => {
    for (const row of song.orders) {
      const n = row[ci]
      const pat = n === undefined ? undefined : song.patterns.get(patternKey(ch.id, n))
      if (pat?.rows.some((c) => c && c.note !== undefined)) {
        out.push(ci)
        return
      }
    }
  })
  return out
}

function noteCount(song: Song, ci: number): number {
  const ch = song.channels[ci]!
  let n = 0
  for (const row of song.orders) {
    const p = row[ci] === undefined ? undefined : song.patterns.get(patternKey(ch.id, row[ci]!))
    if (p) for (const c of p.rows) if (c && typeof c.note === 'number') n++
  }
  return n
}

/** Roles of the instruments a channel plays (from its cells). */
function channelRoles(song: Song, ci: number): string[] {
  const ch = song.channels[ci]!
  const roles = new Set<string>()
  for (const row of song.orders) {
    const p = row[ci] === undefined ? undefined : song.patterns.get(patternKey(ch.id, row[ci]!))
    if (!p) continue
    for (const c of p.rows) {
      const role = c && c.inst !== undefined ? song.instruments[c.inst]?.role : undefined
      if (role) roles.add(role)
    }
  }
  return [...roles]
}

/** Noise/DPCM channels, or any channel that only plays drum-role instruments. */
export function isPercussionChannel(song: Song, ci: number): boolean {
  if (PERCUSSION_KINDS.has(song.channels[ci]!.kind)) return true
  const roles = channelRoles(song, ci)
  return roles.length > 0 && roles.every((r) => isDrumRole(r as never))
}

/** Melodic channels with notes, most notes first. */
export function mainChannels(song: Song): number[] {
  return channelsWithNotes(song)
    .filter((ci) => !isPercussionChannel(song, ci))
    .sort((a, b) => noteCount(song, b) - noteCount(song, a) || a - b)
}

export function drumChannels(song: Song): number[] {
  return channelsWithNotes(song).filter((ci) => isPercussionChannel(song, ci))
}

export function songRowCount(song: Song): number {
  return song.orders.length * song.patternLength
}

function rolesOfInstruments(insts: readonly Instrument[]): string[] {
  return [...new Set(insts.map((i) => i.role).filter((r): r is NonNullable<typeof r> => !!r))]
}

export interface AssetDescription {
  chip: ChipId
  key: PitchClass
  scale: string
  bpm: number
  rowsPerBeat: number
  channels: string[]
  roles: string[]
  rows: number
}

/** Facts stored in meta.md, derived from the asset song. */
export function describeAssetSong(song: Song, kind: AssetKind): AssetDescription {
  const used = usedInstrumentIndices(song)
  const insts = kind === 'instrument' ? song.instruments : used.map((i) => song.instruments[i]).filter((x): x is Instrument => !!x)
  return {
    chip: song.chip,
    key: song.meta.key,
    scale: song.meta.scale,
    bpm: song.timing.bpm,
    rowsPerBeat: song.timing.rowsPerBeat,
    channels: channelsWithNotes(song).map((ci) => song.channels[ci]!.id),
    roles: rolesOfInstruments(insts),
    rows: kind === 'instrument' ? 0 : songRowCount(song)
  }
}

// ---------------------------------------------------------------- building assets

export interface AssetBuildInfo {
  name: string
  tags: string[]
  moods: string[]
  notes?: string
}

function stamp(song: Song, info: AssetBuildInfo): void {
  song.name = info.name
  song.meta.tags = [...info.tags]
  song.meta.moods = [...info.moods]
  if (info.notes) song.meta.notes = info.notes
  else delete song.meta.notes
  song.references = []
}

/** A whole song as an asset (a copy without its style references). */
export function buildSongAsset(song: Song, info: AssetBuildInfo): Song {
  const copy = cloneSong(song)
  copy.id = createId('song')
  stamp(copy, info)
  return copy
}

function usedSamples(song: Song, insts: readonly Instrument[]): SampleSlot[] {
  const ids = new Set<string>()
  for (const i of insts) {
    const id = instSampleId(i)
    if (id) ids.add(id)
  }
  return song.samples.filter((s) => ids.has(s.id)).map((s) => structuredClone(s))
}

export interface MotifSpec {
  /** Channel indices to take (default: every channel that has notes in the range). */
  channels?: number[]
  fromOrder: number
  toOrder: number
  fromRow: number
  /** One past the last row. */
  toRow: number
}

/**
 * A motif: the cells of some channels for an order range / row range, as a small song of the same chip, key and
 * timing (so it can be transposed to another key when placed). Rows are shifted so the motif starts at row 0.
 */
export function buildMotifAsset(song: Song, info: AssetBuildInfo, spec: MotifSpec): Song {
  const len = spec.toRow - spec.fromRow
  const motif = createSong({
    chip: song.chip,
    name: info.name,
    bpm: song.timing.bpm,
    key: song.meta.key,
    scale: song.meta.scale,
    patternLength: len,
    chipConfig: structuredClone(song.chipConfig),
    authenticity: song.authenticity,
    speed: song.timing.speed,
    rowsPerBeat: song.timing.rowsPerBeat,
    beatsPerBar: song.timing.beatsPerBar,
    groove: song.timing.groove
  })
  const wanted = spec.channels ?? song.channels.map((_, i) => i)
  const remap = new Map<number, number>()
  const instruments: Instrument[] = []
  const nOrders = spec.toOrder - spec.fromOrder + 1
  let cells = 0
  motif.orders = Array.from({ length: nOrders }, (_, k) => song.channels.map(() => (wanted.length ? k : 0)))
  for (const ci of wanted) {
    const ch = song.channels[ci]!
    for (let k = 0; k < nOrders; k++) {
      const n = song.orders[spec.fromOrder + k]![ci]
      const src = n === undefined ? undefined : song.patterns.get(patternKey(ch.id, n))
      if (!src) continue
      const rows: (Cell | null)[] = new Array<Cell | null>(len).fill(null)
      for (let r = spec.fromRow; r < spec.toRow; r++) {
        const c = normalizeCell(src.rows[r])
        if (!c) continue
        const cell = cloneCell(c)
        if (cell.inst !== undefined) {
          let idx = remap.get(cell.inst)
          if (idx === undefined) {
            const inst = song.instruments[cell.inst]
            if (!inst) {
              delete cell.inst
            } else {
              idx = instruments.length
              instruments.push(cloneInstrument(inst))
              remap.set(cell.inst, idx)
            }
          }
          if (idx !== undefined) cell.inst = idx
        }
        rows[r - spec.fromRow] = cell
        cells++
      }
      if (rows.some((x) => x)) motif.patterns.set(patternKey(ch.id, k), { rows })
    }
  }
  if (cells === 0) {
    throw new Error(
      `Nothing to save: orders ${spec.fromOrder}..${spec.toOrder}, rows ${spec.fromRow}..${spec.toRow - 1} hold no notes on ${wanted.map((i) => song.channels[i]!.id).join(', ')}. Write the music first, or pick another range or channels.`
    )
  }
  motif.instruments = instruments
  motif.samples = usedSamples(song, instruments)
  motif.loop = null
  stamp(motif, info)
  return motif
}

/** A tiny song that plays one instrument (plus the sample slot it needs), so the asset is audible and has a thumbnail. */
export function buildInstrumentAsset(song: Song, ref: string | number, info: AssetBuildInfo): Song {
  const idx = requireInstrumentIndex(song, ref)
  const inst = cloneInstrument(song.instruments[idx]!)
  const tiny = createSong({
    chip: song.chip,
    name: info.name,
    bpm: song.timing.bpm,
    key: song.meta.key,
    scale: song.meta.scale,
    patternLength: 16,
    chipConfig: structuredClone(song.chipConfig),
    authenticity: 'relaxed',
    speed: song.timing.speed,
    rowsPerBeat: song.timing.rowsPerBeat,
    beatsPerBar: song.timing.beatsPerBar
  })
  tiny.instruments = [inst]
  tiny.samples = usedSamples(song, [inst])
  const defs = songChannelDefs(tiny)
  const ci = defs.findIndex((d) => d.instKinds.includes(inst.kind))
  if (ci >= 0) {
    const d = defs[ci]!
    const fit = (n: number): number => {
      let x = n
      while (x > d.noteMax && x - 12 >= d.noteMin) x -= 12
      while (x < d.noteMin && x + 12 <= d.noteMax) x += 12
      return Math.max(d.noteMin, Math.min(d.noteMax, x))
    }
    const rows: (Cell | null)[] = new Array<Cell | null>(16).fill(null)
    const demo = [60, 64, 67, 72]
    demo.forEach((n, i) => {
      rows[i * 4] = { note: fit(n), inst: 0 }
    })
    rows[14] = { note: 'off' }
    tiny.patterns.set(patternKey(tiny.channels[ci]!.id, 0), { rows })
  }
  tiny.loop = null
  stamp(tiny, info)
  return tiny
}

export function thumbnailOf(song: Song): Uint8Array {
  return renderPianoRoll(song, { maxWidth: 480 }).png
}

// ---------------------------------------------------------------- transposition

/** Smallest signed semitone shift that moves tonic `from` onto tonic `to` (-6..5). */
export function keyShift(from: string, to: string): number {
  const a = PITCH_CLASSES.indexOf(from as PitchClass)
  const b = PITCH_CLASSES.indexOf(to as PitchClass)
  if (a < 0 || b < 0) return 0
  return ((((b - a) % 12) + 12 + 6) % 12) - 6
}

/**
 * Map a note by scale degree: the degree of `note` in the source key/scale becomes the same degree of the target
 * key/scale (chromatic alterations are carried over). Same scale = same result as a chromatic shift.
 */
export function mapDiatonic(note: number, from: { key: string; scale: string }, to: { key: string; scale: string }): number {
  const fromI = requireScale(from.scale).intervals
  const toI = requireScale(to.scale).intervals
  const fromTonic = PITCH_CLASSES.indexOf(from.key as PitchClass)
  const rel = (((note - fromTonic) % 12) + 12) % 12
  const baseTonic = note - rel
  let idx = 0
  for (let i = 0; i < fromI.length; i++) if (fromI[i]! <= rel) idx = i
  const accidental = rel - fromI[idx]!
  const n = toI.length
  const octs = Math.floor(idx / n)
  const deg = idx % n
  return baseTonic + keyShift(from.key, to.key) + 12 * octs + toI[deg]! + accidental
}

// ---------------------------------------------------------------- placing

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function instrumentFingerprint(inst: Instrument, slots: readonly SampleSlot[]): string {
  const copy = cloneInstrument(inst) as Instrument & { sample?: string }
  const slot = copy.sample !== undefined ? slots.find((s) => s.id === copy.sample) : undefined
  if ('sample' in copy) copy.sample = slot ? JSON.stringify([slot.source, slot.loopStart ?? null]) : copy.sample
  return JSON.stringify(copy)
}

/**
 * Make sure the open song has this instrument (with its sample slot): reuses an identical one, else adds a copy
 * (renamed if the name is taken by a different instrument). Returns the instrument index.
 */
export function ensureInstrument(session: SongSession, inst: Instrument, slots: readonly SampleSlot[]): { index: number; added: boolean } {
  const song = session.song
  const fp = instrumentFingerprint(inst, slots)
  const existing = song.instruments.findIndex((x) => instrumentFingerprint(x, song.samples) === fp)
  if (existing >= 0) return { index: existing, added: false }
  const copy = cloneInstrument(inst) as Instrument & { sample?: string }
  const names = new Set(song.instruments.map((x) => x.name))
  if (names.has(copy.name)) {
    let n = 2
    while (names.has(`${copy.name} ${n}`)) n++
    copy.name = `${copy.name} ${n}`
  }
  if (copy.sample !== undefined) {
    const slot = slots.find((s) => s.id === copy.sample)
    if (slot) {
      const same = song.samples.find((s) => sameJson([s.source, s.loopStart ?? null], [slot.source, slot.loopStart ?? null]))
      if (same) copy.sample = same.id
      else {
        let id = slot.id
        for (let n = 2; song.samples.some((s) => s.id === id); n++) id = `${slot.id}-${n}`
        session.execute(createSampleCommand(song, { op: 'add', sample: { ...structuredClone(slot), id } }))
        copy.sample = id
      }
    }
  }
  const cmd = createInstrumentCommand(song, { op: 'add', instrument: copy })
  session.execute(cmd)
  return { index: cmd.createdIndex, added: true }
}

/** Instrument for the open song from an asset instrument: the same one on a matching chip, else its role's preset. */
function adaptInstrument(session: SongSession, inst: Instrument, slots: readonly SampleSlot[], assetChip: ChipId, channelKind?: ChannelDef['kind']): { index: number; added: boolean; note?: string } {
  const song = session.song
  if (assetChip === song.chip && chipSupportsKind(song.chip, inst.kind)) return ensureInstrument(session, inst, slots)
  const role = inst.role
  if (!role) {
    throw new Error(`Instrument "${inst.name}" is a ${assetChip.toUpperCase()} ${inst.kind} without a role, so it cannot be mapped to ${song.chip.toUpperCase()}. Use add_instrument on this song instead.`)
  }
  const resolved = tryResolvePreset(song.chip, role, channelKind)
  if (!resolved) throw new Error(`The ${song.chip.toUpperCase()} preset bank has no instrument for the role "${role}"${channelKind ? ` on a ${channelKind} channel` : ''} (needed for "${inst.name}"). Use list_presets.`)
  const existing = song.instruments.findIndex((x) => x.presetId && x.presetId === resolved.presetId)
  const note = `"${inst.name}" (${assetChip.toUpperCase()} ${inst.kind}, role ${role}) became the ${song.chip.toUpperCase()} preset ${resolved.presetId ?? resolved.name}`
  if (existing >= 0) return { index: existing, added: false, note }
  const names = new Set(song.instruments.map((x) => x.name))
  if (names.has(resolved.name)) {
    let n = 2
    while (names.has(`${resolved.name} ${n}`)) n++
    resolved.name = `${resolved.name} ${n}`
  }
  const r = addInstrumentWithSample(session, resolved)
  return { index: r.index, added: true, note }
}

export interface PlaceInstrumentResult {
  text: string
}

/** place_asset for an instrument asset. */
export function placeInstrumentAsset(session: SongSession, meta: AssetMeta, asset: Song): PlaceInstrumentResult {
  const inst = asset.instruments[0]
  if (!inst) throw new Error(`Asset "${meta.id}" has no instrument.`)
  const r = adaptInstrument(session, inst, asset.samples, asset.chip)
  const i = r.index
  const parts: string[] = []
  if (r.note) parts.push(`The asset is a ${asset.chip.toUpperCase()} instrument and the song is ${session.song.chip.toUpperCase()}: ${r.note}.`)
  parts.push(r.added ? `Added instrument @${i} "${session.song.instruments[i]!.name}".` : `The song already has this instrument as @${i} "${session.song.instruments[i]!.name}".`)
  parts.push(`Use it with @${i} in write_pattern / write_melody, or pass instrument ${i} to set_cells.`)
  return { text: parts.join(' ') }
}

export interface PlaceMotifOptions {
  order: number
  row: number
  /** Target channels, positionally for the motif's channels that hold notes. */
  channels?: Array<string | number>
  diatonic: boolean
  /** Extra semitones after the key transposition. */
  semitones: number
  mode: 'replace' | 'merge'
}

function assetChannelRole(asset: Song, ci: number): string | undefined {
  const roles = channelRoles(asset, ci)
  return roles[0]
}

/** Which target channel each motif channel goes to. */
function mapMotifChannels(song: Song, asset: Song, used: number[], explicit?: Array<string | number>): number[] {
  const usedList = used.map((ci) => asset.channels[ci]!.id).join(', ')
  if (explicit && explicit.length > 0) {
    if (explicit.length !== used.length) {
      throw new Error(`The motif has notes on ${used.length} channel(s) (${usedList}); pass exactly that many target channels in the same order, or none for the automatic mapping.`)
    }
    return explicit.map((c) => {
      const i = findChannelIndex(song, c)
      if (i < 0) throw new Error(`Channel ${JSON.stringify(c)} not found. Channels: ${song.channels.map((x) => x.id).join(', ')}.`)
      return i
    })
  }
  if (asset.chip === song.chip) {
    return used.map((ci) => {
      const id = asset.channels[ci]!.id
      const i = findChannelIndex(song, id)
      if (i < 0) throw new Error(`The song has no channel ${id} (the chip config differs from the motif's). Pass \`channels\` to choose targets: ${song.channels.map((x) => x.id).join(', ')}.`)
      return i
    })
  }
  const taken = new Set<number>()
  return used.map((ci) => {
    const ach = asset.channels[ci]!
    const role = assetChannelRole(asset, ci)
    const percussion = isPercussionChannel(asset, ci)
    const candidates: number[] = []
    if (role) for (const id of defaultChannelIds(song.chip, role as never)) candidates.push(findChannelIndex(song, id))
    const kinds = song.channels.map((c, i) => ({ c, i }))
    for (const { c, i } of kinds) if (c.kind === ach.kind) candidates.push(i)
    if (percussion) for (const { c, i } of kinds) if (c.kind === 'noise' || c.kind === 'psg-noise') candidates.push(i)
    const pick = candidates.find((i) => i >= 0 && !taken.has(i))
    if (pick === undefined) {
      throw new Error(
        `Cannot map motif channel ${ach.id} (${ach.kind}${role ? `, ${role}` : ''}) from ${asset.chip.toUpperCase()} to a free ${song.chip.toUpperCase()} channel. Pass \`channels\` with target channels in the motif's order (${usedList}); the song has ${song.channels.map((x) => x.id).join(', ')}.`
      )
    }
    taken.add(pick)
    return pick
  })
}

/** place_asset for a motif asset: one set of cell diffs (+ instruments), written as the caller's single undo step. */
export function placeMotifAsset(session: SongSession, meta: AssetMeta, asset: Song, opt: PlaceMotifOptions): string {
  const song = session.song
  const used = channelsWithNotes(asset)
  if (used.length === 0) throw new Error(`Motif "${meta.id}" holds no notes.`)
  const P = asset.patternLength
  const nOrders = asset.orders.length
  if (opt.row + P > song.patternLength) {
    throw new Error(
      `The motif is ${P} rows long; starting at row ${opt.row} it needs rows ${opt.row}..${opt.row + P - 1}, but the song's patterns have ${song.patternLength} rows. ${P <= song.patternLength ? `Place it at row ${song.patternLength - P} or earlier` : 'Use set_pattern_length to make the patterns longer'}.`
    )
  }
  if (opt.order + nOrders > song.orders.length) {
    throw new Error(`The motif spans ${plural(nOrders, 'order row')} and starts at order ${opt.order}, but the song has ${song.orders.length}. Add order rows first (insert_order / set_orders).`)
  }
  const targets = mapMotifChannels(song, asset, used, opt.channels)
  const shift = keyShift(asset.meta.key, song.meta.key)
  const notes: string[] = []

  const instMap = new Map<string, number>()
  const diffs: CellDiff[] = []
  const shared: string[] = []
  used.forEach((aci, k) => {
    const tci = targets[k]!
    const tch = song.channels[tci]!
    const ach = asset.channels[aci]!
    const percussion = isPercussionChannel(asset, aci)
    for (let o = 0; o < nOrders; o++) {
      const tpat = song.orders[opt.order + o]![tci]!
      if (opt.mode === 'replace') diffs.push(...clearDiffs(song, tch.id, tpat, opt.row, opt.row + P))
      const others = otherUsers(song, tci, tpat, opt.order + o)
      if (others.length) shared.push(`${tch.id} pattern ${tpat} is also played by order ${others.join(', ')}`)
      const src = asset.patterns.get(patternKey(ach.id, asset.orders[o]![aci]!))
      src?.rows.forEach((cell, r) => {
        if (!cell) return
        const out = cloneCell(cell)
        if (out.inst !== undefined) {
          const key = `${out.inst}:${tci}`
          let idx = instMap.get(key)
          if (idx === undefined) {
            const inst = asset.instruments[out.inst]
            if (!inst) throw new Error(`The motif's cell at row ${r} uses instrument @${out.inst}, which the asset does not contain.`)
            const res = adaptInstrument(session, inst, asset.samples, asset.chip, tch.kind)
            idx = res.index
            instMap.set(key, idx)
            if (res.note) notes.push(res.note)
          }
          out.inst = idx
        }
        if (typeof out.note === 'number') {
          if (asset.chip !== song.chip && percussion) {
            const role = (out.inst !== undefined ? song.instruments[out.inst]?.role : undefined) ?? 'kick'
            out.note = defaultDrumNote(role, tch.kind)
          } else if (!percussion) {
            const final = (opt.diatonic ? mapDiatonic(out.note, asset.meta, song.meta) : out.note + keyShift(asset.meta.key, song.meta.key)) + opt.semitones
            if (final < 0 || final > 127) throw new Error(`${tch.id} row ${r}: ${formatNote(out.note)} would become MIDI ${final}, outside 0..127. Place the motif with a negative/positive \`semitones\` to move it.`)
            out.note = final
          }
        }
        diffs.push({ channel: tch.id, pattern: tpat, row: opt.row + r, cell: out })
      })
    }
  })
  const rep = applyDiffs(session, diffs, `Place motif "${meta.name}"`)
  const how = opt.diatonic ? `diatonic (${asset.meta.key} ${asset.meta.scale} -> ${song.meta.key} ${song.meta.scale})` : `${shift >= 0 ? '+' : ''}${shift} semitones (${asset.meta.key} -> ${song.meta.key})`
  const lines = [
    `Placed motif "${meta.name}" (${plural(P, 'row')}${nOrders > 1 ? `, ${nOrders} order rows` : ''}) at order ${opt.order}, row ${opt.row}: ${used.map((aci, k) => `${asset.channels[aci]!.id}->${song.channels[targets[k]!]!.id}`).join(', ')}; ${rep.changed} cells changed. Transposed ${how}${opt.semitones ? `, plus ${opt.semitones} extra semitones` : ''}.`
  ]
  for (const n of [...new Set(notes)]) lines.push(`Instrument mapping: ${n}.`)
  if (shared.length) lines.push(`Note: ${[...new Set(shared)].join('; ')} (the edit changed those too).`)
  return lines.join('\n') + formatWarnings(rep.warnings)
}

// ---------------------------------------------------------------- text views

/** Short, LLM-readable summary of an instrument. */
export function summarizeInstrument(inst: Instrument, index: number): string {
  const { name: _n, role, presetId, kind, gm: _g, ...rest } = inst as Instrument & Record<string, unknown>
  void _n
  void _g
  const params = JSON.stringify(rest, (_k, v: unknown) => (Array.isArray(v) && v.length > 16 && v.every((x) => typeof x === 'number') ? `[${v.length} numbers]` : v))
  const clipped = params.length > 260 ? `${params.slice(0, 257)}...` : params
  return `@${index} ${inst.name} (${kind}${role ? `, ${role}` : ''}${presetId ? `, preset ${presetId}` : ''}) ${clipped}`
}

/** Chord progression of a song as Roman numerals (consecutive repeats merged, at most `max` chords). */
export function progressionText(song: Song, max = 16): string {
  const chords = analyzeSong(song, { skipChip: true }).chords
  const out: string[] = []
  for (const c of chords) {
    const r = c.roman
    if (!r || out[out.length - 1] === r) continue
    out.push(r)
    if (out.length >= max) break
  }
  return out.join(' - ')
}

function firstActiveOrder(song: Song, channels: number[]): number {
  for (let o = 0; o < song.orders.length; o++) {
    for (const ci of channels) {
      const n = song.orders[o]![ci]
      const pat = n === undefined ? undefined : song.patterns.get(patternKey(song.channels[ci]!.id, n))
      if (pat?.rows.some((c) => c && c.note !== undefined)) return o
    }
  }
  return 0
}

/** Tracker text of the main channels (plus drums) for one order row: the first `rows` rows. */
export function sampleTracker(song: Song, rows: number, header = true): { order: number; text: string; channels: string[] } {
  const main = mainChannels(song).slice(0, 4)
  const drums = drumChannels(song).slice(0, 1)
  const chans = [...main, ...drums].sort((a, b) => a - b)
  if (chans.length === 0) return { order: 0, text: '(no notes)', channels: [] }
  const order = firstActiveOrder(song, chans)
  return { order, text: formatTrackerText(song, { order, channels: chans, fromRow: 0, toRow: Math.min(rows, song.patternLength), header }), channels: chans.map((i) => song.channels[i]!.id) }
}

export function describeTiming(song: Song): string {
  const t = song.timing
  return `${t.bpm} BPM, speed ${t.speed}${t.groove ? ` (groove ${t.groove.join('/')})` : ''}, ${t.rowsPerBeat} rows/beat, ${t.beatsPerBar} beats/bar (${rowsPerBar(t)} rows per bar)`
}

/** Drum step strings (one line per drum channel). */
export function drumLines(song: Song): string[] {
  const out: string[] = []
  for (const ci of drumChannels(song).slice(0, 2)) {
    const order = firstActiveOrder(song, [ci])
    const spec = formatDrumText(song, ci, { order, toRow: Math.min(32, song.patternLength) })
    out.push(`${spec.channel} (order ${order}): "${spec.steps}" legend ${JSON.stringify(spec.legend)}`)
  }
  return out
}
