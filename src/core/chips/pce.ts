// NEC PC Engine / TurboGrafx-16: HuC6280 PSG, six 32x5-bit wavetable channels, noise on C5/C6 only.

import type { EffectCode } from '../types'
import type { ChannelDef } from './types'
import { defineProfile } from './validate'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
const PCE_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'W', 'X', ...FLOW]

export const pceChannels: ChannelDef[] = [1, 2, 3, 4, 5, 6].map((i) => ({
  id: `C${i}`,
  name: `Wave ${i}`,
  kind: 'pce-wave' as const,
  noteMin: 21,
  noteMax: 108,
  instKinds: ['pce-wave' as const],
  hasVolume: true,
  pan: '4bit' as const,
  effects: PCE_FX,
  fxColumns: 2 as const,
  description:
    i >= 5
      ? '32x5-bit wavetable voice; an instrument with noise:true turns this channel into a noise generator (only C5 and C6 can).'
      : '32x5-bit wavetable voice (Wxx picks the wave), 5-bit volume, 4-bit pan per side.'
})) satisfies ChannelDef[]

export const pceProfile = defineProfile({
  id: 'pce',
  label: 'PC Engine',
  name: 'NEC PC Engine / TurboGrafx-16 (HuC6280)',
  era: '16-bit, 1987',
  description: 'Six wavetable channels (32 samples of 5 bits). Channels 5 and 6 can be switched to noise. Stereo with 4-bit pan.',
  notes: [
    'Channels: C1..C6 wavetable; noise instruments only on C5 and C6.',
    'Typical layout: C1 bass, C2 lead, C3 harmony, C4 arp, C5 hats (noise), C6 snare (noise) or more melody.',
    'Waves are drawn per instrument (32 values 0..31); the timbre macro or Wxx switches between several waves.',
    'Pan (Xxx) has 16 levels per side.'
  ],
  channels: () => pceChannels.map((c) => ({ ...c })),
  defaultConfig: () => ({ chip: 'pce' })
})
