// Game Boy preset bank (DMG). Conventions:
//  - gb-pulse: env = hardware volume envelope (init 0..15, pace 0..7 steps of 1/64 s, 0 = constant); duty 0..3.
//  - gb-wave: 32 samples 0..15 and a hardware level (1 = 100%, 2 = 50%, 3 = 25%); volume has only 4 steps.
//  - gb-noise: arp macro in 'fixed' mode holds noise pitch indices 0..15 (15 = highest pitch);
//    `short: true` selects the 7-bit (metallic) LFSR.

import type { GbPulseInstrument, Macro, Macros } from '../../types'
import { createMacro } from '../macros'
import type { Preset } from './types'

const range32 = (f: (i: number) => number): number[] =>
  Array.from({ length: 32 }, (_, i) => Math.max(0, Math.min(15, Math.round(f(i)))))

export const GB_WAVES = {
  saw: range32((i) => i / 2),
  square: range32((i) => (i < 16 ? 15 : 0)),
  pulse25: range32((i) => (i < 8 ? 15 : 0)),
  triangle: range32((i) => (i < 16 ? i : 31 - i)),
  sine: range32((i) => 7.5 + 7.5 * Math.sin((2 * Math.PI * i) / 32)),
  organ: range32((i) => {
    const t = (2 * Math.PI * i) / 32
    return 7.5 + 4 * Math.sin(t) + 2.2 * Math.sin(2 * t) + 1.3 * Math.sin(4 * t)
  }),
  bright: range32((i) => 7.5 + 4.5 * Math.sin((2 * Math.PI * i) / 32) + 3 * Math.sin((6 * Math.PI * i) / 32 + 1))
}

const vibrato = (): Macro => ({ values: [0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, -3, -3, 0], loop: 8 })

function pulse(
  id: string, name: string, role: Preset['role'], description: string,
  duty: 0 | 1 | 2 | 3, init: number, pace: number, macros?: Macros, sweep?: GbPulseInstrument['sweep']
): Preset {
  return {
    id: `gb.${id}`, name, role, description, channelKinds: ['pulse'],
    instrument: { name, kind: 'gb-pulse', duty, env: { init, dir: 'down', pace }, ...(macros ? { macros } : {}), ...(sweep ? { sweep } : {}) }
  }
}

function wave(
  id: string, name: string, role: Preset['role'], description: string,
  w: number[], level: 0 | 1 | 2 | 3, macros?: Macros
): Preset {
  return {
    id: `gb.${id}`, name, role, description, channelKinds: ['wave'],
    instrument: { name, kind: 'gb-wave', wave: [...w], level, ...(macros ? { macros } : {}) }
  }
}

function noise(
  id: string, name: string, role: Preset['role'], description: string,
  init: number, pace: number, short: boolean, pitches: number[]
): Preset {
  return {
    id: `gb.${id}`, name, role, description, channelKinds: ['noise'],
    instrument: {
      name, kind: 'gb-noise', env: { init, dir: 'down', pace }, short,
      macros: { arp: { values: pitches, loop: pitches.length - 1, mode: 'fixed' } }
    }
  }
}

