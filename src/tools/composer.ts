// Procedural composer behind compose_track: a whole calm (or lively) loop in one call, built on the existing
// theory (moods, progressions, scales, drum styles) and presets. Pure and deterministic: the same options
// (including the seed) give the same song. No DOM, no Electron, no node:*.
//
// Layout of a track (all parts follow the same chord per bar):
//   bass   one root per chord (calm) or a pattern of roots/fifths/octaves (lively)
//   pads   chord tones held for the chord (two voices when the chip has two pad channels), or a slow broken
//          chord / 0xy arpeggio when it has only one
//   lead   4-bar phrases from rhythm templates; strong beats land on chord tones, the rest moves by scale steps
//   arp    (lively moods) eighth-note chord tones on a free arpeggio voice
//   drums  from the mood's drum style (none for most calm moods)
// With loop on, the loop covers the whole song body (loop end == song end) and the last chord is the progression's
// turnaround, so the end leads back to the start. An optional intro (0..4 bars) plays once before the loop: quiet
// bass and pad on the tonic, no lead, no drums. An optional motif (the write_melody text format) is the lead line of
// every even 4-bar phrase, fitted to the key, range and scale, lightly developed in the later repeats.

import {
  type Cell,
  type ChannelState,
  type ChipId,
  type Instrument,
  type Role,
  type Song,
  DRUM_PRIORITY,
  DRUM_ROLES,
  PROGRESSIONS,
  ROLE_CHANNELS,
  chordName,
  createSong,
  defaultDrumNote,
  findDrumStyle,
  MelodyTextError,
  listPresets,
  normalizePitchClass,
  parseMelodyText,
  parseNote,
  requireChipId,
  requireMood,
  requireScale,
  romanToChord,
  scaleNotes,
  songChannelDefs,
  songSeconds,
  tryResolvePreset,
  validateSong
} from '../core'
import type { ChannelDef, DrumRole, MoodRecipe, Progression } from '../core'
import { addSongInstrument, bestOctaveShift, foldIntoRange, presetFor, snapVolume, writeChannelPatterns } from '../core/codecs/songBuild'

export interface ComposeOptions {
  mood: string
  chip?: string
  bpm?: number
  key?: string
  scale?: string
  /** Bars (default 16). */
  bars?: number
  /** Approximate length in seconds; overrides bars (rounded to whole bars). */
  seconds?: number
  /** Loop the whole song (default true). */
  loop?: boolean
  seed: number
  /** Intro bars (0..4, default 0) played once before the loop: quiet pads and bass on the tonic, no lead, no drums. */
  intro?: number
  /** Leitmotif in the write_melody text format (notes, r, ~; at most 4 bars). Lead line of every even 4-bar phrase. */
  motif?: string
  /** Key the motif is written in (default C); it is transposed to the track's key. */
  motifKey?: string
  /** Channel id -> preset id or role. */
  instruments?: Record<string, string>
  name?: string
}

export interface ComposeResult {
  song: Song
  seed: number
  bars: number
  /** Intro bars before the loop body (0 when none); `bars` is the loop body. */
  introBars: number
  chip: ChipId
  bpm: number
  key: string
  scale: string
  mood: string
  durationSec: number
  loop: { startBar: number; endBar: number } | null
  /** Ids of the channels that got notes. */
  channels: string[]
  /** One line per part: channel, instrument. */
  parts: string[]
  /** Chord names in order, one per chord slot. */
  chords: string[]
  progression: string
  /** The motif as placed (null without a motif or a lead channel): its length, the shift from motifKey and the bars it starts at. */
  motif: { bars: number; transposeSemis: number; placedAtBars: number[] } | null
}

// ---------------------------------------------------------------------------------------------- random

/** mulberry32: small, fast, good enough, and the same on every platform. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

type Rng = () => number

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.min(items.length - 1, Math.floor(rng() * items.length))]!
const chance = (rng: Rng, p: number): boolean => rng() < p

function weighted(rng: Rng, weights: readonly number[]): number {
  const total = weights.reduce((a, b) => a + b, 0)
  let r = rng() * total
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]!
    if (r < 0) return i
  }
  return weights.length - 1
}

// ---------------------------------------------------------------------------------------------- styles

const CALM_MOODS = new Set(['ambient', 'lullaby', 'peaceful', 'mysterious-calm'])

/** Chip used when the caller gives none. Calm moods like the SNES pads and strings; the rest is the classic NES. */
const DEFAULT_CHIP: Record<string, ChipId> = {
  ambient: 'snes',
  lullaby: 'snes',
  peaceful: 'snes',
  'mysterious-calm': 'snes',
  underwater: 'snes',
  title: 'snes',
  castle: 'genesis',
  shop: 'genesis',
  chill: 'genesis'
}

