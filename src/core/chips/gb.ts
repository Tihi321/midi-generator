// Nintendo Game Boy DMG: 2 pulse (P1 with sweep), 1 wave, 1 noise. Hard L/C/R panning.

import type { EffectCode } from '../types'
import type { ChannelDef } from './types'
import { defineProfile } from './validate'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
const PULSE_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'W', 'X', ...FLOW]
const WAVE_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'X', ...FLOW]
const NOISE_FX: EffectCode[] = ['0', '1', '2', '7', 'A', 'S', 'G', 'W', 'X', ...FLOW]

export const gbChannels: ChannelDef[] = [
  {
    id: 'P1', name: 'Pulse 1', kind: 'pulse', noteMin: 36, noteMax: 108, instKinds: ['gb-pulse'], hasVolume: true,
    pan: 'hard', effects: PULSE_FX, fxColumns: 2,
    description: 'Square wave with 4 duties and a frequency sweep unit. Lead.'
  },
  {
    id: 'P2', name: 'Pulse 2', kind: 'pulse', noteMin: 36, noteMax: 108, instKinds: ['gb-pulse'], hasVolume: true,
    pan: 'hard', effects: PULSE_FX, fxColumns: 2,
    description: 'Square wave with 4 duties, no sweep. Harmony or arpeggios.'
  },
  {
    id: 'WV', name: 'Wave', kind: 'wave', noteMin: 24, noteMax: 108, instKinds: ['gb-wave'], hasVolume: true,
    volumeSteps: [0, 4, 8, 15], pan: 'hard', effects: WAVE_FX, fxColumns: 2,
    description: 'Custom 32x4-bit waveform with only 4 volume levels (100%/50%/25%/mute). Bass or soft lead.'
  },
  {
    id: 'NO', name: 'Noise', kind: 'noise', noteMin: 12, noteMax: 127, noise: true, instKinds: ['gb-noise'], hasVolume: true,
    pan: 'hard', effects: NOISE_FX, fxColumns: 2,
    description: 'LFSR noise, 15-bit (hiss) or 7-bit (metallic, W01). Drums.'
  }
]

export const gbProfile = defineProfile({
  id: 'gb',
  label: 'Game Boy',
  name: 'Nintendo Game Boy (DMG)',
  era: '8-bit, 1989',
  description: 'Two pulse channels (P1 has sweep), a 4-bit wavetable channel, and a noise channel. Stereo pan is hard left/centre/right only.',
  notes: [
    'Channels: P1/P2 pulse, WV wave (32x4-bit, only 4 volume levels), NO noise (15/7-bit LFSR).',
    'Typical layout: P1 lead, P2 harmony/arpeggio, WV bass, NO drums.',
    'WV volume is quantized to 100/50/25/0% (v15/v8/v4/v0); intermediate v values snap to the nearest level.',
    'Pan (Xxx) is hard: 00-55 left, 56-AA centre, AB-FF right.',
    'Only P1 has a frequency sweep; pulse range starts at C-2.'
  ],
  channels: () => gbChannels.map((c) => ({ ...c })),
  defaultConfig: () => ({ chip: 'gb' })
})
