// SNES preset bank: one preset per generated sample recipe (see synth/samplegen/bank.ts), with ADSR and echo
// settings that suit the sound. A preset carries the recipe slot it needs (`sample`); the tool layer adds the slot
// to the song when the preset is added. ADSR = [attack 0..15, decay 0..7, sustain level 0..7, sustain rate 0..31]:
//   attack 15 = instant, 9 ~ 64 ms, 6 ~ 0.25 s; sustain level 7 = no decay; sustain rate 0 = hold,
//   rate 20 ~ 0.2 s, 16 ~ 0.5 s (exponential). The sample of a pluck/drum ends by itself.

import type { Role, SampleSlot, SnesEnvelope } from '../../types'
import type { Preset } from './types'

type Params = Record<string, number | string | boolean>

function snes(
  id: string,
  name: string,
  role: Role,
  description: string,
  slot: { id: string; label: string; recipe: string; params?: Params },
  baseNote: number,
  env: SnesEnvelope,
  echo: boolean
): Preset {
  const sample: SampleSlot = { id: slot.id, name: slot.label, source: { kind: 'recipe', recipe: slot.recipe, params: slot.params ?? {} } }
  return {
    id: `snes.${id}`,
    name,
    role,
    description,
    channelKinds: ['sample'],
    instrument: { kind: 'snes-sample', name, sample: slot.id, baseNote, env, echo },
    sample
  }
}

const adsr = (a: number, d: number, s: number, r: number): SnesEnvelope => ({ adsr: [a, d, s, r] })

