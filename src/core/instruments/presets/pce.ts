// PC Engine (HuC6280) preset bank. Conventions:
//  - pce-wave: `waves` = one or more 32-sample waves (values 0..31); the timbre macro / Wxx picks the wave index.
//  - `noise: true` turns the channel into the noise generator and only works on C5 and C6. Noise instruments
//    use a 'fixed' arp macro holding the noise divider index 0..31 (31 = highest pitch).
//  - Everything plays on 'pce-wave' channels; the kick is a pitch-dropping wave and works on any channel.

import type { Macro, Macros, PceWaveInstrument } from '../../types'
import { createMacro } from '../macros'
import type { Preset } from './types'

const range32 = (f: (i: number) => number): number[] =>
  Array.from({ length: 32 }, (_, i) => Math.max(0, Math.min(31, Math.round(f(i)))))

const harm = (parts: Array<[h: number, amp: number, phase?: number]>): number[] =>
  range32((i) => 15.5 + parts.reduce((s, [h, a, p = 0]) => s + a * Math.sin((2 * Math.PI * h * i) / 32 + p), 0))

export const PCE_WAVES = {
  sine: range32((i) => 15.5 + 15.5 * Math.sin((2 * Math.PI * i) / 32)),
  saw: range32((i) => i),
  square: range32((i) => (i < 16 ? 31 : 0)),
  pulse25: range32((i) => (i < 8 ? 31 : 0)),
  pulse12: range32((i) => (i < 4 ? 31 : 0)),
  triangle: range32((i) => (i < 16 ? i * 2 : 62 - i * 2)),
  bright: harm([[1, 9], [2, 4.5, 0.6], [3, 3.5, 1.2], [5, 2, 0.3]]),
  organ: harm([[1, 8], [2, 5], [3, 2.5], [4, 3], [6, 1.5]]),
  soft: harm([[1, 11], [2, 3], [3, 1]]),
  strings: harm([[1, 7], [2, 4.5, 0.4], [3, 3, 0.9], [4, 2, 0.2], [5, 1.5, 1.1]]),
  vox: harm([[1, 8], [2, 2], [3, 6, 1], [4, 1], [5, 4.5, 2.2]])
}

const vibrato = (): Macro => ({ values: [0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, -3, -3, 0], loop: 8 })
const hold = (v: number[]): Macro => createMacro(v, { hold: true })

function wave(
  id: string, name: string, role: Preset['role'], description: string,
  waves: number[][], macros: Macros = {}, noise = false
): Preset {
  const instrument: PceWaveInstrument = { name, kind: 'pce-wave', waves: waves.map((w) => [...w]), macros, ...(noise ? { noise: true } : {}) }
  return { id: `pce.${id}`, name, role, description, channelKinds: ['pce-wave'], instrument }
}

const noiseDrum = (
  id: string, name: string, role: Preset['role'], description: string, vol: number[], pitches: number[]
): Preset =>
  wave(id, name, role, `${description} (noise: only on C5/C6)`, [PCE_WAVES.sine], {
    vol: { values: vol, loop: vol.length - 1 },
    arp: { values: pitches, loop: pitches.length - 1, mode: 'fixed' }
  }, true)

