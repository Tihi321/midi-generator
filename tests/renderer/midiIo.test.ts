import { describe, expect, it } from 'vitest'
import { createSong, getPattern, parseMidi, resolvePreset } from '../../src/core'
import {
  DEFAULT_MIDI_EXPORT,
  chipConfigFor,
  convertChoices,
  defaultConvertTarget,
  defaultImportSettings,
  describeMidiExport,
  midiOptionsFor,
  planMidiExport,
  readFileBytes,
  reportSummary,
  runConvert,
  runImport,
  songNameFromFile
} from '../../src/renderer/lib/midiIo'

function song() {
  const s = createSong({ chip: 'nes', name: 'My: Song', patternLength: 16 })
  s.instruments.push(resolvePreset('nes', 'lead', 'pulse'), resolvePreset('nes', 'kick', 'noise'))
  getPattern(s, 'P1', 0).rows[0] = { note: 69, inst: 0 }
  getPattern(s, 'P1', 0).rows[4] = { note: 72 }
  getPattern(s, 'NO', 0).rows[0] = { note: 60, inst: 1 }
  return s
}

describe('midiIo', () => {
  it('plans a .mid export with a sanitized name', () => {
    const plan = planMidiExport(song(), 'My: Song', DEFAULT_MIDI_EXPORT)
    expect(plan.file.name).toBe('My_ Song.mid')
    expect(plan.file.data).toBeInstanceOf(Uint8Array)
    expect(String.fromCharCode(...(plan.file.data as Uint8Array).subarray(0, 4))).toBe('MThd')
    expect(parseMidi(plan.file.data as Uint8Array).tracks.length).toBe(plan.info.tracks)
    expect(describeMidiExport(plan.info)).toMatch(/3 tracks, 3 notes/)
    expect(planMidiExport(song(), 'x.mid', DEFAULT_MIDI_EXPORT).file.name).toBe('x.mid')
    expect(planMidiExport(song(), '', DEFAULT_MIDI_EXPORT).file.name).toBe('My_ Song.mid')
  })

  it('clamps the loop count and passes the arp mode', () => {
    expect(midiOptionsFor({ arpMode: 'chord', loops: 99 })).toEqual({ arpMode: 'chord', loops: 8 })
    expect(midiOptionsFor({ arpMode: 'notes', loops: Number.NaN })).toEqual({ arpMode: 'notes', loops: 1 })
  })

  it('imports bytes with the dialog settings and reports errors as values', () => {
    const bytes = planMidiExport(song(), 'a', DEFAULT_MIDI_EXPORT).file.data as Uint8Array
    const ok = runImport(bytes, { ...defaultImportSettings('gb', 'a'), rowsPerBeat: 8 })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.song.chip).toBe('gb')
      expect(ok.song.timing.rowsPerBeat).toBe(8)
      expect(ok.song.name).toBe('a')
      expect(ok.report.length).toBeGreaterThan(3)
    }
    const bad = runImport(new Uint8Array([1, 2, 3]), defaultImportSettings('nes'))
    expect(bad).toMatchObject({ ok: false })
    if (!bad.ok) expect(bad.error).toMatch(/MThd/)
  })

  it('chip options only apply to the chips that have them', () => {
    expect(chipConfigFor('nes', { dpcm: true, fm6Dac: true })).toEqual({ chip: 'nes', dpcm: true })
    expect(chipConfigFor('genesis', { dpcm: true, fm6Dac: true })).toEqual({ chip: 'genesis', fm6Dac: true })
    expect(chipConfigFor('gb', { dpcm: true, fm6Dac: true })).toEqual({})
    const bytes = planMidiExport(song(), 'a', DEFAULT_MIDI_EXPORT).file.data as Uint8Array
    const r = runImport(bytes, { ...defaultImportSettings('nes'), dpcm: true })
    expect(r.ok && r.song.channels.map((c) => c.id)).toContain('DM')
  })

  it('lists the convert targets and converts', () => {
    const s = song()
    const choices = convertChoices(s)
    expect(choices.map((c) => c.id)).toEqual(['nes', 'gb', 'genesis', 'snes', 'pce', 'ps1', 'dreamcast'])
    expect(choices.find((c) => c.current)!.id).toBe('nes')
    expect(defaultConvertTarget(s)).toBe('gb')
    const r = runConvert(s, { chip: 'genesis', dpcm: false, fm6Dac: true })
    expect(r.ok && r.song.channels.find((c) => c.id === 'F6')?.kind).toBe('sample')
    expect(r.ok && r.noop).toBe(false)
    const same = runConvert(s, { chip: 'nes', dpcm: false, fm6Dac: false })
    expect(same.ok && same.noop).toBe(true)
  })

  it('derives song names from file names and summarises reports', async () => {
    expect(songNameFromFile('boss_battle-2.mid')).toBe('boss battle 2')
    expect(songNameFromFile('C:\\x\\y.midi')).toBe('y')
    expect(reportSummary(['a', 'Dropped b', 'Dropped c'])).toBe('3 report lines, 2 drop notices')
    expect(reportSummary(['a'])).toBe('1 report lines')
    expect(Array.from(await readFileBytes(new Blob([new Uint8Array([1, 2, 3])])))).toEqual([1, 2, 3])
  })
})
