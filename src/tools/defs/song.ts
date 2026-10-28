import { z } from 'zod'
import {
  type ChipId,
  type Song,
  CHIP_IDS,
  PITCH_CLASSES,
  SCALE_IDS,
  createSong,
  cloneSong,
  createSongInfoCommand,
  listChips,
  parseProject,
  requireChipId,
  requireMood,
  rowsPerBar,
  serializeProject,
  summarizeSong,
  validateSong,
  formatNote
} from '../../core'
import { defineTool } from '../registry'
import { MANY_CHANNELS, channelIdsText, chipIsPlayable, chipNotReadyNote, describeOrderRow, obj, ok, plural, songSession, withExtension, safeFileName } from '../util'

const timingFields = {
  bpm: z.number().min(20).max(400).optional().describe('Tempo in beats per minute (20..400). Default 120 (or the mood recipe\'s default).'),
  speed: z.number().int().min(1).max(31).optional().describe('Ticks per row (default 6). Higher = finer effect resolution, not slower: tempo comes from bpm.'),
  rowsPerBeat: z.number().int().min(1).max(16).optional().describe('Rows per beat (default 4: a row is a sixteenth note).'),
  beatsPerBar: z.number().int().min(1).max(16).optional().describe('Beats per bar (default 4).'),
  groove: z.array(z.number().int().min(1).max(31)).min(1).optional().describe('Alternating ticks per row for swing, e.g. [7,5] (overrides speed). Pass [] to remove with set_song_info.')
}

const keyField = z.string().min(1).describe(`Key tonic: ${PITCH_CLASSES.join(', ')} (flats like Bb are accepted).`)
const scaleField = z.string().min(1).describe(`Scale id: ${SCALE_IDS.join(', ')}.`)

/** Compact text view of the song: what the LLM needs to continue working on it. */
export function describeSong(song: Song, extra: { undo?: string; cursor?: string } = {}): string {
  const s = summarizeSong(song)
  const t = song.timing
  const lines: string[] = []
  lines.push(`Song "${song.name}" (${song.chip.toUpperCase()}, ${song.authenticity})${chipIsPlayable(song.chip) ? '' : ' [sound engine coming: renders silence]'}`)
  lines.push(
    `Timing: ${t.bpm} BPM, speed ${t.speed}${t.groove ? ` (groove ${t.groove.join('/')})` : ''}, ${t.rowsPerBeat} rows/beat, ${t.beatsPerBar} beats/bar (${rowsPerBar(t)} rows per bar). Pattern length ${song.patternLength} rows (${song.patternLength / rowsPerBar(t)} bars).`
  )
  lines.push(`Key: ${song.meta.key} ${song.meta.scale}${song.meta.moods.length ? ` | moods: ${song.meta.moods.join(', ')}` : ''}${song.meta.tags.length ? ` | tags: ${song.meta.tags.join(', ')}` : ''}${song.meta.notes ? ` | notes: ${song.meta.notes}` : ''}`)
  lines.push(
    `Length: ${plural(s.orders, 'order row')} = ${s.rows} rows = ${Number.isInteger(s.bars) ? s.bars : s.bars.toFixed(1)} bars = ${s.seconds.toFixed(1)} s. ${song.loop ? `Loops back to order ${song.loop.order}.` : 'No loop (plays once).'}`
  )
  lines.push('Orders (pattern number per channel):')
  song.orders.forEach((_, o) => lines.push(`  ${o}: ${describeOrderRow(song, o)}`))
  lines.push('Channels (notes written):')
  if (s.channels.length > MANY_CHANNELS) {
    // PS1 24 voices, Dreamcast 32 / 64: the channels with notes (or muted), then how many are empty
    const used = s.channels.filter((c) => c.notes > 0 || c.muted)
    lines.push('  ' + (used.length ? used.map((c) => `${c.id}${c.muted ? ' [muted]' : ''}: ${c.notes}`).join(' | ') + ' | ' : '') + `${plural(s.channels.length - used.length, 'other channel')} empty (${s.channels.length} in all: ${channelIdsText(s.channels.map((c) => c.id))})`)
  } else lines.push('  ' + s.channels.map((c) => `${c.id} ${c.name}${c.muted ? ' [muted]' : ''}: ${c.notes}`).join(' | '))
  lines.push(
    song.instruments.length === 0
      ? 'Instruments: none yet (add_instrument with a preset or role first).'
      : 'Instruments: ' + song.instruments.map((x, i) => `@${i} ${x.name} (${x.kind}${x.role ? `, ${x.role}` : ''})`).join('; ')
  )
  if (song.samples.length) lines.push(`Samples: ${song.samples.map((x) => x.id).join(', ')}`)
  if (song.references.length) lines.push(`References: ${song.references.map((r) => r.assetId).join(', ')} (call get_style_context first)`)
  if (extra.cursor) lines.push(extra.cursor)
  if (extra.undo) lines.push(extra.undo)
  return lines.join('\n')
}

