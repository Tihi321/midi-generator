import { describe, expect, it } from 'vitest'
import {
  GB_PRESETS, NES_PRESETS, PRESET_BANKS, SNES_PRESETS, createMacro, defaultChannelIds, defaultChannelKinds, formatMacro, gmHint, instrumentSlug,
  instSampleId, isDrumRole, kindsForChip, listPresets, missingPresetSample, parseMacro, parseRole, psxAttackSeconds, psxReleaseTauSec, resolvePreset,
  snesToAicaAeg, snesToPsxAdsr, tryResolvePreset, validateInstrument, validateMacro, aicaAttackSeconds, ROLE_META
} from '../../src/core/instruments'
import { snesEnvTimes } from '../../src/core/instruments/presets/snesTimes'
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
    expect(kindsForChip('ps1')).toEqual(['psx-sample'])
    expect(kindsForChip('dreamcast')).toEqual(['aica-sample'])
  })
  it('names the PS1 and Dreamcast role layouts V1..V16, drums on V13..V16', () => {
    for (const chip of ['ps1', 'dreamcast'] as const) {
      expect(defaultChannelIds(chip, 'bass')).toEqual(['V1'])
      expect(defaultChannelIds(chip, 'lead')).toEqual(['V2', 'V3'])
      expect(defaultChannelIds(chip, 'pad')).toEqual(['V4', 'V5', 'V6'])
      expect(defaultChannelIds(chip, 'brass')).toEqual(['V10', 'V2'])
      expect(['kick', 'snare', 'clap', 'hihat', 'openhat', 'crash'].map((r) => defaultChannelIds(chip, r as never)[0])).toEqual(['V13', 'V14', 'V14', 'V15', 'V15', 'V16'])
      expect(defaultChannelIds(chip, 'tom')).toEqual(['V12'])
      expect(defaultChannelKinds(chip, 'lead')).toEqual(['sample'])
    }
    expect(defaultChannelIds('ps1', 'sfx')).toEqual(['V11'])
  })
})

