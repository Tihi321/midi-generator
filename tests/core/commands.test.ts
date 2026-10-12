import { describe, expect, it } from 'vitest'
import {
  History, createCellsCommand, createChannelCommand, createCompositeCommand, createInstrumentCommand, createPatternLengthCommand,
  createReplaceSongCommand, createSampleCommand, createSetOrdersCommand, createSongInfoCommand, countChangedCells
} from '../../src/core/commands'
import { type Song, cloneSong, createSong, getPattern } from '../../src/core/model'
import { resolvePreset } from '../../src/core/instruments'
import { songWithPresets } from './helpers'

function snapshot(s: Song): unknown {
  return JSON.parse(JSON.stringify({ ...s, patterns: [...s.patterns.entries()] }))
}

function fresh(): { song: Song; h: History } {
  const { song } = songWithPresets('nes', [{ ref: 'lead' }, { ref: 'arp' }, { ref: 'bass', kind: 'triangle' }, { ref: 'kick', kind: 'noise' }])
  return { song, h: new History(song) }
}

describe('cells command', () => {
  it('applies, inverts and redoes; undo removes created patterns', () => {
    const { song, h } = fresh()
    const before = snapshot(song)
    h.execute(createCellsCommand(song, [
      { channel: 'P1', pattern: 0, row: 0, cell: { note: 60, inst: 0, vol: 12 } },
      { channel: 'TR', pattern: 0, row: 4, cell: { note: 36, inst: 2, fx: [{ code: '4', param: 0x42 }] } }
    ]))
    expect(song.patterns.get('P1:0')!.rows[0]).toEqual({ note: 60, inst: 0, vol: 12 })
    expect(song.patterns.get('TR:0')!.rows[4]!.fx).toEqual([{ code: '4', param: 0x42 }])
    expect(h.undo()).toBe(true)
    expect(snapshot(song)).toEqual(before)
    expect(song.patterns.size).toBe(0)
    expect(h.redo()).toBe(true)
    expect(song.patterns.get('P1:0')!.rows[0]!.note).toBe(60)
  })
  it('clears cells and restores them on undo', () => {
    const { song, h } = fresh()
    h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 2, cell: { note: 64 } }]))
    h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 2, cell: null }]))
    expect(song.patterns.get('P1:0')!.rows[2]).toBeNull()
    h.undo()
    expect(song.patterns.get('P1:0')!.rows[2]).toEqual({ note: 64 })
  })
  it('later diffs for the same row win and copies are independent', () => {
    const { song, h } = fresh()
    const cell = { note: 60 }
    h.execute(createCellsCommand(song, [
      { channel: 'P1', pattern: 0, row: 1, cell },
      { channel: 'P1', pattern: 0, row: 1, cell: { note: 62 } }
    ]))
    cell.note = 99
    expect(song.patterns.get('P1:0')!.rows[1]!.note).toBe(62)
  })
  it('writing nothing new creates nothing', () => {
    const { song } = fresh()
    const cmd = createCellsCommand(song, [{ channel: 'P1', pattern: 3, row: 0, cell: null }])
    cmd.apply(song)
    expect(song.patterns.size).toBe(0)
  })
  it('validates input with LLM-readable errors', () => {
    const { song } = fresh()
    expect(() => createCellsCommand(song, [{ channel: 'XX', pattern: 0, row: 0, cell: { note: 60 } }])).toThrow(/not found/)
    expect(() => createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 32, cell: { note: 60 } }])).toThrow(/0\.\.31/)
    expect(() => createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { note: 200 } }])).toThrow(/0\.\.127/)
    expect(() => createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { inst: 9 } }])).toThrow(/@9 does not exist/)
    expect(() => createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { vol: 16 } }])).toThrow(/0\.\.15/)
    expect(() => createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { fx: [{ code: 'Z' as never, param: 0 }] } }])).toThrow(/unknown effect/)
    expect(() => createCellsCommand(song, [{ channel: 'P1', pattern: 300, row: 0, cell: { note: 60 } }])).toThrow(/pattern number/)
  })
  it('counts changed cells', () => {
    const { song, h } = fresh()
    h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { note: 60 } }]))
    expect(
      countChangedCells(song, [
        { channel: 'P1', pattern: 0, row: 0, cell: { note: 60 } },
        { channel: 'P1', pattern: 0, row: 1, cell: { note: 61 } }
      ])
    ).toBe(1)
  })
})