export const songTools = [
  defineTool({
    name: 'get_song',
    group: 'song',
    readOnly: true,
    description:
      'Describe the open song: chip, timing, key, length, the order list (which pattern each channel plays per order row), channels with note counts, instruments, loop point and editor cursor. Call this first to see what exists before you change anything.',
    input: obj({}),
    handler: (_args, ctx) => {
      const session = songSession(ctx)
      const c = session.cursor
      const ch = session.song.channels[c.channel]
      return ok(
        describeSong(session.song, {
          cursor: `Cursor: order ${c.order}, row ${c.row}, channel ${ch?.id ?? c.channel} (tools without an explicit order/channel use it).`,
          undo: session.canUndo() ? `Undo available: "${session.undoLabel()}".` : 'Nothing to undo.'
        })
      )
    }
  }),

  defineTool({
    name: 'new_song',
    group: 'song',
    description:
      'Replace the open song with a new empty one (undoable). Pick the chip ("nes", "gb", "genesis", "snes", "pce", "ps1" for the PlayStation SPU, "dreamcast" for the Sega AICA), tempo, key and scale. Optionally give a mood ("heroic", "spooky", ...) to take BPM, key, scale, groove and pattern length from its recipe (get_mood_recipe shows it). The channels come from the chip (NES: P1 P2 TR NO; PS1 and Dreamcast: V1..Vn sample voices, 16 by default). The song starts with one order row of empty patterns, 64 rows long, no instruments. The voice count of PS1 (16 or 24) and Dreamcast (16, 32 or 64) is fixed here with chipConfig {"voices":24}; the reverb (PS1) and DSP (Dreamcast) presets go there too. Examples: {"chip":"nes","name":"Overworld","bpm":132,"key":"D","scale":"mixolydian"}, {"chip":"ps1","mood":"synthwave","chipConfig":{"voices":24,"reverb":{"preset":"hall"}}}, {"chip":"dreamcast","chipConfig":{"voices":32,"dsp":{"preset":"chorus-hall"}}}.',
    input: obj({
      chip: z.string().min(1).describe(`Chip: ${CHIP_IDS.join(', ')} (loose names like "game boy" work).`),
      name: z.string().min(1).optional().describe('Song name (also the default export file name).'),
      mood: z.string().min(1).optional().describe('Mood id from get_mood_recipe; supplies defaults for bpm, key, scale, groove and moods.'),
      ...timingFields,
      key: keyField.optional(),
      scale: scaleField.optional(),
      patternLength: z.number().int().min(1).max(256).optional().describe('Rows per pattern (default 64 = 4 bars of 16 rows).'),
      authenticity: z.enum(['strict', 'relaxed']).optional().describe('"strict" (default): writes that break the chip\'s limits fail with a fix. "relaxed": they become warnings.'),
      chipConfig: z.record(z.string(), z.unknown()).optional().describe('Chip settings, e.g. NES {"dpcm":true} adds the DM channel, Genesis {"fm6Dac":true}, {"region":"pal"}; PS1 {"voices":16|24,"reverb":{"preset":"studio-large","depth":0.5,"inputVol":1}}; Dreamcast {"voices":16|32|64,"dsp":{"preset":"chorus-hall","mix":0.35,"time":0.5,"feedback":0.35,"chorusRate":0.3,"chorusDepth":0.4,"delayMs":300}}. Fields you leave out keep their defaults.'),
      tags: z.array(z.string()).optional().describe('Free tags.')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const chip: ChipId = requireChipId(args.chip)
      const mood = args.mood ? requireMood(args.mood) : undefined
      const song = createSong({
        chip,
        name: args.name ?? (mood ? `${mood.name} theme` : 'Untitled'),
        bpm: args.bpm ?? mood?.bpmDefault,
        key: args.key ?? mood?.keys[0],
        scale: args.scale ?? mood?.scales[0],
        moods: mood ? [mood.id] : [],
        tags: args.tags,
        patternLength: args.patternLength ?? mood?.patternLength,
        authenticity: args.authenticity,
        speed: args.speed,
        rowsPerBeat: args.rowsPerBeat,
        beatsPerBar: args.beatsPerBar,
        groove: args.groove ?? mood?.groove,
        chipConfig: args.chipConfig as never
      })
      session.replaceSong(song, { history: 'record', label: `New ${chip.toUpperCase()} song` })
      // the sample chips have 16..64 identical voices: V1..Vn instead of one entry each
      const defs = song.channels.length > 16 ? `${song.channels[0]!.id}..${song.channels[song.channels.length - 1]!.id} (${song.channels.length} sample voices)` : song.channels.map((c) => `${c.id} (${c.name})`).join(', ')
      const parts = [`Created a new ${chip.toUpperCase()} song "${song.name}": ${song.timing.bpm} BPM, ${song.meta.key} ${song.meta.scale}, ${song.patternLength} rows per pattern, ${song.authenticity}.`]
      parts.push(`Channels: ${defs}.`)
      if (!chipIsPlayable(chip)) parts.push(chipNotReadyNote(chip))
      parts.push('Next: add_instrument for each part, then write_drums / write_pattern / write_melody; use set_orders to build sections.')
      return ok(parts.join('\n'))
    }
  }),

  defineTool({
    name: 'set_song_info',
    group: 'song',
    description:
      'Change song settings: name, tempo (bpm, speed, rowsPerBeat, beatsPerBar, groove), key, scale, moods, tags, notes, authenticity, or non-structural chip config (region, mixModel, lfo, SNES echo, PS1 reverb, Dreamcast dsp; nested settings merge field by field, so {"reverb":{"preset":"hall"}} keeps depth). The voice count (voices) is fixed by new_song. Only the fields you pass change. groove: [] or null removes swing. Example: {"bpm":150,"key":"A","scale":"minor"}. The key/scale are metadata for analysis and diatonic transpose; they do not rewrite notes.',
    input: obj({
      name: z.string().min(1).optional().describe('New song name (also the default export file name).'),
      ...timingFields,
      groove: z.union([z.array(z.number().int().min(1).max(31)), z.null()]).optional().describe('Swing ticks per row, e.g. [7,5]; [] or null removes it.'),
      key: keyField.optional(),
      scale: scaleField.optional(),
      moods: z.array(z.string()).optional().describe('Mood ids/tags (replaces the list).'),
      tags: z.array(z.string()).optional().describe('Tags (replaces the list).'),
      notes: z.string().nullable().optional().describe('Free-form notes about the song; "" or null clears.'),
      authenticity: z.enum(['strict', 'relaxed']).optional().describe('"strict": writes that break the chip limits fail with a fix; "relaxed": they become warnings.'),
      chipConfig: z.record(z.string(), z.unknown()).optional().describe('Non-structural chip settings to merge (region, mixModel, lfo, echo, PS1 reverb {preset, depth, inputVol}, Dreamcast dsp {preset, mix, time, feedback, chorusRate, chorusDepth, delayMs}). dpcm/fm6Dac/voices need a new_song.')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const before = JSON.stringify({ t: song.timing, m: song.meta, a: song.authenticity, n: song.name, c: song.chipConfig })
      const patch = { ...args, groove: args.groove && args.groove.length === 0 ? null : args.groove } as Parameters<typeof createSongInfoCommand>[1]
      const given = Object.keys(args)
      if (given.length === 0) return ok('Nothing to change: pass at least one field (bpm, key, scale, ...).')
      if (args.chipConfig) {
        // PS1 reverb / Dreamcast dsp values are checked before they are applied (a bad preset name would break rendering)
        const probe = cloneSong(song)
        createSongInfoCommand(probe, patch).apply(probe)
        const bad = validateSong(probe).filter((i) => i.severity === 'error' && i.message.startsWith('chipConfig.'))
        if (bad.length > 0) throw new Error(bad.map((i) => i.message).join(' '))
      }
      session.execute(createSongInfoCommand(song, patch))
      const after = JSON.stringify({ t: song.timing, m: song.meta, a: song.authenticity, n: song.name, c: song.chipConfig })
      const t = song.timing
      return ok(
        `${before === after ? 'No change (values were already set). ' : 'Updated: ' + given.join(', ') + '. '}Now ${t.bpm} BPM, speed ${t.speed}, ${t.rowsPerBeat} rows/beat, key ${song.meta.key} ${song.meta.scale}, ${song.authenticity}.`
      )
    }
  }),

  defineTool({
    name: 'set_loop',
    group: 'song',
    description:
      'Set the loop point: the order row the song jumps back to after the last row (the intro before it plays once). order: null makes the song one-shot (a jingle). Exported WAVs get the loop points in a "smpl" chunk. Example: {"order":1} for intro = order 0, loop body from order 1.',
    input: obj({ order: z.number().int().min(0).nullable().describe('Order row to loop back to, or null for no loop.') }),
    handler: ({ order }, ctx) => {
      const session = songSession(ctx)
      session.execute(createSongInfoCommand(session.song, { loop: order === null ? null : { order } }, 'Set loop'))
      return ok(order === null ? 'Loop removed: the song plays once.' : `Loop set: after the last order row the song jumps back to order ${order}${order === 0 ? ' (whole song loops)' : ` (orders 0..${order - 1} are the intro)`}.`)
    }
  }),

  defineTool({
    name: 'list_chips',
    group: 'song',
    readOnly: true,
    description:
      'List the supported sound chips with their channels (id, kind, note range, volume, accepted instrument kinds, effects) and cheat-sheet notes. Optionally one chip only. Use it to choose a chip and to know which channel plays which role.',
    input: obj({ chip: z.string().optional().describe(`Only this chip (${CHIP_IDS.join(', ')}).`) }),
    handler: ({ chip }) => {
      const want = chip ? requireChipId(chip) : undefined
      const out: string[] = []
      for (const c of listChips()) {
        if (want && c.id !== want) continue
        out.push(`${c.id} - ${c.name} (${c.era})${chipIsPlayable(c.id) ? '' : ' [coming: sound engine not in this build yet]'}`)
        out.push(`  ${c.description}`)
        // a run of 12+ identical channels (the PS1 and Dreamcast voices; the SNES has 8) is one line: V1..V16
        const same = (a: (typeof c.channels)[number], b: (typeof c.channels)[number]): boolean =>
          a.kind === b.kind && a.noteRange[0] === b.noteRange[0] && a.noteRange[1] === b.noteRange[1] && a.hasVolume === b.hasVolume && a.accepts.join() === b.accepts.join() && a.effects === b.effects && a.description === b.description
        for (let i = 0; i < c.channels.length; ) {
          const ch = c.channels[i]!
          let end = i + 1
          while (end < c.channels.length && same(ch, c.channels[end]!)) end++
          const run = end - i >= 12
          const last = c.channels[end - 1]!
          out.push(`  ${run ? `${ch.id}..${last.id} ${ch.name}..${last.name.replace(/^\D+/, '')}` : `${ch.id} ${ch.name}`} [${ch.kind}] ${formatNote(ch.noteRange[0])}..${formatNote(ch.noteRange[1])}${ch.hasVolume ? '' : ', no volume'}; instruments: ${ch.accepts.join('/')}; fx: ${ch.effects}`)
          out.push(`      ${ch.description}`)
          i = run ? end : i + 1
        }
        for (const n of c.notes) out.push(`  * ${n}`)
      }
      return ok(out.join('\n'))
    }
  }),

  defineTool({
    name: 'open_project',
    group: 'song',
    description:
      'Open a .ctune project file, replacing the current song (undoable). A bare name is looked up in ~/ChiptuneStudio/projects (".ctune" is added); an absolute path is used as is.',
    input: obj({ path: z.string().min(1).describe('Project name or absolute path of the .ctune file.') }),
    handler: async ({ path }, ctx) => {
      const session = songSession(ctx)
      const full = await ctx.services.resolveProjectPath(withExtension(path, 'ctune'))
      const bytes = await ctx.services.readFile(full)
      const song = parseProject(new TextDecoder().decode(bytes))
      session.replaceSong(song, { history: 'record', label: `Open ${song.name}` })
      return ok(`Opened ${full}.\n${describeSong(session.song)}`)
    }
  }),

  defineTool({
    name: 'save_project',
    group: 'song',
    readOnly: true,
    description:
      'Save the song as a .ctune project (lossless JSON: patterns, instruments, samples, orders). A bare name goes to ~/ChiptuneStudio/projects (default: the song name); an absolute path is used as is. Returns the written path.',
    input: obj({ path: z.string().min(1).optional().describe('Project name or absolute path. Default: the song name.') }),
    handler: async ({ path }, ctx) => {
      const song = songSession(ctx).song
      const full = await ctx.services.resolveProjectPath(withExtension(path ?? safeFileName(song.name), 'ctune'))
      await ctx.services.writeFile(full, serializeProject(song))
      return ok(`Saved the project to ${full}.`)
    }
  })
]
