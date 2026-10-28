// Generic chip validation engine shared by every chip profile. Messages are written for an LLM:
// they state what is wrong and how to fix it ("transpose +12 or move to TR").

import type { Cell, ChipConfig, ChipId, Instrument, SampleSlot, Song } from '../types'
import { EFFECT_CODES } from '../types'
import { describeNote } from '../notes'
import { KINDS_BY_CHIP } from '../instruments/types'
import { validateInstrument } from '../instruments/validate'
import { getSampleTarget, tryPeekSampleLength } from '../synth/samplegen/bank'
import { type ChannelDef, type ChipProfile, type Issue, type ValidateScope, forEachPattern } from './types'

export interface ProfileSpec {
  id: ChipId
  label: string
  name: string
  era: string
  description: string
  notes: string[]
  channels(cfg: ChipConfig): ChannelDef[]
  defaultConfig(): ChipConfig
  /** Chip-specific whole-song checks (ARAM budget, ...). `rule` is the severity for chip-rule violations. */
  extra?(song: Song, scope: ValidateScope, rule: 'error' | 'warning'): Issue[]
}

export interface CellLocation {
  order?: number
  pattern?: number
  row?: number
}

export function ruleSeverity(song: Song): 'error' | 'warning' {
  return song.authenticity === 'strict' ? 'error' : 'warning'
}

function hex2(n: number): string {
  return n.toString(16).toUpperCase().padStart(2, '0')
}

/** Channels (other than `exclude`) that can play the note with a melodic instrument. */
function alternativeChannels(defs: ChannelDef[], note: number, exclude: string): string[] {
  return defs
    .filter((d) => d.id !== exclude && !d.noise && d.kind !== 'dpcm' && note >= d.noteMin && note <= d.noteMax)
    .map((d) => d.id)
}

function channelsAccepting(defs: ChannelDef[], kind: string, exclude: string): string[] {
  return defs.filter((d) => d.id !== exclude && (d.instKinds as string[]).includes(kind)).map((d) => d.id)
}

/** Round the shift up to whole octaves so the note lands inside the channel's range. */
function octaveShift(note: number, def: ChannelDef): number {
  if (note < def.noteMin) return Math.ceil((def.noteMin - note) / 12) * 12
  if (note > def.noteMax) return -Math.ceil((note - def.noteMax) / 12) * 12
  return 0
}

/**
 * Check one cell against one channel. `instruments` is song.instruments. Returned issues carry the
 * location passed in `loc` plus the channel id.
 */
