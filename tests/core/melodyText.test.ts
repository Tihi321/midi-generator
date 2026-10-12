import { describe, expect, it } from 'vitest'
import { MelodyTextError, formatMelodyText, melodyToDiffs, parseMelodyText } from '../../src/core/codecs/melodyText'
import { createCellsCommand } from '../../src/core/commands'
import { type Song } from '../../src/core/types'
import { cellsEqual, createSong } from '../../src/core/model'
import { formatNoteCompact } from '../../src/core/notes'
import { rng, songWithPresets } from './helpers'

function nesSong(patternLength = 64, extra: Partial<Parameters<typeof createSong>[0]> = {}): Song {
  return songWithPresets('nes', [{ ref: 'lead' }, { ref: 'arp' }, { ref: 'bass', kind: 'triangle' }], { patternLength, ...extra }).song
}

const EXAMPLE = '@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2'

describe('parseMelodyText', () => {
  it('parses the plan example into 32 rows of cells', () => {
    const r = parseMelodyText(EXAMPLE, nesSong(), 'P1')
    expect(r.channel).toBe('P1')
    expect(r.totalRows).toBe(32)
    expect(r.orderSpan).toBe(1)
    expect(r.placements).toEqual([
      { orderOffset: 0, row: 0, cell: { note: 76, inst: 0, vol: 12 } },
      { orderOffset: 0, row: 2, cell: { note: 79 } },
      { orderOffset: 0, row: 4, cell: { note: 81 } },
      { orderOffset: 0, row: 8, cell: { note: 'off' } },
      { orderOffset: 0, row: 10, cell: { note: 79 } },
      { orderOffset: 0, row: 11, cell: { note: 78 } },
      { orderOffset: 0, row: 12, cell: { note: 76 } },
      { orderOffset: 0, row: 20, cell: { note: 69, fx: [{ code: '0', param: 0x37 }] } },
      {
        orderOffset: 0,
        row: 28,
        cell: { note: 74, fx: [{ code: '0', param: 0 }, { code: '4', param: 0xa2 }] }
      }
    ])
  })
  it('accepts tracker note spellings, lengths via defaultLength and release', () => {
    const r = parseMelodyText('C-4 C#4:2 Db4 ^^^ E4', nesSong(), 'P1', { defaultLength: 3 })
    expect(r.placements.map((p) => [p.row, p.cell.note])).toEqual([[0, 60], [3, 61], [5, 61], [8, 'rel'], [11, 64]])
  })
  it('writes starting at startRow and merges consecutive rests', () => {
    const r = parseMelodyText('r:2 r:2 C4:2', nesSong(), 'P1', { startRow: 8 })
    expect(r.placements).toEqual([
      { orderOffset: 0, row: 8, cell: { note: 'off' } },
      { orderOffset: 0, row: 12, cell: { note: 60 } }
    ])
  })
  it('turns chords into root + 0xy and warns when notes are dropped', () => {
    const r = parseMelodyText('{C4 E4 G4 B4}:4 {C4 G4}', nesSong(), 'P1')
    expect(r.placements[0]!.cell).toEqual({ note: 60, fx: [{ code: '0', param: 0x4b }] })
    expect(r.placements[1]!.cell).toEqual({ note: 60, fx: [{ code: '0', param: 0x70 }] })
    expect(r.warnings[0]).toContain('dropped G4')
  })
  it('stops the arpeggio with 000 on the next plain note', () => {
    const r = parseMelodyText('{C4 E4 G4}:2 D4 E4', nesSong(), 'P1')
    expect(r.placements[1]!.cell.fx).toEqual([{ code: '0', param: 0 }])
    expect(r.placements[2]!.cell.fx).toBeUndefined()
  })
  it('re-emits the instrument and volume only when they change', () => {
    const r = parseMelodyText('@lead v10 C4 D4 v8 E4 @arp F4', nesSong(), 'P1')
    expect(r.placements.map((p) => [p.cell.inst, p.cell.vol])).toEqual([[0, 10], [undefined, undefined], [undefined, 8], [1, undefined]])
  })
})

