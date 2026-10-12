// Helpers shared by the MIDI importer and the chip converter: adding preset instruments to a song that is being
// built, resolving a preset for a role on a channel kind, and cutting a channel's linear cell list into
// deduplicated patterns.

import type { Cell, ChannelKind, ChipId, Instrument, Pattern, Role, Song } from '../types'
import type { ChannelDef } from '../chips/types'
import { instrumentSlug } from '../instruments/types'
import { listPresets, missingPresetSample, resolvePreset } from '../instruments/presets'
import { ROLE_FALLBACKS } from '../instruments/roles'
import { cellsEqual, normalizeCell } from '../model'

/** Add an instrument to a song under construction (deduplicated by preset id; sample slots are added too). Returns its index. */
export function addSongInstrument(song: Song, inst: Instrument): number {
  if (inst.presetId) {
    const dup = song.instruments.findIndex((x) => x.presetId === inst.presetId)
    if (dup >= 0) return dup
  }
  const base = inst.name
  let name = base
  for (let n = 2; song.instruments.some((x) => instrumentSlug(x.name) === instrumentSlug(name)); n++) name = `${base}-${n}`
  inst.name = name
  const slot = missingPresetSample(song, inst)
  if (slot) song.samples.push(slot)
  song.instruments.push(inst)
  return song.instruments.length - 1
}

const MELODIC_FALLBACK: Role[] = ['lead', 'arp', 'pluck', 'bass']
const DRUM_FALLBACK: Role[] = ['snare', 'hihat', 'kick']

/** A fresh preset instrument for a role that plays on `kind`; falls back to related roles, then to any preset for the channel kind. */
export function presetFor(chip: ChipId, role: Role, kind: ChannelKind): Instrument {
  const drum = ['kick', 'snare', 'hihat', 'openhat', 'crash', 'tom', 'clap'].includes(role)
  const chain: Role[] = [role, ...(ROLE_FALLBACKS[role] ?? []), ...(drum ? DRUM_FALLBACK : MELODIC_FALLBACK)]
  for (const r of chain) {
    try {
      return resolvePreset(chip, r, kind)
    } catch {
      /* try the next role */
    }
  }
  const any = listPresets(chip, { channelKind: kind })[0]
  if (any) return resolvePreset(chip, any.id)
  throw new Error(`No ${chip} preset plays on a ${kind} channel.`)
}

/** Nearest allowed volume (0..15 scale) for channels that quantize volume (Game Boy wave). */
export function snapVolume(vol: number, def: ChannelDef): number {
  const steps = def.volumeSteps?.filter((v) => v > 0)
  if (!steps || steps.length === 0) return vol
  return steps.reduce((a, b) => (Math.abs(b - vol) < Math.abs(a - vol) ? b : a))
}

/**
 * Cut a channel's linear cell list (one entry per song row) into patterns of `patternLength` rows, deduplicate
 * identical patterns and write the channel's column of song.orders. `song.orders` must already have one row per order.
 */
export function writeChannelPatterns(song: Song, channelIndex: number, linear: readonly (Cell | null)[]): { unique: number } {
  const L = song.patternLength
  const channelId = song.channels[channelIndex]!.id
  const seen: { rows: (Cell | null)[]; number: number }[] = []
  let next = 0
  for (let o = 0; o < song.orders.length; o++) {
    const rows: (Cell | null)[] = []
    for (let r = 0; r < L; r++) rows.push(normalizeCell(linear[o * L + r] ?? null))
    let hit = seen.find((s) => s.rows.every((c, i) => cellsEqual(c, rows[i])))
    if (!hit) {
      hit = { rows, number: next++ }
      seen.push(hit)
      if (rows.some((c) => c !== null)) {
        const pat: Pattern = { rows }
        song.patterns.set(`${channelId}:${hit.number}`, pat)
      }
    }
    song.orders[o]![channelIndex] = hit.number
  }
  return { unique: seen.length }
}

/**
 * Octave shift (multiple of 12) that puts the most of `pitches` inside [min, max]; ties prefer the smaller shift.
 * Returns 0 when everything fits.
 */
export function bestOctaveShift(pitches: readonly number[], min: number, max: number): number {
  if (pitches.length === 0) return 0
  let best = 0
  let bestOut = Infinity
  for (let k = -5; k <= 5; k++) {
    const s = k * 12
    let out = 0
    for (const p of pitches) if (p + s < min || p + s > max) out++
    if (out < bestOut || (out === bestOut && Math.abs(s) < Math.abs(best))) {
      best = s
      bestOut = out
    }
  }
  return best
}

/** Fold a note into [min, max] by octaves; the second value tells whether it had to move. Notes that cannot fit are clamped. */
export function foldIntoRange(note: number, min: number, max: number): { note: number; moved: boolean } {
  let n = note
  while (n < min && n + 12 <= 127) n += 12
  while (n > max && n - 12 >= 0) n -= 12
  n = Math.max(min, Math.min(max, n))
  return { note: n, moved: n !== note }
}
