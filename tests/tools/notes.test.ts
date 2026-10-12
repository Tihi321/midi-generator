import { describe, expect, it } from 'vitest'
import { resultText, snapshot, songSetup } from './helpers'

/** A NES song with the three standard melodic instruments. */
async function nes(patternLength = 64) {
  const t = songSetup({ patternLength })
  await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
  await t.ok('add_instrument', { preset: 'arp', channel: 'P2' })
  await t.ok('add_instrument', { preset: 'bass', channel: 'TR' })
  return t
}

const cell = (t: Awaited<ReturnType<typeof nes>>, ch: string, row: number, pattern = 0) => t.song.patterns.get(`${ch}:${pattern}` as `${string}:${number}`)?.rows[row] ?? null

describe('write_pattern', () => {
  it('writes cells for several channels, reports them and is ONE undo step', async () => {
    const t = await nes()
    const before = snapshot(t.song)
    const depth = t.session.history.undoDepth
    const text = await t.text('write_pattern', {
      text: 'channels: P1 | P2 | TR\n 0 | E-5 @lead v12 | C-4 @arp 037 | A-2 @bass\n 4 | G-5 | . | .\n 8 | A-5 4A2 | === | A-3'
    })
    expect(text).toMatch(/Wrote 7 cells \(7 changed\) to order 0 \(P1:0 P2:0 TR:0\) on P1, P2, TR, rows 0\.\.8/)
    expect(cell(t, 'P1', 0)).toEqual({ note: 76, inst: 0, vol: 12 })
    expect(cell(t, 'P1', 8)).toEqual({ note: 81, fx: [{ code: '4', param: 0xa2 }] })
    expect(cell(t, 'P2', 0)).toEqual({ note: 60, inst: 1, fx: [{ code: '0', param: 0x37 }] })
    expect(cell(t, 'P2', 8)).toEqual({ note: 'off' })
    expect(t.session.history.undoDepth).toBe(depth + 1)
    t.session.undo()
    expect(snapshot(t.song)).toBe(before)
    t.session.redo()
    expect(cell(t, 'P1', 4)).toEqual({ note: 79 })
  })

  it('merge keeps other cells, replace clears the listed channels first', async () => {
    const t = await nes()
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead\n4 | E-5\n8 | G-5' })
    await t.ok('write_pattern', { text: 'channels: P1\n4 | D-5' })
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 72 })
    expect(cell(t, 'P1', 4)).toEqual({ note: 74 })
    expect(cell(t, 'P1', 8)).toEqual({ note: 79 })
    await t.ok('write_pattern', { text: 'channels: P1\n4 | F-5', mode: 'replace' })
    expect(cell(t, 'P1', 0)).toBeNull()
    expect(cell(t, 'P1', 4)).toEqual({ note: 77 })
    expect(cell(t, 'P1', 8)).toBeNull()
  })

  it('targets an order row or an explicit pattern number and warns about shared patterns', async () => {
    const t = await nes()
    await t.ok('set_orders', { orders: [0, 1, 0] })
    const shared = await t.text('write_pattern', { text: 'channels: P1\n0 | C-5 @lead', order: 0 })
    expect(shared).toMatch(/P1 pattern 0 is also used by order 2/)
    await t.ok('write_pattern', { text: 'channels: P1\n0 | D-5 @lead', order: 1 })
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 74 })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | E-5 @lead', pattern: 7 })
    expect(cell(t, 'P1', 0, 7)).toMatchObject({ note: 76 })
    expect(resultText(await t.call('write_pattern', { text: 'channels: P1\n0 | E-5', order: 9 }))).toMatch(/Order 9 not found. The song has 3 order row/)
  })

  it('uses the cursor order when none is given', async () => {
    const t = await nes()
    await t.ok('set_orders', { orders: [0, 1] })
    t.session.setCursor({ order: 1 })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead' })
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 72 })
    expect(cell(t, 'P1', 0, 0)).toBeNull()
  })

  it('reports parse errors with line, channel and fix and writes nothing', async () => {
    const t = await nes()
    const before = snapshot(t.song)
    const r = await t.call('write_pattern', { text: 'channels: P1 | TR\n0 | C-5 @lead zz | A-2 v12\n1 | C-5 C-6 | A-2' })
    expect(r.isError).toBe(true)
    const text = resultText(r)
    expect(text).toMatch(/Invalid tracker text \(\d+ problems?\)/)
    expect(text).toMatch(/Line 2, channel P1.*unrecognized token "zz"/)
    expect(text).toMatch(/Line 2, channel TR.*no volume/i)
    expect(text).toMatch(/Line 3, channel P1.*one note per cell/)
    expect(snapshot(t.song)).toBe(before)
    expect(t.session.history.undoDepth).toBe(3) // only the three add_instrument steps
  })

  it('strict songs reject chip violations with the fix; relaxed songs warn and write', async () => {
    const t = await nes()
    const strict = await t.call('write_pattern', { text: 'channels: P1\n0 | C-0 @lead' })
    expect(strict.isError).toBe(true)
    expect(resultText(strict)).toMatch(/below P1's lowest note A-1 on NES; transpose \+24/)
    expect(cell(t, 'P1', 0)).toBeNull()

    await t.ok('set_song_info', { authenticity: 'relaxed' })
    const relaxed = await t.call('write_pattern', { text: 'channels: P1 | TR\n0 | C-0 @lead | A-2 v8' })
    expect(relaxed.isError).toBeFalsy()
    const text = resultText(relaxed)
    expect(text).toMatch(/Warnings \(relaxed song/)
    expect(text).toMatch(/below P1's lowest note/)
    expect(text).toMatch(/no volume on NES/)
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 12 })
  })

  it('keeps the old chip rule for the Game Boy wave channel: only 4 volume levels (warning)', async () => {
    const t = songSetup({ chip: 'gb' })
    await t.ok('add_instrument', { preset: 'bass', channel: 'WV' })
    const r = await t.ok('write_pattern', { text: 'channels: WV\n0 | A-2 @bass v12' })
    expect(resultText(r)).toMatch(/Wrote 1 cell/)
    const analysis = await t.text('analyze_song')
    expect(analysis).toMatch(/quantized/)
  })
})