export const GB_PRESETS: Preset[] = [
  pulse('lead.duty25', 'lead', 'lead', 'Classic 25% pulse lead (default), constant volume.', 1, 15, 0),
  pulse('lead.duty50', 'lead-square', 'lead', 'Full 50% square lead, constant volume.', 2, 15, 0),
  pulse('lead.duty12', 'lead-thin', 'lead', 'Thin 12.5% pulse lead: bright and nasal.', 0, 15, 0),
  pulse('lead.vibrato', 'lead-vib', 'lead', 'Duty 50% lead with delayed vibrato.', 2, 15, 0, { pitch: vibrato() }),
  pulse('lead.sweep', 'lead-sweep', 'sfx', 'Rising pitch sweep (P1 only): power-up and laser sounds.', 2, 13, 3, undefined, { pace: 2, dir: 'up', step: 3 }),
  pulse('flute.soft', 'flute', 'flute', 'Soft 50% pulse with vibrato at reduced volume.', 2, 10, 0, { pitch: vibrato() }),
  pulse('brass.stab', 'brass', 'brass', 'Bright 75% pulse with a decaying envelope.', 3, 15, 2),
  pulse('pluck.pulse', 'pluck', 'pluck', 'Plucked 25% pulse: fast hardware decay.', 1, 15, 2),
  pulse('arp.duty25', 'arp', 'arp', 'Arpeggio voice: 25% pulse at medium volume.', 1, 11, 0),
  pulse('arp.duty50', 'arp-square', 'arp', 'Arpeggio voice: 50% pulse, softer.', 2, 9, 0),
  pulse('pad.soft', 'pad', 'pad', 'Quiet 12.5% pulse for sustained chord tones.', 0, 7, 0),
  pulse('bell.chime', 'bell', 'bell', 'Bell: 50% pulse with a slow decay and octave-up blip.', 2, 15, 4, { arp: createMacro([12, 0], { mode: 'rel', loop: 1 }) }),
  // soft presets for calm music: slow swell, long release (the vol macro continues after key-off)
  pulse('pad.soft-square', 'pad-soft-square', 'pad', 'Soft 50% square pad: slow swell, long release. The default pad for calm moods.', 2, 9, 0, {
    vol: { values: [3, 4, 5, 6, 7, 8, 9, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1, 0], loop: 7, release: 8 }
  }),
  pulse('lead.soft-square', 'lead-soft-square', 'lead', 'Soft 50% square lead: gentle swell, long release.', 2, 10, 0, {
    vol: { values: [6, 8, 9, 10, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2, 1, 1, 0], loop: 3, release: 4 }
  }),
  pulse('bell.soft', 'bell-soft', 'bell', 'Soft 25% pulse bell: quiet attack that fades slowly.', 1, 9, 4),
  wave('bass.wave-soft', 'bass-soft', 'bass', 'Sine-like wave bass: round and quiet.', GB_WAVES.sine, 1),
  wave('bass.wave-saw', 'bass', 'bass', 'Saw-wave bass at full level (default for WV): buzzy and strong.', GB_WAVES.saw, 1),
  wave('bass.wave-square', 'bass-square', 'bass', 'Square-ish wave bass: hollow, classic.', GB_WAVES.square, 1),
  wave('bass.wave-tri', 'bass-tri', 'bass', 'Triangle-wave bass: soft and round.', GB_WAVES.triangle, 1),
  wave('lead.wave-sine', 'lead-sine', 'lead', 'Sine-like wave lead: smooth and mellow.', GB_WAVES.sine, 1),
  wave('pad.wave-soft', 'pad-wave', 'pad', 'Soft sine pad at half level.', GB_WAVES.sine, 2),
  wave('organ.wave', 'organ', 'organ', 'Organ-like wave with 2nd and 4th harmonics.', GB_WAVES.organ, 2),
  wave('pluck.wave', 'pluck-wave', 'pluck', 'Wave pluck: bright wave whose level steps down (100% to 25% to mute).', GB_WAVES.bright, 1, {
    vol: { values: [15, 15, 8, 8, 4, 4, 0], loop: 6 }
  }),
  wave('strings.wave', 'strings', 'strings', 'Soft bright wave at half level for a string-like pad.', GB_WAVES.bright, 2),
  noise('kick.noise', 'kick', 'kick', 'Low noise burst: kick.', 15, 2, false, [6, 4, 2, 1, 0]),
  noise('snare.noise', 'snare', 'snare', 'Mid noise burst: snare.', 15, 2, false, [11, 10, 9, 9]),
  noise('hat.noise', 'hat', 'hihat', 'Short metallic noise tick: closed hat.', 9, 1, true, [15]),
  noise('openhat.noise', 'openhat', 'openhat', 'Longer metallic noise: open hat.', 11, 4, true, [15]),
  noise('crash.noise', 'crash', 'crash', 'Long hiss: crash cymbal.', 15, 7, false, [14, 13, 12]),
  noise('clap.noise', 'clap', 'clap', 'Medium-high noise burst: clap.', 14, 2, false, [12, 12]),
  noise('tom.noise', 'tom', 'tom', 'Low-mid noise burst: tom.', 15, 3, false, [7, 6, 5, 5])
]
