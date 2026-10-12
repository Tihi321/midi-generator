// Sega Genesis / Mega Drive: YM2612 (6 FM channels, F6 optionally a DAC) + SN76489 PSG (3 squares + noise).

import type { EffectCode, GenesisConfig } from '../types'
import type { ChannelDef } from './types'
import { defineProfile } from './validate'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
const FM_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'X', ...FLOW]
const DAC_FX: EffectCode[] = ['0', '1', '2', 'A', 'S', 'G', 'X', ...FLOW]
const PSG_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', ...FLOW]
const PSG_NOISE_FX: EffectCode[] = ['0', '7', 'A', 'S', 'G', 'W', ...FLOW]

export function genesisChannels(cfg: GenesisConfig | { chip: string; fm6Dac?: boolean }): ChannelDef[] {
  const defs: ChannelDef[] = []
  const dac = !!(cfg as GenesisConfig).fm6Dac
  for (let i = 1; i <= 6; i++) {
    if (i === 6 && dac) {
      defs.push({
        id: 'F6', name: 'DAC', kind: 'sample', noteMin: 12, noteMax: 119, instKinds: ['sample'], hasVolume: true,
        pan: 'hard', effects: DAC_FX, fxColumns: 2,
        description: 'FM 6 switched to the 8-bit DAC: plays samples (drums, voice). Pitch is the sample playback rate.'
      })
    } else {
      defs.push({
        id: `F${i}`, name: `FM ${i}`, kind: 'fm', noteMin: 24, noteMax: 107, instKinds: ['fm'], hasVolume: true,
        pan: 'hard', effects: FM_FX, fxColumns: 2,
        description: '4-operator FM voice (YM2612). Bass, lead, pads, bells, slap bass, brass. Hard L/C/R pan.'
      })
    }
  }
  for (let i = 1; i <= 3; i++) {
    defs.push({
      id: `S${i}`, name: `PSG Square ${i}`, kind: 'psg-square', noteMin: 45, noteMax: 108, instKinds: ['psg'], hasVolume: true,
      pan: 'none', effects: PSG_FX, fxColumns: 2,
      description: 'SN76489 square wave with 16 volume levels, lowest note A-2 (MIDI 45). Doubling, arps, blips.'
    })
  }
  defs.push({
    id: 'NO', name: 'PSG Noise', kind: 'psg-noise', noteMin: 12, noteMax: 127, noise: true, instKinds: ['psg-noise'], hasVolume: true,
    pan: 'none', effects: PSG_NOISE_FX, fxColumns: 2,
    description: 'SN76489 noise (white W00 / periodic W01). Note picks the rate: C-4 fast, C#4 medium, D-4 slow (repeats every 3 semitones from C-3); below C-3 it follows pitch. Hi-hats and snare fizz.'
  })
  return defs
}

export const genesisProfile = defineProfile({
  id: 'genesis',
  label: 'Genesis',
  name: 'Sega Genesis (YM2612 + SN76489)',
  era: '16-bit, 1988',
  description: 'Six 4-operator FM channels (F6 can be a DAC for drum samples) plus a 3-square + noise PSG.',
  notes: [
    'Channels: F1..F6 FM (hard L/C/R pan via Xxx), S1..S3 PSG squares (lowest note A-2), NO PSG noise.',
    'Typical layout: F1 bass, F2 lead, F3/F4 pads, F5 arp or brass, F6 DAC drums (fm6Dac) or second bass, S1..S3 doubling, NO hats.',
    'FM instruments: algorithm, feedback and 4 operators; low total level (tl) = louder operator.',
    'Genesis drums are usually DAC samples on F6 plus PSG noise for hats.',
    'PSG squares cannot play below A-2 (MIDI 45): put low bass on FM.'
  ],
  channels: (cfg) => genesisChannels(cfg as GenesisConfig),
  defaultConfig: () => ({ chip: 'genesis', region: 'ntsc', fm6Dac: false, lfo: 0 })
})
