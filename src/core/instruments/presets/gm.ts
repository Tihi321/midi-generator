// General MIDI SoundFont presets. Ids are `gm.<role>.<name>`: the role says what the instrument does in a track (lead,
// bass, pad, strings, ...), the name is the instrument. Melodic presets are `sf-program` (a GM program number), the
// percussion presets are `sf-drum` (a GM percussion key, optionally in a drum kit such as the brush kit).
//
// Composers and apps can rely on these ids; list_presets {"chip":"gm"} prints them all.

import type { Role, SfDrumInstrument, SfProgramInstrument } from '../../types'
import type { Preset } from './types'

type Row = [name: string, program: number, description: string, range?: [low: number, high: number]]

const melodic = (role: Role, rows: Row[]): Preset[] =>
  rows.map(([name, program, description]) => {
    const instrument: SfProgramInstrument = { kind: 'sf-program', name, program, gm: { program } }
    return { id: `gm.${role}.${name}`, name, role, description, channelKinds: ['gm-melodic'], instrument }
  })

type DrumRow = [name: string, key: number, description: string, kit?: number]

const percussion = (role: Role, rows: DrumRow[]): Preset[] =>
  rows.map(([name, key, description, kit]) => {
    const instrument: SfDrumInstrument = { kind: 'sf-drum', name, key, ...(kit !== undefined ? { kit } : {}), gm: { drumNote: key } }
    return { id: `gm.${role}.${name}`, name, role, description, channelKinds: ['gm-drums'], instrument }
  })

export const GM_PRESETS: Preset[] = [
  ...melodic('lead', [
    ['clarinet', 71, 'Clarinet: warm, woody melody voice (G3 up).'],
    ['oboe', 68, 'Oboe: reedy, pastoral melody.'],
    ['piano', 0, 'Acoustic grand piano: melody or broken chords.'],
    ['epiano', 4, 'Electric piano (Rhodes style): warm, soft attack.'],
    ['trumpet', 56, 'Trumpet: bright, heroic melody.'],
    ['muted-trumpet', 59, 'Muted trumpet: cafe jazz melody.'],
    ['sax', 65, 'Alto saxophone: smooth jazz melody.'],
    ['violin', 40, 'Solo violin: singing melody.'],
    ['cello', 42, 'Solo cello: rich low melody or counter-line.'],
    ['bassoon', 70, 'Bassoon: comic or dark low woodwind melody.'],
    ['accordion', 21, 'Accordion: folk and cafe colour.'],
    ['ocarina', 79, 'Ocarina: soft, breathy, simple melody.'],
    ['whistle', 78, 'Whistling: cheerful, light melody.']
  ]),
  ...melodic('flute', [
    ['flute', 73, 'Flute: airy, clear melody.'],
    ['recorder', 74, 'Recorder: simple, childlike melody.'],
    ['panflute', 75, 'Pan flute: breathy, pastoral melody.']
  ]),
  ...melodic('bell', [
    ['celesta', 8, 'Celesta: sparkling, music-box-like bell tone.'],
    ['glockenspiel', 9, 'Glockenspiel: bright metal bars.'],
    ['musicbox', 10, 'Music box: tender, lullaby colour.'],
    ['vibes', 11, 'Vibraphone: mellow jazz bars.'],
    ['marimba', 12, 'Marimba: warm wooden bars, playful.'],
    ['xylophone', 13, 'Xylophone: dry, bouncy wooden bars.'],
    ['kalimba', 108, 'Kalimba: soft plucked tines.'],
    ['tubular', 14, 'Tubular bells: big, solemn chimes.']
  ]),
  ...melodic('pluck', [
    ['guitar-nylon', 24, 'Nylon-string guitar: soft plucked chords or picking.'],
    ['guitar-steel', 25, 'Steel-string guitar: brighter strum or picking.'],
    ['harp', 46, 'Harp: sweeping or broken chords.'],
    ['pizzicato', 45, 'Pizzicato strings: short, playful plucks.']
  ]),
  ...melodic('bass', [
    ['finger', 33, 'Fingered electric bass: round and steady.'],
    ['upright', 32, 'Upright (acoustic) bass: warm walking or bossa bass.'],
    ['tuba', 58, 'Tuba: comic or march bass.'],
    ['timpani', 47, 'Timpani: pitched drum roll and hits.']
  ]),
  ...melodic('pad', [
    ['warm', 89, 'Warm synth pad: soft sustained harmony.'],
    ['halo', 94, 'Halo pad: wide, airy, dreamy.']
  ]),
  ...melodic('strings', [
    ['ensemble', 48, 'String ensemble: full sustained strings.'],
    ['slow', 49, 'Slow strings: gentle swells.']
  ]),
  ...melodic('choir', [['aah', 52, 'Choir "aah": sustained vocal pad.']]),
  ...melodic('organ', [
    ['church', 19, 'Church organ: solemn chorale and castle halls.'],
    ['drawbar', 16, 'Drawbar organ: soft jazz or pop comping.']
  ]),
  ...melodic('brass', [
    ['section', 61, 'Brass section: stabs and fanfares.'],
    ['horn', 60, 'French horn: warm, heroic sustained notes.']
  ]),
  ...percussion('kick', [
    ['kick', 36, 'Bass drum.'],
    ['kick-soft', 35, 'Acoustic bass drum: softer, rounder.'],
    ['brush-kick', 36, 'Bass drum from the brush kit: very soft.', 40]
  ]),
  ...percussion('snare', [
    ['snare', 38, 'Snare drum.'],
    ['side-stick', 37, 'Side stick (rim click): light calm backbeat.'],
    ['brush-snare', 38, 'Brush swish on the snare (brush kit).', 40]
  ]),
  ...percussion('clap', [['clap', 39, 'Hand clap.']]),
  ...percussion('hihat', [
    ['hat', 42, 'Closed hi-hat.'],
    ['shaker', 70, 'Maracas / shaker: soft steady pulse for calm tracks.'],
    ['tambourine', 54, 'Tambourine.'],
    ['triangle', 81, 'Open triangle: a gentle sparkle on the beat.'],
    ['claves', 75, 'Claves: dry wooden tick.'],
    ['woodblock', 76, 'Hi wood block.'],
    ['brush-hat', 42, 'Closed hat from the brush kit.', 40]
  ]),
  ...percussion('openhat', [['open-hat', 46, 'Open hi-hat.']]),
  ...percussion('crash', [
    ['crash', 49, 'Crash cymbal.'],
    ['ride', 51, 'Ride cymbal: steady jazz pulse.'],
    ['splash', 55, 'Splash cymbal.']
  ]),
  ...percussion('tom', [
    ['tom', 45, 'Mid tom.'],
    ['conga-high', 63, 'Open high conga.'],
    ['conga-low', 64, 'Low conga.'],
    ['bongo-high', 60, 'High bongo.'],
    ['bongo-low', 61, 'Low bongo.']
  ])
]
