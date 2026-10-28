import { describe, expect, it } from 'vitest'
import {
  ARAM_BYTES, CHIP_PROFILES, chipChannels, defaultChipConfig, defaultPs1Config, defineProfile, formatIssues, getChipProfile, listChips, ps1Channels,
  requireChipId, snesAramUsage, validateCellsFor, validateSong
} from '../../src/core/chips'
import { createSong, getPattern } from '../../src/core/model'
import { CHIP_IDS } from '../../src/core/types'
import type { Song } from '../../src/core/types'
import { songWithPresets } from './helpers'

function put(song: Song, channel: string, row: number, cell: object, pattern = 0): void {
  getPattern(song, channel, pattern).rows[row] = cell
}

describe('chip registry', () => {
  it('lists all seven chips with channel data for the LLM', () => {
    const chips = listChips()
    expect(chips.map((c) => c.id)).toEqual([...CHIP_IDS])
    for (const c of chips) {
      expect(c.channels.length).toBeGreaterThan(3)
      expect(c.notes.length).toBeGreaterThan(2)
      expect(c.era).toBeTruthy()
    }
    expect(chips.find((c) => c.id === 'genesis')!.channels).toHaveLength(10)
    expect(chips.map((c) => c.id).slice(-2)).toEqual(['ps1', 'dreamcast'])
  })
  it('defaultChipConfig matches the chip and requireChipId accepts aliases', () => {
    for (const id of CHIP_IDS) expect(defaultChipConfig(id).chip).toBe(id)
    expect(requireChipId('Game Boy')).toBe('gb')
    expect(requireChipId('mega drive')).toBe('genesis')
    expect(requireChipId('PC Engine')).toBe('pce')
    for (const a of ['psx', 'PlayStation', 'play station', 'playstation1', 'SPU', 'ps1']) expect(requireChipId(a), a).toBe('ps1')
    for (const a of ['dc', 'AICA', 'Sega Dreamcast', 'segadreamcast', 'dreamcast']) expect(requireChipId(a), a).toBe('dreamcast')
    expect(() => requireChipId('c64')).toThrow(/Valid chips: nes, gb, genesis, snes, pce, ps1, dreamcast/)
    expect(() => getChipProfile('zx' as never)).toThrow(/Unknown chip/)
  })
  it('channel definitions are consistent', () => {
    for (const id of CHIP_IDS) {
      const defs = chipChannels(id)
      expect(new Set(defs.map((d) => d.id)).size).toBe(defs.length)
      for (const d of defs) {
        expect(d.noteMin).toBeLessThanOrEqual(d.noteMax)
        expect(d.instKinds.length).toBeGreaterThan(0)
        expect(d.effects).toContain('F')
      }
    }
  })
  it('a fresh song with presets validates cleanly on NES and GB', () => {
    const { song } = songWithPresets('nes', [{ ref: 'lead' }, { ref: 'bass', kind: 'triangle' }, { ref: 'snare', kind: 'noise' }])
    expect(validateSong(song)).toEqual([])
    const gb = songWithPresets('gb', [{ ref: 'lead' }, { ref: 'bass' }])
    expect(validateSong(gb.song)).toEqual([])
  })
})

