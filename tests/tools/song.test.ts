import { describe, expect, it } from 'vitest'
import { CHIP_IDS, getPattern, parseProject, serializeProject } from '../../src/core'
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
describe('song tools on PS1 and Dreamcast', () => {
  it('new_song takes voices, the reverb preset and the DSP preset, and says how many voices it made', async () => {
    const t = songSetup()
    const ps1 = await t.text('new_song', { chip: 'ps1', mood: 'synthwave', chipConfig: { voices: 24, reverb: { preset: 'hall' } } })
    expect(ps1).toContain('Created a new PS1 song')
    expect(ps1).toContain('Channels: V1..V24 (24 sample voices).')
    expect(t.session.song.channels).toHaveLength(24)
    expect(t.session.song.chipConfig).toMatchObject({ chip: 'ps1', voices: 24, reverb: { preset: 'hall', depth: 0.5, inputVol: 1 } })
    expect(t.session.song.meta.moods).toEqual(['synthwave'])
    const dc = await t.text('new_song', { chip: 'dc', chipConfig: { voices: 32, dsp: { preset: 'chorus-delay', delayMs: 375 } } })
    expect(dc).toContain('Created a new DREAMCAST song')
    expect(dc).toContain('Channels: V1..V32 (32 sample voices).')
    expect(t.session.song.chipConfig).toMatchObject({ chip: 'dreamcast', voices: 32, dsp: { preset: 'chorus-delay', delayMs: 375, mix: 0.35 } })
    // 16 voices (the default) are listed one by one, like the SNES voices
    expect(await t.text('new_song', { chip: 'psx' })).toContain('Channels: V1 (Voice 1), V2 (Voice 2)')
    expect(t.session.song.channels).toHaveLength(16)
    // one undo step brings the previous song back
    expect(t.session.history.undoDepth).toBe(3)
  })

  it('set_song_info merges the reverb and DSP fields, keeps the rest, and refuses voices', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'ps1', chipConfig: { voices: 24, reverb: { preset: 'studio-small', depth: 0.8 } } })
    await t.ok('set_song_info', { chipConfig: { reverb: { preset: 'space-echo' } } })
    expect(t.session.song.chipConfig).toMatchObject({ voices: 24, reverb: { preset: 'space-echo', depth: 0.8, inputVol: 1 } })
    await t.ok('set_song_info', { chipConfig: { reverb: { depth: 0.2 } } })
    expect(t.session.song.chipConfig).toMatchObject({ reverb: { preset: 'space-echo', depth: 0.2 } })
    expect(resultText(await t.call('set_song_info', { chipConfig: { voices: 16 } }))).toMatch(/voices.*new_song/)
    expect(resultText(await t.call('set_song_info', { chipConfig: { reverb: { preset: 'cathedral' } } }))).toMatch(/reverb\.preset.*not a PS1 reverb preset/)
    expect(t.session.song.chipConfig).toMatchObject({ voices: 24, reverb: { preset: 'space-echo', depth: 0.2 } })

    await t.ok('new_song', { chip: 'dreamcast', chipConfig: { voices: 64 } })
    await t.ok('set_song_info', { chipConfig: { dsp: { preset: 'echo' } } })
    await t.ok('set_song_info', { chipConfig: { dsp: { feedback: 0.6, delayMs: 450 } } })
    expect(t.session.song.chipConfig).toMatchObject({ voices: 64, dsp: { preset: 'echo', feedback: 0.6, delayMs: 450, mix: 0.35 } })
    expect(resultText(await t.call('set_song_info', { chipConfig: { dsp: { feedback: 2 } } }))).toMatch(/dsp\.feedback/)
    t.session.undo()
    expect(t.session.song.chipConfig).toMatchObject({ dsp: { preset: 'echo', delayMs: 300 } })
  })

  it('list_chips shows a run of identical voices as one line and keeps the other chips channel by channel', async () => {
    const t = songSetup()
    const ps1 = await t.text('list_chips', { chip: 'ps1' })
    expect(ps1).toContain('V1..V16 Voice 1..16 [sample] C-0..B-8; instruments: psx-sample; fx: 012347APQRSGXEBCDF')
    expect(ps1).not.toContain('V2 Voice 2')
    const dc = await t.text('list_chips', { chip: 'dreamcast' })
    expect(dc).toContain('instruments: aica-sample')
    expect(dc.split('\n').length).toBeLessThan(14)
    const snes = await t.text('list_chips', { chip: 'snes' })
    expect(snes).toContain('V1 Voice 1 [sample]')
    expect(snes).toContain('V8 Voice 8 [sample]')
    const all = await t.text('list_chips')
    for (const id of CHIP_IDS) expect(all, id).toContain(`${id} - `)
  })

  it('a 64-voice song stays readable: get_song and read_pattern without channels list the voices with notes', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'dreamcast', chipConfig: { voices: 64 } })
    await t.ok('add_instrument', { preset: 'pad', channel: 'V4' })
    await t.ok('set_orders', { orders: [0, 1, 2, 1, 0, 1, 2, 1], loop: 1 })
    for (const v of ['V4', 'V5', 'V20', 'V64']) {
      for (let o = 0; o < 3; o++) {
        const p = getPattern(t.session.song, v, o)
        for (let r = 0; r < 64; r += 4) p.rows[r] = { note: 48 + (r % 12), inst: 0, vol: 12 }
      }
    }
    const song = await t.text('get_song')
    expect(song).toContain('0: V1-V64:0')
    expect(song).toContain('1: V1-V64:1')
    expect(song).toMatch(/Channels \(notes written\):\n {2}V4: 48 \| V5: 48 \| V20: 48 \| V64: 48 \| 60 other channels empty \(64 in all: V1\.\.V64 \(64 channels\)\)/)
    expect(song.length).toBeLessThan(2000)

    const read = await t.text('read_pattern', { order: 1 })
    expect(read).toContain('Only the channels that have notes are shown (4 of 64)')
    expect(read).toContain('channels: V4 | V5 | V20 | V64')
    expect(read.length).toBeLessThan(6000)
    // channels given explicitly are read as asked, empty ones included
    const some = await t.text('read_pattern', { order: 1, channels: ['V1', 'V4'], toRow: 8 })
    expect(some).not.toContain('Only the channels')
    expect(some).toContain('channels: V1 | V4')
    // the text round-trips through write_pattern
    const body = read.slice(read.indexOf('channels: V4'))
    await t.ok('write_pattern', { text: body, order: 2, mode: 'replace' })
    expect(await t.text('read_pattern', { order: 2 })).toContain(body)
    // an empty pattern falls back to the first 16 channels
    await t.ok('insert_order', {})
    const empty = await t.text('read_pattern', { order: t.session.song.orders.length - 1 })
    expect(empty).toContain('the first 16 channels (all are empty)')
    expect(empty).toContain('channels: V1 | V2')
  })

  it('a worst case 64-voice pattern (a note on every row of every voice) stays under 70k characters', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'dreamcast', chipConfig: { voices: 64 } })
    await t.ok('add_instrument', { preset: 'pad', channel: 'V4' })
    for (const ch of t.session.song.channels) {
      const p = getPattern(t.session.song, ch.id, 0)
      for (let r = 0; r < 64; r++) p.rows[r] = { note: 36 + ((r + ch.id.length) % 24), inst: 0, vol: 12 }
    }
    const read = await t.text('read_pattern', { order: 0 })
    expect(read).not.toContain('Only the channels')
    expect(read.length).toBeLessThan(70000)
  })

  it('16-voice songs and the older chips read every channel as before', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'ps1' })
    expect(await t.text('read_pattern', { order: 0 })).toContain('channels: V1 | V2 | V3')
    expect(await t.text('get_song')).toContain('0: V1:0 V2:0 V3:0')
    await t.ok('new_song', { chip: 'snes' })
    expect(await t.text('get_song')).toContain('V8 Voice 8: 0')
  })
})