export function defaultChipForMood(moodId: string): ChipId {
  return DEFAULT_CHIP[moodId] ?? 'nes'
}

type Density = 'sparse' | 'medium' | 'busy'

interface MoodStyle {
  calm: boolean
  density: Density
  /** Chord length in bars. */
  chordBars: number
  bass: 'hold' | 'rock' | 'quarters' | 'eighths'
  /** Probability that a bar of the lead is silent. */
  restBars: number
  /** Volume scale 0..1 for everything. */
  level: number
  /** Drum style id, or null. */
  drums: string | null
}

function styleFor(mood: MoodRecipe): MoodStyle {
  const calm = CALM_MOODS.has(mood.id)
  if (calm) {
    const m: Record<string, Partial<MoodStyle>> = {
      ambient: { density: 'sparse', restBars: 0.28, bass: 'hold', drums: null },
      lullaby: { density: 'medium', restBars: 0.08, bass: 'rock', drums: null },
      peaceful: { density: 'sparse', restBars: 0.15, bass: 'hold', drums: null },
      'mysterious-calm': { density: 'sparse', restBars: 0.3, bass: 'hold', drums: 'soft-pulse' }
    }
    return { calm, density: 'sparse', chordBars: 2, bass: 'hold', restBars: 0.15, level: 0.8, drums: null, ...m[mood.id] }
  }
  const fast = mood.bpm[0] >= 130
  const slow = mood.bpm[1] <= 100
  return {
    calm,
    density: fast ? 'busy' : slow ? 'sparse' : 'medium',
    chordBars: slow ? 2 : 1,
    bass: fast ? 'eighths' : slow ? 'hold' : 'quarters',
    restBars: slow ? 0.15 : 0.05,
    level: 1,
    drums: slow && mood.drumStyles.length === 0 ? null : (mood.drumStyles[0] ?? null)
  }
}

/** Soft preset ids per chip for the calm moods (roles are the fallback where a chip has no soft preset). */
function softPresetRef(chip: ChipId, part: 'lead' | 'pad' | 'pad2' | 'bass', mood: MoodRecipe): string {
  const bellLead = mood.parts.lead === 'bell'
  switch (chip) {
    case 'nes':
      return part === 'lead' ? (bellLead ? 'nes.bell.soft' : 'nes.lead.soft') : part === 'bass' ? 'bass' : 'nes.pad.soft-long'
    case 'gb':
      return part === 'lead' ? (bellLead ? 'gb.bell.soft' : 'gb.lead.soft-square') : part === 'bass' ? 'gb.bass.wave-soft' : 'gb.pad.soft-square'
    case 'snes':
      if (part === 'lead') return bellLead ? 'snes.bell.soft' : 'snes.flute.soft'
      if (part === 'bass') return 'snes.bass.soft'
      if (part === 'pad') return 'snes.pad.soft-strings'
      return mood.id === 'ambient' || mood.id === 'mysterious-calm' ? 'snes.pad.dream' : 'snes.strings.swell'
    default:
      return part === 'lead' ? mood.parts.lead : part === 'bass' ? 'bass' : part === 'pad' ? mood.parts.pad : 'strings'
  }
}

// ---------------------------------------------------------------------------------------------- rhythm

/** [start row, length in rows] inside one 16-row bar. */
type Rhythm = [number, number][]

const RHYTHMS: Record<Density, { normal: Rhythm[]; cadence: Rhythm[] }> = {
  sparse: {
    normal: [
      [[0, 16]],
      [[0, 8], [8, 8]],
      [[0, 12], [12, 4]],
      [[2, 14]],
      [[0, 6], [8, 8]],
      [[0, 4], [8, 8]],
      [[0, 8], [8, 4], [12, 4]],
      [[4, 12]],
      [[0, 10], [10, 6]]
    ],
    cadence: [[[0, 4], [4, 12]], [[0, 8], [8, 8]], [[0, 16]], [[0, 12]]]
  },
  medium: {
    normal: [
      [[0, 4], [4, 4], [8, 8]],
      [[0, 8], [8, 2], [10, 2], [12, 4]],
      [[0, 6], [6, 2], [8, 4], [12, 4]],
      [[0, 4], [4, 4], [8, 4], [12, 4]],
      [[0, 4], [4, 2], [6, 2], [8, 8]],
      [[0, 8], [8, 4], [12, 2], [14, 2]]
    ],
    cadence: [[[0, 4], [4, 4], [8, 8]], [[0, 8], [8, 8]], [[0, 6], [6, 2], [8, 8]]]
  },
  busy: {
    normal: [
      [[0, 2], [2, 2], [4, 4], [6, 2], [8, 2], [10, 2], [12, 4]],
      [[0, 4], [4, 2], [6, 2], [8, 4], [12, 2], [14, 2]],
      [[0, 2], [2, 2], [4, 2], [6, 2], [8, 4], [12, 4]],
      [[0, 3], [3, 3], [6, 2], [8, 4], [12, 4]],
      [[0, 4], [4, 4], [8, 2], [10, 2], [12, 4]]
    ],
    cadence: [[[0, 4], [4, 4], [8, 8]], [[0, 2], [2, 2], [4, 4], [8, 8]]]
  }
}