describe('NES rules', () => {
  const refs = [{ ref: 'lead' }, { ref: 'bass', kind: 'triangle' as const }, { ref: 'snare', kind: 'noise' as const }]
  it('note below the pulse range suggests transposing or moving to the triangle', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'P1', 3, { note: 24, inst: 0 })
    const issues = validateSong(song)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', channel: 'P1', order: 0, pattern: 0, row: 3, field: 'note' })
    expect(issues[0]!.message).toBe("note C-1 is below P1's lowest note A-1 on NES; transpose +12 or move to TR")
  })
  it('note above the triangle range', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'TR', 0, { note: 108, inst: 1 })
    const [issue] = validateSong(song)
    expect(issue!.message).toContain('above TR')
    expect(issue!.message).toContain('transpose -12')
    expect(issue!.message).toContain('move to P1/P2')
  })
  it('volume on the triangle is an error', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'TR', 0, { note: 40, inst: 1, vol: 12 })
    const [issue] = validateSong(song)
    expect(issue).toMatchObject({ field: 'vol' })
    expect(issue!.message).toBe('triangle has no volume on NES; remove it')
  })
  it('instrument kind must match the channel', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'TR', 0, { note: 40, inst: 0 })
    const [issue] = validateSong(song)
    expect(issue!.message).toContain('nes-pulse')
    expect(issue!.message).toContain('TR accepts nes-tri')
    expect(issue!.message).toContain('move this part to P1/P2')
  })
  it('effects must be allowed on the channel', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'TR', 0, { note: 40, inst: 1, fx: [{ code: 'W', param: 2 }] })
    put(song, 'P1', 0, { note: 60, inst: 0, fx: [{ code: 'X', param: 0x80 }] })
    const issues = validateSong(song)
    const msgs = issues.map((i) => i.message)
    expect(msgs.some((m) => m.includes('effect W02 is not available on TR'))).toBe(true)
    expect(msgs.some((m) => m.includes('effect X80 is not available on P1'))).toBe(true)
    expect(issues).toHaveLength(2)
    expect(issues.every((i) => i.severity === 'error' && i.field === 'fx')).toBe(true)
  })
  it('unknown instrument and out-of-range volume are always errors', () => {
    const { song } = songWithPresets('nes', refs)
    song.authenticity = 'relaxed'
    put(song, 'P1', 0, { note: 60, inst: 9 })
    put(song, 'P1', 1, { note: 60, vol: 40 })
    const issues = validateSong(song)
    expect(issues.map((i) => i.severity)).toEqual(['error', 'error'])
    expect(issues[0]!.message).toContain('@0..@2')
  })
  it('relaxed mode downgrades chip rules to warnings', () => {
    const { song } = songWithPresets('nes', refs, { authenticity: 'relaxed' })
    put(song, 'TR', 0, { note: 40, inst: 1, vol: 12 })
    put(song, 'P1', 1, { note: 24, inst: 0 })
    const issues = validateSong(song)
    expect(issues).toHaveLength(2)
    expect(issues.every((i) => i.severity === 'warning')).toBe(true)
  })
  it('noise notes are not range-checked; DPCM exists only when enabled', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'NO', 0, { note: 12, inst: 2 })
    expect(validateSong(song)).toEqual([])
    expect(chipChannels('nes').map((d) => d.id)).not.toContain('DM')
    expect(chipChannels('nes', { chip: 'nes', region: 'ntsc', dpcm: true, mixModel: 'linear' }).map((d) => d.id)).toContain('DM')
  })
  it('flags more effects than columns', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'P1', 0, { note: 60, inst: 0, fx: [{ code: '0', param: 0x47 }, { code: '4', param: 0x12 }, { code: 'W', param: 1 }] })
    const [issue] = validateSong(song)
    expect(issue!.message).toContain('effect column')
  })
  it('scopes validation to channels, patterns or orders', () => {
    const { song } = songWithPresets('nes', refs)
    put(song, 'P1', 0, { note: 24, inst: 0 })
    put(song, 'TR', 0, { note: 40, inst: 1, vol: 5 })
    expect(validateSong(song, { channels: ['TR'] })).toHaveLength(1)
    expect(validateSong(song, { patterns: [{ channel: 'P1', pattern: 0 }] })).toHaveLength(1)
    expect(validateSong(song, { orders: [0] })).toHaveLength(2)
    expect(validateSong(song, { orders: [5] })).toHaveLength(0)
  })
  it('validateCellsFor checks cells before they are written', () => {
    const { song } = songWithPresets('nes', refs)
    const issues = validateCellsFor(getChipProfile('nes'), song, [
      { channel: 'TR', cell: { note: 40, vol: 3 }, row: 2 },
      { channel: 'ZZ', cell: { note: 40 } }
    ])
    expect(issues).toHaveLength(2)
    expect(issues[0]!.row).toBe(2)
    expect(issues[1]!.message).toContain('no channel "ZZ"')
  })
  it('formats issues for tool output', () => {
    const text = formatIssues([{ severity: 'error', channel: 'TR', order: 0, pattern: 1, row: 4, message: 'bad' }])
    expect(text).toBe('ERROR [TR order 0 pattern 1 row 4]: bad')
  })
})