describe('history', () => {
  it('groups a transaction into one undo step and aborts cleanly', () => {
    const { song, h } = fresh()
    const before = snapshot(song)
    h.transaction('Agent turn', () => {
      h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { note: 60 } }]))
      h.execute(createCellsCommand(song, [{ channel: 'P2', pattern: 0, row: 0, cell: { note: 64 } }]))
    })
    expect(h.undoDepth).toBe(1)
    expect(h.undoLabel()).toBe('Agent turn')
    h.undo()
    expect(snapshot(song)).toEqual(before)
    h.redo()
    expect(song.patterns.size).toBe(2)
    h.undo()

    expect(() =>
      h.transaction('boom', () => {
        h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { note: 60 } }]))
        throw new Error('fail')
      })
    ).toThrow('fail')
    expect(snapshot(song)).toEqual(before)
    expect(h.canUndo()).toBe(false)
  })
  it('nested transactions commit once; redo is cleared by new commands; events fire', () => {
    const { song, h } = fresh()
    const events: string[] = []
    h.subscribe((e) => events.push(e.type))
    h.beginTransaction('outer')
    h.beginTransaction('inner')
    h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { note: 60 } }]))
    h.commitTransaction()
    expect(h.undoDepth).toBe(0)
    h.commitTransaction()
    expect(h.undoDepth).toBe(1)
    h.undo()
    expect(h.canRedo()).toBe(true)
    h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 1, cell: { note: 61 } }]))
    expect(h.canRedo()).toBe(false)
    expect(events).toContain('transaction-commit')
    expect(() => h.commitTransaction()).toThrow(/without/)
  })
  it('maxDepth drops the oldest step', () => {
    const { song } = fresh()
    const h = new History(song, { maxDepth: 2 })
    for (let i = 0; i < 4; i++) h.execute(createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: i, cell: { note: 60 + i } }]))
    expect(h.undoDepth).toBe(2)
  })
  it('composite commands invert in reverse order', () => {
    const { song } = fresh()
    const a = createCellsCommand(song, [{ channel: 'P1', pattern: 0, row: 0, cell: { note: 60 } }])
    const c = createCompositeCommand('both', [a])
    const before = snapshot(song)
    c.apply(song)
    c.invert(song)
    expect(snapshot(song)).toEqual(before)
  })
})

