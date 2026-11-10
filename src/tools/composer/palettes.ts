// Instrument palettes of compose_track for the gm chip: per mood a few ready-made combinations of lead, pads, bass,
// accompaniment and colour instruments (all `gm.<role>.<name>` preset ids) and the textures they suit. A seed picks one
// (or `palette` names it), so two tracks of one mood do not sound the same. Pure data plus two lookups.

import type { ChipId } from '../../core'
import type { DrumRole } from '../../core'

export type TextureId = 'pad-lead' | 'broken-chord' | 'ostinato' | 'chorale' | 'march' | 'bossa' | 'lullaby-rock' | 'pizzicato-walk'

/** Light percussion a calm track can have when its mood has no drum style. */
export type PercKind = 'none' | 'shaker' | 'side-stick' | 'brush' | 'triangle' | 'woodblock'

export interface Palette {
  id: string
  description: string
  /** Melody instrument. */
  lead: string
  /** Other melody instruments that suit the palette (the avoid rule may swap the lead for one of them). */
  leads?: string[]
  /** Sustained harmony (strings, pad, organ, choir). */
  pad: string
  /** Second sustained voice (default: the same as pad). */
  pad2?: string
  bass: string
  /** Rhythmic accompaniment: broken chords, stabs, ostinato (guitar, harp, pizzicato, kalimba, ...). */
  comp: string
  /** High colour notes (celesta, glockenspiel, vibes). */
  sparkle?: string
  perc: PercKind
  /** Textures this palette is written for. */
  textures: TextureId[]
  /** Drum presets that replace the default kit presets (brush kit, side-stick, shaker, ...). */
  drums?: Partial<Record<DrumRole, string>>
}

const BRUSH: Partial<Record<DrumRole, string>> = { kick: 'gm.kick.brush-kick', snare: 'gm.snare.brush-snare', hihat: 'gm.hihat.brush-hat' }
const SOFT: Partial<Record<DrumRole, string>> = { snare: 'gm.snare.side-stick', hihat: 'gm.hihat.shaker', kick: 'gm.kick.kick-soft' }

