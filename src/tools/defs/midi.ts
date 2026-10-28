import { z } from 'zod'
import { CHIP_IDS, buildNoteTimeline, convertChip, exportMidi, importMidi, requireChipId } from '../../core'
import { defineTool } from '../registry'
import { baseName, obj, ok, plural, safeFileName, songSession, withExtension } from '../util'
import { describeSong } from './song'

const MAX_REPORT_LINES = 60

function reportText(lines: string[]): string {
  if (lines.length <= MAX_REPORT_LINES) return lines.join('\n')
  return [...lines.slice(0, MAX_REPORT_LINES), `...and ${lines.length - MAX_REPORT_LINES} more lines.`].join('\n')
}

function isAbsolute(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('/') || path.startsWith('\\\\')
}

const hasMidiExtension = (path: string): boolean => /\.midi?$/i.test(path)

export const midiTools = [
  defineTool({
    name: 'export_midi',
    group: 'export',
    readOnly: true,
    description:
      'Write the song as a Standard MIDI File (type 1, 480 PPQ) to ~/ChiptuneStudio/exports (a bare name gets ".mid"; an absolute path is used as is). The timing follows the song exactly (Bxx/Dxx/Fxx/groove become tempo changes); track 0 holds tempo, time and key signature, a marker per order row and, for a looping song, "loopStart"/"loopEnd" markers plus CC111 at the loop start. Every channel with notes is a track with its GM program (from the instrument role or gm hint); MIDI has 15 melodic channels, so a song with more melodic tracks (PS1 and Dreamcast with 24 to 64 voices) shares them by GM program (each program gets its own channel first, the rest are merged onto a channel with the same program, then onto the least-used one; merged tracks keep their notes but not their pitch bends and volume changes) and the reply lists the merges; noise, DPCM, DAC and drum-role instruments go to MIDI channel 10 as GM drum notes (36 kick, 38 snare, 42/46 hats, 49 crash, 45/48 toms, 39 clap). Slides, portamento, vibrato and note slides become pitch bend (range +-12); volume becomes velocity (+ CC11 for changes under a held note). arpMode: "notes" (default) writes 0xy arpeggios as the fast notes the chip plays, "chord" as sounding chords, "ignore" as the base note only. loops unrolls the loop body (default 1). Example: {"name":"overworld","arpMode":"chord"}.',
    input: obj({
      name: z.string().min(1).optional().describe('File name ("overworld" -> overworld.mid) or absolute path. Default: the song name.'),
      arpMode: z.enum(['notes', 'chord', 'ignore']).optional().describe('0xy arpeggios as fast notes (default), chords or the base note only.'),
      loops: z.number().int().min(1).max(8).optional().describe('Times the loop body is present after the intro (default 1).')
    }),
    handler: async (args, ctx) => {
      const song = songSession(ctx).song
      if (buildNoteTimeline(song).events.length === 0) throw new Error('The song has no notes, so the MIDI file would be empty. Write music first (write_pattern / write_melody / write_drums).')
      const r = exportMidi(song, { arpMode: args.arpMode, loops: args.loops })
      const full = await ctx.services.resolveExportPath(withExtension(args.name ?? safeFileName(song.name), 'mid'))
      await ctx.services.writeFile(full, r.data)
      const lines = [
        `Exported ${baseName(full)}: ${plural(r.tracks, 'track')} (${r.trackNames.join(', ')}), ${plural(r.notes, 'note')}, ${r.seconds.toFixed(1)} s at ${song.timing.bpm} BPM, ${r.data.length} bytes.`,
        r.loop
          ? `Loop: "loopStart" and CC111 at tick ${r.loop.startTick}, "loopEnd" at tick ${r.loop.endTick} (480 ticks per quarter note).`
          : 'No loop markers (the song does not loop).',
        r.tempoChanges > 0 ? `${plural(r.tempoChanges, 'tempo change')} from Fxx effects.` : 'Constant tempo.',
        `Arpeggios (0xy): ${args.arpMode ?? 'notes'}.`,
        ...(r.merged
          ? [
              `MIDI has 15 melodic channels: ${plural(r.merged.length, 'track')} share a channel with an earlier track (same GM program first, else the least-used channel); they keep their notes but not pitch bends or volume changes: ${r.merged
                .slice(0, 12)
                .map((m) => `${m.track} -> ${m.into} (ch ${m.midiChannel}${m.sameProgram ? '' : ', other program'})`)
                .join(', ')}${r.merged.length > 12 ? `, ... ${r.merged.length - 12} more` : ''}.`
            ]
          : []),
        `File: ${full}`
      ]
      return ok(lines.join('\n'))
    }
  }),

  defineTool({
    name: 'import_midi',
    group: 'export',
    description:
      'Replace the open song with a Standard MIDI File converted to a chip (one undo step). path: an absolute path, or a file name looked up in ~/ChiptuneStudio/exports and then ~/ChiptuneStudio/projects (".mid" is added). Notes are quantized to a grid (rowsPerBeat 2/3/4/6/8, picked by least error unless you force it), channel 10 becomes drums on the chip\'s noise/drum channel(s) by GM drum note, melodic tracks are ranked (note count + pitch) into bass (TR/WV/F1/V1/C1), lead and harmony channels (PS1 and Dreamcast have 16 to 64 voices, so they keep more tracks), each reduced to one voice (top voice; up to 2 extra chord tones become a 0xy arpeggio), moved by octaves into the channel\'s range, cut into patterns with duplicates removed. Tempo changes become Fxx, loopStart/CC111 sets the loop. chip defaults to the open song\'s chip. Returns a report of every assignment and everything dropped; read it, then fix up with the normal editing tools. Example: {"path":"boss.mid","chip":"genesis","maxChannels":6}.',
    input: obj({
      path: z.string().min(1).describe('MIDI file: absolute path, or a name in the exports/projects folder.'),
      chip: z.string().min(1).optional().describe(`Target chip: ${CHIP_IDS.join(', ')}. Default: the open song's chip.`),
      rowsPerBeat: z.number().int().min(1).max(16).optional().describe('Force the grid (2, 3, 4, 6 or 8 are typical). Default: chosen by least timing error.'),
      patternLength: z.number().int().min(1).max(256).optional().describe('Rows per pattern. Default: about 64, a whole number of bars (and the loop start on an order boundary).'),
      maxChannels: z.number().int().min(1).max(16).optional().describe('Use at most this many melodic channels (drums are extra).'),
      name: z.string().min(1).optional().describe('Song name. Default: the MIDI track name or "Imported MIDI".'),
      chipConfig: z.record(z.string(), z.unknown()).optional().describe('Chip settings, e.g. NES {"dpcm":true}, Genesis {"fm6Dac":true}, PS1 {"voices":24}, Dreamcast {"voices":32}.'),
      foldChords: z.boolean().optional().describe('Fold chord tones into 0xy arpeggios (default true); false keeps only the top voice.')
    }),
    handler: async (args, ctx) => {
      const session = songSession(ctx)
      const chip = args.chip ? requireChipId(args.chip) : session.song.chip
      let bytes: Uint8Array | undefined
      let used = args.path
      const name = hasMidiExtension(args.path) ? args.path : `${args.path}.mid`
      const candidates: string[] = []
      if (isAbsolute(args.path)) candidates.push(args.path, name)
      else candidates.push(await ctx.services.resolveExportPath(name), await ctx.services.resolveProjectPath(name))
      let lastError: unknown
      for (const c of [...new Set(candidates)]) {
        try {
          bytes = await ctx.services.readFile(c)
          used = c
          break
        } catch (e) {
          lastError = e
        }
      }
      if (!bytes) {
        throw new Error(`Cannot read "${args.path}" (${lastError instanceof Error ? lastError.message : String(lastError)}). Give an absolute path, or put the file in ~/ChiptuneStudio/exports.`)
      }
      const res = importMidi(bytes, {
        chip,
        rowsPerBeat: args.rowsPerBeat,
        patternLength: args.patternLength,
        maxChannels: args.maxChannels,
        name: args.name,
        chipConfig: args.chipConfig as never,
        foldChords: args.foldChords,
        authenticity: session.song.authenticity
      })
      session.replaceSong(res.song, { history: 'record', label: `Import ${baseName(used)}` })
      return ok(`Imported ${used} as a ${chip.toUpperCase()} song.\n${reportText(res.report)}\n\n${describeSong(session.song)}`)
    }
  }),

  defineTool({
    name: 'convert_chip',
    group: 'song',
    description:
      'Convert the open song to another chip (one undo step; undo brings the old song back). Channels are mapped by role: bass to TR/WV/F1/V1/C1, lead to P1/F2/V4/C2 (V2 on PS1 and Dreamcast), harmony to the other melodic channels, drums to the noise/drum channels (kick/tom and the rest split over two channels where the chip has two). Instruments are replaced by the target chip\'s presets for the same role (sample slots are added on SNES, PS1 and Dreamcast; PS1 and Dreamcast channels are V1..V16/24/64 with bass on V1, lead on V2 and harmony on V3..V12), notes move by octaves into the channel range, drum notes follow the target convention, effects the target channel cannot play are dropped, extra channels are dropped (their Bxx/Cxx/Dxx/Fxx effects are kept); tempo, orders, loop point, key and pattern length are kept. Macros and hand-made instruments are NOT carried over. Returns a report listing every mapping and drop. Example: {"chip":"genesis"} or {"chip":"nes","chipConfig":{"dpcm":true}}.',
    input: obj({
      chip: z.string().min(1).describe(`Target chip: ${CHIP_IDS.join(', ')} (loose names like "game boy" work).`),
      name: z.string().min(1).optional().describe('New song name. Default: keep the name.'),
      authenticity: z.enum(['strict', 'relaxed']).optional().describe('Default: keep the song\'s setting.'),
      chipConfig: z.record(z.string(), z.unknown()).optional().describe('Target chip settings, e.g. NES {"dpcm":true}, Genesis {"fm6Dac":true}, PS1 {"voices":24}, Dreamcast {"voices":32,"dsp":{"preset":"chorus-hall"}}.')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const target = requireChipId(args.chip)
      const res = convertChip(session.song, target, { name: args.name, authenticity: args.authenticity, chipConfig: args.chipConfig as never })
      if (res.report[0]?.includes('nothing to convert')) return ok(res.report.join('\n'))
      session.replaceSong(res.song, { history: 'record', label: `Convert to ${target.toUpperCase()}` })
      return ok(`${reportText(res.report)}\n\n${describeSong(session.song)}`)
    }
  })
]
