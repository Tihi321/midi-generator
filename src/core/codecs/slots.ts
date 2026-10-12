// Which channel of a chip plays which part when music is imported from MIDI or converted from another chip.
// Shared by midiImport.ts and convert.ts.

import type { ChipConfig, ChipId } from '../types'
import { chipChannels } from '../chips'

export interface ChipSlots {
  /** Channel for the bass part (TR / WV / F1 / V1 / C1). */
  bass: string
  /** Channel for the lead (P1 / P1 / F2 / V4 / C2). */
  lead: string
  /** Other melodic channels, most useful first (the unused drum channels are appended when `reserveDrums` is false). */
  harmony: string[]
  /** Drum channel for kick/tom hits (may equal drumHigh when the chip has a single drum channel). */
  drumLow: string
  /** Drum channel for snare/hats/crash/clap. */
  drumHigh: string
}

const PLANS: Record<ChipId, (cfg: ChipConfig) => { bass: string; lead: string; harmony: string[]; drumLow: string; drumHigh: string; drumChannels: string[]; spare: string[] }> = {
  nes: (cfg) => ({
    bass: 'TR',
    lead: 'P1',
    harmony: ['P2'],
    drumLow: cfg.chip === 'nes' && cfg.dpcm ? 'DM' : 'NO',
    drumHigh: 'NO',
    drumChannels: ['NO'],
    spare: []
  }),
  gb: () => ({ bass: 'WV', lead: 'P1', harmony: ['P2'], drumLow: 'NO', drumHigh: 'NO', drumChannels: ['NO'], spare: [] }),
  genesis: (cfg) => {
    const dac = cfg.chip === 'genesis' && cfg.fm6Dac
    return {
      bass: 'F1',
      lead: 'F2',
      harmony: ['F3', 'F4', 'F5', ...(dac ? [] : ['F6']), 'S1', 'S2', 'S3'],
      drumLow: dac ? 'F6' : 'NO',
      drumHigh: 'NO',
      drumChannels: ['NO'],
      spare: []
    }
  },
  snes: () => ({ bass: 'V1', lead: 'V4', harmony: ['V2', 'V3', 'V5', 'V6'], drumLow: 'V7', drumHigh: 'V8', drumChannels: ['V7', 'V8'], spare: ['V7', 'V8'] }),
  pce: () => ({ bass: 'C1', lead: 'C2', harmony: ['C3', 'C4'], drumLow: 'C5', drumHigh: 'C6', drumChannels: ['C5', 'C6'], spare: ['C5', 'C6'] })
}

/** Channel plan for a chip. With `reserveDrums` false the drum-capable channels of SNES/PCE join the melodic pool. */
export function chipSlots(chip: ChipId, cfg: ChipConfig, reserveDrums: boolean): ChipSlots {
  const plan = PLANS[chip](cfg)
  const ids = new Set(chipChannels(chip, cfg).map((c) => c.id))
  const keep = (list: string[]): string[] => list.filter((id) => ids.has(id))
  const harmony = keep(plan.harmony)
  if (!reserveDrums) harmony.push(...keep(plan.spare))
  return { bass: plan.bass, lead: plan.lead, harmony, drumLow: plan.drumLow, drumHigh: plan.drumHigh }
}

/** Lower number = more important when several simultaneous drum hits compete for one channel. */
export const DRUM_PRIORITY: Record<string, number> = { kick: 0, snare: 1, clap: 2, tom: 3, crash: 4, openhat: 5, hihat: 6, sfx: 7 }

/** True when the drum role belongs on the low drum channel (kick and toms). */
export function isLowDrum(role: string): boolean {
  return role === 'kick' || role === 'tom'
}