describe('Game Boy rules', () => {
  const refs = [{ ref: 'gb.lead.duty25' }, { ref: 'gb.bass.wave-saw' }, { ref: 'gb.lead.sweep' }, { ref: 'gb.kick.noise' }]
  it('warns about wave-channel volume quantization once per pattern', () => {
    const { song } = songWithPresets('gb', refs)
    put(song, 'WV', 0, { note: 36, inst: 1, vol: 10 })
    put(song, 'WV', 4, { note: 36, inst: 1, vol: 6 })
    put(song, 'WV', 8, { note: 36, inst: 1, vol: 8 })
    const issues = validateSong(song)
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', channel: 'WV', row: 0 })
    expect(issues[0]!.message).toContain('2 volume value(s) are quantized')
    expect(issues[0]!.message).toContain('v10 plays as v8')
  })
  it('sweep instruments only work on P1', () => {
    const { song } = songWithPresets('gb', refs)
    put(song, 'P1', 0, { note: 60, inst: 2 })
    expect(validateSong(song)).toEqual([])
    put(song, 'P2', 0, { note: 60, inst: 2 })
    const [issue] = validateSong(song)
    expect(issue!.channel).toBe('P2')
    expect(issue!.message).toContain('only P1')
  })
  it('pulse range starts at C-2', () => {
    const { song } = songWithPresets('gb', refs)
    put(song, 'P1', 0, { note: 33, inst: 0 })
    const [issue] = validateSong(song)
    expect(issue!.message).toContain('transpose +12')
    expect(issue!.message).toContain('WV')
  })
  it('allows pan on every channel but not wave-index effects on the wave channel', () => {
    const { song } = songWithPresets('gb', refs)
    put(song, 'WV', 0, { note: 40, inst: 1, fx: [{ code: 'X', param: 0 }] })
    expect(validateSong(song)).toEqual([])
    put(song, 'WV', 1, { note: 40, inst: 1, fx: [{ code: 'W', param: 1 }] })
    expect(validateSong(song)).toHaveLength(1)
  })
})

describe('Genesis rules', () => {
  const fm = {
    name: 'fm1', kind: 'fm' as const, alg: 4, fb: 3, ams: 0, pms: 0,
    ops: [0, 1, 2, 3].map(() => ({ ar: 31, dr: 5, sr: 0, rr: 7, sl: 3, tl: 20, ks: 0, ml: 1, dt: 0 })) as never
  }
  function genesisSong(cfg?: object): Song {
    const s = createSong({ chip: 'genesis', patternLength: 16, chipConfig: cfg as never })
    s.instruments.push(fm, { name: 'sq', kind: 'psg', macros: {} }, { name: 'nz', kind: 'psg-noise', macros: {} })
    return s
  }
  it('PSG squares cannot play below A-2', () => {
    const song = genesisSong()
    put(song, 'S1', 0, { note: 44, inst: 1 })
    const [issue] = validateSong(song)
    expect(issue!.message).toContain("below S1's lowest note A-2")
    expect(issue!.message).toContain('the SN76489 cannot play below A-2')
    expect(issue!.message).toContain('F1/F2/F3')
    put(song, 'S1', 0, { note: 45, inst: 1 })
    expect(validateSong(song)).toEqual([])
  })
  it('FM channels take FM instruments only; F6 becomes a DAC sample channel with fm6Dac', () => {
    const song = genesisSong()
    put(song, 'F1', 0, { note: 40, inst: 1 })
    expect(validateSong(song)[0]!.message).toContain('accepts fm')
    const dac = genesisSong({ fm6Dac: true })
    put(dac, 'F6', 0, { note: 40, inst: 0 })
    expect(validateSong(dac)[0]!.message).toContain('accepts sample')
  })
  it('PSG noise channel accepts psg-noise only', () => {
    const song = genesisSong()
    put(song, 'NO', 0, { note: 60, inst: 2 })
    expect(validateSong(song)).toEqual([])
    put(song, 'NO', 1, { note: 60, inst: 1 })
    expect(validateSong(song)).toHaveLength(1)
  })
  it('PSG has no pan, FM has', () => {
    const song = genesisSong()
    put(song, 'F1', 0, { note: 40, inst: 0, fx: [{ code: 'X', param: 0 }] })
    expect(validateSong(song)).toEqual([])
    put(song, 'S1', 0, { note: 60, inst: 1, fx: [{ code: 'X', param: 0 }] })
    expect(validateSong(song)).toHaveLength(1)
  })
})

