import { describe, expect, it } from 'vitest'
import { parseMidi, serializeProject } from '../../src/core'
import { resultText, songSetup } from './helpers'

async function writeSong(t: ReturnType<typeof songSetup>): Promise<void> {
  await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
  await t.ok('add_instrument', { preset: 'bass', channel: 'TR' })
  await t.ok('write_drums', { legend: { K: 'kick', S: 'snare', h: 'hat' }, steps: 'K.h.S.h.K.KhS.h.', repeat: 4 })
  await t.ok('write_pattern', { text: 'channels: P1 | TR\n 0 | E-5 @lead v12 | A-2 @bass\n 4 | G-5 | A-2\n 8 | A-5 | F-2\n12 | G-5 | E-2' })
  await t.ok('set_loop', { order: 0 })
}

describe('export_midi', () => {
  it('writes a parseable .mid under the exports folder and does not touch the song or history', async () => {
    const t = songSetup()
    await writeSong(t)
    const depth = t.session.history.undoDepth
    const before = serializeProject(t.song)
    const r = await t.ok('export_midi', { name: 'overworld', arpMode: 'chord' })
    const path = '/mem/exports/overworld.mid'
    expect(t.services.files.has(path)).toBe(true)
    const m = parseMidi(t.services.files.get(path)!)
    expect(m.format).toBe(1)
    expect(m.division).toBe(480)
    expect(m.tracks.length).toBeGreaterThanOrEqual(3)
    expect(m.tracks.some((tr) => tr.some((e) => e.kind === 'noteOn' && e.channel === 9))).toBe(true) // drums on channel 10
    const text = resultText(r)
    expect(text).toContain('Exported overworld.mid')
    expect(text).toContain('Loop:')
    expect(text).toContain(path)
    expect(t.session.history.undoDepth).toBe(depth)
    expect(serializeProject(t.song)).toBe(before)
  })

  it('defaults to the song name, accepts absolute paths and refuses an empty song', async () => {
    const t = songSetup()
    const empty = await t.call('export_midi', {})
    expect(empty.isError).toBe(true)
    expect(resultText(empty)).toMatch(/no notes/)
    await writeSong(t)
    await t.ok('export_midi')
    expect(t.services.files.has('/mem/exports/test.mid')).toBe(true)
    await t.ok('export_midi', { name: '/tmp/x/song.mid' })
    expect(t.services.files.has('/tmp/x/song.mid')).toBe(true)
    const bad = await t.call('export_midi', { arpMode: 'bogus' })
    expect(bad.isError).toBe(true)
  })
})

