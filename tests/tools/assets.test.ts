import { describe, expect, it } from 'vitest'
import { createSong, formatTrackerText, parseProject, patternKey } from '../../src/core'
import { keyShift, mapDiatonic } from '../../src/tools/assetOps'
import { resultText, snapshot, songSetup } from './helpers'

/** A little NES song in A minor with drums, bass and a lead, to save assets from. */
async function composed(chip: 'nes' | 'gb' = 'nes', key = 'A', scale = 'minor') {
  const t = songSetup()
  await t.ok('new_song', { chip, name: 'Source', bpm: 132, key, scale, patternLength: 32 })
  await t.ok('set_song_info', { moods: ['heroic'], tags: ['test'] })
  await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
  await t.ok('add_instrument', { preset: 'bass', channel: chip === 'nes' ? 'TR' : 'WV' })
  await t.ok('write_drums', { channel: 'NO', legend: { K: 'kick', S: 'snare', h: 'hihat' }, steps: 'K.h.S.h.K.hhS.h.', repeat: 2 })
  await t.ok('write_melody', { channel: 'P1', melody: '@lead A4:2 C5:2 E5:4 D5:2 C5:2 B4:4 A4:8' })
  await t.ok('write_melody', { channel: chip === 'nes' ? 'TR' : 'WV', melody: '@bass A2:4 A2:4 F2:4 G2:4' })
  return t
}

describe('keyShift and mapDiatonic', () => {
  it('takes the shortest way between tonics', () => {
    expect(keyShift('C', 'D')).toBe(2)
    expect(keyShift('C', 'A')).toBe(-3)
    expect(keyShift('A', 'C')).toBe(3)
    expect(keyShift('C', 'F#')).toBe(-6)
    expect(keyShift('C', 'C')).toBe(0)
  })

  it('maps scale degrees between scales, keeping the register', () => {
    // A minor degree 3 (C5 = 72) is the major third in A major? no: degree index 2 of C major is E
    expect(mapDiatonic(72, { key: 'A', scale: 'minor' }, { key: 'C', scale: 'major' })).toBe(76)
    // same scale = chromatic shift
    expect(mapDiatonic(69, { key: 'A', scale: 'minor' }, { key: 'D', scale: 'minor' })).toBe(74)
    // tonic maps to tonic
    expect(mapDiatonic(57, { key: 'A', scale: 'minor' }, { key: 'C', scale: 'major' })).toBe(60)
  })
})

