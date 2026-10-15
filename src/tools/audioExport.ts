// Render a song to one audio file (wav / ogg / mp3) for render_audio and for the "export on save" round trip.
// A looping song (without a fade) is rendered intro + loop body x loops and the file ends exactly at the loop end, so
// a player loops from loopStartSec to the end of the file without a seam (Ren'Py: `<loop S>`).
// No DOM, no Electron, no node:* (encoding goes through ToolServices.encodeAudio).

import { type Song, buildNoteTimeline, quantizeStereo, writeWav } from '../core'
import type { AudioFormat, ToolServices } from './services'
import { chipIsPlayable, chipNotReadyNote, withExtension } from './util'

export interface RenderAudioOptions {
  /** Absolute path, or a file name placed in ~/ChiptuneStudio/exports. The extension is set from the format. */
  path: string
  format?: AudioFormat
  /** Loop bodies after the intro (1..8, default 1). */
  loops?: number
  /** Fade-out seconds; makes the file non-looping. */
  fadeOutSec?: number
  sampleRate?: 44100 | 48000
}

export interface RenderAudioResult {
  /** The file actually written. */
  path: string
  format: AudioFormat
  sampleRate: number
  durationSec: number
  loopStartSec: number | null
  loopEndSec: number | null
  loopStartSample: number | null
  loopEndSample: number | null
  warning?: string
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6

export async function renderSongToFile(song: Song, services: ToolServices, opts: RenderAudioOptions): Promise<RenderAudioResult> {
  if (buildNoteTimeline(song).events.length === 0) throw new Error('The song has no notes, so the audio would be silent. Write music first (compose_track, write_pattern, write_melody, write_drums).')
  if (!chipIsPlayable(song.chip)) throw new Error(chipNotReadyNote(song.chip))
  const format: AudioFormat = opts.format ?? 'ogg'
  const fade = opts.fadeOutSec && opts.fadeOutSec > 0 ? opts.fadeOutSec : undefined
  const r = await services.audio.render(song, { sampleRate: opts.sampleRate, loops: opts.loops, fadeOutSec: fade })
  const sr = r.sampleRate
  const loop = r.loopStart !== null && r.loopEnd !== null ? { start: r.loopStart, end: r.loopEnd } : null
  const q = quantizeStereo(r.L, r.R)
  const wav = writeWav({ sampleRate: sr, channels: [q.L, q.R], loop: loop ?? undefined, title: song.name, software: 'Chiptune Studio' })

  const wanted = await services.resolveExportPath(withExtension(opts.path, format))
  let written = wanted
  let actual: AudioFormat = format
  let warning: string | undefined
  if (format === 'wav') {
    await services.writeFile(wanted, wav)
  } else if (services.encodeAudio) {
    const e = await services.encodeAudio(wav, wanted, format)
    written = e.path
    actual = e.format
    warning = e.warning
  } else {
    written = withExtension(wanted, 'wav')
    actual = 'wav'
    warning = `Cannot encode ${format} here (no encoder); wrote a WAV instead.`
    await services.writeFile(written, wav)
  }
  return {
    path: written,
    format: actual,
    sampleRate: sr,
    durationSec: round6(r.L.length / sr),
    loopStartSec: loop ? round6(loop.start / sr) : null,
    loopEndSec: loop ? round6(loop.end / sr) : null,
    loopStartSample: loop ? loop.start : null,
    loopEndSample: loop ? loop.end : null,
    ...(warning ? { warning } : {})
  }
}

/** Auto-export on save: the audio plus `<written file>.json` with the loop points (for apps that loop the file). */
export async function exportWithSidecar(song: Song, services: ToolServices, opts: RenderAudioOptions): Promise<RenderAudioResult> {
  const r = await renderSongToFile(song, services, opts)
  const sidecar = { loopStartSec: r.loopStartSec, loopEndSec: r.loopEndSec, durationSec: r.durationSec, sampleRate: r.sampleRate }
  await services.writeFile(`${r.path}.json`, JSON.stringify(sidecar, null, 2) + '\n')
  return r
}
