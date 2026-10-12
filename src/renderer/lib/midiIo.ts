// MIDI export / import / chip conversion for the dialogs. Pure helpers around the core codecs (no DOM, no IO):
// the dialogs read the picked file into bytes and pass them here.

import {
  type ChipConfig,
  type ChipId,
  type Song,
  CHIP_IDS,
  convertChip,
  defaultChipConfig,
  exportMidi,
  importMidi,
  listChips
} from '../../core'
import type { ArpMode, MidiExport } from '../../core'
import { type ExportFile, sanitizeBaseName } from './exporter'

// ---------------------------------------------------------------- export

export interface MidiExportSettings {
  arpMode: ArpMode
  /** Times the loop body is present (looping songs). */
  loops: number
}

export const DEFAULT_MIDI_EXPORT: MidiExportSettings = { arpMode: 'notes', loops: 1 }

export const ARP_MODES: { id: ArpMode; label: string }[] = [
  { id: 'notes', label: 'Fast notes (as the chip plays them)' },
  { id: 'chord', label: 'Chords (tones sound together)' },
  { id: 'ignore', label: 'Ignore (base note only)' }
]

function clampLoops(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.min(8, Math.floor(n))) : 1
}

export function midiOptionsFor(s: MidiExportSettings): { arpMode: ArpMode; loops: number } {
  return { arpMode: s.arpMode, loops: clampLoops(s.loops) }
}

export interface MidiPlan {
  file: ExportFile
  info: MidiExport
}

/** The .mid file for a song and the numbers shown in the dialog. */
export function planMidiExport(song: Song, baseName: string, s: MidiExportSettings): MidiPlan {
  const info = exportMidi(song, midiOptionsFor(s))
  const base = sanitizeBaseName(baseName || song.name)
  const name = /\.midi?$/i.test(base) ? base : `${base}.mid`
  return { file: { name, data: info.data }, info }
}

export function describeMidiExport(info: MidiExport): string {
  const loop = info.loop ? `loop markers at tick ${info.loop.startTick}..${info.loop.endTick}` : 'no loop markers'
  const tempo = info.tempoChanges > 0 ? `, ${info.tempoChanges} tempo change${info.tempoChanges === 1 ? '' : 's'}` : ''
  return `${info.tracks} tracks, ${info.notes} notes, ${info.seconds.toFixed(1)} s, ${loop}${tempo}`
}

// ---------------------------------------------------------------- import

export interface ImportSettings {
  chip: ChipId
  /** 0 = pick the best grid. */
  rowsPerBeat: number
  /** 0 = automatic. */
  patternLength: number
  /** 0 = every part that fits. */
  maxChannels: number
  foldChords: boolean
  name: string
  /** Chip options, e.g. NES DPCM channel, Genesis DAC. */
  dpcm: boolean
  fm6Dac: boolean
}

export const GRID_CHOICES = [2, 3, 4, 6, 8]
export const PATTERN_LENGTH_CHOICES = [16, 32, 48, 64, 96, 128]

export function defaultImportSettings(chip: ChipId, name = ''): ImportSettings {
  return { chip, rowsPerBeat: 0, patternLength: 0, maxChannels: 0, foldChords: true, name, dpcm: false, fm6Dac: false }
}

export function chipConfigFor(chip: ChipId, s: { dpcm: boolean; fm6Dac: boolean }): Partial<ChipConfig> {
  if (chip === 'nes' && s.dpcm) return { chip: 'nes', dpcm: true }
  if (chip === 'genesis' && s.fm6Dac) return { chip: 'genesis', fm6Dac: true }
  return {}
}

export type ImportOutcome = { ok: true; song: Song; report: string[] } | { ok: false; error: string }

/** Run the importer and turn a thrown error into a message for the dialog. */
export function runImport(bytes: Uint8Array, s: ImportSettings, authenticity: 'strict' | 'relaxed' = 'strict'): ImportOutcome {
  try {
    const r = importMidi(bytes, {
      chip: s.chip,
      chipConfig: chipConfigFor(s.chip, s),
      rowsPerBeat: s.rowsPerBeat || undefined,
      patternLength: s.patternLength || undefined,
      maxChannels: s.maxChannels || undefined,
      foldChords: s.foldChords,
      name: s.name.trim() || undefined,
      authenticity
    })
    return { ok: true, song: r.song, report: r.report }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Name of a picked file without its extension (a default song name). */
export function songNameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName
  return base.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim()
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  return new Uint8Array(await file.arrayBuffer())
}

// ---------------------------------------------------------------- convert

export interface ConvertSettings {
  chip: ChipId
  dpcm: boolean
  fm6Dac: boolean
}

export interface ConvertChoice {
  id: ChipId
  label: string
  current: boolean
}

export function convertChoices(song: Song): ConvertChoice[] {
  const info = new Map(listChips().map((c) => [c.id, c]))
  return CHIP_IDS.map((id) => ({ id, label: `${info.get(id)?.name ?? id} (${info.get(id)?.era ?? ''})`, current: id === song.chip }))
}

/** The first chip that is not the song's own: the dialog's default target. */
export function defaultConvertTarget(song: Song): ChipId {
  return CHIP_IDS.find((c) => c !== song.chip) ?? 'nes'
}

export type ConvertOutcome = { ok: true; song: Song; report: string[]; noop: boolean } | { ok: false; error: string }

export function runConvert(song: Song, s: ConvertSettings): ConvertOutcome {
  try {
    const cfg = chipConfigFor(s.chip, s)
    const r = convertChip(song, s.chip, Object.keys(cfg).length > 0 ? { chipConfig: cfg } : {})
    return { ok: true, song: r.song, report: r.report, noop: r.report[0]?.includes('nothing to convert') ?? false }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Default chip config of a chip (used to show which options exist). */
export function chipOptionsFor(chip: ChipId): { dpcm: boolean; fm6Dac: boolean } {
  const cfg = defaultChipConfig(chip)
  return { dpcm: cfg.chip === 'nes', fm6Dac: cfg.chip === 'genesis' }
}

/** One-line summary of a report for the status bar. */
export function reportSummary(report: string[]): string {
  const dropped = report.filter((l) => /^Dropped/.test(l)).length
  return dropped > 0 ? `${report.length} report lines, ${dropped} drop notice${dropped === 1 ? '' : 's'}` : `${report.length} report lines`
}