describe('library tools', () => {
  it('list_assets is empty at first, and the guide-facing tools are registered (no delete_asset)', async () => {
    const t = songSetup()
    expect(await t.text('list_assets')).toMatch(/^0 assets/)
    const names = t.registry.list().map((x) => x.name)
    for (const n of ['list_assets', 'get_asset', 'save_as_asset', 'place_asset', 'set_style_reference', 'get_style_context']) expect(names).toContain(n)
    expect(names).not.toContain('delete_asset')
  })

  it('save_as_asset does not change the song and makes no undo step', async () => {
    const t = await composed()
    const before = snapshot(t.song)
    const depth = t.session.history.undoDepth
    const text = await t.text('save_as_asset', { name: 'Hero theme', kind: 'song', tags: ['Boss'], notes: 'Driving bass.' })
    expect(text).toMatch(/Saved song asset "Hero theme" \(id hero-theme, NES, key A minor/)
    expect(snapshot(t.song)).toBe(before)
    expect(t.session.history.undoDepth).toBe(depth)
    const stored = t.services.assets!
    const meta = (await stored.list())[0]!
    expect(meta).toMatchObject({ kind: 'song', chip: 'nes', key: 'A', scale: 'minor', bpm: 132, rowsPerBeat: 4, moods: ['heroic'], tags: ['boss'], notes: 'Driving bass.' })
    expect(meta.channels).toEqual(['P1', 'TR', 'NO'])
    expect(meta.roles).toEqual(expect.arrayContaining(['lead', 'bass', 'kick', 'snare', 'hihat']))
    expect(meta.rows).toBe(32)
    expect((await stored.thumbnail('hero-theme'))!.length).toBeGreaterThan(100)
    const asset = parseProject((await stored.get('hero-theme'))!.project)
    expect(asset.references).toEqual([])
    expect(asset.name).toBe('Hero theme')
  })

  it('list_assets filters by kind, chip, tags, mood and text', async () => {
    const t = await composed()
    await t.ok('save_as_asset', { name: 'Hero theme', kind: 'song', tags: ['boss'], moods: ['heroic'] })
    await t.ok('save_as_asset', { name: 'Lead lick', kind: 'motif', channels: ['P1'], tags: ['lick'], moods: ['spooky'], notes: 'Chromatic crawl' })
    await t.ok('save_as_asset', { name: 'Fat lead', kind: 'instrument', instrument: 'lead' })
    const count = async (args: object): Promise<number> => Number(/^(\d+) asset/.exec(await t.text('list_assets', args))![1])
    expect(await count({})).toBe(3)
    expect(await count({ kind: 'motif' })).toBe(1)
    expect(await count({ chip: 'nes' })).toBe(3)
    expect(await count({ chip: 'gb' })).toBe(0)
    expect(await count({ tags: ['boss'] })).toBe(1)
    expect(await count({ mood: 'spooky' })).toBe(1)
    expect(await count({ text: 'chromatic crawl' })).toBe(1)
    expect(await count({ text: 'lead' })).toBe(2)
  })

  it('get_asset shows metadata, instruments, up to 32 tracker rows and a preview image', async () => {
    const t = await composed()
    await t.ok('save_as_asset', { name: 'Hero theme', kind: 'song', notes: 'Think Zelda.' })
    const r = await t.ok('get_asset', { id: 'hero-theme' })
    const text = resultText(r)
    expect(text).toMatch(/Asset "Hero theme" \(id hero-theme, song, NES\)/)
    expect(text).toMatch(/Notes: Think Zelda\./)
    expect(text).toMatch(/Instruments:\n\s+@0 /)
    expect(text).toMatch(/channels: P1 \| TR \| NO/)
    const rows = text.split('\n').filter((l) => /^\s*\d+ \| /.test(l))
    expect(rows.length).toBeLessThanOrEqual(32)
    expect(rows.length).toBe(32)
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
    expect(await t.text('get_asset', { id: 'Hero theme' })).toMatch(/hero-theme/)
    expect(await t.text('get_asset', { id: 'nope' })).toMatch(/not found.*Available assets/)
  })

  it('save_as_asset motif validates the range and keeps the notes of the chosen channels', async () => {
    const t = await composed()
    expect(await t.text('save_as_asset', { name: 'x', kind: 'motif', fromOrder: 4 })).toMatch(/Order range 4..4 is invalid/)
    expect(await t.text('save_as_asset', { name: 'x', kind: 'motif', channels: ['P1'], fromRow: 30, toRow: 31 })).toMatch(/Nothing to save/)
    await t.ok('save_as_asset', { name: 'Bass line', kind: 'motif', channels: ['TR'], toRow: 16 })
    const m = parseProject((await t.services.assets!.get('bass-line'))!.project)
    expect(m.patternLength).toBe(16)
    expect(m.meta.key).toBe('A')
    expect(m.patterns.has(patternKey('TR', 0))).toBe(true)
    expect(m.patterns.has(patternKey('P1', 0))).toBe(false)
    expect(m.instruments.map((i) => i.name)).toHaveLength(1)
    expect(t.services.assets!.items.get('bass-line')!.channels).toEqual(['TR'])
  })

  it('save_as_asset overwrites with id and numbers duplicate names', async () => {
    const t = await composed()
    await t.ok('save_as_asset', { name: 'Same', kind: 'song' })
    await t.ok('save_as_asset', { name: 'Same', kind: 'song' })
    expect([...t.services.assets!.items.keys()].sort()).toEqual(['same', 'same-2'])
    await t.ok('save_as_asset', { name: 'Same v2', kind: 'song', id: 'same' })
    expect(t.services.assets!.items.get('same')!.name).toBe('Same v2')
    expect(t.services.assets!.items.size).toBe(2)
  })
})

describe('place_asset', () => {
  async function targetSong(chip: 'nes' | 'gb' | 'genesis' = 'nes', key = 'C', scale = 'major') {
    const t = songSetup()
    await t.ok('new_song', { chip, name: 'Target', key, scale, patternLength: 32 })
    return t
  }

  it('moves a motif into another key chromatically in one undo step, adding its instruments', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Lick', kind: 'motif', channels: ['P1'], toRow: 16 })
    const t = await targetSong('nes', 'C', 'major')
    t.services.assets!.items.set('lick', src.services.assets!.items.get('lick')!)
    const depth = t.session.history.undoDepth
    const text = await t.text('place_asset', { id: 'lick', order: 0, row: 4 })
    expect(text).toMatch(/Placed motif "Lick" \(16 rows\) at order 0, row 4: P1->P1/)
    expect(text).toMatch(/\+3 semitones \(A -> C\)/)
    expect(t.session.history.undoDepth).toBe(depth + 1)
    expect(t.song.instruments).toHaveLength(1)
    const lines = formatTrackerText(t.song, { channels: ['P1'], sparse: true, header: false })
    // A4 -> C5 at row 4, C5 -> D#5 (+3)
    expect(lines).toMatch(/\n? ?4 \| C-5 @/)
    expect(lines).toMatch(/\| D#5/)
    t.session.undo()
    expect(t.song.instruments).toHaveLength(0)
    expect(t.song.patterns.size).toBe(0)
    t.session.redo()
    expect(t.song.instruments).toHaveLength(1)
  })

  it('diatonic placement maps scale degrees into the song scale', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Lick', kind: 'motif', channels: ['P1'], toRow: 16 })
    const t = await targetSong('nes', 'C', 'major')
    t.services.assets!.items.set('lick', src.services.assets!.items.get('lick')!)
    await t.ok('place_asset', { id: 'lick', row: 0, diatonic: true })
    // A4 C5 E5 D5 C5 B4 -> C5 E5 G5 F5 E5 D5 (A minor degrees onto C major)
    const p = t.song.patterns.get(patternKey('P1', 0))!
    const notes = p.rows.filter((c) => c && typeof c.note === 'number').map((c) => c!.note)
    expect(notes.slice(0, 6)).toEqual([72, 76, 79, 77, 76, 74])
  })

  it('extra semitones, merge mode and shared pattern notes', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Lick', kind: 'motif', channels: ['P1'], toRow: 16 })
    const t = await targetSong('nes', 'A', 'minor')
    t.services.assets!.items.set('lick', src.services.assets!.items.get('lick')!)
    await t.ok('write_pattern', { text: 'channels: P1\n 20 | C-5' })
    await t.ok('place_asset', { id: 'lick', row: 0, semitones: 12, mode: 'merge' })
    const p = t.song.patterns.get(patternKey('P1', 0))!
    expect(p.rows[0]!.note).toBe(81)
    expect(p.rows[20]!.note).toBe(72)
  })

  it('reports problems with row/order/channel mapping', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Full', kind: 'motif', channels: ['P1'] })
    const t = await targetSong()
    t.services.assets!.items.set('full', src.services.assets!.items.get('full')!)
    expect(await t.text('place_asset', { id: 'full', row: 5 })).toMatch(/needs rows 5..36, but the song's patterns have 32 rows/)
    expect(await t.text('place_asset', { id: 'full', order: 3 })).toMatch(/Order 3 not found/)
    expect(await t.text('place_asset', { id: 'full', channels: ['P1', 'P2'] })).toMatch(/pass exactly that many target channels/)
    expect(await t.text('place_asset', { id: 'full', channels: ['XX'] })).toMatch(/Channel "XX" not found/)
  })

  it('maps channels and instruments by role when the chip differs (NES drums+bass -> Game Boy)', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Groove', kind: 'motif', channels: ['TR', 'NO'] })
    const t = await targetSong('gb', 'A', 'minor')
    t.services.assets!.items.set('groove', src.services.assets!.items.get('groove')!)
    const text = await t.text('place_asset', { id: 'groove' })
    expect(text).toMatch(/Placed motif "Groove"/)
    expect(text).toMatch(/TR->WV, NO->NO/)
    expect(text).toMatch(/Instrument mapping: "[^"]+" \(NES [a-z-]+, role bass\) became the GB preset/)
    expect(t.song.instruments.every((i) => i.kind.startsWith('gb-'))).toBe(true)
    expect(t.song.patterns.has(patternKey('WV', 0))).toBe(true)
    expect(t.song.patterns.has(patternKey('NO', 0))).toBe(true)
    expect((await t.ok('analyze_song')).isError).toBeFalsy()
  })

  it('an instrument asset is added when the chip matches and resolved by role otherwise', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Fat lead', kind: 'instrument', instrument: 'lead' })
    const same = await targetSong('nes')
    same.services.assets!.items.set('fat-lead', src.services.assets!.items.get('fat-lead')!)
    expect(await same.text('place_asset', { id: 'fat-lead' })).toMatch(/Added instrument @0/)
    expect(await same.text('place_asset', { id: 'fat-lead' })).toMatch(/already has this instrument as @0/)
    expect(same.song.instruments).toHaveLength(1)

    const other = await targetSong('gb')
    other.services.assets!.items.set('fat-lead', src.services.assets!.items.get('fat-lead')!)
    const text = await other.text('place_asset', { id: 'fat-lead' })
    expect(text).toMatch(/NES instrument and the song is GB/)
    expect(text).toMatch(/role lead\) became the GB preset/)
    expect(other.song.instruments[0]!.kind).toBe('gb-pulse')
    other.session.undo()
    expect(other.song.instruments).toHaveLength(0)
  })

  it('an SNES sample instrument brings its sample slot', async () => {
    const t = songSetup()
    await t.ok('new_song', { chip: 'snes', name: 'S' })
    await t.ok('add_instrument', { preset: 'strings', channel: 'V3' })
    expect(t.song.samples.length).toBeGreaterThan(0)
    await t.ok('save_as_asset', { name: 'Strings', kind: 'instrument', instrument: 0 })
    const stored = parseProject((await t.services.assets!.get('strings'))!.project)
    expect(stored.samples).toHaveLength(1)
    await t.ok('new_song', { chip: 'snes', name: 'T' })
    expect(t.song.samples).toHaveLength(0)
    await t.ok('place_asset', { id: 'strings' })
    expect(t.song.samples).toHaveLength(1)
    expect(t.song.instruments).toHaveLength(1)
    t.session.undo()
    expect(t.song.samples).toHaveLength(0)
  })

  it('refuses a song asset and suggests alternatives', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'Whole', kind: 'song' })
    const t = await targetSong()
    t.services.assets!.items.set('whole', src.services.assets!.items.get('whole')!)
    const text = await t.text('place_asset', { id: 'whole' })
    expect(text).toMatch(/whole song asset/)
    expect(text).toMatch(/open_project/)
    expect(text).toMatch(/set_style_reference/)
    expect(t.session.history.undoDepth).toBe(1) // only new_song
  })
})

