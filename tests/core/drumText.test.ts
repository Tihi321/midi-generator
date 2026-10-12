import { describe, expect, it } from 'vitest'
import { DrumTextError, drumToDiffs, formatDrumText, parseDrumText } from '../../src/core/codecs/drumText'
import { createCellsCommand, createInstrumentCommand } from '../../src/core/commands'
import { type Song } from '../../src/core/types'
import { cellsEqual, createSong } from '../../src/core/model'
import { resolvePreset } from '../../src/core/instruments'
import { songWithPresets } from './helpers'

function drumSong(patternLength = 64): Song {
  return songWithPresets(
    'nes',
    [{ ref: 'lead' }, { ref: 'kick', kind: 'noise' }, { ref: 'snare', kind: 'noise' }, { ref: 'hihat', kind: 'noise' }],
    { patternLength }
  ).song
}

describe('parseDrumText', () => {
  it('parses the plan example', () => {
    const song = drumSong()
    const r = parseDrumText({ channel: 'NO', legend: { K: '@kick', S: '@snare', h: 'hat v6' }, steps: 'K.h.S.h.K.KhS.h.', repeat: 4 }, song)
    expect(r.channel).toBe('NO')
    expect(r.totalRows).toBe(64)
    expect(r.needs).toEqual([])
    expect(r.placements).toHaveLength(4 * 9)
    expect(r.placements[0]).toEqual({ orderOffset: 0, row: 0, cell: { note: 60, inst: 1 } })
    expect(r.placements[1]).toEqual({ orderOffset: 0, row: 2, cell: { note: 60, inst: 3, vol: 6 } })
    expect(r.placements[2]).toEqual({ orderOffset: 0, row: 4, cell: { note: 60, inst: 2 } })
    expect(r.placements.at(-1)).toEqual({ orderOffset: 0, row: 62, cell: { note: 60, inst: 3, vol: 6 } })
  })
  it('resolves roles to existing instruments and reports roles that need instruments', () => {
    const song = drumSong()
    const r = parseDrumText({ channel: 'NO', legend: { K: 'kick', C: 'crash', c: 'clap v8' }, steps: 'K.C.K.c.' }, song)
    expect(r.placements[0]!.cell.inst).toBe(1)
    expect(r.needs.map((n) => [n.key, n.role, n.uses])).toEqual([['C', 'crash', 1], ['c', 'clap', 1]])
    expect(r.placements[1]!.cell.inst).toBeUndefined()
    expect(() => drumToDiffs(song, r)).toThrow(/needs instruments for role\(s\): crash, clap/)
    // the tool layer adds the instruments and parses again
    for (const role of ['crash', 'clap'] as const) {
      const inst = resolvePreset('nes', role, 'noise')
      createInstrumentCommand(song, { op: 'add', instrument: inst }).apply(song)
    }
    const again = parseDrumText({ channel: 'NO', legend: { K: 'kick', C: 'crash', c: 'clap v8' }, steps: 'K.C.K.c.' }, song)
    expect(again.needs).toEqual([])
    expect(drumToDiffs(song, again)).toHaveLength(4)
  })
  it('supports notes, off and rowsPerStep/startRow', () => {
    const song = drumSong()
    const r = parseDrumText({ channel: 'NO', legend: { K: '@kick C-3', x: 'off' }, steps: 'K x', rowsPerStep: 2, startRow: 4 }, song)
    expect(r.placements).toEqual([
      { orderOffset: 0, row: 4, cell: { note: 48, inst: 1 } },
      { orderOffset: 0, row: 6, cell: { note: 'off' } }
    ])
  })
  it('ignores spaces and bar lines in steps', () => {
    const song = drumSong()
    const a = parseDrumText({ channel: 'NO', legend: { K: '@kick' }, steps: 'K...|K...' }, song)
    const b = parseDrumText({ channel: 'NO', legend: { K: '@kick' }, steps: 'K... K...' }, song)
    expect(a.placements.map((p) => p.row)).toEqual([0, 4])
    expect(b.placements).toEqual(a.placements)
  })
  it('uses lower default notes for pitched triangle drums', () => {
    const song = songWithPresets('nes', [{ ref: 'kick', kind: 'triangle' }]).song
    const r = parseDrumText({ channel: 'TR', legend: { K: '@kick-tri' }, steps: 'K' }, song)
    expect(r.placements[0]!.cell).toEqual({ note: 36, inst: 0 })
  })
})