describe('write_melody', () => {
  it('writes notes, chords become arpeggios, and it is one undo step', async () => {
    const t = await nes()
    const depth = t.session.history.undoDepth
    const text = await t.text('write_melody', { channel: 'P1', melody: '@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2' })
    expect(text).toMatch(/Wrote 8 notes .* to P1 at order 0; the melody spans 32 rows/)
    expect(cell(t, 'P1', 0)).toEqual({ note: 76, inst: 0, vol: 12 })
    expect(cell(t, 'P1', 8)).toEqual({ note: 'off' })
    expect(cell(t, 'P1', 20)).toMatchObject({ note: 69, fx: [{ code: '0', param: 0x37 }] })
    expect(t.session.history.undoDepth).toBe(depth + 1)
  })

  it('defaults to the cursor channel, honours startRow and clear', async () => {
    const t = await nes()
    t.session.setCursor({ channel: 1 })
    await t.ok('write_melody', { melody: '@arp C4:2 E4:2', startRow: 8 })
    expect(cell(t, 'P2', 8)).toMatchObject({ note: 60 })
    expect(cell(t, 'P2', 10)).toMatchObject({ note: 64 })
    await t.ok('write_melody', { channel: 'P2', melody: 'G4:4', clear: true })
    expect(cell(t, 'P2', 8)).toBeNull()
    expect(cell(t, 'P2', 0)).toMatchObject({ note: 67 })
  })

  it('needs wrap and enough order rows for a long melody', async () => {
    const t = await nes(16)
    const melody = '@lead C5:8 D5:8 E5:8 F5:8'
    const r = await t.call('write_melody', { channel: 'P1', melody })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toMatch(/pattern|wrap|rows/i)
    const r2 = await t.call('write_melody', { channel: 'P1', melody, wrap: true })
    expect(resultText(r2)).toMatch(/add 1 more order row/)
    await t.ok('insert_order', {})
    const ok = await t.text('write_melody', { channel: 'P1', melody, wrap: true })
    expect(ok).toMatch(/over 2 order rows/)
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 76 })
  })

  it('reports bad tokens, unknown instruments and strict violations', async () => {
    const t = await nes()
    expect(resultText(await t.call('write_melody', { channel: 'P1', melody: '@lead C5:x' }))).toMatch(/Invalid melody/)
    expect(resultText(await t.call('write_melody', { channel: 'P1', melody: '@nope C5' }))).toMatch(/no instrument named "nope"/)
    const strict = await t.call('write_melody', { channel: 'TR', melody: '@bass v8 A2' })
    expect(strict.isError).toBe(true)
    expect(resultText(strict)).toMatch(/no volume/)
    expect(resultText(await t.call('write_melody', { channel: 'ZZ', melody: 'C5' }))).toMatch(/Channel "ZZ" not found/)
  })
})

