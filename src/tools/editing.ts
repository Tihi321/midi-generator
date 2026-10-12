// Shared plumbing of the writing tools: chip validation of the cells about to be written, applying a
// cell diff list as one command, and compact result text.

import {
  type CellDiff,
  type Instrument,
  type Issue,
  type SampleSlot,
  type Song,
  countChangedCells,
  createCellsCommand,
  createInstrumentCommand,
  createSampleCommand,
  formatProblemList,
  getChipProfile,
  missingPresetSample,
  requireChannel,
  validateCellsFor
} from '../core'
import type { SongSession } from './session'

export interface WriteReport {
  /** Cells written (diffs with content). */
  written: number
  /** Cells whose content actually changed (including clears). */
  changed: number
  /** Chip-rule warnings (relaxed songs; strict songs fail instead). */
  warnings: string[]
}

const MAX_WARNING_LINES = 6

function dedupe(lines: string[]): string[] {
  return [...new Set(lines)]
}

export function formatWarnings(warnings: string[]): string {
  if (warnings.length === 0) return ''
  const shown = warnings.slice(0, MAX_WARNING_LINES).map((w) => `- ${w}`)
  if (warnings.length > MAX_WARNING_LINES) shown.push(`- ...and ${warnings.length - MAX_WARNING_LINES} more.`)
  return `\nWarnings (relaxed song, the cells were written anyway):\n${shown.join('\n')}`
}

function issueLine(i: Issue): string {
  const where = [i.channel ?? '', i.pattern !== undefined ? `pattern ${i.pattern}` : '', i.row !== undefined ? `row ${i.row}` : ''].filter(Boolean).join(' ')
  return where ? `${where}: ${i.message}` : i.message
}

/**
 * Check the cells of a diff list against the song's chip. Errors (strict chip rules, bad instrument/volume/effect)
 * throw with the fix; warnings (relaxed chip rules) are returned.
 */
export function checkDiffs(song: Song, diffs: CellDiff[]): string[] {
  const profile = getChipProfile(song.chip)
  const cells = diffs
    .filter((d) => d.cell)
    .map((d) => ({ channel: requireChannel(song, d.channel).id, cell: d.cell, pattern: d.pattern, row: d.row }))
  const issues = validateCellsFor(profile, song, cells)
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    const lines = dedupe(errors.map(issueLine))
    const hint = song.authenticity === 'strict' ? ' (the song is strict; set_song_info {authenticity:"relaxed"} turns chip-rule errors into warnings)' : ''
    throw new Error(formatProblemList(`Chip rules for ${profile.label} violated${hint}`, lines))
  }
  return dedupe(issues.filter((i) => i.severity === 'warning').map(issueLine))
}

/** Validate, then write the diffs as ONE cells command. */
export function applyDiffs(session: SongSession, diffs: CellDiff[], label: string): WriteReport {
  const song = session.song
  const warnings = checkDiffs(song, diffs)
  const changed = countChangedCells(song, diffs)
  if (changed > 0) session.execute(createCellsCommand(song, diffs, label))
  return { written: diffs.filter((d) => d.cell).length, changed, warnings }
}

/**
 * Add an instrument to the song; when it came from a sample preset (SNES samples, Genesis DAC, NES DPCM) the
 * recipe sample slot it plays is added first if the song does not have it yet. Returns the new instrument index
 * and the id of the added slot (if any). Both commands join the caller's transaction (one undo step).
 */
export function addInstrumentWithSample(session: SongSession, inst: Instrument, presetSlot?: SampleSlot): { index: number; sampleAdded?: string } {
  const song = session.song
  const slot = presetSlot ?? missingPresetSample(song, inst)
  if (slot) session.execute(createSampleCommand(song, { op: 'add', sample: slot }))
  const cmd = createInstrumentCommand(song, { op: 'add', instrument: inst })
  session.execute(cmd)
  return { index: cmd.createdIndex, ...(slot ? { sampleAdded: slot.id } : {}) }
}

/** Diffs that clear every row of a pattern (only rows that hold something). */
export function clearDiffs(song: Song, channelId: string, pattern: number, fromRow = 0, toRow = song.patternLength): CellDiff[] {
  const pat = song.patterns.get(`${channelId}:${pattern}`)
  if (!pat) return []
  const out: CellDiff[] = []
  for (let r = Math.max(0, fromRow); r < Math.min(toRow, pat.rows.length); r++) {
    if (pat.rows[r]) out.push({ channel: channelId, pattern, row: r, cell: null })
  }
  return out
}