describe('drum errors', () => {
  const err = (spec: Parameters<typeof parseDrumText>[0], song = drumSong()): DrumTextError => {
    try {
      parseDrumText(spec, song)
    } catch (e) {
      expect(e).toBeInstanceOf(DrumTextError)
      return e as DrumTextError
    }
    throw new Error('expected an error')
  }
  it('snapshot: unknown characters, bad legend values and bad instruments', () => {
    const e = err({ channel: 'NO', legend: { K: '@kick', S: '@nope', hh: 'hat', q: 'banana', z: 'v99' }, steps: 'K.S.xK.y' })
    expect(e.message).toMatchInlineSnapshot(`
      "Invalid drum pattern (4 problems):
      - Legend "S": "@nope": no instrument named "nope". Instruments: @0 "lead", @1 "kick", @2 "snare", @3 "hat".
      - Legend key "hh" must be exactly one character.
      - Legend "q": "banana" is not an instrument (@name or @3), a role (kick, snare, hat, openhat, crash, tom, clap), a note (C-4), a volume (v8) or "off".
      - Legend "z": volume v99 must be v0..v15."
    `)
  })
  it('lists legend keys for unknown step characters', () => {
    const e = err({ channel: 'NO', legend: { K: '@kick' }, steps: 'K.x.y' })
    expect(e.issues.map((i) => i.message)).toEqual([
      'Unknown step character "x" at step 3: legend keys are K; use "." for a rest.',
      'Unknown step character "y" at step 5: legend keys are K; use "." for a rest.'
    ])
  })
  it('reports overflow with the row count', () => {
    const e = err({ channel: 'NO', legend: { K: '@kick' }, steps: 'K...K...K...K...', repeat: 5 })
    expect(e.message).toContain('80 rows')
    expect(e.message).toContain('overflows the pattern (length 64) by 16 row(s)')
    expect(e.message).toContain('wrap:true')
    expect(() => parseDrumText({ channel: 'NO', legend: { K: '@kick' }, steps: 'K...K...K...K...', repeat: 5 }, drumSong(), { wrap: true })).not.toThrow()
  })
  it('validates structure and channels', () => {
    expect(err({ channel: 'NO', legend: { K: '@kick' }, steps: '', repeat: 0 }).message).toContain('repeat must be')
    expect(() => parseDrumText({ channel: 'XX', legend: {}, steps: 'K' }, drumSong())).toThrow(/not found/)
  })
  it('strict mode rejects instruments the channel cannot play', () => {
    const e = err({ channel: 'P1', legend: { K: '@kick' }, steps: 'K' })
    expect(e.message).toContain('P1 (Pulse 1) cannot play')
  })
})

describe('drum round trip', () => {
  it('formats stored drum cells back to a legend + steps spec that parses to the same cells', () => {
    const song = drumSong()
    const spec = { channel: 'NO', legend: { K: '@kick', S: '@snare', h: '@hat v6' }, steps: 'K.h.S.h.K.KhS.hx', repeat: 1 }
    const parsed = parseDrumText({ ...spec, legend: { ...spec.legend, x: 'off' } }, song)
    createCellsCommand(song, drumToDiffs(song, parsed)).apply(song)
    const back = formatDrumText(song, 'NO', { toRow: 16 })
    expect(back.steps).toBe('K.h.S.h.K.KhS.hx')
    expect(back.legend).toEqual({ K: '@kick', S: '@snare', h: '@hat v6', x: 'off' })
    const again = parseDrumText(back, song)
    expect(again.placements).toHaveLength(parsed.placements.length)
    again.placements.forEach((p, i) => expect(cellsEqual(p.cell, parsed.placements[i]!.cell)).toBe(true))
  })
  it('assigns letters for custom note/volume variants', () => {
    const song = drumSong(16)
    createCellsCommand(song, [
      { channel: 'NO', pattern: 0, row: 0, cell: { note: 60, inst: 1 } },
      { channel: 'NO', pattern: 0, row: 2, cell: { note: 50, inst: 1 } },
      { channel: 'NO', pattern: 0, row: 4, cell: { note: 60, inst: 1, vol: 9 } }
    ]).apply(song)
    const spec = formatDrumText(song, 'NO')
    expect(spec.steps).toBe('K.A.B...........')
    expect(spec.legend).toEqual({ K: '@kick', A: '@kick D-3', B: '@kick v9' })
    const parsed = parseDrumText(spec, song)
    expect(parsed.placements.map((p) => p.cell)).toEqual([{ note: 60, inst: 1 }, { note: 50, inst: 1 }, { note: 60, inst: 1, vol: 9 }])
    void createSong
  })
})
