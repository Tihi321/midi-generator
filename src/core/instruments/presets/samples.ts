// Sample drum presets for the chips that play raw samples: the Genesis F6 DAC (genesis.dac.*, 8-bit, up to ~26 kHz)
// and the NES DM channel (nes.dpcm.*, 1-bit delta, 16 playback rates; the note picks the rate, C-4 = base rate).
// Each preset carries the recipe slot it needs; the tool layer adds it to the song with the instrument.

import type { Role, SampleSlot } from '../../types'
import type { Preset } from './types'

type Params = Record<string, number | string | boolean>

function sample(prefix: 'genesis.dac' | 'nes.dpcm', channelKind: 'sample' | 'dpcm', slotPrefix: string, role: Role, recipe: string, description: string, params: Params = {}): Preset {
  const slotId = `${slotPrefix}-${recipe}`
  const slot: SampleSlot = { id: slotId, name: `${slotPrefix.toUpperCase()} ${recipe}`, source: { kind: 'recipe', recipe, params } }
  const name = `${recipe}-${slotPrefix}`
  return {
    id: `${prefix}.${recipe}`,
    name,
    role,
    description,
    channelKinds: [channelKind],
    instrument: { kind: 'sample', name, sample: slotId, baseNote: 60 },
    sample: slot
  }
}

const dac = (recipe: string, role: Role, description: string, params?: Params): Preset =>
  sample('genesis.dac', 'sample', 'dac', role, recipe, description, params)
const dpcm = (recipe: string, role: Role, description: string, params?: Params): Preset =>
  sample('nes.dpcm', 'dpcm', 'dpcm', role, recipe, description, params)

export const GENESIS_SAMPLE_PRESETS: Preset[] = [
  dac('kick', 'kick', 'F6 DAC kick (8-bit sample, 16 kHz). Needs fm6Dac:true. Write at C-4.', { rate: 16000 }),
  dac('snare', 'snare', 'F6 DAC snare (8-bit sample, 16 kHz).', { rate: 16000 }),
  dac('hat', 'hihat', 'F6 DAC closed hat (8-bit sample).', { rate: 20000 }),
  dac('openhat', 'openhat', 'F6 DAC open hat (8-bit sample).', { rate: 20000, seconds: 0.18 }),
  dac('crash', 'crash', 'F6 DAC crash (8-bit sample, 16 kHz).', { rate: 16000, seconds: 0.45 }),
  dac('tom', 'tom', 'F6 DAC tom; the note changes the playback rate (pitch).', { rate: 16000 }),
  dac('clap', 'clap', 'F6 DAC clap (8-bit sample, 16 kHz).', { rate: 16000 })
]

export const NES_SAMPLE_PRESETS: Preset[] = [
  dpcm('kick', 'kick', 'DM channel kick (DPCM). Needs dpcm:true. C-4 plays rate 12 (16.9 kHz); each semitone down/up picks the next slower/faster rate.', { rate: 16000 }),
  dpcm('snare', 'snare', 'DM channel snare (DPCM).', { rate: 16000 }),
  dpcm('hat', 'hihat', 'DM channel closed hat (DPCM): crunchy and loud.', { rate: 20000 }),
  dpcm('tom', 'tom', 'DM channel tom; the note picks the DPCM rate (pitch).', { rate: 16000 }),
  dpcm('crash', 'crash', 'DM channel crash (DPCM).', { rate: 16000, seconds: 0.4 }),
  dpcm('clap', 'clap', 'DM channel clap (DPCM).', { rate: 16000 })
]