/** All palettes by id. */
export const PALETTE_LIBRARY: Palette[] = [
  { id: 'music-box', leads: ['gm.bell.celesta', 'gm.flute.flute', 'gm.lead.ocarina'], description: 'Music box tune over slow strings and a harp: a lullaby.', lead: 'gm.bell.musicbox', pad: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.celesta', perc: 'triangle', textures: ['pad-lead', 'broken-chord', 'lullaby-rock'], drums: SOFT },
  { id: 'clarinet-pizz', leads: ['gm.lead.oboe', 'gm.flute.flute', 'gm.lead.violin'], description: 'Clarinet tune with pizzicato strings and a celesta.', lead: 'gm.lead.clarinet', pad: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.pizzicato', sparkle: 'gm.bell.celesta', perc: 'side-stick', textures: ['pad-lead', 'pizzicato-walk', 'broken-chord', 'lullaby-rock'], drums: SOFT },
  { id: 'flute-harp', leads: ['gm.lead.oboe', 'gm.lead.violin', 'gm.lead.clarinet'], description: 'Flute over strings and harp: open and airy.', lead: 'gm.flute.flute', pad: 'gm.strings.ensemble', pad2: 'gm.pad.warm', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.glockenspiel', perc: 'none', textures: ['pad-lead', 'broken-chord', 'ostinato'], drums: SOFT },
  { id: 'oboe-guitar', leads: ['gm.lead.clarinet', 'gm.flute.flute', 'gm.lead.violin'], description: 'Oboe with a nylon guitar and soft strings: pastoral.', lead: 'gm.lead.oboe', pad: 'gm.strings.ensemble', bass: 'gm.bass.finger', comp: 'gm.pluck.guitar-nylon', sparkle: 'gm.bell.celesta', perc: 'shaker', textures: ['pad-lead', 'ostinato', 'broken-chord', 'bossa'], drums: SOFT },
  { id: 'recorder-folk', leads: ['gm.flute.flute', 'gm.lead.whistle', 'gm.lead.clarinet'], description: 'Recorder and nylon guitar: simple folk.', lead: 'gm.flute.recorder', pad: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.guitar-nylon', sparkle: 'gm.bell.glockenspiel', perc: 'shaker', textures: ['pad-lead', 'broken-chord', 'march', 'pizzicato-walk'], drums: SOFT },
  { id: 'accordion-folk', leads: ['gm.lead.clarinet', 'gm.flute.recorder', 'gm.lead.violin'], description: 'Accordion tune with guitar and upright bass: Central-European folk-pop.', lead: 'gm.lead.accordion', pad: 'gm.strings.ensemble', bass: 'gm.bass.upright', comp: 'gm.pluck.guitar-nylon', sparkle: 'gm.bell.glockenspiel', perc: 'shaker', textures: ['march', 'pizzicato-walk', 'pad-lead', 'bossa'], drums: SOFT },
  { id: 'bassoon-pizz', leads: ['gm.lead.clarinet', 'gm.bell.xylophone', 'gm.lead.oboe'], description: 'Bassoon, pizzicato and xylophone: whimsical cartoon orchestra.', lead: 'gm.lead.bassoon', pad: 'gm.strings.slow', bass: 'gm.bass.tuba', comp: 'gm.pluck.pizzicato', sparkle: 'gm.bell.xylophone', perc: 'woodblock', textures: ['pizzicato-walk', 'march', 'ostinato', 'pad-lead'], drums: SOFT },
  { id: 'marimba-kalimba', leads: ['gm.bell.xylophone', 'gm.flute.flute', 'gm.lead.clarinet'], description: 'Marimba and kalimba over a warm pad: curious and light.', lead: 'gm.bell.marimba', pad: 'gm.pad.warm', bass: 'gm.bass.finger', comp: 'gm.bell.kalimba', sparkle: 'gm.bell.glockenspiel', perc: 'shaker', textures: ['broken-chord', 'ostinato', 'lullaby-rock', 'pad-lead'], drums: SOFT },
  { id: 'epiano-focus', leads: ['gm.bell.vibes', 'gm.lead.piano', 'gm.flute.flute'], description: 'Electric piano, warm pads and a round bass: steady study music.', lead: 'gm.lead.epiano', pad: 'gm.pad.warm', pad2: 'gm.pad.halo', bass: 'gm.bass.finger', comp: 'gm.lead.epiano', sparkle: 'gm.bell.vibes', perc: 'side-stick', textures: ['pad-lead', 'broken-chord', 'ostinato', 'bossa'], drums: SOFT },
  { id: 'vibes-cafe', leads: ['gm.lead.sax', 'gm.lead.muted-trumpet', 'gm.lead.piano'], description: 'Vibraphone and nylon guitar over an upright bass, brushes: cafe jazz.', lead: 'gm.bell.vibes', pad: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.guitar-nylon', sparkle: 'gm.bell.celesta', perc: 'brush', textures: ['bossa', 'pad-lead', 'broken-chord'], drums: BRUSH },
  { id: 'trumpet-cafe', leads: ['gm.lead.sax', 'gm.bell.vibes', 'gm.lead.clarinet'], description: 'Muted trumpet and electric piano comping: smoky jazz.', lead: 'gm.lead.muted-trumpet', pad: 'gm.pad.warm', bass: 'gm.bass.upright', comp: 'gm.lead.epiano', sparkle: 'gm.bell.vibes', perc: 'brush', textures: ['bossa', 'pad-lead', 'pizzicato-walk'], drums: BRUSH },
  { id: 'sax-bossa', leads: ['gm.lead.muted-trumpet', 'gm.bell.vibes', 'gm.lead.clarinet'], description: 'Alto sax over guitar and brushes: bossa nova.', lead: 'gm.lead.sax', pad: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.guitar-nylon', sparkle: 'gm.bell.vibes', perc: 'brush', textures: ['bossa', 'pizzicato-walk', 'pad-lead'], drums: BRUSH },
  { id: 'piano-strings', leads: ['gm.lead.clarinet', 'gm.lead.oboe', 'gm.flute.flute'], description: 'Piano melody over strings and a bass: warm and simple.', lead: 'gm.lead.piano', pad: 'gm.strings.ensemble', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.celesta', perc: 'none', textures: ['pad-lead', 'broken-chord', 'ostinato', 'lullaby-rock'], drums: SOFT },
  { id: 'horn-adventure', leads: ['gm.lead.trumpet', 'gm.lead.clarinet', 'gm.flute.flute'], description: 'French horn over strings, harp and timpani-weight bass: sunlit adventure.', lead: 'gm.brass.horn', pad: 'gm.strings.ensemble', bass: 'gm.bass.finger', comp: 'gm.pluck.harp', sparkle: 'gm.bell.glockenspiel', perc: 'none', textures: ['march', 'ostinato', 'pad-lead', 'broken-chord'] },
  { id: 'trumpet-march', leads: ['gm.brass.horn', 'gm.lead.clarinet', 'gm.flute.recorder'], description: 'Trumpet, brass stabs and pizzicato: a light march.', lead: 'gm.lead.trumpet', pad: 'gm.strings.ensemble', bass: 'gm.bass.tuba', comp: 'gm.brass.section', sparkle: 'gm.bell.glockenspiel', perc: 'none', textures: ['march', 'pizzicato-walk', 'ostinato'] },
  { id: 'violin-wonder', leads: ['gm.flute.flute', 'gm.lead.ocarina', 'gm.bell.vibes'], description: 'Solo violin over halo pads and a harp: wonder.', lead: 'gm.lead.violin', pad: 'gm.pad.halo', pad2: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.celesta', perc: 'none', textures: ['pad-lead', 'broken-chord', 'lullaby-rock', 'ostinato'], drums: SOFT },
  { id: 'choir-castle', leads: ['gm.lead.oboe', 'gm.lead.cello', 'gm.lead.violin'], description: 'Choir and church organ with a flute: a chorale in a great hall.', lead: 'gm.flute.flute', pad: 'gm.choir.aah', pad2: 'gm.organ.church', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.tubular', perc: 'none', textures: ['chorale', 'pad-lead', 'ostinato'] },
  { id: 'organ-castle', leads: ['gm.flute.flute', 'gm.lead.cello', 'gm.lead.violin'], description: 'Church organ and oboe over a harp: stately.', lead: 'gm.lead.oboe', pad: 'gm.organ.church', pad2: 'gm.strings.ensemble', bass: 'gm.bass.finger', comp: 'gm.pluck.harp', sparkle: 'gm.bell.tubular', perc: 'none', textures: ['chorale', 'ostinato', 'pad-lead'] },
  { id: 'ocarina-dream', leads: ['gm.flute.flute', 'gm.bell.vibes', 'gm.lead.violin'], description: 'Ocarina over a halo pad and a kalimba: quiet and dreamy.', lead: 'gm.lead.ocarina', pad: 'gm.pad.halo', pad2: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.bell.kalimba', sparkle: 'gm.bell.celesta', perc: 'triangle', textures: ['pad-lead', 'broken-chord', 'lullaby-rock'], drums: SOFT },
  { id: 'whistle-cheer', leads: ['gm.flute.recorder', 'gm.lead.accordion', 'gm.bell.xylophone'], description: 'Whistling and steel guitar over an upright bass: cheerful.', lead: 'gm.lead.whistle', pad: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.pluck.guitar-steel', sparkle: 'gm.bell.xylophone', perc: 'shaker', textures: ['pizzicato-walk', 'march', 'pad-lead', 'bossa'], drums: SOFT },
  { id: 'cello-sad', leads: ['gm.lead.violin', 'gm.lead.oboe', 'gm.lead.piano'], description: 'Solo cello over slow strings and a harp: tender sadness.', lead: 'gm.lead.cello', pad: 'gm.strings.slow', pad2: 'gm.pad.warm', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.celesta', perc: 'none', textures: ['pad-lead', 'broken-chord', 'ostinato', 'chorale'] },
  { id: 'spooky-bells', leads: ['gm.bell.musicbox', 'gm.lead.cello', 'gm.flute.panflute'], description: 'Celesta and tubular bells over a choir and low strings: eerie.', lead: 'gm.bell.celesta', pad: 'gm.choir.aah', pad2: 'gm.strings.slow', bass: 'gm.bass.upright', comp: 'gm.bell.musicbox', sparkle: 'gm.bell.tubular', perc: 'none', textures: ['pad-lead', 'ostinato', 'chorale'] },
  { id: 'glass-pad', leads: ['gm.bell.celesta', 'gm.lead.ocarina', 'gm.flute.flute'], description: 'Vibraphone over halo and warm pads: floating.', lead: 'gm.bell.vibes', pad: 'gm.pad.halo', pad2: 'gm.pad.warm', bass: 'gm.bass.upright', comp: 'gm.pluck.harp', sparkle: 'gm.bell.glockenspiel', perc: 'none', textures: ['pad-lead', 'broken-chord', 'lullaby-rock'], drums: SOFT }
]

const byId = (id: string): Palette => {
  const p = PALETTE_LIBRARY.find((x) => x.id === id)
  if (!p) throw new Error(`palette "${id}" is not defined`)
  return p
}

/** Palette ids per mood (gm). A mood not listed uses the GENERIC list. */
const MOOD_PALETTE_IDS: Record<string, string[]> = {
  ambient: ['violin-wonder', 'glass-pad', 'ocarina-dream', 'flute-harp'],
  lullaby: ['music-box', 'clarinet-pizz', 'ocarina-dream', 'piano-strings'],
  peaceful: ['flute-harp', 'oboe-guitar', 'recorder-folk', 'piano-strings'],
  'mysterious-calm': ['spooky-bells', 'glass-pad', 'choir-castle', 'ocarina-dream'],
  storybook: ['music-box', 'clarinet-pizz', 'recorder-folk', 'piano-strings', 'oboe-guitar'],
  wonder: ['violin-wonder', 'glass-pad', 'flute-harp', 'ocarina-dream'],
  playful: ['bassoon-pizz', 'whistle-cheer', 'marimba-kalimba', 'clarinet-pizz', 'recorder-folk'],
  curious: ['marimba-kalimba', 'clarinet-pizz', 'ocarina-dream', 'bassoon-pizz'],
  focus: ['epiano-focus', 'piano-strings', 'vibes-cafe', 'oboe-guitar'],
  cafe: ['vibes-cafe', 'trumpet-cafe', 'sax-bossa', 'accordion-folk'],
  'adventure-light': ['horn-adventure', 'trumpet-march', 'whistle-cheer', 'accordion-folk', 'recorder-folk'],
  heroic: ['horn-adventure', 'trumpet-march', 'organ-castle'],
  overworld: ['horn-adventure', 'recorder-folk', 'accordion-folk', 'flute-harp'],
  town: ['accordion-folk', 'recorder-folk', 'whistle-cheer', 'clarinet-pizz'],
  title: ['violin-wonder', 'horn-adventure', 'piano-strings'],
  victory: ['trumpet-march', 'horn-adventure'],
  battle: ['trumpet-march', 'horn-adventure'],
  boss: ['organ-castle', 'trumpet-march'],
  castle: ['choir-castle', 'organ-castle'],
  dungeon: ['spooky-bells', 'choir-castle', 'cello-sad'],
  spooky: ['spooky-bells', 'choir-castle'],
  sad: ['cello-sad', 'piano-strings', 'oboe-guitar'],
  'game-over': ['cello-sad', 'piano-strings'],
  chill: ['epiano-focus', 'vibes-cafe', 'piano-strings'],
  shop: ['vibes-cafe', 'trumpet-cafe', 'sax-bossa', 'accordion-folk'],
  underwater: ['glass-pad', 'ocarina-dream', 'violin-wonder'],
  desert: ['oboe-guitar', 'recorder-folk', 'cello-sad']
}
const GENERIC_PALETTE_IDS = ['flute-harp', 'oboe-guitar', 'piano-strings', 'clarinet-pizz']

/** Palettes by mood id and chip. Only the gm chip has palettes today. */
export const PALETTES: Record<string, Partial<Record<ChipId, Palette[]>>> = Object.fromEntries(
  Object.entries(MOOD_PALETTE_IDS).map(([mood, ids]) => [mood, { gm: ids.map(byId) }])
)

/** The palettes a mood can use on a chip (empty: the chip has none). */
export function palettesFor(moodId: string, chip: ChipId): Palette[] {
  if (chip !== 'gm') return []
  return PALETTES[moodId]?.gm ?? GENERIC_PALETTE_IDS.map(byId)
}

export function findPaletteById(id: string): Palette | undefined {
  const k = id.trim().toLowerCase()
  return PALETTE_LIBRARY.find((p) => p.id === k)
}

/** Comfortable melody range (MIDI) per lead preset; instruments not listed use 60..84. */
export const LEAD_RANGE: Record<string, [number, number]> = {
  'gm.lead.clarinet': [55, 84],
  'gm.lead.oboe': [58, 86],
  'gm.lead.piano': [55, 88],
  'gm.lead.epiano': [55, 84],
  'gm.lead.trumpet': [58, 82],
  'gm.lead.muted-trumpet': [58, 80],
  'gm.lead.sax': [53, 80],
  'gm.lead.violin': [60, 91],
  'gm.lead.cello': [45, 74],
  'gm.lead.bassoon': [43, 70],
  'gm.lead.accordion': [55, 82],
  'gm.lead.ocarina': [62, 88],
  'gm.lead.whistle': [67, 92],
  'gm.flute.flute': [62, 91],
  'gm.flute.recorder': [64, 91],
  'gm.flute.panflute': [62, 88],
  'gm.bell.celesta': [67, 96],
  'gm.bell.glockenspiel': [72, 100],
  'gm.bell.musicbox': [67, 96],
  'gm.bell.vibes': [58, 88],
  'gm.bell.marimba': [55, 84],
  'gm.bell.xylophone': [67, 96],
  'gm.bell.kalimba': [60, 88],
  'gm.brass.horn': [48, 76]
}
