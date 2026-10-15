// NES preset bank (2A03). Macro conventions:
//  - nes-pulse timbre macro: duty 0..3 (12.5/25/50/75%); vol macro: 0..15 multiplier of the cell volume.
//  - nes-noise: arp macro in 'fixed' mode holds noise pitch indices 0..15 (15 = highest pitch);
//    timbre 0 = long LFSR (hiss), 1 = short 93-step LFSR (metallic).
//  - nes-tri: no volume; a vol macro only gates (0 = off).

import type { Macro, Macros } from '../../types'
import { createMacro } from '../macros'
import type { Preset } from './types'

const hold = (values: number[], release?: number[]): Macro =>
  release
    ? { values: [...values, ...release], loop: values.length - 1, release: values.length }
    : { values: [...values], loop: values.length - 1 }

/** Slow vibrato: delay, then +-1/16-semitone-ish steps that sum to zero over a cycle. */
const vibrato = (): Macro => ({ values: [0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, -3, -3, 0], loop: 8 })

function pulse(
  id: string, name: string, role: Preset['role'], description: string, macros: Macros
): Preset {
  return { id: `nes.${id}`, name, role, description, channelKinds: ['pulse'], instrument: { name, kind: 'nes-pulse', macros } }
}

export const NES_PRESETS: Preset[] = [
  pulse('lead.duty25', 'lead', 'lead', 'Classic 25% pulse lead (default). Constant volume with a short release.', { vol: hold([15], [8, 4, 0]), timbre: hold([1]) }),
  pulse('lead.duty12', 'lead-thin', 'lead', 'Thin 12.5% pulse lead: sharp, nasal, cuts through.', { vol: hold([15]), timbre: hold([0]) }),
  pulse('lead.duty50', 'lead-square', 'lead', 'Full 50% square lead: hollow and strong.', { vol: hold([15], [8, 4, 0]), timbre: hold([2]) }),
  pulse('lead.vibrato', 'lead-vib', 'lead', 'Duty 50% lead with delayed vibrato for long notes.', { vol: hold([15], [8, 4, 0]), timbre: hold([2]), pitch: vibrato() }),
  pulse('lead.pwm', 'lead-pwm', 'lead', 'Lead whose duty cycles 25/50/75/50% for a chorus-like shimmer.', { vol: hold([14]), timbre: { values: [1, 2, 3, 2], loop: 0 } }),
  pulse('flute.soft', 'flute', 'flute', 'Soft 50% pulse with a slow volume swell and light vibrato.', { vol: hold([4, 6, 8, 10, 11, 12], [8, 4, 0]), timbre: hold([2]), pitch: vibrato() }),
  pulse('brass.stab', 'brass', 'brass', 'Short bright 75%-duty stab with a quick decay.', { vol: hold([15, 15, 13, 11, 9, 8], [4, 0]), timbre: hold([3]) }),
  pulse('pluck.stab', 'pluck', 'pluck', 'Short plucked 25% pulse: fast decay.', { vol: { values: [15, 12, 9, 7, 5, 4, 3, 2, 1, 0], loop: 9 }, timbre: hold([1]) }),
  pulse('pluck.duty50', 'pluck-square', 'pluck', 'Plucked 50% pulse with a medium decay.', { vol: { values: [15, 14, 12, 10, 8, 7, 6, 5, 4, 3, 2, 1, 0], loop: 12 }, timbre: hold([2]) }),
  pulse('arp.duty25', 'arp', 'arp', 'Arpeggio voice: 25% pulse at medium volume, sits under the lead.', { vol: hold([11], [6, 3, 0]), timbre: hold([1]) }),
  pulse('arp.duty50', 'arp-square', 'arp', 'Arpeggio voice: 50% pulse, softer.', { vol: hold([10], [5, 2, 0]), timbre: hold([2]) }),
  pulse('pad.soft', 'pad', 'pad', 'Slow-swell 12.5% pulse pad for long chord tones.', { vol: hold([0, 2, 4, 6, 8, 9, 10], [6, 3, 0]), timbre: hold([0]) }),
  pulse('organ.duty50', 'organ', 'organ', 'Steady 50% pulse with constant level and a tremolo-like dip.', { vol: { values: [11, 11, 10, 9, 10, 11], loop: 0 }, timbre: hold([2]) }),
  pulse('bell.chime', 'bell', 'bell', 'Bell: 50% pulse with a long decay and an octave-up attack.', {
    vol: { values: [15, 13, 11, 10, 9, 8, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], loop: 19 },
    timbre: hold([2]),
    arp: createMacro([12, 0], { mode: 'rel', loop: 1 })
  }),
  pulse('sfx.zap', 'zap', 'sfx', 'Laser zap: fast downward pitch slide.', { vol: { values: [15, 14, 12, 10, 8, 6, 4, 2, 0], loop: 8 }, timbre: hold([1]), pitch: { values: [-24, -24, -20, -16, -12, -8, -6, -4, -2], loop: 8 } }),
  // soft presets for calm music: gentle swell and a long release
  pulse('lead.soft', 'lead-soft', 'lead', 'Soft 50% pulse lead: gentle swell, long release. The default lead for calm moods.', { vol: hold([5, 7, 9, 10], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), timbre: hold([2]) }),
  pulse('pad.soft-long', 'pad-soft-long', 'pad', 'Quiet 50% pulse pad: very slow swell, long release. Use with a 0xy arpeggio for soft chords.', { vol: hold([0, 2, 3, 4, 5, 6, 6], [5, 4, 4, 3, 3, 2, 2, 1, 1, 0]), timbre: hold([2]) }),
  pulse('bell.soft', 'bell-soft', 'bell', 'Soft 25% pulse bell: quiet attack that fades slowly.', { vol: { values: [10, 9, 8, 7, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], loop: 15 }, timbre: hold([1]) }),
  {
    id: 'nes.bass.pulse', name: 'bass-pulse', role: 'bass', channelKinds: ['pulse'],
    description: 'Pulse bass: 50% duty, use an octave below the lead (A-1 and up).',
    instrument: { name: 'bass-pulse', kind: 'nes-pulse', macros: { vol: hold([15], [6, 0]), timbre: hold([2]) } }
  },
  {
    id: 'nes.bass.tri', name: 'bass', role: 'bass', channelKinds: ['triangle'],
    description: 'Triangle bass (default for TR): fixed volume, soft round tone.',
    instrument: { name: 'bass', kind: 'nes-tri', macros: {} }
  },
  {
    id: 'nes.bass.tri-slap', name: 'bass-slap', role: 'bass', channelKinds: ['triangle'],
    description: 'Triangle bass with a short upward blip at the attack, for funky/driving lines.',
    instrument: { name: 'bass-slap', kind: 'nes-tri', macros: { arp: createMacro([12, 0], { mode: 'rel', loop: 1 }) } }
  },
  {
    id: 'nes.kick.tri-drop', name: 'kick-tri', role: 'kick', channelKinds: ['triangle'],
    description: 'Triangle kick: fast pitch drop then silence. Play on TR at about C-3; the bass must rest meanwhile.',
    instrument: {
      name: 'kick-tri', kind: 'nes-tri',
      macros: { arp: { values: [24, 17, 12, 7, 3, 0, 0, 0], loop: 7, mode: 'rel' }, vol: { values: [15, 15, 15, 15, 15, 15, 0], loop: 6 } }
    }
  },
  {
    id: 'nes.tom.tri', name: 'tom', role: 'tom', channelKinds: ['triangle'],
    description: 'Triangle tom: slower pitch drop, then silence.',
    instrument: {
      name: 'tom', kind: 'nes-tri',
      macros: { arp: { values: [7, 5, 4, 3, 2, 1, 0, 0, 0, 0], loop: 9, mode: 'rel' }, vol: { values: [15, 15, 15, 15, 15, 15, 15, 15, 0], loop: 8 } }
    }
  },
  {
    id: 'nes.kick.noise', name: 'kick', role: 'kick', channelKinds: ['noise'],
    description: 'Noise kick (default for NO): low-pitched noise burst with falling pitch.',
    instrument: { name: 'kick', kind: 'nes-noise', macros: { vol: { values: [15, 14, 12, 9, 6, 3, 1, 0], loop: 7 }, arp: { values: [8, 6, 4, 2, 1, 0, 0, 0], loop: 7, mode: 'fixed' }, timbre: hold([0]) } }
  },
  {
    id: 'nes.snare.noise', name: 'snare', role: 'snare', channelKinds: ['noise'],
    description: 'Noise snare: mid-pitched, medium decay.',
    instrument: { name: 'snare', kind: 'nes-noise', macros: { vol: { values: [15, 13, 10, 8, 6, 4, 3, 2, 1, 0], loop: 9 }, arp: { values: [12, 12, 11, 10, 9, 9, 8, 8, 8, 8], loop: 9, mode: 'fixed' }, timbre: hold([0]) } }
  },
  {
    id: 'nes.hat.noise', name: 'hat', role: 'hihat', channelKinds: ['noise'],
    description: 'Closed hi-hat: very short metallic (short-mode) noise at the highest pitch.',
    instrument: { name: 'hat', kind: 'nes-noise', macros: { vol: { values: [9, 5, 2, 0], loop: 3 }, arp: { values: [15], loop: 0, mode: 'fixed' }, timbre: hold([1]) } }
  },
  {
    id: 'nes.openhat.noise', name: 'openhat', role: 'openhat', channelKinds: ['noise'],
    description: 'Open hi-hat: longer metallic noise decay.',
    instrument: { name: 'openhat', kind: 'nes-noise', macros: { vol: { values: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], loop: 10 }, arp: { values: [15], loop: 0, mode: 'fixed' }, timbre: hold([1]) } }
  },
  {
    id: 'nes.crash.noise', name: 'crash', role: 'crash', channelKinds: ['noise'],
    description: 'Crash cymbal: long hiss-noise decay.',
    instrument: {
      name: 'crash', kind: 'nes-noise',
      macros: { vol: { values: [15, 14, 13, 12, 11, 10, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 1, 1, 0], loop: 23 }, arp: { values: [14, 14, 13, 13, 12, 12, 11], loop: 6, mode: 'fixed' }, timbre: hold([0]) }
    }
  },
  {
    id: 'nes.clap.noise', name: 'clap', role: 'clap', channelKinds: ['noise'],
    description: 'Hand clap: three quick noise bursts.',
    instrument: { name: 'clap', kind: 'nes-noise', macros: { vol: { values: [15, 0, 12, 0, 10, 6, 3, 1, 0], loop: 8 }, arp: { values: [11], loop: 0, mode: 'fixed' }, timbre: hold([0]) } }
  },
  {
    id: 'nes.tom.noise', name: 'tom-noise', role: 'tom', channelKinds: ['noise'],
    description: 'Noise tom: low-mid pitched burst; vary the note between hits for a fill.',
    instrument: { name: 'tom-noise', kind: 'nes-noise', macros: { vol: { values: [15, 13, 11, 9, 7, 5, 3, 1, 0], loop: 8 }, arp: { values: [7, 6, 5, 4, 4, 4, 4, 4, 4], loop: 8, mode: 'fixed' }, timbre: hold([0]) } }
  }
]