describe('import_midi', () => {
  it('replaces the song as one undo step and returns the report; undo restores', async () => {
    const t = songSetup()
    await writeSong(t)
    await t.ok('export_midi', { name: 'src' })
    // work on a different chip so the import visibly replaces the song
    await t.ok('new_song', { chip: 'gb', name: 'blank' })
    const depth = t.session.history.undoDepth
    const r = await t.ok('import_midi', { path: 'src', chip: 'nes' })
    const text = resultText(r)
    expect(text).toContain('Imported /mem/exports/src.mid as a NES song')
    expect(text).toMatch(/Grid: 4 rows per beat/)
    expect(text).toMatch(/Drums/)
    expect(t.song.chip).toBe('nes')
    expect(t.session.history.undoDepth).toBe(depth + 1)
    expect(t.song.loop).toEqual({ order: 0 })
    const notes = [...t.song.patterns.values()].flatMap((p) => p.rows.filter((c) => c && typeof c.note === 'number'))
    expect(notes.length).toBeGreaterThan(10)
    // the import is a faithful copy of the exported music
    const roundTrip = await t.ok('read_pattern', { channels: ['P1'], format: 'melody' })
    expect(resultText(roundTrip)).toContain('E5')
    t.session.undo()
    expect(t.song.chip).toBe('gb')
    expect(t.song.name).toBe('blank')
    t.session.redo()
    expect(t.song.chip).toBe('nes')
  })

  it('defaults the chip to the open song, reads absolute paths and explains problems', async () => {
    const t = songSetup({ chip: 'gb' })
    await writeSong(t).catch(() => undefined)
    const t2 = songSetup()
    await writeSong(t2)
    await t2.ok('export_midi', { name: 'a' })
    const bytes = t2.services.files.get('/mem/exports/a.mid')!
    await t.services.writeFile('C:\\music\\a.mid', bytes)
    const r = await t.ok('import_midi', { path: 'C:\\music\\a.mid' })
    expect(resultText(r)).toContain('as a GB song')
    expect(t.song.chip).toBe('gb')
    const missing = await t.call('import_midi', { path: 'nope' })
    expect(missing.isError).toBe(true)
    expect(resultText(missing)).toMatch(/Cannot read "nope"/)
    await t.services.writeFile('/mem/exports/junk.mid', new Uint8Array([1, 2, 3, 4]))
    const junk = await t.call('import_midi', { path: 'junk' })
    expect(junk.isError).toBe(true)
    expect(resultText(junk)).toMatch(/MThd/)
    expect(t.song.chip).toBe('gb') // failures change nothing
  })

  it('honours rowsPerBeat, patternLength and maxChannels', async () => {
    const t = songSetup()
    await writeSong(t)
    await t.ok('export_midi', { name: 'b' })
    await t.ok('import_midi', { path: 'b.mid', rowsPerBeat: 8, patternLength: 32, maxChannels: 1 })
    expect(t.song.timing.rowsPerBeat).toBe(8)
    expect(t.song.patternLength).toBe(32)
    const used = t.song.channels.filter((c) => [...t.song.patterns.keys()].some((k) => k.startsWith(`${c.id}:`)))
    expect(used.length).toBeLessThanOrEqual(2) // one melodic channel plus the drums
  })
})

describe('convert_chip', () => {
  it('converts in one undo step and undo restores the original song', async () => {
    const t = songSetup()
    await writeSong(t)
    const before = serializeProject(t.song)
    const depth = t.session.history.undoDepth
    const r = await t.ok('convert_chip', { chip: 'genesis' })
    const text = resultText(r)
    expect(text).toMatch(/Converting "test" from NES/)
    expect(text).toMatch(/-> F1 FM 1 \[bass\]/)
    expect(t.song.chip).toBe('genesis')
    expect(t.song.channels).toHaveLength(10)
    expect(t.session.history.undoDepth).toBe(depth + 1)
    expect(t.session.undoLabel()).toBe('convert_chip')
    t.session.undo()
    expect(serializeProject(t.song)).toBe(before)
    t.session.redo()
    expect(t.song.chip).toBe('genesis')
  })

  it('does nothing on the same chip, converts with config, and explains unknown chips', async () => {
    const t = songSetup()
    await writeSong(t)
    const depth = t.session.history.undoDepth
    const same = await t.ok('convert_chip', { chip: 'nes' })
    expect(resultText(same)).toMatch(/nothing to convert/)
    expect(t.session.history.undoDepth).toBe(depth)
    await t.ok('convert_chip', { chip: 'NES', chipConfig: { dpcm: true } })
    expect(t.song.channels.map((c) => c.id)).toContain('DM')
    const bad = await t.call('convert_chip', { chip: 'amiga' })
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toMatch(/Unknown chip "amiga"/)
  })

  it('keeps the song playable: converted songs render sound', async () => {
    const t = songSetup()
    await writeSong(t)
    for (const chip of ['gb', 'pce', 'snes', 'genesis', 'ps1', 'dreamcast']) {
      await t.ok('convert_chip', { chip })
      const analysis = resultText(await t.ok('analyze_song'))
      expect(analysis).not.toMatch(/ERROR/)
    }
  })
})
