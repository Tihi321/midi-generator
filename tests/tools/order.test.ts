import { describe, expect, it } from 'vitest'
import { resultText, songSetup } from './helpers'

describe('order tools', () => {
  it('set_orders accepts one number (all channels) or one number per channel, and sets the loop', async () => {
    const t = songSetup()
    const text = await t.text('set_orders', { orders: [0, [1, 1, 2, 3], 1], loop: 1 })
    expect(t.song.orders).toEqual([[0, 0, 0, 0], [1, 1, 2, 3], [1, 1, 1, 1]])
    expect(t.song.loop).toEqual({ order: 1 })
    expect(text).toContain('3 order rows')
    expect(text).toContain('1: P1:1 P2:1 TR:2 NO:3')
    expect(t.session.history.undoDepth).toBe(1)
    t.session.undo()
    expect(t.song.orders).toEqual([[0, 0, 0, 0]])
    expect(t.song.loop).toEqual({ order: 0 })
  })

  it('set_orders errors tell how many channels there are', async () => {
    const t = songSetup()
    const r = await t.call('set_orders', { orders: [[0, 1]] })
    expect(r.isError).toBe(true)
    expect(resultText(r)).toMatch(/Order row 0 has 2 entries but the song has 4 channels \(P1, P2, TR, NO\)/)
    expect(resultText(await t.call('set_orders', { orders: [0], loop: 3 }))).toMatch(/Loop order 3 is outside 0\.\.0/)
    expect(resultText(await t.call('set_orders', { orders: [] }))).toMatch(/Invalid arguments/)
    expect(t.song.orders).toHaveLength(1)
  })

  it('insert_order adds a section with fresh patterns and moves the loop target', async () => {
    const t = songSetup()
    await t.ok('set_orders', { orders: [0, 1], loop: 1 })
    await t.ok('insert_order', { at: 1 })
    expect(t.song.orders).toEqual([[0, 0, 0, 0], [2, 2, 2, 2], [1, 1, 1, 1]])
    expect(t.song.loop).toEqual({ order: 2 })
    await t.ok('insert_order', { patterns: 5 })
    expect(t.song.orders[3]).toEqual([5, 5, 5, 5])
    await t.ok('insert_order', { patterns: [0, 1, 2, 3], at: 0 })
    expect(t.song.orders[0]).toEqual([0, 1, 2, 3])
    expect(resultText(await t.call('insert_order', { at: 99 }))).toMatch(/Cannot insert at 99/)
  })

  it('delete_order removes a row, keeps the last one and fixes the loop', async () => {
    const t = songSetup()
    await t.ok('set_orders', { orders: [0, 1, 2], loop: 2 })
    await t.ok('delete_order', { order: 0 })
    expect(t.song.orders).toEqual([[1, 1, 1, 1], [2, 2, 2, 2]])
    expect(t.song.loop).toEqual({ order: 1 })
    await t.ok('delete_order', { order: 1 })
    expect(t.song.loop).toEqual({ order: 0 })
    const r = await t.call('delete_order', { order: 0 })
    expect(resultText(r)).toMatch(/Cannot delete the only order row/)
    expect(resultText(await t.call('delete_order', { order: 5 }))).toMatch(/Order 5 not found/)
  })

  it('duplicate_order copies the music into new patterns (or shares them)', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead' })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead\n4 | E-5' })
    await t.ok('duplicate_order', { order: 0 })
    expect(t.song.orders).toEqual([[0, 0, 0, 0], [1, 1, 1, 1]])
    expect(t.song.patterns.get('P1:1')!.rows[4]).toMatchObject({ note: 76 })
    // independent copy
    await t.ok('write_pattern', { text: 'channels: P1\n4 | G-5', order: 1 })
    expect(t.song.patterns.get('P1:0')!.rows[4]).toMatchObject({ note: 76 })
    expect(t.song.patterns.get('P1:1')!.rows[4]).toMatchObject({ note: 79 })
    await t.ok('duplicate_order', { order: 0, copyPatterns: false, at: 2 })
    expect(t.song.orders[2]).toEqual([0, 0, 0, 0])
    expect(t.session.history.undoDepth).toBe(5)
    const before = t.session.history.undoDepth
    await t.ok('duplicate_order', { order: 1 })
    expect(t.session.history.undoDepth).toBe(before + 1) // cells + orders in ONE step
    t.session.undo()
    expect(t.song.orders).toHaveLength(3)
    expect(t.song.patterns.has('P1:3')).toBe(false)
  })

  it('set_pattern_length resizes patterns and reports what was cut', async () => {
    const t = songSetup()
    await t.ok('add_instrument', { preset: 'lead' })
    await t.ok('write_pattern', { text: 'channels: P1\n0 | C-5 @lead\n40 | E-5' })
    const text = await t.text('set_pattern_length', { length: 32 })
    expect(text).toContain('Pattern length is now 32 rows (2 bars of 16 rows)')
    expect(text).toContain('1 cell beyond the new end were removed')
    expect(t.song.patternLength).toBe(32)
    expect(t.song.patterns.get('P1:0')!.rows).toHaveLength(32)
    t.session.undo()
    expect(t.song.patternLength).toBe(64)
    expect(t.song.patterns.get('P1:0')!.rows[40]).toMatchObject({ note: 76 })
    expect(await t.text('set_pattern_length', { length: 24 })).toMatch(/not a whole number of bars/)
  })
})