describe('instrument command', () => {
  it('adds, updates and undoes', () => {
    const { song, h } = fresh()
    const n = song.instruments.length
    const add = createInstrumentCommand(song, { op: 'add', instrument: resolvePreset('nes', 'nes.lead.duty50') })
    h.execute(add)
    expect(add.createdIndex).toBe(n)
    expect(song.instruments).toHaveLength(n + 1)
    h.execute(createInstrumentCommand(song, { op: 'update', ref: 'lead-square', patch: { name: 'square2' } }))
    expect(song.instruments[n]!.name).toBe('square2')
    h.undo()
    expect(song.instruments[n]!.name).toBe('lead-square')
    h.undo()
    expect(song.instruments).toHaveLength(n)
  })
  it('refuses duplicate names, wrong kinds and bad data', () => {
    const { song } = fresh()
    expect(() => createInstrumentCommand(song, { op: 'add', instrument: resolvePreset('nes', 'lead') })).toThrow(/already used by @0/)
    expect(() => createInstrumentCommand(song, { op: 'add', instrument: { ...resolvePreset('gb', 'lead'), name: 'gbp' } })).toThrow(/cannot be used on nes/)
    expect(() => createInstrumentCommand(song, { op: 'add', instrument: { ...resolvePreset('nes', 'lead'), name: '808' } })).toThrow(/digits/)
    const bad = { ...resolvePreset('nes', 'lead'), name: 'bad', macros: { vol: { values: [99] } } }
    expect(() => createInstrumentCommand(song, { op: 'add', instrument: bad })).toThrow(/out of range/)
  })
  it('delete refuses while cells use the instrument, and force clears + renumbers', () => {
    const { song, h } = fresh()
    // inst 0=lead, 1=arp, 2=bass, 3=kick
    h.execute(createCellsCommand(song, [
      { channel: 'P1', pattern: 0, row: 0, cell: { note: 60, inst: 0 } },
      { channel: 'P2', pattern: 0, row: 0, cell: { note: 64, inst: 1, vol: 8 } },
      { channel: 'P2', pattern: 0, row: 2, cell: { inst: 1 } },
      { channel: 'TR', pattern: 0, row: 0, cell: { note: 36, inst: 2 } },
      { channel: 'NO', pattern: 0, row: 0, cell: { note: 60, inst: 3 } }
    ]))
    expect(() => createInstrumentCommand(song, { op: 'delete', ref: 'arp' })).toThrow(/used by 2 cell.*force: true/)
    const before = snapshot(song)
    h.execute(createInstrumentCommand(song, { op: 'delete', ref: 1, force: true }))
    expect(song.instruments.map((i) => i.name)).toEqual(['lead', 'bass', 'kick'])
    expect(song.patterns.get('P1:0')!.rows[0]!.inst).toBe(0)
    expect(song.patterns.get('P2:0')!.rows[0]).toEqual({ note: 64, vol: 8 })
    expect(song.patterns.get('P2:0')!.rows[2]).toBeNull()
    expect(song.patterns.get('TR:0')!.rows[0]!.inst).toBe(1)
    expect(song.patterns.get('NO:0')!.rows[0]!.inst).toBe(2)
    h.undo()
    expect(snapshot(song)).toEqual(before)
    h.redo()
    expect(song.instruments).toHaveLength(3)
  })
  it('deleting an unused instrument renumbers without force', () => {
    const { song, h } = fresh()
    h.execute(createCellsCommand(song, [{ channel: 'TR', pattern: 0, row: 0, cell: { note: 36, inst: 2 } }]))
    h.execute(createInstrumentCommand(song, { op: 'delete', ref: 0 }))
    expect(song.patterns.get('TR:0')!.rows[0]!.inst).toBe(1)
  })
})

