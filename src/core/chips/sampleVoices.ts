// Channel layout shared by the two voice-count sample chips (PS1 SPU, Dreamcast AICA): V1..Vn sample voices with the
// SNES effect list. The role tables (instruments/roles.ts) use V1..V16, so every allowed voice count has the same
// default layout and the extra voices are free for doubling and polyphony.

import type { EffectCode } from '../types'
import type { ChannelDef } from './types'

const FLOW: EffectCode[] = ['B', 'C', 'D', 'F']
/** Effects of the sample chips: the SNES list, where E01/E00 switches the voice's effect send (reverb / DSP) on or off. */
export const SAMPLE_CHIP_FX: EffectCode[] = ['0', '1', '2', '3', '4', '7', 'A', 'P', 'Q', 'R', 'S', 'G', 'X', 'E', ...FLOW]

/** V1..V`count` channel definitions of kind `sample`. */
export function sampleVoiceChannels(count: number, instKind: 'psx-sample' | 'aica-sample', description: string): ChannelDef[] {
  const out: ChannelDef[] = []
  for (let i = 1; i <= count; i++) {
    out.push({
      id: `V${i}`,
      name: `Voice ${i}`,
      kind: 'sample',
      noteMin: 12,
      noteMax: 119,
      instKinds: [instKind],
      hasVolume: true,
      pan: 'full',
      effects: SAMPLE_CHIP_FX,
      fxColumns: 2,
      description
    })
  }
  return out
}

/** Throw the "voices must be ..." error for an unsupported voice count. */
export function assertVoiceCount(label: string, value: unknown, allowed: readonly number[]): number {
  if (typeof value !== 'number' || !allowed.includes(value)) {
    throw new Error(
      `${label} voices must be ${allowed.slice(0, -1).join(', ')}${allowed.length > 1 ? ' or ' : ''}${allowed[allowed.length - 1]} (got ${JSON.stringify(value)}); the voice count is set when the song is created: new_song chipConfig {"voices":${allowed[allowed.length - 1]}}.`
    )
  }
  return value
}