describe('PC Engine rules', () => {
  const wave = (noise: boolean) => ({
    name: noise ? 'nz' : 'w', kind: 'pce-wave' as const, noise, macros: {}, waves: [Array.from({ length: 32 }, (_, i) => i)]
  })
  it('noise instruments only on C5/C6', () => {
    const song = createSong({ chip: 'pce', patternLength: 16 })
    song.instruments.push(wave(false), wave(true))
    put(song, 'C5', 0, { note: 60, inst: 1 })
    put(song, 'C6', 0, { note: 60, inst: 1 })
    expect(validateSong(song)).toEqual([])
    put(song, 'C1', 0, { note: 60, inst: 1 })
    const [issue] = validateSong(song)
    expect(issue!.channel).toBe('C1')
    expect(issue!.message).toContain('only works on C5 and C6')
  })
  it('wave data is validated at song level', () => {
    const song = createSong({ chip: 'pce', patternLength: 16 })
    song.instruments.push({ ...wave(false), waves: [[1, 2, 3]] })
    const issues = validateSong(song)
    expect(issues[0]!.message).toContain('waves[0] must be exactly 32')
  })
})

describe('SNES rules', () => {
  function snesSong(delay: number, size: number): Song {
    const song = createSong({ chip: 'snes', patternLength: 16, chipConfig: { echo: { delay } } as never })
    song.samples.push({ id: 'smp1', name: 'big', source: { kind: 'recipe', recipe: 'strings', params: {} } })
    song.instruments.push({ name: 'str', kind: 'snes-sample', sample: 'smp1', baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: true })
    void size
    return song
  }
  it('computes ARAM usage from sample sizes and the echo delay', () => {
    const song = snesSong(4, 0)
    const u = snesAramUsage(song, { smp1: 16000 })
    expect(u.sampleBytes).toBe(Math.ceil(16000 / 16) * 9)
    expect(u.echoBytes).toBe(4 * 2048)
    expect(u.total).toBe(9000 + 8192)
    expect(u.budget).toBe(ARAM_BYTES)
  })
  it('errors when the budget is exceeded and says how to fix it', () => {
    const song = snesSong(8, 0)
    const issues = validateSong(song, { sampleSizes: { smp1: 100000 } })
    const budget = issues.find((i) => i.message.includes('ARAM budget exceeded'))!
    expect(budget.severity).toBe('error')
    expect(budget.message).toContain('lower the echo delay')
    expect(budget.message).toContain('"smp1"')
  })
  it('warns when nearly full and is silent when small', () => {
    const near = validateSong(snesSong(4, 0), { sampleSizes: { smp1: 90000 } })
    expect(near.some((i) => i.severity === 'warning' && i.message.includes('nearly full'))).toBe(true)
    expect(validateSong(snesSong(2, 0), { sampleSizes: { smp1: 8000 } })).toEqual([])
  })
  it('estimates recipe sample sizes when unknown and reports missing samples', () => {
    const song = snesSong(4, 0)
    expect(snesAramUsage(song).sampleBytes).toBeGreaterThan(0)
    song.samples = []
    const issues = validateSong(song)
    expect(issues.some((i) => i.message.includes('missing sample "smp1"'))).toBe(true)
  })
  it('only snes-sample instruments are allowed', () => {
    const song = createSong({ chip: 'snes' })
    song.instruments.push({ name: 'x', kind: 'nes-pulse', macros: {} })
    expect(validateSong(song).some((i) => i.message.includes('SNES cannot play'))).toBe(true)
  })
})

