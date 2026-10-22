// Tools for driving Chiptune Studio from another app (VN Studio): compose a whole loop in one call, render it to ogg,
// and keep several songs per session. Every result ends with one JSON text item (see docs/llm-guide.md).

import { z } from 'zod'
import { parseProject, serializeProject } from '../../core'
import { exportWithSidecar, renderSongToFile } from '../audioExport'
import { composeSong } from '../composer'
import { SFX_SOUNDS, composeSfx } from '../sfx'
import { defineTool } from '../registry'
import type { ExportTarget } from '../session'
import { activateSong, deleteSong, listSongs, resolveSong } from '../songStore'
import { baseName, obj, okJson, safeFileName, songSession, withExtension } from '../util'

const SONG_DESC = 'Song id from compose_track / list_songs. Default: the open song.'

function exportFormatOf(path: string, given?: 'ogg' | 'wav' | 'mp3'): ExportTarget['format'] {
  if (given) return given
  return /\.wav$/i.test(path) ? 'wav' : /\.mp3$/i.test(path) ? 'mp3' : 'ogg'
}

export const studioTools = [
  defineTool({
    name: 'compose_track',
    group: 'song',
    description:
      'Compose a whole track in one call and open it as the current song (the song that was open is kept: list_songs, open_song). A procedural composer (chord progression, bass, pads, melody, optional drums) built on the mood recipes, so you get a finished loop to render with render_audio, or to refine with write_pattern / write_melody. Deterministic: the same seed and arguments give the same song. Calm moods ("ambient", "lullaby", "peaceful", "mysterious-calm") use soft presets, slow tempo and no or very sparse drums. With loop true (default) the loop covers the whole song and ends exactly at the song end. With intro 1..4 a quiet intro (pads and bass on the tonic, no lead, no drums) plays once before the loop: bars / seconds are the loop body, the loop starts after the intro, and render_audio reports that as loopStartSec. With motif (the write_melody text format, at most 4 bars, e.g. "E5:4 G5:2 A5:2 B5:8") that leitmotif is the lead line of every even 4-bar phrase, transposed from motifKey to the track key and fitted to the scale; later repeats are lightly developed, the other phrases stay generated. With variation 1..99 you get a different arrangement of the same track (same seed and arguments): same key, scale, tempo, chords, instruments and motif, but other lead rhythms and notes, bass pattern, pad voicing and drum fills; 0 (default) is the original, so one theme can serve several scenes. Returns songId, chip, bpm, key, scale, bars, introBars, variation, motif ({bars, transposeSemis, placedAtBars} or null), seed, durationSec and loop as JSON. Example: {"mood":"ambient","chip":"snes","seed":1}.',
    input: obj({
      mood: z.string().min(1).describe('Mood id or alias (get_mood_recipe lists them): ambient, lullaby, peaceful, mysterious-calm, chill, heroic, ...'),
      chip: z.string().optional().describe('Chip: nes, gb, genesis, snes, pce. Default depends on the mood (SNES for calm moods, NES otherwise).'),
      bpm: z.number().min(20).max(400).optional().describe('Tempo. Default: a seeded pick inside the mood recipe\'s range (60-90 for calm moods).'),
      key: z.string().min(1).optional().describe('Key tonic, e.g. "C", "F#", "Bb". Default: a seeded pick from the mood recipe.'),
      scale: z.string().min(1).optional().describe('Scale id (list_chips / get_mood_recipe), e.g. "major", "dorian", "lydian". Default: a seeded pick from the mood recipe.'),
      bars: z.number().int().min(1).max(128).optional().describe('Length in bars (default 16). 4/4: a bar is 4 beats.'),
      seconds: z.number().min(2).max(900).optional().describe('Approximate length in seconds; overrides bars and is rounded to whole bars.'),
      intro: z.number().int().min(0).max(4).optional().describe('Intro bars (0..4, default 0) played once before the loop: quiet pads and bass, no lead, no drums. Not part of bars / seconds.'),
      motif: z.string().min(1).optional().describe('A leitmotif in the write_melody text format: note names, :N lengths in rows (16 rows = 1 bar), r rests, ~ ties; at most 4 bars. No @instrument, vNN, chords or effects. Example: "E5:4 G5:2 A5:2 B5:8". It becomes the lead line of every even 4-bar phrase (from the first loop bar), fitted to the track key and scale.'),
      motifKey: z.string().min(1).optional().describe('The key the motif is written in (default "C"). It is transposed to the track key; out-of-scale notes move to the nearest scale note.'),
      variation: z.number().int().min(0).max(99).optional().describe('A different arrangement of the same track: same key, chords, tempo, instruments and motif, other lead, bass, pads and drum fills. 0 (default) = the original track for the seed.'),
      loop: z.boolean().optional().describe('Loop the whole song (default true). false = a one-shot piece.'),
      seed: z.number().int().min(0).max(4294967295).optional().describe('Random seed (default: random; the used seed is returned). Same seed + same arguments = same song.'),
      instruments: z.record(z.string(), z.string()).optional().describe('Channel id -> preset id or role, e.g. {"V4":"snes.flute.soft"}. Default: soft presets for calm moods, role presets otherwise.'),
      name: z.string().min(1).optional().describe('Song name (default "<Mood> (<CHIP>)").')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31)
      const r = composeSong({ ...args, seed })
      activateSong(session, r.song, null, `Compose ${r.mood}`)
      const text = [
        `Composed "${r.song.name}": ${r.chip.toUpperCase()}, ${r.bpm} BPM, ${r.key} ${r.scale}, mood ${r.mood}, ${r.bars} bars${r.introBars ? ` + ${r.introBars} intro` : ''} = ${r.durationSec.toFixed(1)} s, seed ${seed}${r.variation ? `, variation ${r.variation}` : ''}.`,
        `Chords (progression ${r.progression}, ${r.chords.length} chord slots): ${r.chords.join(' ')}.`,
        `Parts: ${r.parts.join('; ')}.`,
        r.motif ? `Motif (${r.motif.bars} bar${r.motif.bars === 1 ? '' : 's'}, transposed ${r.motif.transposeSemis} semitones) plays at loop bars ${r.motif.placedAtBars.join(', ')}; the other phrases are generated.` : '',
        r.loop
          ? `Loops over bars ${r.loop.startBar}..${r.loop.endBar}; the loop ends exactly at the song end.${r.introBars ? ` The ${r.introBars}-bar intro plays once: render_audio's loopStartSec is the intro end.` : ''}`
          : 'No loop: the song plays once.',
        'Next: render_audio {"path":"<absolute path>.ogg"} to get the file, or refine with write_pattern / write_melody / write_drums.'
      ].filter(Boolean).join('\n')
      return okJson(text, {
        songId: r.song.id,
        name: r.song.name,
        chip: r.chip,
        bpm: r.bpm,
        key: r.key,
        scale: r.scale,
        mood: r.mood,
        bars: r.bars,
        introBars: r.introBars,
        variation: r.variation,
        motif: r.motif,
        seed,
        durationSec: r.durationSec,
        loop: r.loop,
        channels: r.channels
      })
    }
  }),

  defineTool({
    name: 'compose_sfx',
    group: 'song',
    description:
      `Make a sound effect, a stinger or an ambience loop in one call and open it as the current song (the song that was open is kept: list_songs, open_song). Chiptune sounds from the chip's own presets, deterministic per seed. kind "sfx" (one-shot, under 2 s): ${SFX_SOUNDS.sfx.join(', ')}. kind "stinger" (1-2 bars in a key, ends on a held chord, one-shot): ${SFX_SOUNDS.stinger.join(', ')}. kind "ambience" (loops over the whole song, seamless): ${SFX_SOUNDS.ambience.join(', ')}. With path the audio is rendered in the same call (ogg / wav / mp3) and the file info is returned too; a looping ambience file ends at the loop end (loopStartSec 0). Default chip: nes for sfx, snes for stingers and ambience. Returns songId, kind, sound, chip, bpm, seed, durationSec and loop as JSON (plus the render fields with path). Examples: {"kind":"sfx","sound":"coin","path":"C:\\sfx\\coin.ogg"}, {"kind":"ambience","sound":"rain","seconds":30}.`,
    input: obj({
      kind: z.enum(['sfx', 'stinger', 'ambience']).describe('sfx (one-shot effect), stinger (short musical sting) or ambience (seamless loop).'),
      sound: z.string().min(1).describe('The sound of that kind (see the description); an unknown name lists the valid ones.'),
      chip: z.string().optional().describe('Chip: nes, gb, genesis, snes, pce. Default: nes for sfx, snes for stingers and ambience.'),
      key: z.string().min(1).optional().describe('Tonic of stingers and of the drone of an ambience, e.g. "C", "F#" (default C).'),
      seconds: z.number().min(4).max(120).optional().describe('Ambience length (default 16), rounded to whole 2 s bars. Ignored for sfx and stingers.'),
      pitch: z.number().int().min(-12).max(12).optional().describe('Semitones added to the pitched notes of sfx and stingers (default 0).'),
      seed: z.number().int().min(0).max(4294967295).optional().describe('Random seed (default: random; the used seed is returned). Moves a one-shot by up to a semitone and shapes the random parts of ambience.'),
      songName: z.string().min(1).optional().describe('Song name (default "<sound> (<kind>, <CHIP>)").'),
      path: z.string().min(1).optional().describe('Also render to this file: an absolute path or a file name (goes to ~/ChiptuneStudio/exports). The extension is set from the format.'),
      format: z.enum(['ogg', 'wav', 'mp3']).optional().describe('Audio format with path (default ogg).')
    }),
    handler: async (args, ctx) => {
      const session = songSession(ctx)
      const seed = args.seed ?? Math.floor(Math.random() * 2 ** 31)
      const r = composeSfx({ kind: args.kind, sound: args.sound, chip: args.chip, key: args.key, seconds: args.seconds, pitch: args.pitch, seed, songName: args.songName })
      activateSong(session, r.song, null, `Compose ${r.kind} ${r.sound}`)
      const rendered = args.path ? await renderSongToFile(r.song, ctx.services, { path: args.path, format: args.format }) : null
      const text = [
        `Made ${r.kind} "${r.sound}" ("${r.song.name}"): ${r.chip.toUpperCase()}, ${r.durationSec.toFixed(2)} s, seed ${seed}.`,
        r.loop ? `Loops over the whole song (bars ${r.loop.startBar}..${r.loop.endBar}); the loop ends exactly at the song end.` : 'One-shot: no loop.',
        rendered ? `Rendered to ${baseName(rendered.path)} (${rendered.format}, ${rendered.durationSec.toFixed(2)} s).` : 'Next: render_audio {"path":"<absolute path>.ogg"} to get the file.',
        ...(rendered?.warning ? [`Warning: ${rendered.warning}`] : []),
        ...(rendered ? [rendered.path] : [])
      ].join('\n')
      return okJson(text, { songId: r.song.id, name: r.song.name, kind: r.kind, sound: r.sound, chip: r.chip, bpm: r.bpm, seed, durationSec: r.durationSec, loop: r.loop, ...(rendered ? { ...rendered } : {}) })
    }
  }),

  defineTool({
    name: 'render_audio',
    group: 'export',
    readOnly: true,
    description:
      'Render a song to ONE audio file: ogg (default, ffmpeg libvorbis), mp3 (libmp3lame) or wav. ffmpeg is taken from FFMPEG_PATH or PATH; without it a WAV is written next to the path and a warning says so. A looping song (without fadeOutSec) is rendered intro + loop body x loops and the file ends exactly at the loop end, so a player loops from loopStartSec to the end of the file without a seam (Ren\'Py: "<loop S>file.ogg"). Returns the written path, format, durationSec and loop points (seconds and samples) as JSON. Example: {"path":"C:\\\\music\\\\theme.ogg"}.',
    input: obj({
      path: z.string().min(1).describe('Output file. An absolute path is used as is (parent folders are created); a file name goes to ~/ChiptuneStudio/exports. The extension is set from the format.'),
      song: z.string().min(1).optional().describe(SONG_DESC),
      format: z.enum(['ogg', 'wav', 'mp3']).optional().describe('ogg (default), wav or mp3.'),
      loops: z.number().int().min(1).max(8).optional().describe('Times the loop body is present after the intro (1..8, default 1).'),
      fadeOutSec: z.number().min(0).max(30).optional().describe('Fade-out seconds after the loops; makes the file non-looping (no loop points).'),
      sampleRate: z.union([z.literal(44100), z.literal(48000)]).optional().describe('44100 (default) or 48000.')
    }),
    handler: async (args, ctx) => {
      const { song } = resolveSong(songSession(ctx), args.song)
      const r = await renderSongToFile(song, ctx.services, args)
      const text = [
        `Rendered "${song.name}" to ${baseName(r.path)} (${r.format}, ${r.sampleRate} Hz, ${r.durationSec.toFixed(2)} s).`,
        r.loopStartSec !== null && r.loopEndSec !== null
          ? `Loop: start ${r.loopStartSec.toFixed(3)} s (sample ${r.loopStartSample}), end ${r.loopEndSec.toFixed(3)} s = end of file.`
          : 'No loop points (the song does not loop, or fadeOutSec was set).',
        ...(r.warning ? [`Warning: ${r.warning}`] : []),
        r.path
      ].join('\n')
      return okJson(text, { ...r })
    }
  }),

  defineTool({
    name: 'save_song',
    group: 'song',
    readOnly: true,
    description:
      'Save a song as a native .ctune project file (lossless), so open_song can load it again. An absolute path is used as is; a bare name goes to ~/ChiptuneStudio/projects. When the open song has an export target (open_song with exportTo) the looping audio is exported there too. Returns songId and path as JSON.',
    input: obj({
      path: z.string().min(1).describe('Absolute path of the .ctune file, or a project name. ".ctune" is added if missing.'),
      song: z.string().min(1).optional().describe(SONG_DESC)
    }),
    handler: async (args, ctx) => {
      const session = songSession(ctx)
      const { song, current } = resolveSong(session, args.song)
      const full = await ctx.services.resolveProjectPath(withExtension(args.path, 'ctune'))
      await ctx.services.writeFile(full, serializeProject(song))
      session.songPaths.set(song.id, full)
      if (!current) {
        const h = session.held.get(song.id)
        if (h) h.path = full
      } else await ctx.services.studio?.songSaved(full)
      let exported = ''
      if (current && session.exportTarget) {
        const t = session.exportTarget
        const r = await exportWithSidecar(song, ctx.services, { path: t.path, format: t.format })
        exported = ` Exported the audio to ${r.path} (loop points in ${r.path}.json).`
      }
      return okJson(`Saved "${song.name}" to ${full}.${exported}`, { songId: song.id, path: full })
    }
  }),

  defineTool({
    name: 'list_songs',
    group: 'song',
    readOnly: true,
    description: 'List the songs held in this session (the open song and the ones compose_track / open_song replaced): id, name, file path (null when never saved), chip, bpm, and which one is current. Returns {"songs":[...]} as JSON.',
    input: obj({}),
    handler: (_args, ctx) => {
      const songs = listSongs(songSession(ctx))
      const text = songs.map((s) => `${s.current ? '*' : ' '} ${s.songId}  "${s.name}"  ${s.chip.toUpperCase()} ${s.bpm} BPM  ${s.path ?? '(not saved)'}`).join('\n')
      return okJson(`${songs.length} song(s); * = current.\n${text}`, { songs })
    }
  }),

  defineTool({
    name: 'open_song',
    group: 'song',
    description:
      'Load a native .ctune song file and make it the current song (the song that was open is kept: list_songs). In the app window it also brings the window to front. With exportTo, the looping audio is exported to that file every time the song is saved (save_song or Ctrl+S): exportFormat ogg (default; from the extension), wav or mp3. Returns songId, name and path as JSON.',
    input: obj({
      path: z.string().min(1).describe('Absolute path of the .ctune file, or a project name from ~/ChiptuneStudio/projects.'),
      exportTo: z.string().min(1).optional().describe('Absolute path the audio is exported to on every save.'),
      exportFormat: z.enum(['ogg', 'wav', 'mp3']).optional().describe('Format of the export (default: from the exportTo extension, else ogg).')
    }),
    handler: async (args, ctx) => {
      const session = songSession(ctx)
      const full = await ctx.services.resolveProjectPath(withExtension(args.path, 'ctune'))
      const song = parseProject(new TextDecoder().decode(await ctx.services.readFile(full)))
      activateSong(session, song, full, `Open ${song.name}`)
      session.exportTarget = args.exportTo ? { path: args.exportTo, format: exportFormatOf(args.exportTo, args.exportFormat) } : null
      await ctx.services.studio?.songOpened({ path: full, name: song.name })
      return okJson(`Opened "${song.name}" from ${full}.${session.exportTarget ? ` Saving exports ${session.exportTarget.format} to ${session.exportTarget.path}.` : ''}`, {
        songId: song.id,
        name: song.name,
        path: full
      })
    }
  }),

  defineTool({
    name: 'delete_song',
    group: 'song',
    description: 'Remove a song from the session (never deletes files). Deleting the open song makes the most recent other song current, or an empty song if there is none. Returns {"deleted":true} as JSON.',
    input: obj({ song: z.string().min(1).describe('Song id from list_songs.') }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const name = listSongs(session).find((s) => s.songId === args.song)?.name ?? safeFileName(args.song)
      deleteSong(session, args.song)
      return okJson(`Removed "${name}" from the session. Files on disk are untouched.`, { deleted: true })
    }
  })
]
