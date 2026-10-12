// Genesis preset bank (YM2612 FM + SN76489 PSG). All patches are original, written in the style of well-known
// Genesis sounds (slap bass, brass stabs, tine e-piano, string ensembles ...).
//
// FM conventions (see synth/chips/ym2612.ts):
//  - ops are OP1..OP4 in diagram order; algorithm carriers: 0-3 -> OP4, 4 -> OP2+OP4, 5/6 -> OP2+OP3+OP4, 7 -> all.
//  - lower tl = louder; the cell volume is added to the carriers' TL (v15 = 0 dB, v8 = -5.5 dB).
//  - rate fields: ar 31 = instant attack, dr/sr 0 = hold, rr 15 = fast release (~7 ms), 4 = slow (~2 s).
//  - FM drums use a 'fixed' arp macro (absolute MIDI notes) so the hit sounds the same whatever note is written
//    (write drums at C-4, the default of write_drums); tom follows the note with a relative pitch drop.
// PSG conventions:
//  - psg (S1..S3): the vol macro 0..15 multiplies the cell volume; the chip rounds the result to 2 dB steps.
//  - psg-noise (NO): the 'fixed' arp macro holds absolute MIDI notes that pick the noise rate:
//    note >= 48: rate = note mod 3 (C-4 = fast/bright, C#4 = medium, D-4 = slow/dull); note < 48: pitched
//    (periodic noise sounds at the note). timbre 0 = white, 1 = periodic.

import type { FmInstrument, FmOp, Macro, Macros } from '../../types'
import type { Preset } from './types'

const hold = (values: number[], release?: number[]): Macro =>
  release
    ? { values: [...values, ...release], loop: values.length - 1, release: values.length }
    : { values: [...values], loop: values.length - 1 }

/** Slow delayed vibrato: the values sum to zero over a cycle. */
const vibrato = (): Macro => ({ values: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 3, 2, 0, -2, -3, -3, -2, 0], loop: 12 })

/** FM operator: attack, decay, sustain rate, release, sustain level, total level, multiplier, detune, key scale. */
function o(ar: number, dr: number, sr: number, rr: number, sl: number, tl: number, ml: number, dt = 0, ks = 0): FmOp {
  return { ar, dr, sr, rr, sl, tl, ks, ml, dt }
}
/** A muted operator (tl 127), for algorithms where fewer than four operators are wanted. */
const OFF: FmOp = o(31, 0, 0, 15, 0, 127, 1)

function fm(
  id: string, name: string, role: Preset['role'], description: string,
  alg: number, fb: number, ops: [FmOp, FmOp, FmOp, FmOp], macros?: Macros, lfo?: { ams?: number; pms?: number }
): Preset {
  const instrument: FmInstrument = { name, kind: 'fm', alg, fb, ams: lfo?.ams ?? 0, pms: lfo?.pms ?? 0, ops }
  if (macros) instrument.macros = macros
  return { id: `genesis.${id}`, name, role, description, channelKinds: ['fm'], instrument }
}

function psg(id: string, name: string, role: Preset['role'], description: string, macros: Macros): Preset {
  return { id: `genesis.${id}`, name, role, description, channelKinds: ['psg-square'], instrument: { name, kind: 'psg', macros } }
}

function noise(
  id: string, name: string, role: Preset['role'], description: string, macros: Macros, periodic = false
): Preset {
  return {
    id: `genesis.${id}`, name, role, description, channelKinds: ['psg-noise'],
    instrument: { name, kind: 'psg-noise', macros, ...(periodic ? { noiseMode: 'periodic' as const } : {}) }
  }
}

const fixedArp = (values: number[]): Macro => ({ values, loop: values.length - 1, mode: 'fixed' })