describe('PS1 and Dreamcast profiles', () => {
  const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `V${i + 1}`)
  it('have V1..Vn sample channels for every allowed voice count', () => {
    for (const [chip, counts] of [['ps1', [16, 24]], ['dreamcast', [16, 32, 64]]] as const) {
      expect(chipChannels(chip).map((d) => d.id)).toEqual(ids(16))
      for (const voices of counts) {
        const song = createSong({ chip, chipConfig: { voices } as never })
        expect(song.channels.map((c) => c.id)).toEqual(ids(voices))
        expect(chipChannels(chip, song.chipConfig).map((d) => d.id)).toEqual(ids(voices))
        for (const d of chipChannels(chip, song.chipConfig)) {
          expect(d).toMatchObject({ kind: 'sample', pan: 'full', hasVolume: true, noteMin: 12, noteMax: 119 })
          expect(d.instKinds).toEqual([chip === 'ps1' ? 'psx-sample' : 'aica-sample'])
          expect(d.effects).toEqual(chipChannels('snes')[0]!.effects)
        }
      }
    }
  })
  it('refuse a voice count the chip does not have', () => {
    expect(() => chipChannels('ps1', { ...defaultPs1Config(), voices: 20 as never })).toThrow('PS1 voices must be 16 or 24 (got 20)')
    expect(() => chipChannels('dreamcast', { ...defaultChipConfig('dreamcast'), voices: 48 } as never)).toThrow(/Dreamcast voices must be 16, 32 or 64/)
    expect(() => createSong({ chip: 'ps1', chipConfig: { voices: '24' } as never })).toThrow(/voices must be/)
  })
  it('list_chips describes both chips', () => {
    const ps1 = listChips().find((c) => c.id === 'ps1')!
    expect(ps1.channels).toHaveLength(16)
    expect(ps1.channels[0]!.accepts).toEqual(['psx-sample'])
    expect(ps1.notes.join(' ')).toMatch(/512 KB/)
    const dc = listChips().find((c) => c.id === 'dreamcast')!
    expect(dc.channels[0]!.accepts).toEqual(['aica-sample'])
    expect(dc.notes.join(' ')).toMatch(/2 MB/)
  })
  it('report a bad reverb or DSP config', () => {
    const ps1 = createSong({ chip: 'ps1' })
    ;(ps1.chipConfig as { reverb: { preset: string; depth: number } }).reverb = { preset: 'cathedral', depth: 2 }
    const msgs = validateSong(ps1).map((i) => i.message)
    expect(msgs.some((m) => m.includes('reverb.preset') && m.includes('studio-large'))).toBe(true)
    expect(msgs.some((m) => m.includes('reverb.depth'))).toBe(true)
    const dc = createSong({ chip: 'dreamcast' })
    ;(dc.chipConfig as { dsp: { preset: string; feedback: number } }).dsp = { ...(dc.chipConfig as { dsp: object }).dsp, preset: 'cave', feedback: 1.5 } as never
    const d = validateSong(dc).map((i) => i.message)
    expect(d.some((m) => m.includes('dsp.preset') && m.includes('chorus-hall'))).toBe(true)
    expect(d.some((m) => m.includes('dsp.feedback'))).toBe(true)
  })
  it('only their own sample kind is allowed and a missing sample is reported', () => {
    const song = createSong({ chip: 'ps1' })
    song.instruments.push({ name: 'x', kind: 'snes-sample', sample: 's', baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: false })
    expect(validateSong(song).some((i) => i.message.includes('PS1 cannot play'))).toBe(true)
    const dc = createSong({ chip: 'dreamcast' })
    dc.instruments.push({ name: 'a', kind: 'aica-sample', sample: 'nope', baseNote: 60, format: 'pcm16', aeg: { ar: 31, d1r: 0, d2r: 0, rr: 20, dl: 0 }, send: 0 })
    expect(validateSong(dc).some((i) => i.message.includes('missing sample "nope"'))).toBe(true)
  })
  it('a chip can add its own instrument-on-channel rule', () => {
    const profile = defineProfile({
      id: 'ps1', label: 'PS1', name: 'T', era: '', description: '', notes: [],
      channels: ps1Channels, defaultConfig: defaultPs1Config,
      instrumentOnChannel: (_song, def, inst, index) => (def.id === 'V1' ? [`@${index} ${inst.name} cannot go on V1`] : [])
    })
    const song = createSong({ chip: 'ps1' })
    song.instruments.push({ name: 'p', kind: 'psx-sample', sample: 's', baseNote: 60, adsr: { attack: 0, attackExp: false, decay: 0, sustainLevel: 15, sustainRate: 0, sustainDir: 'dec', sustainExp: false, release: 0, releaseExp: false }, reverb: false })
    const issues = validateCellsFor(profile, song, [{ channel: 'V1', cell: { note: 60, inst: 0 } }, { channel: 'V2', cell: { note: 60, inst: 0 } }])
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'error', channel: 'V1', field: 'inst', message: '@0 p cannot go on V1' })
  })
})

describe('profiles are registered', () => {
  it('every profile validates an empty song without issues', () => {
    for (const id of CHIP_IDS) {
      const song = createSong({ chip: id })
      expect(CHIP_PROFILES[id].validate(song)).toEqual([])
    }
  })
})
