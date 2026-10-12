import { describe, expect, it } from 'vitest'
import {
  GB_PRESETS, NES_PRESETS, PRESET_BANKS, createMacro, defaultChannelIds, defaultChannelKinds, formatMacro, gmHint, instrumentSlug,
  isDrumRole, kindsForChip, listPresets, parseMacro, parseRole, resolvePreset, tryResolvePreset, validateInstrument, validateMacro, ROLE_META
} from '../../src/core/instruments'
import { CHIP_IDS, ROLES } from '../../src/core/types'
import { chipChannels, validateCellForChannel, getChipProfile } from '../../src/core/chips'
import { createSong } from '../../src/core/model'

describe('macros', () => {
  it('round-trips the text form', () => {
    const m = parseMacro('15 12 | 9 6 / 3 0')
    expect(m).toEqual({ values: [15, 12, 9, 6, 3, 0], loop: 2, release: 4 })
    expect(formatMacro(m)).toBe('15 12 | 9 6 / 3 0')
    expect(parseMacro('12 0', 'rel').mode).toBe('rel')
    expect(() => parseMacro('1 | 2 | 3')).toThrow(/two loop/)
    expect(() => parseMacro('1 x')).toThrow(/not an integer/)
  })
  it('validates ranges and loop points', () => {
    expect(validateMacro('vol', createMacro([15, 8, 0], { hold: true }))).toEqual([])
    expect(validateMacro('vol', { values: [16] })[0]).toContain('out of range')
    expect(validateMacro('vol', { values: [] })[0]).toContain('at least one')
    expect(validateMacro('arp', { values: [1], loop: 3 })[0]).toContain('loop index')
    expect(validateMacro('arp', { values: [0, 12], mode: 'fixed' })).toEqual([])
    expect(validateMacro('arp', { values: [-1], mode: 'fixed' })[0]).toContain('out of range')
    expect(validateMacro('vol', { values: [1], mode: 'rel' })[0]).toContain('arp only')
  })
})

describe('roles', () => {
  it('has metadata for every role', () => {
    for (const r of ROLES) expect(ROLE_META[r].role).toBe(r)
    expect(isDrumRole('kick')).toBe(true)
    expect(isDrumRole('lead')).toBe(false)
    expect(gmHint('snare')).toEqual({ drumNote: 38 })
    expect(gmHint('bass')).toEqual({ program: 38 })
    expect(parseRole('hat')).toBe('hihat')
    expect(parseRole('LEAD')).toBe('lead')
    expect(parseRole('banana')).toBeUndefined()
  })
  it('names default channels and kinds per chip', () => {
    expect(defaultChannelIds('nes', 'bass')).toEqual(['TR'])
    expect(defaultChannelIds('gb', 'kick')).toEqual(['NO'])
    expect(defaultChannelKinds('nes', 'lead')).toEqual(['pulse'])
    for (const chip of CHIP_IDS) {
      const ids = chipChannels(chip).map((d) => d.id)
      for (const r of ROLES) for (const id of defaultChannelIds(chip, r)) expect(ids).toContain(id)
    }
  })
  it('slugs instrument names', () => {
    expect(instrumentSlug('Lead Square!')).toBe('lead-square')
  })
  it('lists kinds per chip', () => {
    expect(kindsForChip('nes')).toContain('nes-tri')
    expect(kindsForChip('snes')).toEqual(['snes-sample'])
  })
})

