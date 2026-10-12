// .ctune project files: JSON { format: 'chiptune-studio', version: 1, song, samples }.
//
// Patterns are stored sparsely as { "P1:0": [[row, note, inst, vol, ...fx], ...] } where note is a MIDI
// number, "off", "rel" or null; inst and vol are numbers or null; each fx is a string "4A2" (code +
// two hex digits). Empty patterns are omitted. Samples live at the top level (not inside song).

import { z } from 'zod'
import type { Cell, Effect, Instrument, Pattern, PatternKey, SampleSlot, Song } from '../types'
import { CHIP_IDS, EFFECT_CODES, ROLES } from '../types'
import { createEmptyPattern, normalizeCell } from '../model'
import { normalizePitchClass } from '../notes'
import { formatEffect, parseEffectToken } from './common'

export const PROJECT_FORMAT = 'chiptune-studio'
export const PROJECT_VERSION = 1

export class ProjectError extends Error {
  readonly issues: string[]
  constructor(issues: string[]) {
    const shown = issues.slice(0, 12)
    super(
      `Invalid Chiptune Studio project (${issues.length} problem${issues.length === 1 ? '' : 's'}):\n- ${shown.join('\n- ')}` +
        (issues.length > 12 ? `\n- ...and ${issues.length - 12} more.` : '')
    )
    this.name = 'ProjectError'
    this.issues = issues
  }
}

// ---------------------------------------------------------------- schemas

const int = z.number().int()
const macro = z.object({
  values: z.array(z.number()),
  loop: int.optional(),
  release: int.optional(),
  mode: z.enum(['rel', 'fixed']).optional()
})
const macros = z.object({ vol: macro.optional(), arp: macro.optional(), pitch: macro.optional(), timbre: macro.optional() })
const gm = z.object({ program: int.optional(), drumNote: int.optional() })
const base = {
  name: z.string(),
  role: z.enum(ROLES as [string, ...string[]]).optional(),
  presetId: z.string().optional(),
  gm: gm.optional()
}
const gbEnv = z.object({ init: int, dir: z.enum(['up', 'down']), pace: int })
const fmOp = z.object({
  ar: z.number(), dr: z.number(), sr: z.number(), rr: z.number(), sl: z.number(), tl: z.number(),
  ks: z.number(), ml: z.number(), dt: z.number(), ssg: z.number().optional(), am: z.boolean().optional()
})
const snesEnv = z.union([
  z.object({ adsr: z.tuple([z.number(), z.number(), z.number(), z.number()]) }),
  z.object({ gain: z.object({ mode: z.enum(['direct', 'linear-dec', 'exp-dec', 'linear-inc', 'bent-inc']), rate: z.number() }) })
])

const instrumentSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.enum(['nes-pulse', 'nes-tri', 'nes-noise', 'psg', 'psg-noise']), macros, noiseMode: z.enum(['white', 'periodic']).optional() }),
  z.object({
    ...base, kind: z.literal('gb-pulse'), env: gbEnv, duty: z.number().optional(),
    sweep: z.object({ pace: z.number(), dir: z.enum(['up', 'down']), step: z.number() }).optional(), macros: macros.optional()
  }),
  z.object({ ...base, kind: z.literal('gb-noise'), env: gbEnv, short: z.boolean().optional(), macros: macros.optional() }),
  z.object({ ...base, kind: z.literal('gb-wave'), wave: z.array(z.number()), level: z.number(), macros: macros.optional() }),
  z.object({ ...base, kind: z.literal('pce-wave'), waves: z.array(z.array(z.number())), noise: z.boolean().optional(), macros }),
  z.object({
    ...base, kind: z.literal('fm'), alg: z.number(), fb: z.number(), ams: z.number(), pms: z.number(),
    ops: z.tuple([fmOp, fmOp, fmOp, fmOp]), macros: macros.optional()
  }),
  z.object({
    ...base, kind: z.literal('snes-sample'), sample: z.string(), baseNote: z.number(), env: snesEnv, echo: z.boolean(),
    fine: z.number().optional(), macros: macros.optional()
  }),
  z.object({ ...base, kind: z.literal('sample'), sample: z.string(), baseNote: z.number().optional(), macros: macros.optional() })
])

const sampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.union([
    z.object({ kind: z.literal('recipe'), recipe: z.string(), params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])) }),
    z.object({ kind: z.literal('pcm'), sampleRate: z.number(), data: z.string() })
  ]),
  loopStart: z.number().optional()
})

