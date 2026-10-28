import { z } from 'zod'
import {
  DRUM_STYLES,
  MOODS,
  PITCH_CLASSES,
  PROGRESSIONS,
  SCALE_IDS,
  chordToArp,
  describeScale,
  findDrumStyle,
  formatNote,
  getDrumPattern,
  realizeProgression,
  requireChipId,
  requireMood,
  requireScale,
  rowsPerBar,
  scaleNotes,
  suggestProgressions
} from '../../core'
import { defineTool } from '../registry'
import { obj, ok, plural, songSession } from '../util'

export const theoryTools = [
  defineTool({
    name: 'get_mood_recipe',
    group: 'theory',
    readOnly: true,
    description:
      'A composition recipe for a game-music mood: BPM range, keys, scales, groove, chord progressions and drum styles that fit, the arrangement (sections with bars and the loop point), which role each channel plays on the chip, and concrete techniques. Moods: heroic, battle, boss, spooky, dungeon, chill, town, overworld, victory, game-over, title, shop, underwater, desert, castle, sad, the calm ones (ambient, lullaby, peaceful, mysterious-calm) and the synth moods synthwave, outrun, darkwave, dreamwave (aliases like "epic", "cave", "village", "retrowave", "chase" work). Without "mood" it lists all moods. The channel plan covers all seven chips (nes, gb, genesis, snes, pce, ps1, dreamcast). Call it before new_song. Example: {"mood":"spooky","chip":"gb"}.',
    input: obj({
      mood: z.string().min(1).optional().describe('Mood id or alias. Omit to list the moods.'),
      chip: z.string().optional().describe('Chip for the channel plan: nes, gb, genesis, snes, pce, ps1, dreamcast (default: the song\'s chip).')
    }),
    handler: (args, ctx) => {
      if (!args.mood) {
        return ok('Moods:\n' + MOODS.map((m) => `${m.id}: ${m.name}, ${m.bpm[0]}-${m.bpm[1]} BPM. ${m.description}`).join('\n') + '\nget_mood_recipe {"mood":"<id>"} gives the full recipe.')
      }
      const song = songSession(ctx).song
      const chip = args.chip ? requireChipId(args.chip) : song.chip
      const m = requireMood(args.mood)
      const plan = m.chips[chip]
      const orderRows = (bars: number): string => `${bars} bars = ${(bars * m.rowsPerBar) / m.patternLength} order row(s) of ${m.patternLength} rows`
      const out: string[] = []
      out.push(`${m.name} (${m.id}): ${m.description}`)
      out.push(`BPM ${m.bpm[0]}-${m.bpm[1]} (default ${m.bpmDefault}). Keys: ${m.keys.join(', ')}. Scales: ${m.scales.join(', ')}.${m.groove ? ` Groove: ${m.groove.join('/')} ticks per row (set_song_info {"groove":[${m.groove.join(',')}]}).` : ''}`)
      out.push(`Parts: lead=${m.parts.lead}, harmony=${m.parts.harmony}, pad=${m.parts.pad}, bass=${m.parts.bass}.`)
      const progs = m.progressions.map((id) => PROGRESSIONS.find((p) => p.id === id)).filter(Boolean)
      out.push('Progressions: ' + progs.map((p) => `${p!.id} (${p!.numerals.join(' ')})`).join('; ') + '. suggest_progression gives the chords in your key.')
      out.push(`Drum styles: ${m.drumStyles.join(', ')} (get_drum_pattern).`)
      out.push(`Arrangement, ${m.arrangement.totalBars} bars total (${m.patternLength} rows per pattern = ${m.patternLength / m.rowsPerBar} bars): ` + m.arrangement.sections.map((s) => `${s.name} ${s.bars}`).join(' | ') + `. ${m.arrangement.loopFrom ? `Loop from "${m.arrangement.loopFrom}" (set_loop).` : 'No loop: a one-shot jingle (set_loop null).'}`)
      out.push(`  e.g. ${m.arrangement.sections.map((s) => `${s.name}: ${orderRows(s.bars)}`).join('; ')}.`)
      if (plan) {
        out.push(`Channel plan for ${chip.toUpperCase()}:`)
        for (const c of plan.channels) out.push(`  ${c.channel} (${c.role}): ${c.part}`)
        out.push(`Idioms for ${chip.toUpperCase()}:`)
        for (const i of plan.idioms) out.push(`  - ${i}`)
      }
      out.push('Techniques:')
      for (const t of m.techniques) out.push(`  - ${t}`)
      out.push(`Start: new_song {"chip":"${chip}","mood":"${m.id}"} (takes BPM ${m.bpmDefault}, key ${m.keys[0]}, scale ${m.scales[0]}).`)
      return ok(out.join('\n'))
    }
  }),

  defineTool({
    name: 'suggest_progression',
    group: 'theory',
    readOnly: true,
    description:
      'Chord progressions for a mood or mode, realised in a key: Roman numerals, chord names, the chord notes (root in octave 3) and the arpeggio effect (0xy) that plays the triad on a single chip channel. Use these chords for bass roots, arpeggios and melody targets. Example: {"mood":"heroic","key":"D"}. The key defaults to the song\'s key.',
    input: obj({
      mood: z.string().optional().describe('Mood id (see get_mood_recipe).'),
      mode: z.enum(['major', 'minor']).optional().describe('Only major or minor progressions.'),
      key: z.string().optional().describe('Key tonic (default: the song\'s key).'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum progressions (default 5).'),
      octave: z.number().int().min(1).max(6).optional().describe('Octave of the chord roots (default 3).')
    }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      const key = args.key ?? song.meta.key
      const mood = args.mood ? requireMood(args.mood).id : undefined
      const list = suggestProgressions({ mood, mode: args.mode, limit: args.limit ?? 5 })
      if (list.length === 0) return ok(`No progressions match${mood ? ` mood ${mood}` : ''}${args.mode ? ` in ${args.mode}` : ''}. Ids: ${PROGRESSIONS.map((p) => p.id).join(', ')}.`)
      const out: string[] = [`${plural(list.length, 'progression')} in ${key}:`]
      for (const p of list) {
        out.push(`${p.id} - ${p.name} [${p.mode}${p.barsPerChord ? `, ${p.barsPerChord} bar/chord` : ', 1 bar per chord'}]: ${p.description}`)
        const chords = realizeProgression(p, key, args.octave ?? 3)
        out.push('  ' + chords.map((c) => `${c.numeral}=${c.name} [${c.notes.map(formatNote).join(' ')}] ${chordToArp(c.notes).text}`).join('  '))
      }
      out.push('The arp text is the effect for a one-voice channel: C-4 + 047 plays C E G. Bass: use the root (first note) one or two octaves down.')
      return ok(out.join('\n'))
    }
  }),

  defineTool({
    name: 'get_scale',
    group: 'theory',
    readOnly: true,
    description:
      'The notes of a scale in a key (default: the song\'s key and scale): pitch classes, the scale degrees as note names over the octaves in [low, high], and the intervals. Use it to keep melodies in key; transpose with degrees stays in this scale. Scales: ' +
      SCALE_IDS.join(', ') + '. Example: {"key":"D","scale":"phrygian-dominant","octave":4}.',
    input: obj({
      key: z.string().optional().describe(`Tonic (${PITCH_CLASSES.join(', ')}). Default: the song's key.`),
      scale: z.string().optional().describe('Scale id. Default: the song\'s scale.'),
      octave: z.number().int().min(0).max(8).optional().describe('Octave whose scale notes are listed first (default 4); notes up to two octaves higher follow.')
    }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      const key = args.key ?? song.meta.key
      const scale = requireScale(args.scale ?? song.meta.scale)
      const d = describeScale(key, scale.id)
      const oct = args.octave ?? 4
      const low = (oct + 1) * 12
      const notes = scaleNotes(key, scale.id, low, low + 24)
      return ok(
        `${d.key} ${scale.name}: ${scale.description}\nPitch classes: ${d.pitchClasses.join(' ')}. Intervals from the tonic (semitones): ${scale.intervals.join(' ')}.\nNotes (octave ${oct} to +2): ${notes.map(formatNote).join(' ')}\nOther scales: ${SCALE_IDS.filter((s) => s !== scale.id).join(', ')}.`
      )
    }
  }),

  defineTool({
    name: 'get_drum_pattern',
    group: 'theory',
    readOnly: true,
    description:
      'Ready-made drum grooves as write_drums arguments. Without "style" it lists the styles (with fitting moods and BPM). With a style it returns the combined single-channel pattern (legend + steps; the legend uses roles, so write_drums adds the instruments itself) and the per-role lanes for chips with separate drum channels. Steps are one character per row (a 16-row bar of sixteenths). bars: bars to generate; fill: the last bar becomes a fill. Example: {"style":"rock","bars":2,"fill":true}.',
    input: obj({
      style: z.string().optional().describe('Style id. Omit to list.'),
      bars: z.number().int().min(1).max(16).optional().describe('Bars of 16 steps (default 1).'),
      fill: z.boolean().optional().describe('Replace the last bar by the style\'s fill (needs bars > 1).'),
      mood: z.string().optional().describe('When listing: only styles for this mood.')
    }),
    handler: (args, ctx) => {
      if (!args.style) {
        const mood = args.mood ? requireMood(args.mood).id : undefined
        const list = DRUM_STYLES.filter((s) => !mood || s.moods.includes(mood))
        return ok(`Drum styles${mood ? ` for ${mood}` : ''}:\n` + list.map((s) => `${s.id}: ${s.description} (${s.bpm[0]}-${s.bpm[1]} BPM; ${s.moods.join(', ')})`).join('\n'))
      }
      const style = findDrumStyle(args.style)
      if (!style) throw new Error(`Unknown drum style "${args.style}". Valid styles: ${DRUM_STYLES.map((s) => s.id).join(', ')}.`)
      const song = songSession(ctx).song
      const bars = args.bars ?? 1
      const p = getDrumPattern(style.id, { bars, fill: args.fill })
      const rowsInBar = rowsPerBar(song.timing)
      const stepRows = bars * 16
      const repeat = Math.max(1, Math.floor(song.patternLength / stepRows))
      const call = { legend: p.legend, steps: p.steps, repeat }
      const out = [
        `${style.name}: ${style.description} (${style.bpm[0]}-${style.bpm[1]} BPM)`,
        `${bars} bar(s) = ${stepRows} steps${rowsInBar !== 16 ? ` (note: this song has ${rowsInBar} rows per bar, the pattern assumes 16 sixteenth steps per bar)` : ''}. write_drums arguments for a ${song.patternLength}-row pattern:`,
        JSON.stringify(call),
        'Lanes (one drum channel per role):',
        ...Object.entries(p.lanes).map(([r, l]) => `  ${r}: ${l}`)
      ]
      return ok(out.join('\n'))
    }
  })
]