describe('write_drums', () => {
  it('adds the preset instruments for role legends, writes the hits and says so', async () => {
    const t = songSetup()
    const depth = t.session.history.undoDepth
    const text = await t.text('write_drums', { legend: { K: 'kick', S: 'snare', h: 'hat v6' }, steps: 'K.h.S.h.K.KhS.h.', repeat: 4 })
    expect(text).toMatch(/Wrote 36 drum hits .* to NO at order 0, covering 64 of 64 rows/)
    expect(text).toMatch(/Added instruments for the roles: @0 kick \(nes-noise, preset nes\.kick\.noise\); @1 hat .*; @2 snare/)
    expect(t.song.instruments.map((i) => i.name).sort()).toEqual(['hat', 'kick', 'snare'])
    expect(cell(t as never, 'NO', 0)).toMatchObject({ note: 60, inst: 0 })
    expect(cell(t as never, 'NO', 2)).toMatchObject({ vol: 6 })
    expect(t.session.history.undoDepth).toBe(depth + 1) // instruments + cells in ONE step
    t.session.undo()
    expect(t.song.instruments).toHaveLength(0)
    expect(t.song.patterns.size).toBe(0)
  })

  it('reuses existing instruments of that role and hints when the steps do not fill the pattern', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'kick', channel: 'NO' })
    const text = await t.text('write_drums', { legend: { K: 'kick' }, steps: 'K...K...K...K...' })
    expect(text).not.toContain('Added instruments')
    expect(text).toMatch(/covering 16 of 64 rows/)
    expect(text).toMatch(/Hint: .* pass "repeat": 4/)
    expect(t.song.instruments).toHaveLength(1)
  })

  it('works on the Game Boy and Genesis-style noise channel defaults', async () => {
    const t = songSetup({ chip: 'gb' })
    await t.ok('write_drums', { legend: { K: 'kick', h: 'hihat' }, steps: 'K.h.K.h.', repeat: 8 })
    expect(t.song.instruments.every((i) => i.kind === 'gb-noise')).toBe(true)
  })

  it('reports unknown step characters, bad legend values and overflow', async () => {
    const t = songSetup()
    expect(resultText(await t.call('write_drums', { legend: { K: 'kick' }, steps: 'K.x.' }))).toMatch(/Unknown step character "x" at step 3: legend keys are K/)
    expect(resultText(await t.call('write_drums', { legend: { K: 'banjo' }, steps: 'K' }))).toMatch(/"banjo" is not an instrument/)
    expect(resultText(await t.call('write_drums', { legend: { K: 'kick' }, steps: 'K.......', repeat: 20 }))).toMatch(/overflows the pattern \(length 64\) by 96 row/)
    expect(t.song.instruments).toHaveLength(0) // failed calls roll the auto-added instruments back
    expect(resultText(await t.call('write_drums', { legend: { K: 'kick' }, steps: 'K', channel: 'P1' }))).toMatch(/pulse|P1/)
  })

  it('clear:true replaces the pattern', async () => {
    const t = songSetup()
    await t.ok('write_drums', { legend: { K: 'kick' }, steps: 'K...', repeat: 4 })
    await t.ok('write_drums', { legend: { K: 'kick' }, steps: '..K.', repeat: 2, clear: true })
    expect(cell(t as never, 'NO', 0)).toBeNull()
    expect(cell(t as never, 'NO', 2)).toMatchObject({ note: 60 })
  })
})