const chipConfigSchema = z.discriminatedUnion('chip', [
  z.object({ chip: z.literal('nes'), region: z.enum(['ntsc', 'pal']), dpcm: z.boolean(), mixModel: z.enum(['nonlinear', 'linear']) }),
  z.object({ chip: z.literal('gb') }),
  z.object({ chip: z.literal('genesis'), region: z.enum(['ntsc', 'pal']), fm6Dac: z.boolean(), lfo: z.number() }),
  z.object({
    chip: z.literal('snes'),
    echo: z.object({ delay: z.number(), feedback: z.number(), volL: z.number(), volR: z.number(), fir: z.array(z.number()) })
  }),
  z.object({ chip: z.literal('pce') })
])

const rowEntry = z.array(z.union([z.number(), z.string(), z.null()])).min(4)

const songSchema = z.object({
  format: z.literal(1),
  id: z.string(),
  name: z.string(),
  chip: z.enum(CHIP_IDS as unknown as [string, ...string[]]),
  chipConfig: chipConfigSchema,
  authenticity: z.enum(['strict', 'relaxed']),
  meta: z.object({
    key: z.string(),
    scale: z.string(),
    moods: z.array(z.string()),
    tags: z.array(z.string()),
    notes: z.string().optional()
  }),
  timing: z.object({
    bpm: z.number(), speed: z.number(), rowsPerBeat: z.number(), beatsPerBar: z.number(), groove: z.array(z.number()).optional()
  }),
  patternLength: z.number().int().min(1).max(256),
  channels: z.array(
    z.object({
      id: z.string(), name: z.string(), kind: z.string(), fxColumns: z.number().int().min(1).max(4),
      muted: z.boolean().optional(), pan: z.number().optional(), trim: z.number().optional()
    })
  ),
  orders: z.array(z.array(z.number().int())),
  patterns: z.record(z.string(), z.array(rowEntry)),
  instruments: z.array(instrumentSchema),
  loop: z.object({ order: z.number().int() }).nullable(),
  references: z.array(z.object({ assetId: z.string(), note: z.string().optional() }))
})

const projectSchema = z.object({
  format: z.literal(PROJECT_FORMAT),
  version: z.number().int(),
  song: songSchema,
  samples: z.array(sampleSchema)
})

// ---------------------------------------------------------------- types

export type ProjectSongJson = z.infer<typeof songSchema>
export interface ProjectFile {
  format: typeof PROJECT_FORMAT
  version: number
  song: ProjectSongJson
  samples: SampleSlot[]
}

// ---------------------------------------------------------------- migration

type Migration = (raw: Record<string, unknown>) => Record<string, unknown>

/** Version N -> N+1 upgrades, keyed by the source version. Add an entry when the format changes. */
export const PROJECT_MIGRATIONS: Record<number, Migration> = {}

/** Upgrade an older project object to the current version (hook for future format changes). */
export function migrateProject(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  let obj = raw as Record<string, unknown>
  let version = typeof obj.version === 'number' ? obj.version : PROJECT_VERSION
  if (version > PROJECT_VERSION) {
    throw new ProjectError([`the project was saved by a newer version (format version ${version}); this app reads up to version ${PROJECT_VERSION}.`])
  }
  while (version < PROJECT_VERSION) {
    const step = PROJECT_MIGRATIONS[version]
    if (!step) throw new ProjectError([`no migration from project version ${version} to ${version + 1}.`])
    obj = step(obj)
    version++
    obj.version = version
  }
  return obj
}

// ---------------------------------------------------------------- song -> JSON

function patternToSparse(p: Pattern): (number | string | null)[][] {
  const out: (number | string | null)[][] = []
  p.rows.forEach((cell, row) => {
    const c = normalizeCell(cell)
    if (!c) return
    out.push([row, c.note ?? null, c.inst ?? null, c.vol ?? null, ...(c.fx ?? []).map(formatEffect)])
  })
  return out
}

export function songToProject(song: Song): ProjectFile {
  const patterns: Record<string, (number | string | null)[][]> = {}
  const keys = [...song.patterns.keys()].sort((a, b) => {
    const pa = a.lastIndexOf(':')
    const pb = b.lastIndexOf(':')
    const ca = a.slice(0, pa)
    const cb = b.slice(0, pb)
    return ca === cb ? Number(a.slice(pa + 1)) - Number(b.slice(pb + 1)) : ca < cb ? -1 : 1
  })
  for (const k of keys) {
    const sparse = patternToSparse(song.patterns.get(k)!)
    if (sparse.length > 0) patterns[k] = sparse
  }
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    song: {
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
      instruments: structuredClone(song.instruments) as ProjectSongJson['instruments'],
      loop: song.loop ? { ...song.loop } : null,
      references: song.references.map((r) => ({ ...r }))
    },
    samples: structuredClone(song.samples)
  }
}

export function serializeProject(song: Song, pretty = true): string {
  return JSON.stringify(songToProject(song), null, pretty ? 1 : undefined)
}

