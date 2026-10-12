import { z } from 'zod'
import { buildNoteTimeline, quantizeStereo, writeWav } from '../../core'
import { defineTool } from '../registry'
import { baseName, chipIsPlayable, chipNotReadyNote, obj, ok, plural, safeFileName, songSession, withExtension } from '../util'

const PATH_DESC =
  'Output path. A file name is placed in ~/ChiptuneStudio/exports; an absolute path is used as is. ".wav" is added if missing. Default: the song name.'

function peakRms(L: Int16Array, R: Int16Array): { peakDb: number; rmsDb: number } {
  let peak = 0
  let sum = 0
  for (let i = 0; i < L.length; i++) {
    const a = Math.abs(L[i]!)
    const b = Math.abs(R[i]!)
    if (a > peak) peak = a
    if (b > peak) peak = b
    sum += L[i]! * L[i]! + R[i]! * R[i]!
  }
  const rms = Math.sqrt(sum / Math.max(1, L.length * 2))
  const db = (v: number): number => (v <= 0 ? -Infinity : 20 * Math.log10(v / 32768))
  return { peakDb: db(peak), rmsDb: db(rms) }
}

const fmtDb = (v: number): string => (Number.isFinite(v) ? `${v.toFixed(1)} dBFS` : 'silent')

export const exportTools = [
  defineTool({
    name: 'export_wav',
    group: 'export',
    readOnly: true,
    description:
      'Render the song to a stereo 16-bit WAV. A looping song (see set_loop) is rendered intro + loop body and the file carries the loop points in a "smpl" chunk (read by Godot, FMOD, Wwise), so it loops seamlessly; "loops" adds extra repetitions of the body. fadeOutSec instead fades the song out after the loops (no loop points). stems:true also writes one WAV per channel next to it, named <name>_<channelId>.wav (e.g. song_P1.wav; channels without notes are skipped); SNES songs also get <name>_echo.wav, the echo bus on its own. Returns the written paths, duration and loop points. Example: {"path":"overworld","loops":2,"stems":true}.',
    input: obj({
      path: z.string().min(1).optional().describe(PATH_DESC),
      loops: z.number().int().min(1).max(8).optional().describe('Times the loop body is present after the intro (default 1).'),
      fadeOutSec: z.number().min(0).max(30).optional().describe('Fade-out length in seconds; makes the export non-looping.'),
      stems: z.boolean().optional().describe('Also write one WAV per channel with notes.'),
      sampleRate: z.union([z.literal(44100), z.literal(48000)]).optional().describe('44100 (default) or 48000.')
    }),
    handler: async (args, ctx) => {
      const song = songSession(ctx).song
      const tl = buildNoteTimeline(song)
      if (tl.events.length === 0) throw new Error('The song has no notes, so the WAV would be silent. Write music first (write_pattern / write_melody / write_drums).')
      if (!chipIsPlayable(song.chip)) throw new Error(chipNotReadyNote(song.chip))
      const r = await ctx.services.audio.render(song, { sampleRate: args.sampleRate, loops: args.loops, fadeOutSec: args.fadeOutSec, stems: args.stems })
      const loop = r.loopStart !== null && r.loopEnd !== null ? { start: r.loopStart, end: r.loopEnd } : undefined
      const q = quantizeStereo(r.L, r.R)
      const name = withExtension(args.path ?? safeFileName(song.name), 'wav')
      const full = await ctx.services.resolveExportPath(name)
      const wav = writeWav({ sampleRate: r.sampleRate, channels: [q.L, q.R], loop, title: song.name, software: 'Chiptune Studio' })
      await ctx.services.writeFile(full, wav)
      const written = [full]
      if (args.stems && r.stems) {
        const used = new Set(tl.events.map((e) => e.channel))
        const stem = full.replace(/\.wav$/i, '')
        for (const [id, s] of Object.entries(r.stems)) {
          if (!used.has(id) && !id.startsWith('_')) continue // channel stems only for channels with notes; shared buses (_echo) always
          const sq = quantizeStereo(s.L, s.R)
          const p = `${stem}${id.startsWith('_') ? id : `_${id}`}.wav`
          await ctx.services.writeFile(p, writeWav({ sampleRate: r.sampleRate, channels: [sq.L, sq.R], loop, title: `${song.name} (${id})`, software: 'Chiptune Studio' }))
          written.push(p)
        }
      }
      const sr = r.sampleRate
      const level = peakRms(q.L, q.R)
      const lines = [
        `Exported ${baseName(full)}: ${(r.L.length / sr).toFixed(2)} s, ${sr} Hz stereo 16-bit, peak ${fmtDb(level.peakDb)}, RMS ${fmtDb(level.rmsDb)}.`,
        loop
          ? `Loop points (smpl chunk): start ${loop.start} (${(loop.start / sr).toFixed(3)} s), end ${loop.end} (${(loop.end / sr).toFixed(3)} s), ${((loop.end - loop.start) / sr).toFixed(2)} s long.`
          : args.fadeOutSec
            ? 'Faded out: no loop points.'
            : 'No loop points (the song does not loop).',
        `Files (${plural(written.length, 'file')}):`,
        ...written
      ]
      if (!Number.isFinite(level.peakDb)) lines.push('Warning: the render is silent. Check that the notes have instruments and the channels are not muted (get_song).')
      return ok(lines.join('\n'))
    }
  })
]