export function validateCellForChannel(
  profile: ChipProfile,
  song: Song,
  defs: ChannelDef[],
  def: ChannelDef,
  cell: Cell,
  loc: CellLocation = {}
): Issue[] {
  const out: Issue[] = []
  const rule = ruleSeverity(song)
  const at = { channel: def.id, ...loc }
  const push = (severity: 'error' | 'warning', message: string, field?: Issue['field'], fxIndex?: number): void => {
    out.push({ severity, ...at, ...(field ? { field } : {}), ...(fxIndex !== undefined ? { fxIndex } : {}), message })
  }

  const note = cell.note
  if (typeof note === 'number') {
    if (!Number.isInteger(note) || note < 0 || note > 127) {
      push('error', `note ${note} is not a MIDI note 0..127.`, 'note')
    } else if (!def.noise && (note < def.noteMin || note > def.noteMax)) {
      const shift = octaveShift(note, def)
      const alts = alternativeChannels(defs, note, def.id)
      const side = note < def.noteMin ? 'below' : 'above'
      const bound = side === 'below' ? def.noteMin : def.noteMax
      let fix = `transpose ${shift > 0 ? '+' : ''}${shift}`
      if (alts.length > 0) fix += ` or move to ${alts.slice(0, 3).join('/')}`
      if (profile.id === 'genesis' && def.kind === 'psg-square' && side === 'below') {
        fix += '; the SN76489 cannot play below A-2'
      }
      push(rule, `note ${describeNote(note)} is ${side} ${def.id}'s ${side === 'below' ? 'lowest' : 'highest'} note ${describeNote(bound)} on ${profile.label}; ${fix}`, 'note')
    }
  }

  if (cell.inst !== undefined) {
    const inst = song.instruments[cell.inst]
    if (!Number.isInteger(cell.inst) || cell.inst < 0 || !inst) {
      const n = song.instruments.length
      push('error', `instrument @${cell.inst} does not exist (the song has ${n === 0 ? 'no instruments; add one first' : `@0..@${n - 1}`}).`, 'inst')
    } else {
      if (!(def.instKinds as string[]).includes(inst.kind)) {
        const alts = channelsAccepting(defs, inst.kind, def.id)
        push(
          rule,
          `instrument @${cell.inst} "${inst.name}" is kind ${inst.kind}, which ${def.id} (${def.name}) cannot play; ${def.id} accepts ${def.instKinds.join(', ')}` +
            (alts.length > 0 ? `; move this part to ${alts.slice(0, 3).join('/')} or pick a ${def.instKinds[0]} instrument` : ''),
          'inst'
        )
      }
      if (inst.kind === 'pce-wave' && inst.noise && def.kind === 'pce-wave' && def.id !== 'C5' && def.id !== 'C6') {
        push(rule, `instrument @${cell.inst} "${inst.name}" uses noise, which only works on C5 and C6 on the PC Engine; move it to C5/C6 or clear its noise flag`, 'inst')
      }
      if (inst.kind === 'gb-pulse' && inst.sweep && def.id !== 'P1') {
        push(rule, `instrument @${cell.inst} "${inst.name}" has a frequency sweep, which only P1 has on the Game Boy; move it to P1 or remove the sweep`, 'inst')
      }
    }
  }

  if (cell.vol !== undefined) {
    if (!Number.isInteger(cell.vol) || cell.vol < 0 || cell.vol > 15) {
      push('error', `volume v${cell.vol} is out of range; use v0..v15.`, 'vol')
    } else if (!def.hasVolume) {
      push(rule, `${def.name.toLowerCase()} has no volume on ${profile.label}; remove it`, 'vol')
    }
  }

  if (cell.fx && cell.fx.length > 0) {
    if (cell.fx.length > 4) push('error', `a cell can hold at most 4 effects; got ${cell.fx.length}.`)
    else if (cell.fx.length > def.fxColumns) {
      push(rule, `${def.id} shows ${def.fxColumns} effect column(s) but the cell has ${cell.fx.length} effects; raise the channel's fxColumns (update_channel) or drop one`, 'fx')
    }
    for (const [fi, fx] of cell.fx.entries()) {
      const label = `${fx.code}${hex2(fx.param)}`
      if (!EFFECT_CODES.includes(fx.code)) {
        push('error', `effect ${label}: unknown code "${fx.code}"; valid codes are ${EFFECT_CODES.join(' ')}.`, 'fx', fi)
        continue
      }
      if (!Number.isInteger(fx.param) || fx.param < 0 || fx.param > 255) {
        push('error', `effect ${fx.code}${fx.param}: parameter must be an integer 0..255 (two hex digits).`, 'fx', fi)
        continue
      }
      if (!def.effects.includes(fx.code)) {
        push(rule, `effect ${label} is not available on ${def.id} (${profile.label} ${def.name}); allowed effects: ${def.effects.join(' ')}`, 'fx', fi)
      }
    }
  }
  return out
}

/** Resolve the channel definition for a channel id in a song (undefined if the chip has no such channel). */
export function channelDefFor(profile: ChipProfile, song: Song, channelId: string): ChannelDef | undefined {
  return profile.channels(song.chipConfig).find((d) => d.id === channelId)
}

// ---------------------------------------------------------------------------------------------
// Samples

/** Approximate sample length in PCM samples for RAM accounting (default: the SNES ARAM pipeline; `target` picks another). */
export function estimateSampleLength(slot: SampleSlot, sampleSizes?: Record<string, number>, target = 'snes'): number {
  const rate = getSampleTarget(target)?.userRate
  const known = sampleSizes?.[slot.id]
  if (known !== undefined) return known
  if (slot.source.kind === 'pcm') {
    const b64 = slot.source.data
    const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
    const n = Math.floor(((b64.length * 3) / 4 - pad) / 2)
    // the SNES pipeline resamples user PCM to 32 kHz
    return rate && slot.source.sampleRate > 0 ? Math.round((n * rate) / slot.source.sampleRate) : n
  }
  // recipe slots: the exact length after the target's pipeline (cached generation)
  const exact = tryPeekSampleLength(slot, target)
  if (exact !== undefined) return exact
  const p = slot.source.params
  for (const k of ['samples', 'length', 'numSamples']) {
    const v = p[k]
    if (typeof v === 'number' && v > 0) return Math.round(v)
  }
  for (const k of ['seconds', 'duration', 'durationSec']) {
    const v = p[k]
    if (typeof v === 'number' && v > 0) return Math.round(v * (rate ?? 32000))
  }
  return 8192
}

// ---------------------------------------------------------------------------------------------

export function defineProfile(spec: ProfileSpec): ChipProfile {
  const profile: ChipProfile = {
    id: spec.id,
    label: spec.label,
    name: spec.name,
    era: spec.era,
    description: spec.description,
    notes: spec.notes,
    channels: spec.channels,
    defaultConfig: spec.defaultConfig,
    validate(song, scope = {}) {
      return validateSongWith(profile, spec, song, scope)
    }
  }
  return profile
}

