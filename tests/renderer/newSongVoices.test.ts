import { describe, expect, it } from 'vitest'
import { getPattern, validateSong } from '../../src/core'
import { DEFAULT_MIDI_EXPORT, chipConfigFor, convertVoices, defaultImportSettings, planMidiExport, runConvert, runImport } from '../../src/renderer/lib/midiIo'
import { createStarterSong, defaultVoices, voiceChoices, voicesConfig } from '../../src/renderer/lib/newSong'

const opts = { name: 'x', bpm: 120, key: 'C', scale: 'major', moods: [], patternLength: 16 }

describe('voice choices', () => {
  it('only the sample chips offer a voice count, default 16', () => {
    expect(voiceChoices('ps1')).toEqual([16, 24])
    expect(voiceChoices('dreamcast')).toEqual([16, 32, 64])
    for (const chip of ['nes', 'gb', 'genesis', 'snes', 'pce'] as const) expect(voiceChoices(chip)).toEqual([])
    expect(defaultVoices('ps1')).toBe(16)
    expect(defaultVoices('dreamcast')).toBe(16)
    expect(defaultVoices('snes')).toBe(0)
    expect(voicesConfig('ps1', 24)).toEqual({ chip: 'ps1', voices: 24 })
    expect(voicesConfig('ps1', 64)).toEqual({})
    expect(voicesConfig('snes', 16)).toEqual({})
    expect(voicesConfig('ps1', undefined)).toEqual({})
  })
})

describe('new song with voices', () => {
  it('creates 16 / 24 PS1 voices and 16 / 32 / 64 Dreamcast voices', () => {
    for (const [chip, counts] of [['ps1', [16, 24]], ['dreamcast', [16, 32, 64]]] as const) {
      for (const voices of counts) {
        const song = createStarterSong({ ...opts, chip, voices })
        expect(song.channels).toHaveLength(voices)
        expect(song.channels[0]!.id).toBe('V1')
        expect(song.channels.at(-1)!.id).toBe(`V${voices}`)
        expect(song.orders[0]).toHaveLength(voices)
        expect(song.chipConfig).toMatchObject({ chip, voices })
        expect(validateSong(song).filter((i) => i.severity === 'error')).toEqual([])
      }
    }
  })

  it('the default and an unsupported count give 16 voices; chips without the choice ignore it', () => {
    expect(createStarterSong({ ...opts, chip: 'ps1' }).channels).toHaveLength(16)
    expect(createStarterSong({ ...opts, chip: 'ps1', voices: 64 }).channels).toHaveLength(16)
    expect(createStarterSong({ ...opts, chip: 'snes', voices: 24 }).channels).toHaveLength(8)
  })
})

describe('convert with voices', () => {
  it('passes the voice count to the target chip', () => {
    const nes = createStarterSong({ ...opts, chip: 'nes' })
    expect(chipConfigFor('dreamcast', { dpcm: false, fm6Dac: false, voices: 32 })).toEqual({ chip: 'dreamcast', voices: 32 })
    const r = runConvert(nes, { chip: 'dreamcast', dpcm: false, fm6Dac: false, voices: 32 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.song.channels).toHaveLength(32)
      expect(r.song.chipConfig).toMatchObject({ chip: 'dreamcast', voices: 32 })
    }
    const dflt = runConvert(nes, { chip: 'ps1', dpcm: false, fm6Dac: false, voices: convertVoices(nes, 'ps1') })
    expect(dflt.ok && dflt.song.channels.length).toBe(16)
  })

  it("the dialog starts with the song's own voice count for its own chip, else the default", () => {
    const ps1 = createStarterSong({ ...opts, chip: 'ps1', voices: 24 })
    expect(convertVoices(ps1, 'ps1')).toBe(24)
    expect(convertVoices(ps1, 'dreamcast')).toBe(16)
    expect(convertVoices(ps1, 'snes')).toBeUndefined()
  })

  it('another voice count on the same chip keeps its reverb settings', () => {
    const ps1 = createStarterSong({ ...opts, chip: 'ps1', voices: 16 })
    ;(ps1.chipConfig as { reverb: { preset: string } }).reverb.preset = 'hall'
    const r = runConvert(ps1, { chip: 'ps1', dpcm: false, fm6Dac: false, voices: 24 })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.song.channels).toHaveLength(24)
      expect(r.song.chipConfig).toMatchObject({ voices: 24, reverb: { preset: 'hall' } })
    }
  })
})

describe('import with voices', () => {
  it('imports onto the chosen voice count', () => {
    const nes = createStarterSong({ ...opts, chip: 'nes' })
    getPattern(nes, 'P1', 0).rows[0] = { note: 69, inst: 0 }
    getPattern(nes, 'P1', 0).rows[4] = { note: 72 }
    const bytes = planMidiExport(nes, 'a', DEFAULT_MIDI_EXPORT).file.data as Uint8Array
    for (const [chip, voices] of [['ps1', 24], ['dreamcast', 32]] as const) {
      const r = runImport(bytes, { ...defaultImportSettings(chip, 'a'), voices })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.song.channels).toHaveLength(voices)
    }
    const dflt = runImport(bytes, defaultImportSettings('ps1', 'a'))
    expect(dflt.ok && dflt.song.channels.length).toBe(16)
  })
})