describe('style references', () => {
  it('set_style_reference add/remove/set/clear, one undo step each', async () => {
    const src = await composed()
    await src.ok('save_as_asset', { name: 'A', kind: 'song' })
    await src.ok('save_as_asset', { name: 'B', kind: 'song' })
    const t = songSetup()
    t.services.assets!.items.set('a', src.services.assets!.items.get('a')!)
    t.services.assets!.items.set('b', src.services.assets!.items.get('b')!)
    const depth = t.session.history.undoDepth
    expect(await t.text('set_style_reference', { ids: ['a', 'B'], note: 'groove' })).toMatch(/now: a, b/)
    expect(t.song.references).toEqual([{ assetId: 'a', note: 'groove' }, { assetId: 'b', note: 'groove' }])
    expect(t.session.history.undoDepth).toBe(depth + 1)
    await t.ok('set_style_reference', { ids: ['a'], action: 'remove' })
    expect(t.song.references.map((r) => r.assetId)).toEqual(['b'])
    await t.ok('set_style_reference', { ids: ['a'], action: 'set' })
    expect(t.song.references.map((r) => r.assetId)).toEqual(['a'])
    await t.ok('set_style_reference', { action: 'clear' })
    expect(t.song.references).toEqual([])
    t.session.undo()
    expect(t.song.references.map((r) => r.assetId)).toEqual(['a'])
    expect(await t.text('set_style_reference', {})).toMatch(/needs `ids`/)
    expect(await t.text('set_style_reference', { ids: ['zzz'] })).toMatch(/not found/)
    // get_song points to the context
    expect(await t.text('get_song')).toMatch(/References: a/)
  })

  it('get_style_context starts with "No style references" when none are set', async () => {
    const t = songSetup()
    const text = await t.text('get_style_context')
    expect(text.startsWith('No style references')).toBe(true)
  })

  it('get_style_context describes chip, timing, key, moods, instruments, drums, chords, tracker rows, notes and images', async () => {
    const src = await composed()
    await src.ok('write_pattern', { text: 'channels: P1\n 16 | A-4' })
    await src.ok('save_as_asset', { name: 'Hero theme', kind: 'song', notes: 'Galloping bass, minor, brass-like lead.' })
    const t = songSetup()
    t.services.assets!.items.set('hero-theme', src.services.assets!.items.get('hero-theme')!)
    await t.ok('set_style_reference', { ids: ['hero-theme'], note: 'copy the drum groove' })
    const r = await t.ok('get_style_context')
    const text = resultText(r)
    expect(text).toMatch(/^Style context from 1 reference asset/)
    expect(text).toMatch(/Reference 1: "Hero theme" \(id hero-theme, song\)/)
    expect(text).toMatch(/Chip: NES \| 132 BPM, speed 6, 4 rows\/beat, 4 beats\/bar \(16 rows per bar\) \| key A minor/)
    expect(text).toMatch(/Moods: heroic/)
    expect(text).toMatch(/Instruments:\n\s+@0 .*\(nes-pulse, lead, preset nes\.lead\./)
    expect(text).toMatch(/Drums \(steps, one character per row\):\n\s+NO \(order 0\): "[A-Za-z.]{32}" legend/)
    expect(text).toMatch(/Chord progression: \S+/)
    expect(text).toMatch(/Tracker sample \(order 0, P1 \| TR \| NO\):/)
    const trackerRows = text.split('\n').filter((l) => /^\s+\d+ \| /.test(l))
    expect(trackerRows.length).toBeGreaterThanOrEqual(16)
    expect(trackerRows.length).toBeLessThanOrEqual(32)
    expect(text).toMatch(/User notes: Galloping bass/)
    expect(text).toMatch(/Reference note: copy the drum groove/)
    expect(r.content.filter((c) => c.type === 'image')).toHaveLength(1)
    // explicit ids work without references
    await t.ok('set_style_reference', { action: 'clear' })
    expect(resultText(await t.ok('get_style_context', { ids: ['hero-theme'] }))).toMatch(/Reference 1/)
    expect(await t.text('get_style_context', { ids: ['nope'] })).toMatch(/None of the style references could be found/)
  })

  it('works for songs of other chips (a Genesis reference shows FM instruments)', async () => {
    const g = songSetup()
    await g.ok('new_song', { chip: 'genesis', name: 'Blast' })
    await g.ok('add_instrument', { preset: 'bass', channel: 'F1' })
    await g.ok('write_melody', { channel: 'F1', melody: '@bass E2:4 E2:4' })
    await g.ok('save_as_asset', { name: 'Blast', kind: 'song' })
    const t = songSetup({ song: createSong({ chip: 'nes', name: 'n' }) })
    t.services.assets!.items.set('blast', g.services.assets!.items.get('blast')!)
    const text = await t.text('get_style_context', { ids: ['blast'] })
    expect(text).toMatch(/Chip: GENESIS/)
    expect(text).toMatch(/\(fm, bass/)
  })
})