function validateSongWith(profile: ChipProfile, spec: ProfileSpec, song: Song, scope: ValidateScope): Issue[] {
  const out: Issue[] = []
  const rule = ruleSeverity(song)
  const defs = profile.channels(song.chipConfig)
  const scoped = !!(scope.channels || scope.patterns || scope.orders)
  const includeSong = scope.includeSong ?? !scoped

  if (song.chip !== profile.id) {
    out.push({ severity: 'error', message: `song chip is ${song.chip} but it was checked against ${profile.id}.` })
    return out
  }

  const orderPatterns = scope.orders ? new Set<string>() : undefined
  if (orderPatterns && scope.orders) {
    for (const o of scope.orders) {
      const row = song.orders[o]
      if (!row) continue
      row.forEach((p, ci) => {
        const ch = song.channels[ci]
        if (ch) orderPatterns.add(`${ch.id}:${p}`)
      })
    }
  }
  const patternFilter = scope.patterns ? new Set(scope.patterns.map((p) => `${p.channel}:${p.pattern}`)) : undefined
  const channelFilter = scope.channels ? new Set(scope.channels) : undefined

  if (includeSong) {
    const ids = song.channels.map((c) => c.id).join(',')
    const want = defs.map((d) => d.id).join(',')
    if (ids !== want) {
      out.push({ severity: 'error', message: `channels [${ids}] do not match the ${profile.label} layout [${want}]; create the song with new_song.` })
    }
    song.orders.forEach((row, o) => {
      if (row.length !== song.channels.length) {
        out.push({ severity: 'error', order: o, message: `order ${o} has ${row.length} entries but the song has ${song.channels.length} channels.` })
      }
    })
    song.instruments.forEach((inst: Instrument, i) => {
      if (!KINDS_BY_CHIP[profile.id].includes(inst.kind)) {
        out.push({
          severity: rule,
          message: `instrument @${i} "${inst.name}" is kind ${inst.kind}, which ${profile.label} cannot play; use ${KINDS_BY_CHIP[profile.id].join(', ')}.`
        })
      }
      for (const p of validateInstrument(inst)) out.push({ severity: 'error', message: `instrument @${i} "${inst.name}": ${p}` })
      if ((inst.kind === 'snes-sample' || inst.kind === 'sample') && !song.samples.some((s) => s.id === inst.sample)) {
        const ids = song.samples.map((s) => s.id).join(', ') || '(none)'
        out.push({ severity: 'error', message: `instrument @${i} "${inst.name}" refers to missing sample "${inst.sample}"; existing samples: ${ids}.` })
      }
    })
  }

  forEachPattern(song, (ci, channelId, pattern, key, order) => {
    if (channelFilter && !channelFilter.has(channelId)) return
    if (patternFilter && !patternFilter.has(key)) return
    if (orderPatterns && !orderPatterns.has(key)) return
    const def = defs.find((d) => d.id === channelId)
    const pat = song.patterns.get(key)
    if (!def || !pat) return
    void ci
    if (pat.rows.length !== song.patternLength) {
      out.push({ severity: 'error', channel: channelId, order, pattern, message: `pattern ${key} has ${pat.rows.length} rows but the song's pattern length is ${song.patternLength}.` })
    }
    const quantized = new Map<number, number>()
    pat.rows.forEach((cell, row) => {
      if (!cell) return
      out.push(...validateCellForChannel(profile, song, defs, def, cell, { order, pattern, row }))
      if (def.volumeSteps && cell.vol !== undefined && cell.vol >= 0 && cell.vol <= 15 && !def.volumeSteps.includes(cell.vol)) {
        quantized.set(row, cell.vol)
      }
    })
    if (def.volumeSteps && quantized.size > 0) {
      const [firstRow, firstVol] = quantized.entries().next().value as [number, number]
      const nearest = def.volumeSteps.reduce((a, b) => (Math.abs(b - firstVol) < Math.abs(a - firstVol) ? b : a))
      out.push({
        severity: 'warning',
        channel: channelId,
        order,
        pattern,
        row: firstRow,
        message:
          `${quantized.size} volume value(s) are quantized: ${def.name} has only ${def.volumeSteps.length} levels (${def.volumeSteps.map((v) => `v${v}`).join(', ')}); ` +
          `v${firstVol} plays as v${nearest}. Use those values to hear what the hardware plays.`
      })
    }
  })

  if (spec.extra && includeSong) out.push(...spec.extra(song, scope, rule))
  return out
}

/** Validate cells that are about to be written (before the patterns exist). */
export function validateCellsFor(
  profile: ChipProfile,
  song: Song,
  cells: { channel: string; cell: Cell | null | undefined; pattern?: number; row?: number; order?: number }[]
): Issue[] {
  const defs = profile.channels(song.chipConfig)
  const out: Issue[] = []
  for (const c of cells) {
    if (!c.cell) continue
    const def = defs.find((d) => d.id === c.channel)
    if (!def) {
      out.push({ severity: 'error', channel: c.channel, message: `${profile.label} has no channel "${c.channel}"; channels: ${defs.map((d) => d.id).join(', ')}.` })
      continue
    }
    out.push(...validateCellForChannel(profile, song, defs, def, c.cell, { pattern: c.pattern, row: c.row, order: c.order }))
  }
  return out
}