describe('preset banks', () => {
  it('have 15-40 presets for NES and GB and are empty placeholders for the rest', () => {
    expect(NES_PRESETS.length).toBeGreaterThanOrEqual(15)
    expect(NES_PRESETS.length).toBeLessThanOrEqual(40)
    expect(GB_PRESETS.length).toBeGreaterThanOrEqual(15)
    expect(GB_PRESETS.length).toBeLessThanOrEqual(40)
    expect(PRESET_BANKS.genesis.length).toBeGreaterThanOrEqual(20)
    expect(PRESET_BANKS.snes.length).toBeGreaterThanOrEqual(20)
    expect(PRESET_BANKS.ps1).toHaveLength(SNES_PRESETS.length)
    expect(PRESET_BANKS.dreamcast).toHaveLength(SNES_PRESETS.length)
  })
  for (const chip of ['nes', 'gb', 'ps1', 'dreamcast'] as const) {
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
  it('the PS1 and Dreamcast baseline banks mirror the SNES presets: same slots, mapped envelopes, reverb/send from echo', () => {
    SNES_PRESETS.forEach((s, i) => {
      const snes = s.instrument as { sample: string; echo: boolean; env: Parameters<typeof snesToPsxAdsr>[0] }
      const ps1 = PRESET_BANKS.ps1[i]!
      const dc = PRESET_BANKS.dreamcast[i]!
      expect(ps1.id).toBe(s.id.replace('snes.', 'ps1.'))
      expect(dc.id).toBe(s.id.replace('snes.', 'dreamcast.'))
      expect(ps1.sample).toEqual(s.sample)
      expect(dc.sample).toEqual(s.sample)
      expect(ps1.role).toBe(s.role)
      expect(ps1.instrument).toMatchObject({ kind: 'psx-sample', sample: snes.sample, reverb: snes.echo, adsr: snesToPsxAdsr(snes.env) })
      expect(dc.instrument).toMatchObject({ kind: 'aica-sample', sample: snes.sample, format: 'pcm16', aeg: snesToAicaAeg(snes.env), send: snes.echo ? 10 : 0 })
      expect(ps1.description).not.toMatch(/SNES|echo/i)
    })
  })
  it('snesToPsxAdsr keeps the SNES attack time (within 20%) and release', () => {
    for (let a = 3; a <= 14; a++) {
      const env = { adsr: [a, 5, 6, 0] as [number, number, number, number] }
      const want = snesEnvTimes(env).attackSec
      const got = psxAttackSeconds(snesToPsxAdsr(env).attack)
      expect(got / want, `attack ${a}`).toBeGreaterThan(0.8)
      expect(got / want, `attack ${a}`).toBeLessThan(1.2)
    }
    const a = snesToPsxAdsr({ adsr: [15, 7, 7, 0] })
    expect(psxAttackSeconds(a.attack)).toBeLessThan(0.001)
    expect(a).toMatchObject({ sustainLevel: 15, sustainRate: 127, sustainDir: 'dec' })
    const want = snesEnvTimes({ adsr: [15, 7, 7, 0] }).releaseTauSec
    expect(psxReleaseTauSec(a.release) / want).toBeGreaterThan(0.8)
    expect(psxReleaseTauSec(a.release) / want).toBeLessThan(1.2)
    // a plucky envelope (sustain rate 17) decays: not held; SNES level 3/8 is PS1 level 6/16 (field 5)
    expect(snesToPsxAdsr({ adsr: [14, 6, 2, 17] })).toMatchObject({ sustainLevel: 5, sustainDir: 'dec' })
    expect(snesToPsxAdsr({ adsr: [14, 6, 2, 17] }).sustainRate).toBeLessThan(127)
  })
  it('snesToAicaAeg maps attack, hold (D2R 0) and decay level', () => {
    for (let a = 3; a <= 14; a++) {
      const ar = snesToAicaAeg({ adsr: [a, 5, 6, 0] }).ar
      const got = aicaAttackSeconds(ar)
      const want = snesEnvTimes({ adsr: [a, 5, 6, 0] }).attackSec
      expect(got / want, `attack ${a}`).toBeGreaterThan(0.7)
      expect(got / want, `attack ${a}`).toBeLessThan(1.45)
    }
    expect(snesToAicaAeg({ adsr: [15, 7, 7, 0] })).toMatchObject({ ar: 31, d2r: 0, dl: 0 })
    expect(snesToAicaAeg({ adsr: [14, 6, 2, 17] }).d2r).toBeGreaterThan(0)
    expect(snesToAicaAeg({ adsr: [14, 6, 2, 17] }).dl).toBeGreaterThan(0)
    for (const g of [snesToAicaAeg({ gain: { mode: 'direct', rate: 80 } }), snesToAicaAeg({ gain: { mode: 'exp-dec', rate: 12 } })]) {
      expect(validateInstrument({ kind: 'aica-sample', name: 'x', sample: 's', baseNote: 60, format: 'pcm16', aeg: g, send: 0 })).toEqual([])
    }
  })
  it('instSampleId finds the slot of every sample kind and nothing else', () => {
    expect(instSampleId(resolvePreset('snes', 'lead'))).toBe('lead-saw')
    expect(instSampleId(resolvePreset('ps1', 'lead'))).toBe('lead-saw')
    expect(instSampleId(resolvePreset('dreamcast', 'lead'))).toBe('lead-saw')
    expect(instSampleId(resolvePreset('nes', 'lead'))).toBeUndefined()
    expect(instSampleId({ kind: 'sample', name: 'd', sample: 'dac1' })).toBe('dac1')
  })
  it('missingPresetSample works for the PS1 and Dreamcast presets', () => {
    for (const chip of ['ps1', 'dreamcast'] as const) {
      const inst = resolvePreset(chip, 'lead')
      const slot = missingPresetSample({ samples: [] }, inst)
      expect(slot?.id).toBe('lead-saw')
      expect(missingPresetSample({ samples: [slot!] }, resolvePreset(chip, 'lead'))).toBeUndefined()
    }
  })
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
  it('validates PS1 and Dreamcast instrument ranges with readable messages', () => {
    const psx = resolvePreset('ps1', 'lead')
    if (psx.kind !== 'psx-sample') throw new Error('kind')
    expect(validateInstrument(psx)).toEqual([])
    expect(validateInstrument({ ...psx, adsr: { ...psx.adsr, attack: 128 } })).toEqual(['adsr.attack 128 must be an integer 0..127 (0 = fastest).'])
    expect(validateInstrument({ ...psx, adsr: { ...psx.adsr, decay: 16, sustainLevel: -1 } })).toHaveLength(2)
    expect(validateInstrument({ ...psx, adsr: { ...psx.adsr, sustainRate: 1.5 } })[0]).toContain('sustainRate')
    expect(validateInstrument({ ...psx, adsr: { ...psx.adsr, release: 32 } })[0]).toContain('adsr.release 32')
    expect(validateInstrument({ ...psx, adsr: { ...psx.adsr, sustainDir: 'up' as never } })[0]).toContain('sustainDir')
    expect(validateInstrument({ ...psx, adsr: undefined as never })[0]).toContain('missing "adsr"')
    expect(validateInstrument({ ...psx, reverb: 1 as never })[0]).toContain('reverb must be true or false')
    expect(validateInstrument({ ...psx, baseNote: 130 })[0]).toContain('baseNote')
    expect(validateInstrument({ ...psx, pmod: 'yes' as never })[0]).toContain('pmod')
    expect(validateInstrument({ ...psx, pmod: true, noise: { shift: 15, step: 3 } })).toEqual([])
    expect(validateInstrument({ ...psx, noise: { shift: 16, step: 4 } })).toHaveLength(2)
    expect(validateInstrument({ ...psx, noise: 5 as never })[0]).toContain('noise must be')
    const aica = resolvePreset('dreamcast', 'lead')
    if (aica.kind !== 'aica-sample') throw new Error('kind')
    expect(validateInstrument(aica)).toEqual([])
    expect(validateInstrument({ ...aica, aeg: { ...aica.aeg, ar: 32 } })).toEqual(['aeg.ar 32 must be an integer 0..31.'])
    expect(validateInstrument({ ...aica, aeg: { ...aica.aeg, dl: -1, krs: 16 } })).toHaveLength(2)
    expect(validateInstrument({ ...aica, aeg: undefined as never })[0]).toContain('missing "aeg"')
    expect(validateInstrument({ ...aica, format: 'mp3' as never })[0]).toContain('format must be one of pcm16, pcm8, adpcm')
    expect(validateInstrument({ ...aica, send: 16 })[0]).toContain('send 16')
    const filter = { q: 12, flv: [8191, 4000, 2000, 1000, 500] as [number, number, number, number, number], far: 20, fd1r: 10, fd2r: 5, frr: 12 }
    expect(validateInstrument({ ...aica, filter })).toEqual([])
    expect(validateInstrument({ ...aica, filter: { ...filter, q: 32 } })[0]).toContain('filter.q 32')
    expect(validateInstrument({ ...aica, filter: { ...filter, flv: [8192, 0, 0, 0, 0] } })[0]).toContain('filter.flv')
    expect(validateInstrument({ ...aica, filter: { ...filter, flv: [1, 2] as never } })[0]).toContain('filter.flv')
    expect(validateInstrument({ ...aica, filter: { ...filter, frr: 40 } })[0]).toContain('filter.frr')
    const lfo = { freq: 10, pitchWave: 'tri' as const, pitchDepth: 3, ampWave: 'noise' as const, ampDepth: 0, reset: false }
    expect(validateInstrument({ ...aica, lfo })).toEqual([])
    expect(validateInstrument({ ...aica, lfo: { ...lfo, freq: 32, pitchDepth: 8 } })).toHaveLength(2)
    expect(validateInstrument({ ...aica, lfo: { ...lfo, ampWave: 'sine' as never } })[0]).toContain('lfo.ampWave')
    expect(validateInstrument({ ...aica, lfo: { ...lfo, reset: 'x' as never } })[0]).toContain('lfo.reset')
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