describe('melody errors', () => {
  const err = (text: string, opts = {}, song = nesSong()): MelodyTextError => {
    try {
      parseMelodyText(text, song, 'P1', opts)
    } catch (e) {
      expect(e).toBeInstanceOf(MelodyTextError)
      return e as MelodyTextError
    }
    throw new Error('expected an error')
  }
  it('reports how many rows overflow and how to fix it', () => {
    const song = nesSong(32)
    const e = err('C4:20 D4:20', {}, song)
    expect(e.message).toContain('40 rows long')
    expect(e.message).toContain('overflows the pattern (length 32) by 8 row(s)')
    expect(e.message).toContain('wrap:true')
    expect(err('C4:8', { startRow: 28 }, song).message).toContain('by 4 row(s)')
  })
  it('chord intervals over 15 semitones are rejected', () => {
    const e = err('{C4 C6}:4')
    expect(e.issues[0]).toMatchObject({ col: 1, token: '{C4 C6}:4' })
    expect(e.message).toContain('exceeds 15')
  })
  it('snapshot: syntax problems with columns', () => {
    const e = err('C4 xx ~:2 {A4 H4} @zzz v20 E4:0 ~')
    expect(e.message).toMatchInlineSnapshot(`
      "Invalid melody (5 problems):
      - col 4, "xx": unrecognized token. Use a note (E5, F#5, Db4) with optional :length and !effect, r (rest), ~ (tie), ^^^ (release), {A4 C5 E5} (chord), @instrument, or vNN (volume).
      - col 11, "{A4 H4}": "H4" inside the chord is not a note (use names like A4, C#5, Db4).
      - col 19, "@zzz": no instrument named "zzz". Instruments: @0 "lead", @1 "arp", @2 "bass".
      - col 24, "v20": volume must be v0..v15.
      - col 28, "E4:0": length must be 1 or more rows."
    `)
  })
  it('a tie before any note is an error', () => {
    expect(err('~:2 C4').message).toContain('nothing to hold')
  })
  it('strict mode rejects notes the channel cannot play, with the fix', () => {
    const e = err('C1 E4')
    expect(e.message).toContain('"C1": note C-1 is below P1')
    expect(e.message).toContain('transpose +12 or move to TR')
    expect(() => parseMelodyText('C1', nesSong(), 'P1', { strict: false })).not.toThrow()
    expect(() => parseMelodyText('C4', nesSong(), 'ZZ')).toThrow(/not found/)
    expect(() => parseMelodyText('C4', nesSong(), 'P1', { startRow: 99 })).toThrow(/startRow/)
  })
  it('a chord and its own arpeggio effect conflict', () => {
    expect(err('{C4 E4 G4}!047').message).toContain('already uses the 0xy')
  })
})

describe('wrap and diffs', () => {
  it('continues into following order rows with wrap:true', () => {
    const song = nesSong(16)
    const r = parseMelodyText('C4:8 D4:8 E4:8 F4:4', song, 'P1', { wrap: true })
    expect(r.orderSpan).toBe(2)
    expect(r.placements.map((p) => [p.orderOffset, p.row, p.cell.note])).toEqual([[0, 0, 60], [0, 8, 62], [1, 0, 64], [1, 8, 65]])
    expect(() => melodyToDiffs(song, r, 0)).toThrow(/add 1 more order row/)
    song.orders = [[0, 0, 0, 0], [1, 1, 1, 1]]
    const diffs = melodyToDiffs(song, r, 0)
    expect(diffs.map((d) => [d.pattern, d.row])).toEqual([[0, 0], [0, 8], [1, 0], [1, 8]])
    createCellsCommand(song, diffs).apply(song)
    expect(song.patterns.get('P1:1')!.rows[8]!.note).toBe(65)
    expect(() => melodyToDiffs(song, r, 5)).toThrow(/Order 5 not found/)
  })
})