const BASS_PATTERNS: Record<'rock' | 'quarters' | 'eighths', { row: number; semis: number }[]> = {
  rock: [{ row: 0, semis: 0 }, { row: 8, semis: 7 }],
  quarters: [{ row: 0, semis: 0 }, { row: 4, semis: 0 }, { row: 8, semis: 7 }, { row: 12, semis: 0 }],
  eighths: [0, 0, 12, 0, 0, 0, 12, 7].map((semis, i) => ({ row: i * 2, semis }))
}

// ---------------------------------------------------------------------------------------------- composing

const ROWS_PER_BAR = 16
const MOTIF_MAX_ROWS = 4 * ROWS_PER_BAR

interface MotifNote {
  /** Row from the start of the motif. */
  row: number
  len: number
  midi: number
}

/** The motif text on the lead channel with write_melody's parser; only notes, rests and ties are allowed. */
function parseMotif(text: string, song: Song, lead: number): { notes: MotifNote[]; rows: number } {
  for (const m of text.matchAll(/\S+/g)) {
    const t = m[0]
    if (/^(@|[vV]\d)/.test(t) || /[{!]/.test(t)) {
      throw new Error(`motif: col ${m.index! + 1}, "${t}": instrument, volume, chord and effect tokens are not allowed in a motif; write notes (E5:4), r (rest) and ~ (tie) only.`)
    }
  }
  let parsed: ReturnType<typeof parseMelodyText>
  try {
    parsed = parseMelodyText(text, song, lead, { wrap: true, strict: false })
  } catch (e) {
    throw e instanceof MelodyTextError ? new Error(`motif: ${e.message}`) : e
  }
  if (parsed.totalRows > MOTIF_MAX_ROWS) throw new Error(`motif: ${parsed.totalRows} rows is too long; at most 4 bars = ${MOTIF_MAX_ROWS} rows (16 rows per bar).`)
  const events = parsed.placements.map((p) => ({ pos: p.orderOffset * song.patternLength + p.row, note: p.cell.note }))
  const notes: MotifNote[] = []
  events.forEach((e, i) => {
    if (typeof e.note !== 'number') return
    notes.push({ row: e.pos, len: (events[i + 1]?.pos ?? parsed.totalRows) - e.pos, midi: e.note })
  })
  if (notes.length === 0) throw new Error('motif: no notes; write note names such as "E5:4 G5:2 A5:2 B5:8".')
  return { notes, rows: parsed.totalRows }
}

interface Plan {
  bass?: number
  lead?: number
  pads: number[]
  arp?: number
  /** channel index -> drum roles it plays */
  drums: Map<number, DrumRole[]>
}

function chordPitchClasses(root: number, intervals: number[]): number[] {
  return intervals.map((i) => (root + i) % 12)
}

/** The MIDI note with pitch class `pc` closest to `center`. */
function nearPitch(pc: number, center: number): number {
  let m = center + (((pc - center) % 12) + 12) % 12
  if (m - center > 6) m -= 12
  return m
}

function findProgression(mood: MoodRecipe, minor: boolean, rng: Rng): Progression {
  const mode = minor ? 'minor' : 'major'
  let list = PROGRESSIONS.filter((p) => p.moods.includes(mood.id) && p.mode === mode)
  if (list.length === 0) list = PROGRESSIONS.filter((p) => p.moods.includes(mood.id))
  if (list.length === 0) list = PROGRESSIONS.filter((p) => p.mode === mode)
  return pick(rng, list)
}

function isMinorScale(scaleId: string): boolean {
  const iv = requireScale(scaleId).intervals
  return iv.includes(3) && !iv.includes(4)
}

function channelIndex(song: Song, id: string): number {
  return song.channels.findIndex((c) => c.id === id)
}

function planChannels(song: Song, style: MoodStyle, drumRoles: DrumRole[]): Plan {
  const chip = song.chip
  const table = ROLE_CHANNELS[chip]
  const has = (id: string): boolean => channelIndex(song, id) >= 0
  const first = (roles: Role[]): string | undefined => roles.flatMap((r) => table[r] ?? []).find(has)
  const taken = new Set<string>()
  const take = (id: string | undefined): number | undefined => {
    if (!id) return undefined
    taken.add(id)
    return channelIndex(song, id)
  }
  const bass = take(first(['bass']))
  const lead = take(first(['lead']))
  const padIds: string[] = []
  for (const id of [...(table.pad ?? []), ...(table.strings ?? []), ...(table.choir ?? []), ...(table.organ ?? [])]) {
    const ch = song.channels[channelIndex(song, id)]
    if (!ch || taken.has(id) || padIds.includes(id) || ch.kind === 'noise') continue
    padIds.push(id)
  }
  // chips with one soft voice for harmony (NES, GB, PCE) keep it to one channel; the rest get two chord voices
  const pads = padIds.slice(0, padIds.length >= 2 ? 2 : 1).map((id) => take(id)!)
  let arp: number | undefined
  if (!style.calm) arp = take((table.arp ?? []).find((id) => has(id) && !taken.has(id)))
  // drums: each role goes to the first listed channel that has a preset for it
  const drums = new Map<number, DrumRole[]>()
  for (const role of drumRoles) {
    for (const id of table[role] ?? []) {
      const i = channelIndex(song, id)
      if (i < 0 || (taken.has(id) && !drums.has(i))) continue
      if (listPresets(chip, { role, channelKind: song.channels[i]!.kind }).length === 0) continue
      drums.set(i, [...(drums.get(i) ?? []), role])
      taken.add(id)
      break
    }
  }
  return { bass, lead, pads, arp, drums }
}

function cellVol(def: ChannelDef | undefined, vol: number): number | undefined {
  if (!def || !def.hasVolume) return undefined
  const v = Math.max(1, Math.min(15, Math.round(vol)))
  return def.volumeSteps ? snapVolume(v, def) : v
}

export function composeSong(opts: ComposeOptions): ComposeResult {
  const mood = requireMood(opts.mood)
  const chip = opts.chip ? requireChipId(opts.chip) : defaultChipForMood(mood.id)
  const style = styleFor(mood)
  const rng = createRng(opts.seed)

  const minorPick = opts.scale ? isMinorScale(opts.scale) : undefined
  const scaleId = requireScale(opts.scale ?? pick(rng, mood.scales)).id
  const keyPc = normalizePitchClass(opts.key ?? pick(rng, mood.keys))
  if (!keyPc) throw new Error(`Invalid key "${opts.key}": use a note name such as C, F#, Bb.`)
  const bpm = opts.bpm ?? Math.round(mood.bpm[0] + rng() * (mood.bpm[1] - mood.bpm[0]))
  if (!(bpm >= 20 && bpm <= 400)) throw new Error(`Invalid bpm ${bpm}: use 20..400.`)

  let bars = Math.round(opts.bars ?? 16)
  if (opts.seconds !== undefined) bars = Math.round(opts.seconds / ((60 / bpm) * 4))
  bars = Math.max(1, Math.min(128, bars))
  const introBars = Math.max(0, Math.min(4, Math.round(opts.intro ?? 0)))
  const patternBars = [4, 2, 1].find((n) => bars % n === 0 && introBars % n === 0)!
  const totalRows = bars * ROWS_PER_BAR // the body; the intro rows sit in front of it
  const off = introBars * ROWS_PER_BAR

  const song = createSong({
    chip,
    name: opts.name ?? `${mood.name} (${chip.toUpperCase()})`,
    bpm,
    key: keyPc,
    scale: scaleId,
    moods: [mood.id],
    tags: ['composed'],
    patternLength: patternBars * ROWS_PER_BAR,
    groove: mood.groove
  })
  song.meta.notes = `Composed by compose_track (seed ${opts.seed}).`
  if (chip === 'snes' && style.calm) {
    const cfg = song.chipConfig
    if (cfg.chip === 'snes') cfg.echo = { ...cfg.echo, delay: 6, feedback: 0.5, volL: 0.35, volR: 0.35 }
  }

  // ---- channels and instruments
  const drumStyle = style.drums ? findDrumStyle(style.drums) : undefined
  const drumRoles = drumStyle ? DRUM_ROLES.filter((r) => drumStyle.lanes[r] || (!style.calm && drumStyle.fill?.[r])) : []
  const plan = planChannels(song, style, drumRoles)
  const defs = songChannelDefs(song)
  const motifPc = normalizePitchClass(opts.motifKey ?? 'C')
  if (!motifPc) throw new Error(`Invalid motifKey "${opts.motifKey}": use a note name such as C, F#, Bb.`)
  const motif = opts.motif?.trim() && plan.lead !== undefined ? parseMotif(opts.motif, song, plan.lead) : null
  let motifInfo: ComposeResult['motif'] = null
  const defOf = (i: number | undefined): ChannelDef | undefined => (i === undefined ? undefined : defs[i])

  for (const id of Object.keys(opts.instruments ?? {})) {
    if (channelIndex(song, id) < 0) throw new Error(`instruments: the ${chip.toUpperCase()} song has no channel "${id}". Channels: ${song.channels.map((c: ChannelState) => c.id).join(', ')}.`)
  }
  const instFor = (chIdx: number, wanted: () => Instrument): number => {
    const ch = song.channels[chIdx]!
    const override = opts.instruments?.[ch.id]
    let inst: Instrument
    if (override) {
      const found = tryResolvePreset(chip, override, ch.kind)
      if (!found) throw new Error(`instruments.${ch.id}: "${override}" is not a ${chip.toUpperCase()} preset or role for a ${ch.kind} channel (list_presets shows them).`)
      inst = found
    } else inst = wanted()
    return addSongInstrument(song, inst)
  }
  const soft = (part: 'lead' | 'pad' | 'pad2' | 'bass', chIdx: number, fallbackRole: Role): Instrument => {
    const kind = song.channels[chIdx]!.kind
    if (style.calm) {
      const ref = softPresetRef(chip, part, mood)
      const inst = tryResolvePreset(chip, ref, kind)
      if (inst) return inst
    }
    return presetFor(chip, fallbackRole, kind)
  }

  const parts: string[] = []
  const linear: (Cell | null)[][] = song.channels.map(() => new Array<Cell | null>(off + totalRows).fill(null))
  /** Rows count from the start of the body (the loop), after the intro. */
  const put = (chIdx: number, row: number, cell: Cell): void => {
    if (row < 0 || row >= totalRows) return
    linear[chIdx]![off + row] = cell
  }
  const noteCell = (chIdx: number, midi: number, inst: number, vol: number, fx?: Cell['fx']): Cell => {
    const def = defOf(chIdx)
    const n = def ? foldIntoRange(midi, def.noteMin, def.noteMax).note : midi
    const v = cellVol(def, vol * style.level)
    return { note: n, inst, ...(v !== undefined ? { vol: v } : {}), ...(fx ? { fx } : {}) }
  }

  // ---- harmony
  const prog = findProgression(mood, minorPick ?? isMinorScale(scaleId), rng)
  const slots = Math.ceil(bars / style.chordBars)
  const chordAt = (bar: number): ReturnType<typeof romanToChord> => {
    const slot = Math.floor(bar / style.chordBars)
    const idx = slot === slots - 1 && slots > 1 ? prog.numerals.length - 1 : slot % prog.numerals.length
    return romanToChord(prog.numerals[idx]!, keyPc, 3)
  }
  // intro: the tonic held, the last bar (with 2+ bars) on the progression's last chord, which leads into the first one
  const introChord = (bar: number): ReturnType<typeof romanToChord> =>
    romanToChord(prog.numerals[bar === introBars - 1 && introBars >= 2 ? prog.numerals.length - 1 : 0]!, keyPc, 3)
  const putIntro = (chIdx: number, bar: number, cell: Cell): void => {
    linear[chIdx]![bar * ROWS_PER_BAR] = cell
  }
  const chordNames: string[] = []
  for (let s = 0; s < slots; s++) {
    const c = chordAt(s * style.chordBars)
    chordNames.push(chordName(c.root, c.quality))
  }

  // ---- bass
  if (plan.bass !== undefined) {
    const ch = plan.bass
    const inst = instFor(ch, () => soft('bass', ch, 'bass'))
    parts.push(`${song.channels[ch]!.id} bass: ${song.instruments[inst]!.name}`)
    for (let bar = 0; bar < introBars; bar++) {
      if (bar === 0 || bar === introBars - 1) putIntro(ch, bar, noteCell(ch, 36 + introChord(bar).root, inst, 8))
    }
    for (let bar = 0; bar < bars; bar++) {
      const chord = chordAt(bar)
      const root = 36 + chord.root
      const newChord = bar % style.chordBars === 0
      if (style.bass === 'hold') {
        if (newChord) put(ch, bar * ROWS_PER_BAR, noteCell(ch, root, inst, 12))
      } else {
        for (const step of BASS_PATTERNS[style.bass]) put(ch, bar * ROWS_PER_BAR + step.row, noteCell(ch, root + step.semis, inst, step.row === 0 ? 12 : 10))
      }
    }
  }

  // ---- pads
  const padInsts: number[] = []
  plan.pads.forEach((ch, k) => {
    const inst = instFor(ch, () => soft(k === 0 ? 'pad' : 'pad2', ch, k === 0 ? mood.parts.pad : 'strings'))
    padInsts.push(inst)
    parts.push(`${song.channels[ch]!.id} pad: ${song.instruments[inst]!.name}`)
  })
  // two chord voices: the first the third (or so), the second the top tone, one beat late
  const padPitch = (k: number, chord: ReturnType<typeof romanToChord>): number => {
    const iv = chord.intervals
    const semis = k === 0 ? iv[1]! : iv.length >= 4 ? iv[iv.length - 1]! : iv[2] ?? iv[1]!
    return nearPitch((chord.root + semis) % 12, k === 0 ? 62 : 68)
  }
  for (let bar = 0; bar < introBars; bar++) {
    if (bar !== 0 && bar !== introBars - 1) continue
    const chord = introChord(bar)
    plan.pads.forEach((ch, k) => {
      const pitch = plan.pads.length >= 2 ? padPitch(k, chord) : nearPitch(chord.root, 60)
      putIntro(ch, bar, noteCell(ch, pitch, padInsts[k]!, 5))
    })
  }
  if (plan.pads.length >= 2) {
    plan.pads.forEach((ch, k) => {
      const inst = padInsts[k]!
      for (let bar = 0; bar < bars; bar += style.chordBars) {
        const chord = chordAt(bar)
        // the second pad enters one beat late: the two attacks do not dip together
        put(ch, bar * ROWS_PER_BAR + (k === 0 ? 0 : 4), noteCell(ch, padPitch(k, chord), inst, 8))
      }
    })
  } else if (plan.pads.length === 1) {
    const ch = plan.pads[0]!
    const inst = padInsts[0]!
    for (let bar = 0; bar < bars; bar++) {
      const chord = chordAt(bar)
      const iv = chord.intervals
      const base = nearPitch(chord.root, 60)
      if (style.calm) {
        const tones = [0, iv[1]!, iv[2] ?? iv[1]!, iv[1]!]
        tones.forEach((t, q) => put(ch, bar * ROWS_PER_BAR + q * 4, noteCell(ch, base + t, inst, 7)))
      } else {
        const fx = [{ code: '0' as const, param: ((iv[1]! & 15) << 4) | ((iv[2] ?? iv[1]!) & 15) }]
        put(ch, bar * ROWS_PER_BAR, noteCell(ch, base, inst, 8, fx))
      }
    }
  }

  // ---- arp (lively moods, on a free arpeggio voice)
  if (plan.arp !== undefined) {
    const ch = plan.arp
    const inst = instFor(ch, () => presetFor(chip, mood.parts.harmony, song.channels[ch]!.kind))
    parts.push(`${song.channels[ch]!.id} arp: ${song.instruments[inst]!.name}`)
    const order = [0, 1, 2, 1]
    for (let bar = 0; bar < bars; bar++) {
      const chord = chordAt(bar)
      const tones = chord.intervals
      for (let r = 0; r < ROWS_PER_BAR; r += 2) {
        const t = tones[order[(r / 2) % order.length]! % tones.length]!
        put(ch, bar * ROWS_PER_BAR + r, noteCell(ch, nearPitch((chord.root + t) % 12, 67), inst, 6))
      }
    }
  }

  // ---- lead
  if (plan.lead !== undefined) {
    const ch = plan.lead
    const inst = instFor(ch, () => soft('lead', ch, mood.parts.lead))
    parts.push(`${song.channels[ch]!.id} lead: ${song.instruments[inst]!.name}`)
    const def = defOf(ch)
    const lo = Math.max(def?.noteMin ?? 0, 60)
    const hi = Math.min(def?.noteMax ?? 127, 84)
    const range = scaleNotes(keyPc, scaleId, lo, hi)

    const writeLead = (notes: number[], low: number, high: number): void => {
      const center = Math.round((low + high) / 2) - 2
      const nearest = (m: number): number => notes.reduce((best, n, i) => (Math.abs(n - m) < Math.abs(notes[best]! - m) ? i : best), 0)
      const snap = (idx: number, pcs: number[], prefer?: number): number => {
        const cands = [0, 1, -1, 2, -2, 3, -3].map((d) => idx + d).filter((i) => i >= 0 && i < notes.length)
        if (prefer !== undefined) {
          const root = cands.find((i) => notes[i]! % 12 === prefer)
          if (root !== undefined) return root
        }
        return cands.find((i) => pcs.includes(notes[i]! % 12)) ?? idx
      }
      const rh = RHYTHMS[style.density]
      // phrase rhythms: set A for even phrases, set B for odd ones, so the music has a recognisable shape
      const makeSet = (): Rhythm[] => {
        const a = pick(rng, rh.normal)
        const b = pick(rng, rh.normal)
        return [a, b, chance(rng, 0.6) ? a : pick(rng, rh.normal), pick(rng, rh.cadence)]
      }
      const sets = [makeSet(), makeSet()]
      let idx = nearest(center)
      let prevStep = 0

      // motif: transposed to the key, folded into the range, out-of-scale notes moved to the nearest scale note
      // (in-scale notes stay as written). It starts every even phrase (the last one only if it fits).
      const motifAt = new Map<number, { notes: { row: number; len: number; idx: number }[] }>()
      let motifBars = 0
      if (motif) {
        motifBars = Math.ceil(motif.rows / ROWS_PER_BAR)
        const semis = (((parseNote(`${keyPc}4`)! - parseNote(`${motifPc}4`)!) % 12) + 12) % 12
        const shift = semis > 6 ? semis - 12 : semis
        const moved = motif.notes.map((n) => n.midi + shift)
        const oct = bestOctaveShift(moved, lo, hi)
        const fitted = motif.notes.map((n, i) => ({ row: n.row, len: n.len, idx: nearest(moved[i]! + oct) }))
        const rngM = createRng((opts.seed ^ 0x9e3779b9 ^ 0x4d) >>> 0) // development of the repeats: never the main RNG
        const placed: number[] = []
        for (let start = 0; start < bars; start += 8) {
          if (start > 0 && start + motifBars > bars) break
          const r = placed.length
          let ns = fitted.map((n) => ({ ...n }))
          if (r >= 1) {
            // every second repeat is sequenced: moved a scale step or two, starting on a tone of the chord of its first bar
            if (r % 2 === 0) {
              const c0 = chordAt(start)
              const pcs0 = chordPitchClasses(c0.root, c0.intervals)
              const steps = [1, -1, 2, -2]
              const at = (i: number): number => Math.max(0, Math.min(notes.length - 1, i))
              const fits = steps.filter((d) => pcs0.includes(notes[at(ns[0]!.idx + d)]! % 12))
              const d = pick(rngM, fits.length > 0 ? fits : steps)
              ns = ns.map((n) => ({ ...n, idx: at(n.idx + d) }))
            }
            // the last note, and sometimes the one before it, may move to a tone of the chord under it
            const tail = [ns.length - 1, ns.length - 2].filter((i) => i >= 0)
            tail.forEach((i, k) => {
              if (!chance(rngM, k === 0 ? 0.6 : 0.3)) return
              const c = chordAt(start + Math.floor(ns[i]!.row / ROWS_PER_BAR))
              ns[i]!.idx = snap(ns[i]!.idx, chordPitchClasses(c.root, c.intervals))
            })
          }
          motifAt.set(start, { notes: ns })
          placed.push(start)
        }
        motifInfo = { bars: motifBars, transposeSemis: shift, placedAtBars: placed }
      }
      let skipUntil = 0

      for (let bar = 0; bar < bars; bar++) {
        const mp = motifAt.get(bar)
        if (mp) {
          mp.notes.forEach((n, j) => {
            const row = bar * ROWS_PER_BAR + n.row
            put(ch, row, noteCell(ch, notes[n.idx]!, inst, n.row % 8 === 0 ? 11 : 10))
            const endRow = row + n.len
            const nextStart = mp.notes[j + 1] ? bar * ROWS_PER_BAR + mp.notes[j + 1]!.row : (bar + motifBars) * ROWS_PER_BAR
            if (endRow < nextStart) put(ch, endRow, { note: 'rel' })
          })
          idx = mp.notes[mp.notes.length - 1]!.idx
          prevStep = 0
          skipUntil = bar + motifBars
        }
        if (bar < skipUntil) continue
        const phrase = Math.floor(bar / 4)
        const inPhrase = bar % 4
        const lastBarOfSong = bar === bars - 1
        let rhythm = sets[phrase % 2]![inPhrase]!
        if (lastBarOfSong && inPhrase !== 3) rhythm = pick(rng, rh.cadence)
        const cadence = inPhrase === 3 || lastBarOfSong
        if (bar > 0 && !cadence && chance(rng, style.restBars)) rhythm = []
        const chord = chordAt(bar)
        const pcs = chordPitchClasses(chord.root, chord.intervals)
        rhythm.forEach(([start, len], j) => {
          const first = bar === 0 && j === 0
          if (first) idx = snap(nearest(center), pcs, chord.root)
          else {
            const w = [1, 3, 3, 1.3, 1.3, 0.3, 0.3] // steps 0, +1, -1, +2, -2, +3, -3
            const here = notes[idx]!
            if (here > center + 8) {
              for (const k of [1, 3, 5]) w[k] = w[k]! * 0.4
              w[2] = w[2]! * 2
            }
            if (here < center - 8) {
              for (const k of [2, 4, 6]) w[k] = w[k]! * 0.4
              w[1] = w[1]! * 2
            }
            if (prevStep >= 2) w[1] = w[1]! * 0.3
            if (prevStep <= -2) w[2] = w[2]! * 0.3
            const step = [0, 1, -1, 2, -2, 3, -3][weighted(rng, w)]!
            prevStep = step
            idx = Math.max(0, Math.min(notes.length - 1, idx + step))
          }
          const last = j === rhythm.length - 1
          if (start % 8 === 0 || first) idx = snap(idx, pcs)
          if (cadence && last) idx = snap(idx, pcs, lastBarOfSong ? chord.root : undefined)
          const row = bar * ROWS_PER_BAR + start
          put(ch, row, noteCell(ch, notes[idx]!, inst, start % 8 === 0 ? 11 : 10))
          // a note shorter than the gap to the next one is released (so the instrument's release plays out)
          const next = rhythm[j + 1]
          const endRow = row + len
          const nextStart = next ? bar * ROWS_PER_BAR + next[0] : (bar + 1) * ROWS_PER_BAR
          if (endRow < nextStart && endRow < totalRows) put(ch, endRow, { note: 'rel' })
        })
        if (rhythm.length === 0 && bar > 0) {
          // a silent bar: release whatever still rings from the bar before
          const prevRow = bar * ROWS_PER_BAR
          if (linear[ch]![off + prevRow] === null) put(ch, prevRow, { note: 'rel' })
        }
      }
    }
    if (range.length > 0) writeLead(range, lo, hi)
  }

  // ---- drums
  if (drumStyle) {
    const volByRole: Record<DrumRole, number> = { kick: 12, snare: 10, hihat: 6, openhat: 6, crash: 8, tom: 9, clap: 9 }
    for (const [ch, roles] of plan.drums) {
      const kind = song.channels[ch]!.kind
      const insts = new Map<DrumRole, number>()
      for (const role of roles) {
        const override = opts.instruments?.[song.channels[ch]!.id]
        const found = override && roles.length === 1 ? tryResolvePreset(chip, override, kind) : undefined
        insts.set(role, addSongInstrument(song, found ?? presetFor(chip, role, kind)))
      }
      parts.push(`${song.channels[ch]!.id} drums: ${roles.join('+')}`)
      for (let bar = 0; bar < bars; bar++) {
        const isFill = !style.calm && !!drumStyle.fill && bar % 4 === 3 && bar !== bars - 1 && bars > 1
        for (let step = 0; step < 16; step++) {
          const hit = DRUM_PRIORITY.find((role) => {
            if (!roles.includes(role)) return false
            const base = drumStyle.lanes[role]
            const fill = drumStyle.fill?.[role]
            const lane = isFill && drumStyle.fill ? (fill ?? (role === 'snare' || role === 'tom' ? undefined : base)) : base
            return lane?.[step] === 'x'
          })
          if (hit) put(ch, bar * ROWS_PER_BAR + step, noteCell(ch, defaultDrumNote(hit, kind), insts.get(hit)!, volByRole[hit] * (style.calm ? 0.55 : 1)))
        }
      }
    }
  }

  // ---- write the patterns
  song.orders = Array.from({ length: (introBars + bars) / patternBars }, () => song.channels.map(() => 0))
  song.channels.forEach((_, i) => writeChannelPatterns(song, i, linear[i]!))
  song.loop = opts.loop === false ? null : { order: introBars / patternBars }

  const problems = validateSong(song).filter((x) => x.severity === 'error')
  if (problems.length > 0) throw new Error(`The composed song breaks ${chip.toUpperCase()} limits: ${problems.map((p) => p.message).slice(0, 3).join(' ')}`)

  const used = song.channels.filter((_, i) => linear[i]!.some((c) => c !== null)).map((c) => c.id)
  return {
    song,
    seed: opts.seed,
    bars,
    introBars,
    chip,
    bpm,
    key: keyPc,
    scale: scaleId,
    mood: mood.id,
    durationSec: Math.round(songSeconds(song) * 1000) / 1000,
    loop: song.loop ? { startBar: introBars, endBar: introBars + bars } : null,
    channels: used,
    parts,
    chords: chordNames,
    progression: prog.id,
    motif: motifInfo
  }
}