describe('other commands', () => {
  it('sets orders and keeps the loop valid', () => {
    const { song, h } = fresh()
    h.execute(createSetOrdersCommand(song, [[0, 0, 0, 0], [1, 1, 1, 1], [2, 2, 2, 2]], { loop: { order: 1 } }))
    expect(song.orders).toHaveLength(3)
    expect(song.loop).toEqual({ order: 1 })
    h.execute(createSetOrdersCommand(song, [[0, 0, 0, 0]]))
    expect(song.loop).toEqual({ order: 0 })
    h.undo()
    h.undo()
    expect(song.orders).toHaveLength(1)
    expect(() => createSetOrdersCommand(song, [[0, 0]])).toThrow(/4 channels/)
    expect(() => createSetOrdersCommand(song, [])).toThrow(/non-empty/)
    expect(() => createSetOrdersCommand(song, [[0, 0, 0, 999]])).toThrow(/0\.\.255/)
    expect(() => createSetOrdersCommand(song, [[0, 0, 0, 0]], { loop: { order: 4 } })).toThrow(/Loop order/)
  })
  it('updates song info', () => {
    const { song, h } = fresh()
    h.execute(createSongInfoCommand(song, { name: 'Boss', bpm: 150, key: 'Eb', scale: 'harmonic-minor', moods: ['boss'], groove: [7, 5], loop: null }))
    expect(song.name).toBe('Boss')
    expect(song.timing.bpm).toBe(150)
    expect(song.timing.groove).toEqual([7, 5])
    expect(song.meta.key).toBe('D#')
    expect(song.loop).toBeNull()
    h.execute(createSongInfoCommand(song, { groove: null, chipConfig: { region: 'pal' } }))
    expect(song.timing.groove).toBeUndefined()
    expect((song.chipConfig as { region: string }).region).toBe('pal')
    h.undo()
    expect(song.timing.groove).toEqual([7, 5])
    h.undo()
    expect(song.name).toBe('Untitled')
    expect(() => createSongInfoCommand(song, { bpm: 1 })).toThrow(/bpm/)
    expect(() => createSongInfoCommand(song, { scale: 'nope' })).toThrow(/Valid scales/)
    expect(() => createSongInfoCommand(song, { chipConfig: { dpcm: true } })).toThrow(/channel layout/)
    expect(() => createSongInfoCommand(song, { chipConfig: { bogus: 1 } })).toThrow(/Unknown chipConfig/)
  })
  it('updates channels', () => {
    const { song, h } = fresh()
    h.execute(createChannelCommand(song, 'P1', { muted: true, trim: -3, fxColumns: 3 }))
    expect(song.channels[0]).toMatchObject({ muted: true, trim: -3, fxColumns: 3 })
    h.undo()
    expect(song.channels[0]!.muted).toBeUndefined()
    expect(() => createChannelCommand(song, 'P1', { pan: 0.5 })).toThrow(/no panning/)
    song.authenticity = 'relaxed'
    h.execute(createChannelCommand(song, 'P1', { pan: 0.5 }))
    expect(song.channels[0]!.pan).toBe(0.5)
    expect(() => createChannelCommand(song, 'P1', { pan: 2 })).toThrow(/-1/)
  })
  it('adds, updates and deletes samples', () => {
    const song = createSong({ chip: 'snes' })
    const h = new History(song)
    const add = createSampleCommand(song, { op: 'add', sample: { name: 'kick', source: { kind: 'recipe', recipe: 'kick', params: {} } } })
    h.execute(add)
    expect(song.samples).toHaveLength(1)
    h.execute(createSampleCommand(song, { op: 'update', id: add.sampleId, patch: { name: 'kick2' } }))
    expect(song.samples[0]!.name).toBe('kick2')
    h.execute(
      createInstrumentCommand(song, {
        op: 'add',
        instrument: { name: 'k', kind: 'snes-sample', sample: add.sampleId, baseNote: 60, env: { adsr: [15, 7, 7, 0] }, echo: false }
      })
    )
    expect(() => createSampleCommand(song, { op: 'delete', id: add.sampleId })).toThrow(/used by instrument/)
    h.undo()
    h.execute(createSampleCommand(song, { op: 'delete', id: add.sampleId }))
    expect(song.samples).toHaveLength(0)
    h.undo()
    expect(song.samples).toHaveLength(1)
    expect(() => createSampleCommand(song, { op: 'delete', id: 'zzz' })).toThrow(/not found/)
  })
  it('changes the pattern length (truncating and padding) reversibly', () => {
    const { song, h } = fresh()
    h.execute(createCellsCommand(song, [
      { channel: 'P1', pattern: 0, row: 3, cell: { note: 60 } },
      { channel: 'P1', pattern: 0, row: 20, cell: { note: 62 } }
    ]))
    const before = snapshot(song)
    h.execute(createPatternLengthCommand(song, 8))
    expect(song.patternLength).toBe(8)
    expect(song.patterns.get('P1:0')!.rows).toHaveLength(8)
    expect(song.patterns.get('P1:0')!.rows[3]!.note).toBe(60)
    h.undo()
    expect(snapshot(song)).toEqual(before)
    h.execute(createPatternLengthCommand(song, 64))
    expect(song.patterns.get('P1:0')!.rows).toHaveLength(64)
    expect(() => createPatternLengthCommand(song, 0)).toThrow(/pattern length/)
  })
  it('replaces the whole song reversibly', () => {
    const { song, h } = fresh()
    const other = createSong({ chip: 'gb', name: 'Other' })
    const before = snapshot(song)
    h.execute(createReplaceSongCommand(song, other))
    expect(song.chip).toBe('gb')
    expect(song.name).toBe('Other')
    getPattern(other, 'P1', 0).rows[0] = { note: 60 }
    expect(song.patterns.size).toBe(0)
    h.undo()
    expect(snapshot(song)).toEqual(before)
    expect(snapshot(cloneSong(song))).toEqual(before)
  })
})
