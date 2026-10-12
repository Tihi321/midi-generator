// Instrument kind helpers. The instrument data types themselves live in ../types.

import type { ChipId, Instrument, InstrumentKind } from '../types'

export type {
  FmInstrument,
  FmOp,
  GbEnvelope,
  GbNoiseInstrument,
  GbPulseInstrument,
  GbWaveInstrument,
  Instrument,
  InstrumentBase,
  InstrumentKind,
  Macro,
  MacroInstrument,
  MacroName,
  Macros,
  PceWaveInstrument,
  Role,
  SampleInstrument,
  SnesEnvelope,
  SnesSampleInstrument
} from '../types'

export const INSTRUMENT_KINDS: readonly InstrumentKind[] = [
  'nes-pulse', 'nes-tri', 'nes-noise', 'psg', 'psg-noise', 'gb-pulse', 'gb-wave', 'gb-noise',
  'pce-wave', 'fm', 'snes-sample', 'sample'
]

/** Instrument kinds each chip can host at all (before looking at individual channels). */
export const KINDS_BY_CHIP: Record<ChipId, readonly InstrumentKind[]> = {
  nes: ['nes-pulse', 'nes-tri', 'nes-noise', 'sample'],
  gb: ['gb-pulse', 'gb-wave', 'gb-noise'],
  genesis: ['fm', 'psg', 'psg-noise', 'sample'],
  snes: ['snes-sample'],
  pce: ['pce-wave', 'sample']
}

export function kindsForChip(chip: ChipId): readonly InstrumentKind[] {
  return KINDS_BY_CHIP[chip]
}

export function chipSupportsKind(chip: ChipId, kind: InstrumentKind): boolean {
  return KINDS_BY_CHIP[chip].includes(kind)
}

export const MAX_INSTRUMENTS = 64

/** Lowercase identifier used for `@name` references: letters, digits, '-' and '_'. */
export function instrumentSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function cloneInstrument<T extends Instrument>(inst: T): T {
  return structuredClone(inst)
}