describe('preset banks', () => {
  it('have 15-30 presets for NES and GB and are empty placeholders for the rest', () => {
    expect(NES_PRESETS.length).toBeGreaterThanOrEqual(15)
    expect(NES_PRESETS.length).toBeLessThanOrEqual(30)
    expect(GB_PRESETS.length).toBeGreaterThanOrEqual(15)
    expect(GB_PRESETS.length).toBeLessThanOrEqual(30)
    expect(PRESET_BANKS.genesis.length).toBeGreaterThanOrEqual(20)
    expect(PRESET_BANKS.snes.length).toBeGreaterThanOrEqual(20)
  })
  for (const chip of ['nes', 'gb'] as const) {
    describe(chip, () => {
      const bank = PRESET_BANKS[chip]
      it('ids are unique and prefixed with the chip', () => {
        expect(new Set(bank.map((p) => p.id)).size).toBe(bank.length)
        for (const p of bank) expect(p.id.startsWith(`${chip}.`)).toBe(true)
      })
      it('every preset resolves and validates', () => {
        for (const p of bank) {
          const inst = resolvePreset(chip, p.id)
          expect(validateInstrument(inst), p.id).toEqual([])
          expect(inst.presetId).toBe(p.id)
          expect(inst.role).toBe(p.role)
          expect(inst.gm).toBeDefined()
          expect(kindsForChip(chip)).toContain(inst.kind)
        }
      })
      it('every preset is playable on a channel of a matching kind without chip errors', () => {
        const song = createSong({ chip, patternLength: 16 })
        // the NES DM channel (DPCM sample presets) only exists with dpcm:true
        const defs = chip === 'nes' ? chipChannels(chip, { chip: 'nes', region: 'ntsc', dpcm: true, mixModel: 'nonlinear' }) : chipChannels(chip)
        const profile = getChipProfile(chip)
        for (const p of bank) {
          song.instruments = [resolvePreset(chip, p.id)]
          const targets = defs.filter((d) => p.channelKinds.includes(d.kind) && d.instKinds.includes(song.instruments[0]!.kind))
          expect(targets.length, p.id).toBeGreaterThan(0)
          const def = targets[0]!
          const note = def.noise ? 60 : Math.max(def.noteMin + 12, 60)
          const issues = validateCellForChannel(profile, song, defs, def, { note, inst: 0, ...(def.hasVolume ? { vol: 15 } : {}) }, {})
          expect(issues.filter((i) => i.severity === 'error'), p.id).toEqual([])
        }
      })
      it('covers lead, bass and the drum kit', () => {
        for (const role of ['lead', 'bass', 'kick', 'snare', 'hihat', 'openhat', 'crash'] as const) {
          expect(listPresets(chip, { role }).length, role).toBeGreaterThan(0)
        }
      })
    })
  }
  it('resolves by id, short id and role with channel kind', () => {
    expect(resolvePreset('nes', 'nes.lead.duty25').kind).toBe('nes-pulse')
    expect(resolvePreset('nes', 'lead.duty25').presetId).toBe('nes.lead.duty25')
    expect(resolvePreset('nes', 'lead').presetId).toBe('nes.lead.duty25')
    expect(resolvePreset('nes', 'bass', 'triangle').presetId).toBe('nes.bass.tri')
    expect(resolvePreset('nes', 'bass', 'pulse').presetId).toBe('nes.bass.pulse')
    expect(resolvePreset('nes', 'kick', 'triangle').presetId).toBe('nes.kick.tri-drop')
    expect(resolvePreset('nes', 'kick', 'noise').presetId).toBe('nes.kick.noise')
    expect(resolvePreset('nes', 'hat').role).toBe('hihat')
    expect(resolvePreset('gb', 'bass').kind).toBe('gb-wave')
    expect(resolvePreset('gb', 'snare').kind).toBe('gb-noise')
  })
  it('uses fallbacks for roles without a preset', () => {
    expect(resolvePreset('nes', 'strings').role).toBe('pad')
    expect(resolvePreset('nes', 'clap', 'noise').role).toBe('clap')
    expect(resolvePreset('gb', 'choir').role).toBe('pad')
  })
  it('returns fresh independent copies', () => {
    const a = resolvePreset('gb', 'gb.bass.wave-saw')
    const b = resolvePreset('gb', 'gb.bass.wave-saw')
    if (a.kind !== 'gb-wave' || b.kind !== 'gb-wave') throw new Error('kind')
    a.wave[0] = 9
    expect(b.wave[0]).not.toBe(9)
  })
  it('lists valid values on failure', () => {
    expect(() => resolvePreset('nes', 'banana')).toThrow(/Roles: lead.*Presets: nes\.lead\.duty25/s)
    expect(() => resolvePreset('nes', 'lead', 'wave')).toThrow(/No nes preset/)
    expect(() => resolvePreset('genesis', 'banana')).toThrow(/Unknown preset or role "banana" for genesis.*genesis.bass.slap/s)
    expect(tryResolvePreset('nes', 'banana')).toBeUndefined()
  })
  it('instrument validation catches bad data', () => {
    const wave = resolvePreset('gb', 'gb.bass.wave-saw')
    if (wave.kind !== 'gb-wave') throw new Error('kind')
    expect(validateInstrument({ ...wave, wave: [1, 2] })[0]).toContain('exactly 32')
    expect(validateInstrument({ ...wave, level: 7 as never })[0]).toContain('level')
    const pulse = resolvePreset('gb', 'gb.lead.duty25')
    expect(validateInstrument({ ...pulse, name: '' })[0]).toContain('name')
    expect(validateInstrument({ kind: 'bogus', name: 'x' } as never)[0]).toContain('unknown kind')
  })
})