describe('formatMelodyText', () => {
  it('formats stored cells back to the plan notation', () => {
    const song = nesSong()
    const r = parseMelodyText(EXAMPLE, song, 'P1')
    createCellsCommand(song, melodyToDiffs(song, r)).apply(song)
    const text = formatMelodyText(song, 'P1', { toRow: 32 })
    expect(text).toBe('@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:8 {A4 C5 E5}:8 D5:4!4A2')
  })
  it('prints leading silence as a rest, release and instrument changes', () => {
    const song = nesSong(16)
    createCellsCommand(song, [
      { channel: 'P1', pattern: 0, row: 2, cell: { note: 60, inst: 0, vol: 9 } },
      { channel: 'P1', pattern: 0, row: 4, cell: { note: 62, inst: 1 } },
      { channel: 'P1', pattern: 0, row: 6, cell: { note: 'rel' } },
      { channel: 'P1', pattern: 0, row: 8, cell: { note: 64, fx: [{ code: 'W', param: 2 }] } }
    ]).apply(song)
    expect(formatMelodyText(song, 'P1')).toBe('r:2 @lead v9 C4:2 @arp D4:2 ^^^:2 E4:8!W02')
    expect(formatMelodyText(song, 'P1', { instrumentRefs: 'index', toRow: 7 })).toBe('r:2 @0 v9 C4:2 @1 D4:2 ^^^')
    expect(formatMelodyText(song, 'P2')).toBe('r:16')
    expect(formatMelodyText(song, 'P1', { orders: 2 }).endsWith('E5')).toBe(false)
  })
  it('hides the 000 that follows a chord so the text stays tidy', () => {
    const song = nesSong()
    const r = parseMelodyText('{C4 E4 G4}:2 D4:2', song, 'P1')
    createCellsCommand(song, melodyToDiffs(song, r)).apply(song)
    expect(formatMelodyText(song, 'P1', { toRow: 4 })).toBe('{C4 E4 G4}:2 D4:2')
  })

  it('round-trips randomized melodies (text -> cells -> text -> cells)', () => {
    const random = rng(99)
    const int = (n: number): number => Math.floor(random() * n)
    for (let round = 0; round < 60; round++) {
      const song = nesSong(256, { authenticity: 'relaxed' })
      const toks: string[] = []
      let rows = 0
      const count = 3 + int(14)
      for (let i = 0; i < count; i++) {
        const len = 1 + int(4)
        const kind = int(10)
        const note = formatNoteCompact(36 + int(48))
        const lenText = len === 1 && random() < 0.5 ? '' : `:${len}`
        if (kind < 4) toks.push(`${note}${lenText}`)
        else if (kind === 4) toks.push(`r${lenText}`)
        else if (kind === 5) toks.push(`^^^${lenText}`)
        else if (kind === 6) {
          const root = 36 + int(40)
          const iv = [3 + int(2), 7 + int(2)]
          toks.push(`{${formatNoteCompact(root)} ${formatNoteCompact(root + iv[0]!)} ${formatNoteCompact(root + iv[1]!)}}${lenText}`)
        } else if (kind === 7) toks.push(`@${['lead', 'arp', 'bass'][int(3)]}`, `${note}${lenText}`)
        else if (kind === 8) toks.push(`v${int(16)}`, `${note}${lenText}`)
        else toks.push(`${note}${lenText}!4A${int(10)}`)
        rows += len
        if (i === 0 && toks[0]!.startsWith('^^^')) toks[0] = 'C4'
      }
      void rows
      const text = toks.join(' ')
      const a = parseMelodyText(text, song, 'P1', { strict: false })
      createCellsCommand(song, melodyToDiffs(song, a)).apply(song)
      const text2 = formatMelodyText(song, 'P1')
      const b = parseMelodyText(text2, song, 'P1', { strict: false })
      expect(b.placements.length, `${text}\n=> ${text2}`).toBe(a.placements.length)
      a.placements.forEach((p, i) => {
        expect(b.placements[i]!.row, `${text}\n=> ${text2}`).toBe(p.row)
        expect(cellsEqual(b.placements[i]!.cell, p.cell), `${text}\n=> ${text2}\n${JSON.stringify(p.cell)} vs ${JSON.stringify(b.placements[i]!.cell)}`).toBe(true)
      })
    }
  })
})
