// Chip registry: profiles, default configs and the summaries the LLM sees via list_chips.

import type { ChipConfig, ChipId, Song } from '../types'
import { CHIP_IDS } from '../types'
import type { ChannelDef, ChipProfile, ChipSummary, Issue, ValidateScope } from './types'
import { nesProfile } from './nes'
import { gbProfile } from './gb'
import { genesisProfile } from './genesis'
import { snesProfile } from './snes'
import { pceProfile } from './pce'
import { ps1Profile } from './ps1'
import { dreamcastProfile } from './dreamcast'

export * from './types'
export { channelDefFor, defineProfile, estimateSampleLength, ruleSeverity, validateCellForChannel, validateCellsFor } from './validate'
export { ARAM_BYTES, ECHO_BYTES_PER_STEP, defaultSnesConfig, snesAramUsage } from './snes'
export type { AramUsage } from './snes'
export { defaultPs1Config, ps1Channels, ps1Voices } from './ps1'
export { defaultDreamcastConfig, dreamcastChannels, dreamcastVoices } from './dreamcast'

export const CHIP_PROFILES: Record<ChipId, ChipProfile> = {
  nes: nesProfile,
  gb: gbProfile,
  genesis: genesisProfile,
  snes: snesProfile,
  pce: pceProfile,
  ps1: ps1Profile,
  dreamcast: dreamcastProfile
}

export function isChipId(v: unknown): v is ChipId {
  return typeof v === 'string' && (CHIP_IDS as readonly string[]).includes(v)
}

export function getChipProfile(chip: ChipId): ChipProfile {
  const p = CHIP_PROFILES[chip]
  if (!p) throw new Error(`Unknown chip "${String(chip)}". Valid chips: ${CHIP_IDS.join(', ')}.`)
  return p
}

/** Resolve a chip from an id or a loose name ("NES", "game boy", "mega drive", "snes", "pc engine"). */
export function requireChipId(ref: string): ChipId {
  const k = ref.trim().toLowerCase().replace(/[\s_-]+/g, '')
  if (isChipId(k)) return k
  const aliases: Record<string, ChipId> = {
    famicom: 'nes', nintendo: 'nes', gameboy: 'gb', dmg: 'gb', megadrive: 'genesis', mega: 'genesis', ym2612: 'genesis',
    sega: 'genesis', supernes: 'snes', sfc: 'snes', spc700: 'snes', pcengine: 'pce', turbografx: 'pce', turbografx16: 'pce', tg16: 'pce', huc6280: 'pce',
    psx: 'ps1', playstation: 'ps1', playstation1: 'ps1', spu: 'ps1',
    dc: 'dreamcast', aica: 'dreamcast', segadreamcast: 'dreamcast'
  }
  const hit = aliases[k]
  if (hit) return hit
  throw new Error(`Unknown chip "${ref}". Valid chips: ${CHIP_IDS.join(', ')}.`)
}

export function defaultChipConfig(chip: ChipId): ChipConfig {
  return getChipProfile(chip).defaultConfig()
}

export function chipChannels(chip: ChipId, cfg: ChipConfig = defaultChipConfig(chip)): ChannelDef[] {
  return getChipProfile(chip).channels(cfg)
}

export function songChannelDefs(song: Song): ChannelDef[] {
  return getChipProfile(song.chip).channels(song.chipConfig)
}

export function validateSong(song: Song, scope?: ValidateScope): Issue[] {
  return getChipProfile(song.chip).validate(song, scope)
}

export function listChips(): ChipSummary[] {
  return CHIP_IDS.map((id) => {
    const p = CHIP_PROFILES[id]
    const defs = p.channels(p.defaultConfig())
    return {
      id,
      name: p.name,
      era: p.era,
      description: p.description,
      channels: defs.map((d) => ({
        id: d.id,
        name: d.name,
        kind: d.kind,
        noteRange: [d.noteMin, d.noteMax] as [number, number],
        hasVolume: d.hasVolume,
        accepts: d.instKinds,
        effects: d.effects.join(''),
        description: d.description
      })),
      notes: p.notes
    }
  })
}

/** Format issues as text lines (for tool results). */
export function formatIssues(issues: Issue[], limit = 30): string {
  const lines = issues.slice(0, limit).map((i) => {
    const where = [
      i.channel ? i.channel : '',
      i.order !== undefined ? `order ${i.order}` : '',
      i.pattern !== undefined ? `pattern ${i.pattern}` : '',
      i.row !== undefined ? `row ${i.row}` : ''
    ].filter(Boolean).join(' ')
    return `${i.severity.toUpperCase()}${where ? ` [${where}]` : ''}: ${i.message}`
  })
  if (issues.length > limit) lines.push(`...and ${issues.length - limit} more.`)
  return lines.join('\n')
}
