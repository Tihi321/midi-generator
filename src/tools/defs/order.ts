import { z } from 'zod'
import {
  type CellDiff,
  MAX_ORDERS,
  createCellsCommand,
  createPatternLengthCommand,
  createSetOrdersCommand,
  nextFreePattern,
  patternKey,
  rowsPerBar
} from '../../core'
import { defineTool } from '../registry'
import { describeOrderRow, obj, ok, pickOrder, plural, songSession } from '../util'

const orderRow = z.union([z.number().int().min(0).max(255), z.array(z.number().int().min(0).max(255))])

export const orderTools = [
  defineTool({
    name: 'set_orders',
    group: 'channels',
    description:
      'Set the whole order list (the song structure). Each entry is one order row: either ONE pattern number (every channel plays that pattern number) or an array with one pattern number per channel (see get_song for the channel order). Each channel has its own pool of patterns, so [0,0,1] means: orders 0 and 1 play pattern 0, order 2 plays pattern 1 (a new, empty pattern until you write to it). Reusing a number repeats the same music (and edits to it change every use). Optionally set the loop target. Example for intro + A + B + A: {"orders":[0,1,2,1],"loop":1}. Existing patterns are kept even if no longer used.',
    input: obj({
      orders: z.array(orderRow).min(1).max(MAX_ORDERS).describe('Order rows: a number (same pattern on all channels) or one number per channel.'),
      loop: z.number().int().min(0).nullable().optional().describe('Order row to loop back to (null = no loop). Omitted: keep the current loop (clamped).')
    }),
    handler: ({ orders, loop }, ctx) => {
      const session = songSession(ctx)
      const n = session.song.channels.length
      const rows = orders.map((r) => (typeof r === 'number' ? new Array<number>(n).fill(r) : r))
      session.execute(createSetOrdersCommand(session.song, rows, loop === undefined ? {} : { loop: loop === null ? null : { order: loop } }))
      const s = session.song
      const bars = (s.orders.length * s.patternLength) / rowsPerBar(s.timing)
      return ok(`Order list set: ${plural(s.orders.length, 'order row')} (${bars} bars). ${s.loop ? `Loops back to order ${s.loop.order}.` : 'No loop.'}\n${s.orders.map((_, o) => `  ${o}: ${describeOrderRow(s, o)}`).join('\n')}\nWrite to a row with write_pattern {order: N, ...}.`)
    }
  }),

  defineTool({
    name: 'insert_order',
    group: 'channels',
    description:
      'Insert one order row (a new section of patternLength rows). patterns: "new" (default) gives every channel a fresh empty pattern; a number or an array of numbers (one per channel) reuses existing patterns instead. at: position to insert at (default: at the end). The loop target moves along when you insert before it. Example: {"at":2,"patterns":"new"}.',
    input: obj({
      at: z.number().int().min(0).optional().describe('Order position to insert at (0..current length). Default: append.'),
      patterns: z.union([z.literal('new'), z.number().int().min(0).max(255), z.array(z.number().int().min(0).max(255))]).optional().describe('"new" (default), one number for all channels, or one number per channel.')
    }),
    handler: ({ at, patterns }, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      if (song.orders.length >= MAX_ORDERS) throw new Error(`The song already has the maximum of ${MAX_ORDERS} order rows.`)
      const pos = at ?? song.orders.length
      if (pos > song.orders.length) throw new Error(`Cannot insert at ${pos}: the song has ${song.orders.length} order row(s); use 0..${song.orders.length}.`)
      const n = song.channels.length
      let row: number[]
      if (patterns === undefined || patterns === 'new') row = song.channels.map((c) => nextFreePattern(song, c.id))
      else if (typeof patterns === 'number') row = new Array<number>(n).fill(patterns)
      else row = patterns
      const next = song.orders.map((r) => [...r])
      next.splice(pos, 0, row)
      const loop = song.loop ? { order: song.loop.order >= pos ? song.loop.order + 1 : song.loop.order } : null
      session.execute(createSetOrdersCommand(song, next, { loop }, 'Insert order'))
      return ok(`Inserted order ${pos}: ${describeOrderRow(song, pos)} (${plural(song.orders.length, 'order row')} now).${song.loop ? ` Loop target: order ${song.loop.order}.` : ''}`)
    }
  }),

  defineTool({
    name: 'delete_order',
    group: 'channels',
    description:
      'Remove one order row. The patterns it used stay stored (other rows may still use them). The last remaining row cannot be deleted. The loop target is adjusted. Example: {"order":3}.',
    input: obj({ order: z.number().int().min(0).describe('Order row to remove.') }),
    handler: ({ order }, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      pickOrder(session, order)
      if (song.orders.length <= 1) throw new Error('Cannot delete the only order row; use set_orders or clear_pattern instead.')
      const next = song.orders.filter((_, i) => i !== order).map((r) => [...r])
      let loop = song.loop ? { order: song.loop.order } : null
      if (loop) {
        if (loop.order > order) loop = { order: loop.order - 1 }
        loop = { order: Math.min(loop.order, next.length - 1) }
      }
      session.execute(createSetOrdersCommand(song, next, { loop }, 'Delete order'))
      return ok(`Deleted order ${order}. ${plural(song.orders.length, 'order row')} left.${song.loop ? ` Loop target: order ${song.loop.order}.` : ''}`)
    }
  }),

  defineTool({
    name: 'duplicate_order',
    group: 'channels',
    description:
      'Duplicate an order row, inserted after it (or at "at"). copyPatterns true (default) copies the music into NEW patterns so you can vary the copy (e.g. a second verse); false reuses the same patterns (edits then change both). Example: {"order":1,"copyPatterns":true}.',
    input: obj({
      order: z.number().int().min(0).describe('Order row to duplicate.'),
      at: z.number().int().min(0).optional().describe('Where the copy goes (default: right after the source).'),
      copyPatterns: z.boolean().optional().describe('Copy into new patterns (default true) or share the same patterns (false).')
    }),
    handler: ({ order, at, copyPatterns }, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      pickOrder(session, order)
      if (song.orders.length >= MAX_ORDERS) throw new Error(`The song already has the maximum of ${MAX_ORDERS} order rows.`)
      const pos = at ?? order + 1
      if (pos > song.orders.length) throw new Error(`Cannot insert the copy at ${pos}: use 0..${song.orders.length}.`)
      const src = song.orders[order]!
      let row: number[]
      const diffs: CellDiff[] = []
      if (copyPatterns === false) row = [...src]
      else {
        row = song.channels.map((c, ci) => {
          const fresh = nextFreePattern(song, c.id)
          const pat = song.patterns.get(patternKey(c.id, src[ci]!))
          pat?.rows.forEach((cell, r) => {
            if (cell) diffs.push({ channel: c.id, pattern: fresh, row: r, cell })
          })
          return fresh
        })
      }
      if (diffs.length > 0) session.execute(createCellsCommand(song, diffs, 'Duplicate order'))
      const next = song.orders.map((r) => [...r])
      next.splice(pos, 0, row)
      const loop = song.loop ? { order: song.loop.order >= pos ? song.loop.order + 1 : song.loop.order } : null
      session.execute(createSetOrdersCommand(song, next, { loop }, 'Duplicate order'))
      return ok(`Duplicated order ${order} to order ${pos}: ${describeOrderRow(song, pos)}${copyPatterns === false ? ' (shared patterns)' : ' (new patterns, independent of the source)'}.`)
    }
  }),

  defineTool({
    name: 'set_pattern_length',
    group: 'channels',
    description:
      'Change the number of rows of every pattern (1..256; default 64 = 4 bars at 4 rows per beat). Shrinking cuts rows off the end (the result tells you how many notes were lost; undo restores them). 16 rows = 1 bar, 32 = 2 bars, 64 = 4 bars. Example: {"length":32}.',
    input: obj({ length: z.number().int().min(1).max(256).describe('Rows per pattern.') }),
    handler: ({ length }, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      let lost = 0
      for (const pat of song.patterns.values()) for (let r = length; r < pat.rows.length; r++) if (pat.rows[r]) lost++
      session.execute(createPatternLengthCommand(song, length))
      const rpb = rowsPerBar(song.timing)
      return ok(`Pattern length is now ${length} rows (${length / rpb} bars of ${rpb} rows).${lost ? ` ${plural(lost, 'cell')} beyond the new end were removed (undo brings them back).` : ''}${length % rpb ? ' Note: not a whole number of bars.' : ''}`)
    }
  })
]