// ---------------------------------------------------------------- JSON -> song

function formatZodIssues(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
}

/** Validate and convert a project object (already JSON-parsed) to a Song. Throws ProjectError. */
export function projectToSong(raw: unknown): Song {
  const migrated = migrateProject(raw)
  const parsed = projectSchema.safeParse(migrated)
  if (!parsed.success) throw new ProjectError(formatZodIssues(parsed.error))
  const { song: sj, samples } = parsed.data
  const issues: string[] = []

  const ids = new Set<string>()
  for (const c of sj.channels) {
    if (ids.has(c.id)) issues.push(`channels: duplicate channel id "${c.id}".`)
    ids.add(c.id)
  }
  sj.orders.forEach((row, i) => {
    if (row.length !== sj.channels.length) issues.push(`orders[${i}]: has ${row.length} entries but the song has ${sj.channels.length} channels.`)
  })
  if (!normalizePitchClass(sj.meta.key)) issues.push(`meta.key "${sj.meta.key}" is not a pitch class (C, C#, D, ... B).`)
  if (sj.orders.length === 0) issues.push('orders: must contain at least one order row.')
  if (sj.loop && (sj.loop.order < 0 || sj.loop.order >= sj.orders.length)) issues.push(`loop.order ${sj.loop.order} is outside 0..${sj.orders.length - 1}.`)

  const patterns = new Map<PatternKey, Pattern>()
  for (const [key, entries] of Object.entries(sj.patterns)) {
    const colon = key.lastIndexOf(':')
    const channelId = key.slice(0, colon)
    if (colon <= 0 || !/^\d+$/.test(key.slice(colon + 1)) || !ids.has(channelId)) {
      issues.push(`patterns["${key}"]: key must be "<channelId>:<number>" for an existing channel.`)
      continue
    }
    const pat = createEmptyPattern(sj.patternLength)
    for (const entry of entries) {
      const [row, note, inst, vol, ...fxRaw] = entry
      if (typeof row !== 'number' || !Number.isInteger(row) || row < 0 || row >= sj.patternLength) {
        issues.push(`patterns["${key}"]: row ${String(row)} is outside 0..${sj.patternLength - 1}.`)
        continue
      }
      const cell: Cell = {}
      if (note !== null) {
        if (note === 'off' || note === 'rel') cell.note = note
        else if (typeof note === 'number' && Number.isInteger(note) && note >= 0 && note <= 127) cell.note = note
        else issues.push(`patterns["${key}"] row ${row}: note ${JSON.stringify(note)} must be 0..127, "off", "rel" or null.`)
      }
      if (inst !== null) {
        if (typeof inst === 'number' && Number.isInteger(inst) && inst >= 0 && inst < sj.instruments.length) cell.inst = inst
        else issues.push(`patterns["${key}"] row ${row}: instrument ${JSON.stringify(inst)} does not exist (${sj.instruments.length} instruments).`)
      }
      if (vol !== null) {
        if (typeof vol === 'number' && Number.isInteger(vol) && vol >= 0 && vol <= 15) cell.vol = vol
        else issues.push(`patterns["${key}"] row ${row}: volume ${JSON.stringify(vol)} must be 0..15.`)
      }
      const fx: Effect[] = []
      for (const f of fxRaw) {
        const e = typeof f === 'string' ? parseEffectToken(f) : null
        if (!e) issues.push(`patterns["${key}"] row ${row}: effect ${JSON.stringify(f)} must be a string like "4A2" (code ${EFFECT_CODES.join('')} + two hex digits).`)
        else fx.push(e)
      }
      if (fx.length > 0) cell.fx = fx
      pat.rows[row] = normalizeCell(cell)
    }
    patterns.set(key as PatternKey, pat)
  }
  if (issues.length > 0) throw new ProjectError(issues)

  const song: Song = {
    format: 1,
    id: sj.id,
    name: sj.name,
    chip: sj.chip as Song['chip'],
    chipConfig: sj.chipConfig,
    authenticity: sj.authenticity,
    meta: { ...sj.meta, key: sj.meta.key as Song['meta']['key'] },
    timing: sj.timing,
    patternLength: sj.patternLength,
    channels: sj.channels as Song['channels'],
    orders: sj.orders,
    patterns,
    instruments: sj.instruments as unknown as Instrument[],
    samples: samples as SampleSlot[],
    loop: sj.loop,
    references: sj.references
  }
  return song
}

/** Parse the text of a .ctune file. Throws ProjectError with readable problems. */
export function parseProject(text: string): Song {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ProjectError([`not valid JSON: ${(e as Error).message}`])
  }
  return projectToSong(raw)
}

