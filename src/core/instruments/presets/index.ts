// Preset banks per chip and preset lookup. The genesis/snes/pce banks are filled in Phase 4.

import type { ChannelKind, ChipId, Instrument, Role, SampleSlot } from '../../types'
import { ROLES } from '../../types'
import { ROLE_FALLBACKS, gmHint, parseRole } from '../roles'
import { instrumentSlug } from '../types'
import { NES_PRESETS } from './nes'
import { GB_PRESETS } from './gb'
import { GENESIS_PRESETS } from './genesis'
import { SNES_PRESETS } from './snes'
import { PCE_PRESETS } from './pce'
import { GENESIS_SAMPLE_PRESETS, NES_SAMPLE_PRESETS } from './samples'
import type { Preset } from './types'

export type { Preset } from './types'
export { NES_PRESETS } from './nes'
export { GB_PRESETS, GB_WAVES } from './gb'

export { GENESIS_PRESETS } from './genesis'
export { SNES_PRESETS } from './snes'
export { PCE_PRESETS, PCE_WAVES } from './pce'
export { GENESIS_SAMPLE_PRESETS, NES_SAMPLE_PRESETS } from './samples'

export const PRESET_BANKS: Record<ChipId, Preset[]> = {
  nes: [...NES_PRESETS, ...NES_SAMPLE_PRESETS],
  gb: GB_PRESETS,
  genesis: [...GENESIS_PRESETS, ...GENESIS_SAMPLE_PRESETS],
  snes: SNES_PRESETS,
  pce: PCE_PRESETS
}

export function listPresets(chip: ChipId, filter: { role?: Role; channelKind?: ChannelKind } = {}): Preset[] {
  return PRESET_BANKS[chip].filter(
    (p) => (!filter.role || p.role === filter.role) && (!filter.channelKind || p.channelKinds.includes(filter.channelKind))
  )
}

export function findPreset(chip: ChipId, id: string): Preset | undefined {
  const bank = PRESET_BANKS[chip]
  const k = id.trim().toLowerCase()
  return bank.find((p) => p.id === k) ?? bank.find((p) => p.id === `${chip}.${k}`)
}

function presetListing(chip: ChipId): string {
  const bank = PRESET_BANKS[chip]
  if (bank.length === 0) return `(no presets for ${chip} yet)`
  return bank.map((p) => p.id).join(', ')
}

function instantiate(p: Preset): Instrument {
  const inst = structuredClone(p.instrument)
  inst.presetId = p.id
  inst.role = p.role
  inst.gm = inst.gm ?? gmHint(p.role)
  return inst
}

/**
 * Build a fresh Instrument from a preset id ("nes.lead.duty25"; the chip prefix may be omitted) or from
 * a role ("lead", "hat", "kick"). With a role, `channelKind` picks the preset that plays on that channel
 * (e.g. bass on a triangle channel gives nes.bass.tri). Throws with the valid values on failure.
 */
export function resolvePreset(chip: ChipId, ref: string, channelKind?: ChannelKind): Instrument {
  const byId = findPreset(chip, ref)
  if (byId) return instantiate(byId)
  const role = parseRole(ref)
  if (!role) {
    throw new Error(
      `Unknown preset or role "${ref}" for ${chip}. Roles: ${ROLES.join(', ')}. Presets: ${presetListing(chip)}.`
    )
  }
  const candidates = [role, ...(ROLE_FALLBACKS[role] ?? [])]
  for (const r of candidates) {
    const list = PRESET_BANKS[chip].filter((p) => p.role === r && (!channelKind || p.channelKinds.includes(channelKind)))
    if (list.length > 0) return instantiate(list.find((p) => p.name === r) ?? list[0]!)
  }
  const kinds = channelKind ? ` on a ${channelKind} channel` : ''
  throw new Error(`No ${chip} preset for role "${role}"${kinds}. Presets: ${presetListing(chip)}.`)
}

/** Resolve by preset id, role or default-name slug; undefined when nothing matches (no throw). */
export function tryResolvePreset(chip: ChipId, ref: string, channelKind?: ChannelKind): Instrument | undefined {
  try {
    return resolvePreset(chip, ref, channelKind)
  } catch {
    const slug = instrumentSlug(ref)
    const p = PRESET_BANKS[chip].find((x) => instrumentSlug(x.name) === slug && (!channelKind || x.channelKinds.includes(channelKind)))
    return p ? instantiate(p) : undefined
  }
}

/**
 * The sample slot a preset-made instrument needs that the song does not have yet, or undefined. The instrument
 * is the fresh result of resolvePreset (it is adjusted in place when a slot with the same id but different content
 * already exists: the instrument then points at a new, suffixed slot id).
 */
export function missingPresetSample(song: { samples: readonly SampleSlot[] }, inst: Instrument): SampleSlot | undefined {
  if ((inst.kind !== 'snes-sample' && inst.kind !== 'sample') || !inst.presetId) return undefined
  const preset = Object.values(PRESET_BANKS)
    .flat()
    .find((p) => p.id === inst.presetId)
  const want = preset?.sample
  if (!want || want.id !== inst.sample) return undefined
  const same = (a: SampleSlot, b: SampleSlot): boolean => JSON.stringify(a.source) === JSON.stringify(b.source) && a.loopStart === b.loopStart
  let id = want.id
  for (let n = 2; ; n++) {
    const existing = song.samples.find((s) => s.id === id)
    if (!existing) break
    if (same(existing, want)) return undefined
    id = `${want.id}-${n}`
  }
  inst.sample = id
  return { ...structuredClone(want), id }
}
