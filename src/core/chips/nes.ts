// Nintendo NES / Famicom: Ricoh 2A03 (2 pulse, triangle, noise, optional DPCM).

import type { EffectCode, NesConfig } from '../types'
import type { ChannelDef } from './types'
import { defineProfile } from './validate'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
const PULSE_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'W', ...FLOW]
const TRI_FX: EffectCode[] = ['0', '1', '2', '3', '4', 'P', 'Q', 'R', 'S', 'G', ...FLOW]
const NOISE_FX: EffectCode[] = ['0', '1', '2', '7', 'A', 'S', 'G', 'W', ...FLOW]
const DPCM_FX: EffectCode[] = ['S', 'G', ...FLOW]

export function nesChannels(cfg: NesConfig | { chip: string; dpcm?: boolean }): ChannelDef[] {
  const defs: ChannelDef[] = [
    {
      id: 'P1', name: 'Pulse 1', kind: 'pulse', noteMin: 33, noteMax: 108, instKinds: ['nes-pulse'], hasVolume: true,
      pan: 'none', effects: PULSE_FX, fxColumns: 2,
      description: 'Square wave with 4 duties (W00..W03 = 12.5/25/50/75%), 16 volume levels. Lead or harmony.'
    },
    {
      id: 'P2', name: 'Pulse 2', kind: 'pulse', noteMin: 33, noteMax: 108, instKinds: ['nes-pulse'], hasVolume: true,
      pan: 'none', effects: PULSE_FX, fxColumns: 2,
      description: 'Second square wave, identical to Pulse 1. Counter-melody or arpeggiated chords (0xy).'
    },
    {
      id: 'TR', name: 'Triangle', kind: 'triangle', noteMin: 21, noteMax: 96, instKinds: ['nes-tri'], hasVolume: false,
      pan: 'none', effects: TRI_FX, fxColumns: 2,
      description: 'Fixed-volume triangle wave: no volume control (cannot fade). Bass line, or a pitch-drop kick/tom.'
    },
    {
      id: 'NO', name: 'Noise', kind: 'noise', noteMin: 12, noteMax: 127, noise: true, instKinds: ['nes-noise'], hasVolume: true,
      pan: 'none', effects: NOISE_FX, fxColumns: 2,
      description: 'LFSR noise with 16 periods (the note picks the period); W01 switches to the metallic 93-step mode. Drums.'
    }
  ]
  if ((cfg as NesConfig).dpcm) {
    defs.push({
      id: 'DM', name: 'DPCM', kind: 'dpcm', noteMin: 12, noteMax: 127, instKinds: ['sample'], hasVolume: false,
      pan: 'none', effects: DPCM_FX, fxColumns: 1,
      description: '1-bit delta sample channel (16 playback rates), no volume. Drum samples and bass hits.'
    })
  }
  return defs
}

export const nesProfile = defineProfile({
  id: 'nes',
  label: 'NES',
  name: 'Nintendo NES (Ricoh 2A03)',
  era: '8-bit, 1983',
  description: 'Two pulse channels, a triangle, a noise channel and an optional DPCM sample channel. Mono.',
  notes: [
    'Channels: P1/P2 pulse (duty via Wxx), TR triangle (no volume, A-1..C-7), NO noise (16 periods), optional DM DPCM.',
    'Typical layout: P1 lead, P2 arpeggio/harmony (0xy), TR bass, NO drums.',
    'The triangle has no volume: do not write v-column values there; use note-off (===) to stop it.',
    'Pulse range is A-1..C-8; below A-1 only the triangle reaches.',
    'Drums: noise instruments with fixed-pitch macros; kick can also be a fast pitch drop on TR.',
    'Chords on one channel are arpeggios: 0xy at speed 6 gives root, +x, +y cycling.'
  ],
  channels: (cfg) => nesChannels(cfg as NesConfig),
  defaultConfig: () => ({ chip: 'nes', region: 'ntsc', dpcm: false, mixModel: 'nonlinear' })
})