export const SNES_PRESETS: Preset[] = [
  snes('strings.ensemble', 'strings', 'strings', 'String ensemble: slow bow attack, sustained, chorus-detuned loop. Add echo for width.', { id: 'strings', label: 'Strings', recipe: 'strings' }, 60, adsr(9, 5, 6, 0), true),
  snes('strings.stac', 'strings-stac', 'strings', 'Short bright staccato strings that decay by themselves.', { id: 'strings-bright', label: 'Strings (bright)', recipe: 'strings', params: { bright: 0.8 } }, 60, adsr(14, 6, 2, 17), true),
  snes('choir.aah', 'choir', 'choir', 'Sung "aah" choir pad with a slow swell.', { id: 'choir-aah', label: 'Choir aah', recipe: 'choir' }, 60, adsr(8, 4, 6, 0), true),
  snes('choir.ooh', 'choir-ooh', 'choir', 'Darker "ooh" choir for low, sustained chords.', { id: 'choir-ooh', label: 'Choir ooh', recipe: 'choir', params: { vowel: 'ooh' } }, 60, adsr(7, 4, 6, 0), true),
  snes('organ.drawbar', 'organ', 'organ', 'Drawbar organ: constant level, instant attack.', { id: 'organ', label: 'Organ', recipe: 'organ' }, 60, adsr(15, 7, 7, 0), false),
  snes('flute.breathy', 'flute', 'flute', 'Breathy flute with a chiff; solo or doubled melody.', { id: 'flute', label: 'Flute', recipe: 'flute' }, 72, adsr(11, 5, 6, 0), true),
  snes('brass.section', 'brass', 'brass', 'Brass section: blooming attack, sustained.', { id: 'brass', label: 'Brass', recipe: 'brass' }, 60, adsr(11, 5, 6, 0), true),
  snes('brass.stab', 'brass-stab', 'brass', 'Short brass stab for fanfares and orchestral hits.', { id: 'brass', label: 'Brass', recipe: 'brass' }, 60, adsr(15, 4, 3, 20), true),
  snes('pad.warm', 'pad', 'pad', 'Warm detuned saw pad with a soft attack; the classic SNES wash.', { id: 'pad-saw', label: 'Pad (saw)', recipe: 'pad' }, 60, adsr(6, 4, 7, 0), true),
  snes('pad.glass', 'pad-glass', 'pad', 'Glassy triangle pad, hollow and airy.', { id: 'pad-glass', label: 'Pad (glass)', recipe: 'pad', params: { wave: 'tri' } }, 60, adsr(5, 4, 7, 0), true),
  snes('pluck.pizz', 'pluck', 'pluck', 'Short plucked string (pizzicato / lute).', { id: 'pluck', label: 'Pluck', recipe: 'pluck' }, 60, adsr(15, 7, 7, 0), true),
  snes('pluck.harp', 'harp', 'pluck', 'Harp: smooth long-ringing string, ideal for arpeggios with echo.', { id: 'harp', label: 'Harp', recipe: 'harp' }, 60, adsr(15, 7, 7, 0), true),
  snes('pluck.guitar', 'guitar', 'pluck', 'Picked acoustic guitar string.', { id: 'guitar', label: 'Guitar', recipe: 'guitar' }, 52, adsr(15, 7, 7, 0), true),
  snes('pluck.koto', 'koto', 'pluck', 'Koto / kalimba-like bright pluck with a metallic tine.', { id: 'koto', label: 'Koto', recipe: 'koto' }, 64, adsr(15, 7, 7, 0), true),
  snes('bell.glock', 'bell', 'bell', 'FM bell / glockenspiel; rings out with echo.', { id: 'bell', label: 'Bell', recipe: 'bell' }, 72, adsr(15, 7, 7, 0), true),
  snes('arp.epiano', 'epiano', 'arp', 'FM electric piano: tine attack and a mellow body. Chords and arps.', { id: 'epiano', label: 'E-piano', recipe: 'epiano' }, 60, adsr(15, 7, 7, 0), true),
  snes('bass.synth', 'bass', 'bass', 'Low-passed saw bass loop, sustained and punchy.', { id: 'bass', label: 'Bass', recipe: 'bass' }, 36, adsr(15, 7, 7, 0), false),
  snes('bass.pick', 'bass-pick', 'bass', 'Picked bass: plucked attack, decays into a mellow sustain.', { id: 'bass-pick', label: 'Bass (pick)', recipe: 'bass', params: { style: 'pick' } }, 36, adsr(15, 5, 3, 21), false),
  snes('lead.saw', 'lead', 'lead', 'Sawtooth lead (single-cycle loop); bright and cutting, light echo.', { id: 'lead-saw', label: 'Lead (saw)', recipe: 'lead' }, 72, adsr(14, 7, 7, 0), true),
  snes('lead.square', 'lead-square', 'lead', 'Square lead (single-cycle loop); hollow, chiptune-flavoured.', { id: 'lead-square', label: 'Lead (square)', recipe: 'lead', params: { wave: 'square' } }, 72, adsr(14, 7, 7, 0), true),
  // ---- soft presets for calm music (ambient, lullaby, peaceful, mysterious-calm): slow attacks, held sustain, echo on
  snes('pad.soft-strings', 'pad-soft', 'pad', 'Soft strings pad: very slow bow attack, held, wide echo. The default pad for calm moods.', { id: 'strings', label: 'Strings', recipe: 'strings' }, 60, adsr(5, 4, 7, 0), true),
  snes('strings.swell', 'strings-swell', 'strings', 'Slow string swell for second chord tones; blends into the echo.', { id: 'strings', label: 'Strings', recipe: 'strings' }, 60, adsr(4, 4, 7, 0), true),
  snes('pad.dream', 'pad-dream', 'pad', 'Dreamy glassy pad: slowest attack, hollow and airy.', { id: 'pad-glass', label: 'Pad (glass)', recipe: 'pad', params: { wave: 'tri' } }, 60, adsr(3, 4, 7, 0), true),
  snes('bell.soft', 'bell-soft', 'bell', 'Soft music-box bell that rings out and fades by itself.', { id: 'bell', label: 'Bell', recipe: 'bell' }, 72, adsr(15, 6, 4, 19), true),
  snes('flute.soft', 'flute-soft', 'flute', 'Gentle breathy flute with a slower attack than "flute".', { id: 'flute', label: 'Flute', recipe: 'flute' }, 72, adsr(8, 5, 6, 0), true),
  snes('bass.soft', 'bass-soft', 'bass', 'Soft low bass: slower attack, sustained, no echo.', { id: 'bass', label: 'Bass', recipe: 'bass' }, 36, adsr(11, 5, 7, 0), false),
  snes('kick.drum', 'kick', 'kick', 'Kick drum: sine sweep with a click. Write at C-4.', { id: 'kick', label: 'Kick', recipe: 'kick' }, 60, adsr(15, 7, 7, 0), false),
  snes('snare.drum', 'snare', 'snare', 'Snare: 180 Hz tone plus noise. Echo makes it big.', { id: 'snare', label: 'Snare', recipe: 'snare' }, 60, adsr(15, 7, 7, 0), true),
  snes('hat.closed', 'hat', 'hihat', 'Closed hi-hat.', { id: 'hat', label: 'Hi-hat', recipe: 'hat' }, 60, adsr(15, 7, 7, 0), false),
  snes('openhat.open', 'openhat', 'openhat', 'Open hi-hat.', { id: 'openhat', label: 'Open hat', recipe: 'openhat' }, 60, adsr(15, 7, 7, 0), false),
  snes('crash.cymbal', 'crash', 'crash', 'Crash cymbal; use sparingly (large sample).', { id: 'crash', label: 'Crash', recipe: 'crash' }, 60, adsr(15, 7, 7, 0), true),
  snes('tom.drum', 'tom', 'tom', 'Tom drum; play different notes for different pitches (C-3 low, C-4 mid).', { id: 'tom', label: 'Tom', recipe: 'tom' }, 60, adsr(15, 7, 7, 0), true),
  snes('clap.hand', 'clap', 'clap', 'Hand clap with a noise tail.', { id: 'clap', label: 'Clap', recipe: 'clap' }, 60, adsr(15, 7, 7, 0), true)
]
