import { describe, expect, it } from 'vitest'
import { parseProject, serializeProject } from '../../src/core'
import { resultText, songSetup } from './helpers'

describe('song tools', () => {
  it('get_song describes an empty song and is read-only', async () => {
    const t = songSetup()
    const text = await t.text('get_song')
    expect(text).toContain('Song "test" (NES, strict)')
    expect(text).toContain('0: P1:0 P2:0 TR:0 NO:0')
    expect(text).toContain('Instruments: none yet')
    expect(t.session.history.undoDepth).toBe(0)
  })

  it('new_song replaces the song in ONE undoable step and takes defaults from a mood', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead' })
    const before = serializeProject(t.song)
    const text = await t.text('new_song', { chip: 'gb', mood: 'spooky', name: 'Crypt' })
    expect(text).toContain('Created a new GB song "Crypt": 75 BPM')
    expect(t.song.chip).toBe('gb')
    expect(t.song.channels.map((c) => c.id)).toEqual(['P1', 'P2', 'WV', 'NO'])
    expect(t.song.meta.moods).toEqual(['spooky'])
    expect(t.song.meta.scale).toBe('phrygian')
    expect(t.session.history.undoDepth).toBe(2)
    t.session.undo()
    expect(serializeProject(t.song)).toBe(before)
  })

  it('new_song accepts loose chip names and explains unknown ones', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'Game Boy' })
    expect(t.song.chip).toBe('gb')
    const bad = await t.call('new_song', { chip: 'amiga' })
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toMatch(/Unknown chip "amiga"\. Valid chips: nes, gb, genesis, snes, pce/)
    const badMood = await t.call('new_song', { chip: 'nes', mood: 'jazzy' })
    expect(resultText(badMood)).toMatch(/Unknown mood "jazzy"\. Valid moods: heroic/)
    expect(t.song.chip).toBe('gb') // failed calls change nothing
  })

  it('new_song on Genesis has a sound engine (no "not available" warning)', async () => {
    const t = songSetup()
    const text = await t.text('new_song', { chip: 'genesis' })
    expect(text).not.toMatch(/not available yet/)
    expect(t.song.channels[0]!.id).toBe('F1')
  })

  it('new_song passes chip config and validates timing', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'nes', chipConfig: { dpcm: true }, bpm: 90, groove: [7, 5] })
    expect(t.song.channels.map((c) => c.id)).toEqual(['P1', 'P2', 'TR', 'NO', 'DM'])
    expect(t.song.timing).toMatchObject({ bpm: 90, groove: [7, 5] })
    const bad = await t.call('new_song', { chip: 'nes', bpm: 1000 })
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toMatch(/bpm/)
  })

  it('set_song_info changes only the given fields, in one step', async () => {
    const t = songSetup()
    const text = await t.text('set_song_info', { bpm: 150, key: 'A', scale: 'minor', moods: ['battle'], groove: [7, 5] })
    expect(text).toMatch(/^Updated: [a-z, ]*bpm[a-z, ]*key/)
    expect(t.song.timing.bpm).toBe(150)
    expect(t.song.meta).toMatchObject({ key: 'A', scale: 'minor', moods: ['battle'] })
    expect(t.session.history.undoDepth).toBe(1)
    await t.ok('set_song_info', { groove: [] })
    expect(t.song.timing.groove).toBeUndefined()
    expect(await t.text('set_song_info', {})).toMatch(/Nothing to change/)
  })

  it('set_song_info reports invalid values readably', async () => {
    const t = songSetup()
    expect(resultText(await t.call('set_song_info', { scale: 'wibble' }))).toMatch(/Unknown scale "wibble"\. Valid scales: major/)
    expect(resultText(await t.call('set_song_info', { key: 'H' }))).toMatch(/Invalid key "H"/)
    expect(resultText(await t.call('set_song_info', { chipConfig: { dpcm: true } }))).toMatch(/new_song/)
    expect(resultText(await t.call('set_song_info', { bpm: 'fast' }))).toMatch(/Invalid arguments for set_song_info/)
  })

  it('set_loop sets and clears the loop point', async () => {
    const t = songSetup()
    await t.ok('set_orders', { orders: [0, 1, 2] })
    expect(await t.text('set_loop', { order: 1 })).toMatch(/jumps back to order 1/)
    expect(t.song.loop).toEqual({ order: 1 })
    expect(await t.text('set_loop', { order: null })).toMatch(/plays once/)
    expect(t.song.loop).toBeNull()
    expect(resultText(await t.call('set_loop', { order: 9 }))).toMatch(/Loop order 9 is outside 0\.\.2/)
  })

  it('list_chips lists channels and marks chips whose engine is coming', async () => {
    const t = songSetup()
    const all = await t.text('list_chips')
    for (const id of ['nes', 'gb', 'genesis', 'snes', 'pce']) expect(all).toContain(`${id} - `)
    expect(all).not.toMatch(/genesis - .*\[coming/)
    const nes = await t.text('list_chips', { chip: 'nes' })
    expect(nes).toContain('TR Triangle [triangle] A-0..C-7, no volume')
    expect(nes).not.toContain('gb - ')
  })

  it('save_project and open_project round-trip through the services; open is undoable', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead' })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead v12\n4 | E-5' })
    const saved = await t.text('save_project', { path: 'my song' })
    expect(saved).toContain('/mem/projects/my song.ctune')
    const file = new TextDecoder().decode(t.services.files.get('/mem/projects/my song.ctune')!)
    expect(file).toContain('"format": "chiptune-studio"')
    const original = serializeProject(parseProject(serializeProject(t.song)))

    await t.ok('new_song', { chip: 'gb' })
    expect(t.song.chip).toBe('gb')
    const opened = await t.text('open_project', { path: 'my song' })
    expect(opened).toContain('Opened /mem/projects/my song.ctune')
    expect(serializeProject(parseProject(serializeProject(t.song)))).toBe(original)
    expect(parseProject(file).instruments).toHaveLength(1)
    t.session.undo()
    expect(t.song.chip).toBe('gb')

    const missing = await t.call('open_project', { path: 'nope' })
    expect(missing.isError).toBe(true)
    expect(resultText(missing)).toMatch(/File not found/)
    t.services.files.set('/mem/projects/bad.ctune', new TextEncoder().encode('{"x":1}'))
    expect(resultText(await t.call('open_project', { path: 'bad' }))).toMatch(/Invalid Chiptune Studio project/)
  })

  it('update_channel changes mixer settings and validates them', async () => {
    const t = songSetup()
    await t.ok('update_channel', { channel: 'P2', muted: true, trim: -3 })
    expect(t.song.channels[1]).toMatchObject({ muted: true, trim: -3 })
    await t.ok('update_channel', { channel: 'NO', fxColumns: 3, name: 'Drums' })
    expect(t.song.channels[3]).toMatchObject({ name: 'Drums', fxColumns: 3 })
    expect(resultText(await t.call('update_channel', { channel: 'XX', muted: true }))).toMatch(/Channel "XX" not found\. Channels of nes \(index:id\): 0:P1/)
    expect(resultText(await t.call('update_channel', { channel: 'P1', pan: 0.5 }))).toMatch(/no panning on nes/)
    expect(resultText(await t.call('update_channel', { channel: 'P1', trim: 40 }))).toMatch(/Invalid arguments/)
    expect(await t.text('update_channel', { channel: 'P1' })).toMatch(/Nothing to change/)
  })
})