export const GENESIS_PRESETS: Preset[] = [
  // --- bass ---------------------------------------------------------------------------------------------------
  fm('bass.slap', 'bass', 'bass', 'Slap bass (default bass, F1): alg 4, a bright percussive click on top of a round body. A-1..C-3.', 4, 5, [
    o(31, 16, 10, 8, 6, 32, 1), o(31, 10, 6, 9, 3, 6, 1), o(31, 22, 12, 8, 4, 40, 4), o(31, 12, 7, 9, 3, 8, 1)
  ]),
  fm('bass.synth', 'bass-synth', 'bass', 'Synth bass: alg 0 chain with strong OP1 feedback, buzzy and fat. Good for driving 8th-note lines.', 0, 6, [
    o(31, 6, 3, 8, 2, 38, 1), o(31, 8, 4, 8, 2, 30, 1), o(31, 8, 4, 8, 2, 26, 1, 3), o(31, 5, 2, 9, 1, 4, 1)
  ]),
  fm('bass.finger', 'bass-finger', 'bass', 'Finger bass: alg 4, softer attack and a warm decay. Walking lines and ballads.', 4, 3, [
    o(31, 12, 6, 9, 5, 36, 1), o(31, 8, 4, 9, 2, 6, 1), o(31, 18, 8, 9, 5, 44, 2), o(31, 9, 4, 9, 2, 8, 1, 2)
  ]),
  fm('bass.sub', 'bass-sub', 'bass', 'Sub bass: nearly a pure sine plus a faint 2nd harmonic. Long notes under busy music.', 7, 1, [
    o(31, 6, 2, 10, 2, 2, 1), o(31, 10, 5, 10, 3, 36, 2), OFF, OFF
  ]),
  fm('bass.growl', 'bass-growl', 'bass', 'Growling bass: alg 1 with maximum feedback; boss fights and dark themes.', 1, 7, [
    o(31, 4, 0, 8, 0, 30, 1), o(31, 4, 0, 8, 0, 26, 2), o(31, 6, 3, 8, 2, 22, 1), o(31, 5, 2, 8, 1, 4, 1, 3)
  ]),
  // --- lead ---------------------------------------------------------------------------------------------------
  fm('lead.saw', 'lead', 'lead', 'Saw-like lead (default lead): OP1 feedback into a carrier, a detuned second layer, slow vibrato.', 4, 6, [
    o(31, 5, 2, 8, 1, 26, 1), o(31, 4, 2, 9, 1, 6, 1), o(31, 5, 2, 8, 1, 34, 1), o(31, 4, 2, 9, 1, 10, 1, 3)
  ], { pitch: vibrato() }),
  fm('lead.square', 'lead-square', 'lead', 'Square-ish lead built additively (alg 7: fundamental + 3rd, 5th, 7th harmonics). Hollow and clear.', 7, 0, [
    o(31, 4, 0, 10, 0, 6, 1), o(31, 4, 0, 10, 0, 19, 3), o(31, 4, 0, 10, 0, 25, 5), o(31, 4, 0, 10, 0, 29, 7)
  ]),
  fm('lead.brass', 'lead-brass', 'lead', 'Brassy lead: a slightly slower attack than the stab, strong mids. Heroic melodies.', 4, 5, [
    o(24, 8, 4, 8, 3, 24, 1, 0, 1), o(26, 6, 3, 8, 2, 6, 1, 0, 1), o(24, 10, 5, 8, 4, 30, 1, 0, 1), o(26, 6, 3, 8, 2, 8, 1, 2, 1)
  ], { pitch: vibrato() }),
  // --- brass --------------------------------------------------------------------------------------------------
  fm('brass.stab', 'brass', 'brass', 'Brass stab (default brass): alg 4, bright attack that settles quickly. Fanfare hits and offbeat stabs.', 4, 5, [
    o(26, 14, 8, 9, 6, 22, 1), o(28, 12, 6, 9, 4, 6, 1), o(26, 16, 8, 9, 6, 28, 1, 1), o(28, 12, 6, 9, 4, 8, 1, 2)
  ]),
  fm('brass.swell', 'brass-swell', 'brass', 'Sustained brass section with a soft swell. Long fanfare chords.', 4, 4, [
    o(18, 6, 2, 7, 2, 26, 1), o(20, 5, 2, 7, 1, 6, 1), o(18, 6, 2, 7, 3, 32, 1, 1), o(20, 5, 2, 7, 1, 8, 1, -2)
  ], { pitch: vibrato() }),
  // --- strings / pads / choir ---------------------------------------------------------------------------------
  fm('strings.slow', 'strings', 'strings', 'String ensemble (default strings): alg 5, three detuned carriers, slow attack. Chords of 2-8 bars.', 5, 3, [
    o(14, 4, 2, 6, 1, 34, 1), o(12, 4, 1, 6, 1, 14, 1, 3), o(12, 4, 1, 6, 1, 14, 1, -3), o(12, 4, 1, 6, 1, 18, 2)
  ], { pitch: vibrato() }),
  fm('pad.warm', 'pad', 'pad', 'Warm pad (default pad): alg 5 with a gentle modulator, slow swell and a long release.', 5, 2, [
    o(10, 4, 1, 5, 1, 48, 1), o(10, 4, 1, 5, 1, 14, 1, 2), o(10, 4, 1, 5, 1, 14, 1, -2), o(10, 4, 1, 5, 1, 18, 2)
  ]),
  fm('choir.aah', 'choir', 'choir', 'Choir "aah": alg 2 with vowel-like mid harmonics and a slow attack. Sad and sacred themes.', 2, 3, [
    o(14, 5, 2, 6, 2, 36, 1), o(14, 5, 2, 6, 2, 32, 3), o(14, 5, 2, 6, 2, 26, 1), o(13, 5, 2, 6, 2, 8, 1, 2)
  ], { pitch: vibrato() }),
  // --- keys ---------------------------------------------------------------------------------------------------
  fm('epiano.tine', 'epiano', 'pluck', 'Tine electric piano: alg 4 with a high-ratio modulator that dies away fast. Chords and comping.', 4, 2, [
    o(31, 22, 10, 9, 8, 36, 14), o(31, 9, 4, 8, 3, 8, 1), o(31, 14, 6, 9, 5, 38, 1), o(31, 10, 4, 8, 3, 10, 1, 2)
  ]),
  fm('epiano.soft', 'epiano-soft', 'pad', 'Soft electric piano: alg 5, mellow, sustains for shops and ballads.', 5, 1, [
    o(31, 14, 6, 8, 5, 38, 1), o(31, 8, 4, 8, 3, 10, 1), o(31, 10, 5, 8, 4, 14, 2), o(31, 8, 4, 8, 3, 16, 1, -2)
  ]),
  fm('organ.drawbar', 'organ', 'organ', 'Drawbar organ: alg 7, four harmonics at fixed levels, no decay. Church and castle themes.', 7, 1, [
    o(31, 0, 0, 12, 0, 10, 1), o(31, 0, 0, 12, 0, 14, 2), o(31, 0, 0, 12, 0, 22, 4), o(31, 0, 0, 12, 0, 20, 3)
  ]),
  // --- bells / plucks / winds ---------------------------------------------------------------------------------
  fm('bell.chime', 'bell', 'bell', 'Bell (default bell): alg 4 with high multipliers (7, 14, 3) for inharmonic partials and a long ring.', 4, 2, [
    o(31, 12, 5, 6, 6, 32, 7), o(31, 8, 5, 6, 5, 10, 1), o(31, 18, 8, 7, 8, 40, 14), o(31, 10, 6, 6, 6, 18, 3)
  ]),
  fm('pluck.guitar', 'pluck', 'pluck', 'Plucked guitar / harp (default pluck): alg 2, the brightness decays with the note.', 2, 5, [
    o(31, 18, 10, 9, 6, 30, 1), o(31, 16, 8, 9, 6, 36, 1), o(31, 20, 10, 9, 6, 28, 2), o(31, 12, 6, 9, 4, 6, 1)
  ]),
  fm('flute.soft', 'flute', 'flute', 'Soft flute: nearly sine with a little breathy feedback and delayed vibrato.', 4, 3, [
    o(18, 5, 2, 8, 2, 44, 1), o(20, 4, 2, 8, 1, 6, 1), OFF, OFF
  ], { pitch: vibrato() }),
  fm('arp.chip', 'arp', 'arp', 'FM arpeggio voice (default arp): bright and short with a bell-like second layer. Use 0xy arpeggios.', 4, 3, [
    o(31, 20, 14, 10, 8, 30, 1), o(31, 14, 8, 10, 5, 10, 1), o(31, 24, 16, 10, 9, 36, 3), o(31, 16, 10, 10, 6, 16, 1)
  ]),
  // --- FM drums (F6 when it is not a DAC) ---------------------------------------------------------------------
  fm('kick.fm', 'kick-fm', 'kick', 'FM kick (F6 without DAC): a single sine operator with a fast pitch drop (fixed arp macro, any note).', 7, 3, [
    o(31, 18, 14, 15, 15, 0, 1), OFF, OFF, OFF
  ], { arp: fixedArp([66, 58, 52, 47, 44, 41, 39, 38, 36]) }),
  fm('snare.fm', 'snare-fm', 'snare', 'FM snare: alg 4 with maximum feedback on a high-ratio modulator for the noise, plus a short body tone.', 4, 7, [
    o(31, 22, 18, 12, 15, 16, 13), o(31, 21, 16, 12, 15, 4, 3), o(31, 19, 14, 12, 15, 30, 1), o(31, 18, 14, 12, 15, 8, 1)
  ], { arp: fixedArp([57, 55, 54]) }),
  fm('tom.fm', 'tom-fm', 'tom', 'FM tom: sine with a short pitch drop below the written note. Play fills from C-3 to C-4.', 7, 1, [
    o(31, 16, 10, 12, 12, 2, 1), o(31, 18, 12, 12, 14, 24, 2), OFF, OFF
  ], { arp: { values: [10, 6, 3, 1, 0], loop: 4, mode: 'rel' } }),
  fm('hat.fm', 'hat-fm', 'hihat', 'FM hi-hat: four detuned high-ratio operators with feedback, very short.', 7, 7, [
    o(31, 24, 24, 15, 15, 10, 15), o(31, 24, 24, 15, 15, 14, 11), o(31, 24, 24, 15, 15, 16, 13), o(31, 24, 24, 15, 15, 18, 9)
  ], { arp: fixedArp([72]) }),
  fm('crash.fm', 'crash-fm', 'crash', 'FM crash cymbal: the hi-hat patch with a long decay.', 7, 7, [
    o(31, 16, 14, 8, 15, 10, 15), o(31, 16, 14, 8, 15, 14, 11), o(31, 16, 14, 8, 15, 16, 13), o(31, 16, 14, 8, 15, 18, 9)
  ], { arp: fixedArp([72]) }),
  // --- PSG squares (S1..S3) -----------------------------------------------------------------------------------
  psg('lead.psg', 'lead-psg', 'lead', 'PSG square lead (default lead on S1..S3): steady volume with a short release and slow vibrato. A-2 and up.', {
    vol: hold([15], [8, 4, 0]), pitch: vibrato()
  }),
  psg('arp.psg', 'arp-psg', 'arp', 'PSG arpeggio voice (default arp on S1..S3): quick decay to a soft sustain; use 0xy chords.', {
    vol: hold([14, 12, 10, 9, 8], [5, 2, 0])
  }),
  psg('lead.psg-echo', 'lead-echo', 'lead', 'PSG lead with a stepped echo: the volume drops every 6 ticks like repeated notes.', {
    vol: { values: [15, 15, 15, 15, 15, 15, 8, 8, 8, 8, 8, 8, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3], loop: 18 }
  }),
  psg('sfx.psg-zap', 'zap-psg', 'sfx', 'PSG laser zap: fast downward pitch slide with a falling volume.', {
    vol: { values: [15, 14, 12, 10, 8, 6, 4, 2, 0], loop: 8 }, pitch: { values: [-24, -24, -20, -16, -12, -8, -6, -4, -2], loop: 8 }
  }),
  // --- PSG noise (NO) -----------------------------------------------------------------------------------------
  noise('hihat.noise', 'hihat', 'hihat', 'Closed hi-hat (default for NO): very short white noise at the fastest rate (6991 Hz). Play at C-4.', {
    vol: { values: [11, 5, 2, 0], loop: 3 }, arp: fixedArp([60])
  }),
  noise('openhat.noise', 'openhat', 'openhat', 'Open hi-hat: bright white noise with a longer decay.', {
    vol: { values: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], loop: 12 }, arp: fixedArp([60])
  }),
  noise('snare.noise', 'snare', 'snare', 'Snare: a short pitched thump, then white noise at the medium rate (3496 Hz).', {
    vol: { values: [15, 15, 13, 11, 9, 7, 5, 4, 3, 2, 1, 0], loop: 11 }, arp: fixedArp([40, 44, 61, 61, 61, 61, 61, 61, 61, 61, 61, 61]),
    timbre: { values: [1, 1, 0], loop: 2 }
  }),
  noise('crash.noise', 'crash', 'crash', 'Crash cymbal: long white noise, bright at first and duller at the end.', {
    vol: { values: [15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], loop: 23 },
    arp: fixedArp([60, 60, 60, 60, 60, 60, 61, 61, 61, 61, 61, 61, 62])
  }),
  noise('kick.noise', 'kick', 'kick', 'Noise kick (kick on NO): periodic noise whose pitch falls from 123 Hz to 62 Hz, a thin synthetic thump.', {
    vol: { values: [15, 15, 15, 14, 12, 10, 8, 6, 4, 2, 0], loop: 10 }, arp: fixedArp([47, 45, 43, 41, 39, 37, 36]), timbre: { values: [1], loop: 0 }
  }, true)
]