describe('set_cells, clear_pattern', () => {
  it('sets cells by note name, number, off/rel, instrument name and effects; clear empties', async () => {
    const t = await nes()
    const r = await t.text('set_cells', {
      cells: [
        { channel: 'P1', row: 0, note: 'G-5', inst: 'lead', vol: 12, fx: ['4A2'] },
        { channel: 'P1', row: 4, note: 72 },
        { channel: 'P1', row: 6, note: 'off' },
        { channel: 'P2', row: 2, note: 'rel', inst: 1 },
        { channel: 0, row: 8, note: 'Db5', fx: [{ code: 'W', param: 2 }] }
      ]
    })
    expect(r).toMatch(/Set 5 cells \(5 changed\)/)
    expect(cell(t, 'P1', 0)).toEqual({ note: 79, inst: 0, vol: 12, fx: [{ code: '4', param: 0xa2 }] })
    expect(cell(t, 'P1', 6)).toEqual({ note: 'off' })
    expect(cell(t, 'P1', 8)).toEqual({ note: 73, fx: [{ code: 'W', param: 2 }] })
    expect(t.session.history.undoDepth).toBe(4)
    await t.ok('set_cells', { cells: [{ channel: 'P1', row: 4, clear: true }] })
    expect(cell(t, 'P1', 4)).toBeNull()
  })

  it('rejects bad cells without changing anything', async () => {
    const t = await nes()
    const before = snapshot(t.song)
    expect(resultText(await t.call('set_cells', { cells: [{ channel: 'P1', row: 0, note: 'H-9' }] }))).toMatch(/"H-9" is not a note/)
    expect(resultText(await t.call('set_cells', { cells: [{ channel: 'P1', row: 0, note: 60, inst: 'ghost' }] }))).toMatch(/Instrument "ghost" not found\. Instruments: @0 "lead"/)
    expect(resultText(await t.call('set_cells', { cells: [{ channel: 'P1', row: 0, note: 60, fx: ['zz9'] }] }))).toMatch(/not an effect/)
    expect(resultText(await t.call('set_cells', { cells: [{ channel: 'P1', row: 99, note: 60 }] }))).toMatch(/Row 99 is outside the pattern/)
    expect(resultText(await t.call('set_cells', { cells: [{ channel: 'TR', row: 0, note: 40, vol: 5 }] }))).toMatch(/no volume on NES/)
    expect(resultText(await t.call('set_cells', { cells: [{ channel: 'P1', row: 0, note: 60, fx: ['X10'] }] }))).toMatch(/effect X10 is not available on P1/)
    expect(snapshot(t.song)).toBe(before)
  })

  it('clear_pattern clears an order row on chosen channels and rows', async () => {
    const t = await nes()
    await t.ok('write_pattern', { text: 'channels: P1 | P2\n0 | C-5 @lead | C-4 @arp\n8 | E-5 | E-4\n16 | G-5 | G-4' })
    const r = await t.text('clear_pattern', { channels: ['P1'], fromRow: 8 })
    expect(r).toMatch(/Cleared 2 cells on P1 at order 0/)
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 72 })
    expect(cell(t, 'P1', 8)).toBeNull()
    expect(cell(t, 'P2', 8)).toMatchObject({ note: 64 })
    await t.ok('clear_pattern', {})
    expect(cell(t, 'P2', 0)).toBeNull()
    expect(await t.text('clear_pattern', {})).toMatch(/already empty/)
    expect(resultText(await t.call('clear_pattern', { channels: ['QQ'] }))).toMatch(/Channel "QQ" not found/)
  })
})