export const PCE_PRESETS: Preset[] = [
  wave('lead.saw', 'lead', 'lead', 'Bright saw-wave lead (default).', [PCE_WAVES.saw]),
  wave('lead.sine', 'lead-sine', 'lead', 'Smooth sine lead.', [PCE_WAVES.sine]),
  wave('lead.square', 'lead-square', 'lead', 'Hollow square lead.', [PCE_WAVES.square]),
  wave('lead.bright', 'lead-bright', 'lead', 'PCE lead: harmonically rich bright wave.', [PCE_WAVES.bright]),
  wave('lead.vibrato', 'lead-vib', 'lead', 'Bright lead with delayed vibrato.', [PCE_WAVES.bright], { pitch: vibrato() }),
  wave('lead.pwm', 'lead-pwm', 'lead', 'Pulse-width sweep: the timbre macro steps through 50%, 25% and 12.5% pulses.', [PCE_WAVES.square, PCE_WAVES.pulse25, PCE_WAVES.pulse12, PCE_WAVES.pulse25], {
    timbre: { values: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3], loop: 0 }
  }),
  wave('bass.saw', 'bass', 'bass', 'Saw-wave bass (default): buzzy and strong.', [PCE_WAVES.saw]),
  wave('bass.sine', 'bass-sine', 'bass', 'Round sine bass for sub-heavy lines.', [PCE_WAVES.sine]),
  wave('bass.square', 'bass-square', 'bass', 'Hollow square-wave bass.', [PCE_WAVES.square]),
  wave('pad.soft', 'pad', 'pad', 'Soft wave with a slow volume swell for sustained chords.', [PCE_WAVES.soft], {
    vol: { values: [4, 6, 8, 10, 12, 13, 14, 15], loop: 7 }
  }),
  wave('strings.wave', 'strings', 'strings', 'String-like wave with a slow swell and light vibrato.', [PCE_WAVES.strings], {
    vol: { values: [5, 8, 11, 13, 14, 15], loop: 5 }, pitch: vibrato()
  }),
  wave('choir.wave', 'choir', 'choir', 'Vocal-ish wave pad with a slow attack.', [PCE_WAVES.vox], {
    vol: { values: [3, 5, 7, 9, 11, 12, 12], loop: 6 }
  }),
  wave('organ.wave', 'organ', 'organ', 'Organ wave: constant volume with strong harmonics.', [PCE_WAVES.organ]),
  wave('flute.sine', 'flute', 'flute', 'Sine flute with delayed vibrato.', [PCE_WAVES.sine], { pitch: vibrato(), vol: { values: [10, 12, 13, 13], loop: 3 } }),
  wave('brass.wave', 'brass', 'brass', 'Bright brass stab: fast decay to a sustain.', [PCE_WAVES.bright], {
    vol: { values: [15, 15, 13, 11, 10, 10], loop: 5 }
  }),
  wave('pluck.wave', 'pluck', 'pluck', 'Plucked wave with a short decaying volume macro.', [PCE_WAVES.bright], {
    vol: { values: [15, 12, 9, 6, 4, 2, 1, 0], loop: 7 }
  }),
  wave('bell.chime', 'bell', 'bell', 'Bell: sine with a long decay and an octave-up blip.', [PCE_WAVES.sine], {
    vol: { values: [15, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], loop: 14 },
    arp: createMacro([12, 0], { mode: 'rel', loop: 1 })
  }),
  wave('arp.wave', 'arp', 'arp', 'Arpeggio voice: square wave at medium volume.', [PCE_WAVES.square], { vol: hold([11]) }),
  wave('arp.pulse', 'arp-pulse', 'arp', 'Arpeggio voice: thin 25% pulse, softer.', [PCE_WAVES.pulse25], { vol: hold([9]) }),
  wave('sfx.zap', 'zap', 'sfx', 'Falling zap: saw wave with a fast downward pitch slide.', [PCE_WAVES.saw], {
    vol: { values: [15, 14, 12, 10, 8, 6, 4, 2, 0], loop: 8 }, pitch: { values: [-40, -40, -40, -40, -40, -40, -40, -40, 0], loop: 8 }
  }),
  wave('kick.drop', 'kick', 'kick', 'Kick: sine with a fast pitch drop (fixed arp). Works on any channel.', [PCE_WAVES.sine], {
    vol: { values: [15, 15, 14, 12, 10, 8, 5, 2, 0], loop: 8 },
    arp: { values: [62, 55, 48, 42, 38, 35, 33, 31, 31], loop: 8, mode: 'fixed' }
  }),
  wave('tom.drop', 'tom', 'tom', 'Tom: triangle with a medium pitch drop. Works on any channel; vary the note for fills.', [PCE_WAVES.triangle], {
    vol: { values: [15, 14, 12, 10, 8, 6, 3, 1, 0], loop: 8 },
    arp: { values: [12, 6, 3, 1, 0, 0, 0, 0, 0], loop: 8, mode: 'rel' }
  }),
  noiseDrum('snare.noise', 'snare', 'snare', 'Noise snare: mid-high pitch, medium decay.', [15, 13, 10, 8, 6, 4, 3, 2, 1, 0], [24, 24, 22, 21, 20, 19, 19, 18, 18, 18]),
  noiseDrum('hat.noise', 'hat', 'hihat', 'Closed hi-hat: very short high noise.', [9, 5, 2, 0], [31]),
  noiseDrum('openhat.noise', 'openhat', 'openhat', 'Open hi-hat: longer high noise decay.', [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], [31]),
  noiseDrum('crash.noise', 'crash', 'crash', 'Crash cymbal: long noise hiss.', [15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], [30, 30, 29, 29, 28, 28, 27]),
  noiseDrum('clap.noise', 'clap', 'clap', 'Hand clap: three quick noise bursts.', [15, 0, 12, 0, 10, 6, 3, 1, 0], [26])
]
