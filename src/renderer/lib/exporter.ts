// Export planning: turns a rendered song + dialog settings into files (name + bytes). Pure, no IO.

import { type Song, buildTimeline, quantizeStereo, serializeProject, writeWav } from '../../core'
import type { AudioRenderOptions, AudioRenderResult } from '../../tools/services'

export interface ExportSettings {
  /** File name without extension. */
  baseName: string
  /** Optional output folder (relative to ~/ChiptuneStudio/exports, or absolute). */
  dir: string
  sampleRate: 44100 | 48000
  /** Times the loop body is present (looping songs without a fade). */
  loops: number
  /** Fade-out seconds; > 0 renders intro + loops bodies + fade and writes no loop points. */
  fadeOutSec: number
  /** Also write one WAV per channel. */
  stems: boolean
}

export const DEFAULT_EXPORT: ExportSettings = { baseName: '', dir: '', sampleRate: 44100, loops: 1, fadeOutSec: 0, stems: false }

export interface ExportFile {
  name: string
  data: Uint8Array | string
}

/** A safe file base name (no path separators or reserved characters). */
export function sanitizeBaseName(name: string, fallback = 'song'): string {
  const s = name
    .trim()
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/^\.+/, '')
  return s || fallback
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(min, Math.min(max, Math.floor(v))) : fallback
}

export function renderOptionsFor(s: ExportSettings): AudioRenderOptions {
  return {
    sampleRate: s.sampleRate === 48000 ? 48000 : 44100,
    loops: clampInt(s.loops, 1, 16, 1),
    fadeOutSec: Number.isFinite(s.fadeOutSec) ? Math.max(0, Math.min(60, s.fadeOutSec)) : 0,
    stems: s.stems
  }
}

export interface ExportEstimate {
  looping: boolean
  /** Rendered length in seconds. */
  seconds: number
  /** Number of files the export writes. */
  files: number
  /** Whether the WAV carries `smpl` loop points. */
  loopPoints: boolean
}

/** Ids of the shared effect-bus stems a stems export adds: SNES echo, PS1 reverb, Dreamcast DSP. */
export function auxStemIds(song: Song): string[] {
  switch (song.chip) {
    case 'snes':
      return ['_echo']
    case 'ps1':
      return ['_reverb']
    case 'dreamcast':
      return ['_dsp']
    default:
      return []
  }
}

/** What an export would produce, without rendering (shown in the dialog). */
export function estimateExport(song: Song, s: ExportSettings): ExportEstimate {
  const o = renderOptionsFor(s)
  const tl = buildTimeline(song)
  const files = 1 + (s.stems ? song.channels.length + auxStemIds(song).length : 0)
  if (!tl.isLooping) return { looping: false, seconds: tl.introSeconds + 0.5, files, loopPoints: false }
  if ((o.fadeOutSec ?? 0) > 0) return { looping: true, seconds: tl.introSeconds + (o.loops ?? 1) * tl.loopSeconds + (o.fadeOutSec ?? 0), files, loopPoints: false }
  return { looping: true, seconds: tl.introSeconds + (o.loops ?? 1) * tl.loopSeconds, files, loopPoints: true }
}

/** Build the WAV files (master + optional stems) from a render result. */
export function planWavExport(song: Song, s: ExportSettings, r: AudioRenderResult): ExportFile[] {
  const base = sanitizeBaseName(s.baseName || song.name)
  const loop = r.loopStart !== null && r.loopEnd !== null ? { start: r.loopStart, end: r.loopEnd } : undefined
  const pack = (L: Float32Array, R: Float32Array): Uint8Array => {
    const q = quantizeStereo(L, R)
    return writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R], loop, title: song.name, software: 'Chiptune Studio' })
  }
  const files: ExportFile[] = [{ name: `${base}.wav`, data: pack(r.L, r.R) }]
  if (s.stems && r.stems) {
    for (const [id, stem] of Object.entries(r.stems)) files.push({ name: `${base}${id.startsWith('_') ? '' : '_'}${sanitizeBaseName(id, 'ch')}.wav`, data: pack(stem.L, stem.R) })
  }
  return files
}

/** The .ctune file for a song. */
export function planProject(song: Song, baseName: string): ExportFile {
  const base = sanitizeBaseName(baseName || song.name)
  return { name: base.toLowerCase().endsWith('.ctune') ? base : `${base}.ctune`, data: serializeProject(song) }
}