describe('copy_pattern and transpose', () => {
  async function twoSections() {
    const t = await nes()
    await t.ok('set_orders', { orders: [0, 1] })
    await t.ok('write_pattern', { text: 'channels: P1 | TR | NO\n0 | C-5 @lead | C-2 @bass | C-4\n4 | E-5 | G-2 | .\n8 | G-5 | .  | C-4' })
    return t
  }

  it('copies one order row to another, optionally transposed; drums are not transposed', async () => {
    const t = await twoSections()
    const r = await t.text('copy_pattern', { fromOrder: 0, toOrder: 1, semitones: 12 })
    expect(r).toMatch(/Copied order 0 to order 1 on P1, P2, TR, NO \(rows 0\.\.63, \+12 semitones\)/)
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 84, inst: 0 })
    expect(cell(t, 'TR', 4, 1)).toMatchObject({ note: 55 })
    expect(cell(t, 'NO', 0, 1)).toMatchObject({ note: 60 })
    expect(cell(t, 'P1', 0, 0)).toMatchObject({ note: 72 }) // source untouched
  })

  it('transposes diatonically with degrees in the song key', async () => {
    const t = await twoSections()
    await t.ok('copy_pattern', { fromOrder: 0, toOrder: 1, degrees: 2, channels: ['P1'] })
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 76 }) // C-5 up a third in C major = E-5
    expect(cell(t, 'P1', 4, 1)).toMatchObject({ note: 79 })
    expect(cell(t, 'P1', 8, 1)).toMatchObject({ note: 83 })
  })

  it('refuses when both orders share the patterns, and merge keeps existing cells', async () => {
    const t = await twoSections()
    await t.ok('set_orders', { orders: [0, 0, 1] })
    expect(resultText(await t.call('copy_pattern', { fromOrder: 0, toOrder: 1 }))).toMatch(/Nothing copied: .* \(both orders use pattern 0\)/)
    await t.ok('write_pattern', { text: 'channels: P1\n12 | A-5 @lead', order: 2 })
    await t.ok('copy_pattern', { fromOrder: 0, toOrder: 2, mode: 'merge', channels: ['P1'] })
    expect(cell(t, 'P1', 12, 1)).toMatchObject({ note: 81 })
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 72 })
  })

  it('transpose shifts notes in place, skips drums and note-offs, and is one undo step', async () => {
    const t = await twoSections()
    await t.ok('write_pattern', { text: 'channels: P1\n12 | ===' })
    const depth = t.session.history.undoDepth
    const r = await t.text('transpose', { semitones: -12 })
    expect(r).toMatch(/Transposed 5 notes by -12 semitones on P1, P2, TR/)
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 60 })
    expect(cell(t, 'P1', 12)).toEqual({ note: 'off' })
    expect(cell(t, 'NO', 0)).toMatchObject({ note: 60 }) // drums untouched
    expect(t.session.history.undoDepth).toBe(depth + 1)
    t.session.undo()
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 72 })
  })

  it('transpose by degrees and across all orders', async () => {
    const t = await twoSections()
    await t.ok('copy_pattern', { fromOrder: 0, toOrder: 1 })
    await t.ok('transpose', { degrees: 1, allOrders: true, channels: ['P1'] })
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 74 }) // C -> D
    expect(cell(t, 'P1', 0, 1)).toMatchObject({ note: 74 })
    expect(cell(t, 'P1', 8)).toMatchObject({ note: 81 }) // G -> A
  })

  it('transpose reports range violations with the fix (strict) and bad arguments', async () => {
    const t = await twoSections()
    const r = await t.call('transpose', { semitones: -48, channels: ['P1'] })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toMatch(/Chip rules for NES violated/)
    expect(resultText(r)).toMatch(/below P1's lowest note/)
    expect(cell(t, 'P1', 0)).toMatchObject({ note: 72 })
    expect(resultText(await t.call('transpose', {}))).toMatch(/exactly one of "semitones".*"degrees"/)
    expect(resultText(await t.call('transpose', { semitones: 1, degrees: 1 }))).toMatch(/exactly one of/)
    expect(resultText(await t.call('transpose', { semitones: 100 }))).toMatch(/Invalid arguments/)
    expect(await t.text('transpose', { semitones: 2, order: 1 })).toMatch(/No notes found/)
    expect(resultText(await t.call('transpose', { semitones: 2, channels: ['NO'] }))).toMatch(/No pitched channels/)
  })
})

describe('every writing tool is exactly one undo step and undo restores the song', () => {
  const writes: Array<[string, unknown]> = [
    ['write_pattern', { text: 'channels: P1 | NO\n0 | C-5 @lead | C-4 @kick' }],
    ['write_melody', { channel: 'P1', melody: '@lead C5:4 E5:4 G5:8' }],
    ['write_drums', { legend: { K: 'kick', S: 'snare' }, steps: 'K...S...', repeat: 8 }],
    ['set_cells', { cells: [{ channel: 'P1', row: 3, note: 'C-5', inst: 0 }] }],
    ['clear_pattern', { channels: ['P1'] }],
    ['transpose', { semitones: 5 }],
    ['copy_pattern', { fromOrder: 0, toOrder: 1, semitones: 2 }],
    ['set_orders', { orders: [0, 1, 2], loop: 1 }],
    ['insert_order', {}],
    ['duplicate_order', { order: 0 }],
    ['delete_order', { order: 1 }],
    ['set_pattern_length', { length: 32 }],
    ['set_loop', { order: 1 }],
    ['set_song_info', { bpm: 99, key: 'D' }],
    ['update_channel', { channel: 'P1', muted: true }],
    ['add_instrument', { preset: 'pad' }],
    ['update_instrument', { instrument: 'lead', params: { macros: { vol: '8 6 4' } } }],
    ['delete_instrument', { instrument: 'lead', force: true }],
    ['new_song', { chip: 'gb' }]
  ]

  it.each(writes)('%s', async (name, args) => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead', channel: 'P1' })
    await t.ok('add_instrument', { preset: 'kick', channel: 'NO' })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead\n8 | E-5' })
    await t.ok('set_orders', { orders: [0, 1] })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | A-5 @lead', order: 1 })
    const before = snapshot(t.song)
    const depth = t.session.history.undoDepth
    await t.ok(name, args)
    expect(snapshot(t.song), `${name} changed nothing`).not.toBe(before)
    expect(t.session.history.undoDepth).toBe(depth + 1)
    t.session.undo()
    expect(snapshot(t.song)).toBe(before)
    t.session.redo()
    expect(snapshot(t.song)).not.toBe(before)
  })
})
