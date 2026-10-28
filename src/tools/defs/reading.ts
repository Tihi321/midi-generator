import { z } from 'zod'
import { analyzeSong, formatDrumText, formatIssues, formatMelodyText, formatTrackerText, requireChannelIndex, rowsPerBar } from '../../core'
import { defineTool, imageResult } from '../registry'
import { renderPianoRoll } from '../render'
import { CHANNEL_DESC, MANY_CHANNELS, ORDER_DESC, channelRef, describeOrderRow, obj, ok, pickChannels, pickOrder, plural, songSession } from '../util'

export const readingTools = [
  defineTool({
    name: 'read_pattern',
    group: 'reading',
    readOnly: true,
    description:
      'Read music back as text, in exactly the formats the write tools take. format "tracker" (default): all (or the listed) channels of an order row as tracker text, ready for write_pattern. "melody": ONE channel as a melody string for write_melody (orders: how many consecutive order rows to read). "drums": one channel as {legend, steps} for write_drums. Use it to inspect, then change a few rows and write them back. Example: {"order":1,"channels":["P1","TR"],"fromRow":0,"toRow":32} or {"format":"melody","channel":"P1","orders":2}.',
    input: obj({
      format: z.enum(['tracker', 'melody', 'drums']).optional().describe('"tracker" (default), "melody" or "drums".'),
      order: z.number().int().min(0).optional().describe(ORDER_DESC),
      pattern: z.number().int().min(0).max(255).optional().describe('Read this pattern number instead of the order row\'s.'),
      channels: z.array(channelRef).optional().describe('tracker: channels to include (default all; on songs with more than 16 channels, PS1 24 voices and Dreamcast 32 / 64, the default is the channels that have notes in this pattern).'),
      channel: channelRef.optional().describe(`melody/drums: the channel. ${CHANNEL_DESC} Default: the cursor's channel.`),
      orders: z.number().int().min(1).max(32).optional().describe('melody: number of consecutive order rows to read (default 1).'),
      fromRow: z.number().int().min(0).optional().describe('First row (default 0).'),
      toRow: z.number().int().min(1).optional().describe('One past the last row (default: pattern end).'),
      sparse: z.boolean().optional().describe('tracker: leave out rows where every listed channel is empty (default false).')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const format = args.format ?? 'tracker'
      const order = pickOrder(session, args.order)
      const range = { fromRow: args.fromRow, toRow: args.toRow }
      if (format === 'tracker') {
        let idxs = pickChannels(song, args.channels)
        let note = ''
        if (!args.channels?.length && song.channels.length > MANY_CHANNELS) {
          // 24 to 64 voices: reading every column would be mostly empty cells (and very long), so read the ones with notes
          const hasNotes = (i: number): boolean => {
            const n = args.pattern ?? song.orders[order]![i]!
            return song.patterns.get(`${song.channels[i]!.id}:${n}`)?.rows.some((c) => c !== null && c !== undefined) ?? false
          }
          const used = idxs.filter(hasNotes)
          const keep = used.length > 0 ? used : idxs.slice(0, MANY_CHANNELS)
          if (keep.length < song.channels.length) note = ` Only ${keep === used ? 'the channels that have notes' : 'the first 16 channels (all are empty)'} are shown (${keep.length} of ${song.channels.length}); pass "channels" to read others.`
          idxs = keep
        }
        const patterns = args.pattern !== undefined ? Object.fromEntries(idxs.map((i) => [song.channels[i]!.id, args.pattern!])) : undefined
        const text = formatTrackerText(song, { order, channels: idxs, patterns, sparse: args.sparse, ...range })
        return ok(`Order ${order}${args.pattern !== undefined ? `, pattern ${args.pattern}` : ` (${describeOrderRow(song, order)})`}; pass this text to write_pattern to write it back:${note}\n${text}`)
      }
      const ci = args.channel === undefined ? session.cursor.channel : requireChannelIndex(song, args.channel)
      const ch = song.channels[ci]!
      if (format === 'melody') {
        const text = formatMelodyText(song, ci, { order, orders: args.orders, pattern: args.pattern, ...range })
        return ok(`Melody of ${ch.id} from order ${order}${args.orders && args.orders > 1 ? ` (${args.orders} order rows)` : ''}, for write_melody:\n${text}`)
      }
      const spec = formatDrumText(song, ci, { order, pattern: args.pattern, ...range })
      return ok(`Drums of ${ch.id} at order ${order}, for write_drums (steps use one character per row):\n${JSON.stringify(spec)}`)
    }
  }),

  defineTool({
    name: 'render_preview',
    group: 'reading',
    readOnly: true,
    description:
      'Render a PIANO-ROLL IMAGE of the song so you can look at it: time runs left to right (bright vertical lines = order rows, medium = bars, faint = beats; numbers at the top are order/bar numbers), pitch runs bottom to top with octave numbers at the C lines, every channel has its own colour (listed in the text reply), arpeggio tones are drawn dimmer, drums are small ticks in lanes at the bottom. Returns the image plus a text summary. Options: show only some order rows (fromOrder..toOrder) or channels, and chipRange to shade notes a single channel cannot play on its chip. Call it after writing to check rhythm, range and structure.',
    input: obj({
      fromOrder: z.number().int().min(0).optional().describe('First order row shown (default 0).'),
      toOrder: z.number().int().min(0).optional().describe('Last order row shown, inclusive (default: as many as fit, up to the end).'),
      channels: z.array(channelRef).optional().describe('Only these channels (default all).'),
      chipRange: z.boolean().optional().describe('With ONE channel selected: shade the notes outside that channel\'s chip range.')
    }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      const idxs = args.channels ? pickChannels(song, args.channels) : undefined
      const to = args.toOrder === undefined ? undefined : Math.min(args.toOrder, song.orders.length - 1)
      if (args.fromOrder !== undefined && args.fromOrder >= song.orders.length) {
        throw new Error(`fromOrder ${args.fromOrder} is outside the song: use 0..${song.orders.length - 1}.`)
      }
      const r = renderPianoRoll(song, { fromOrder: args.fromOrder, toOrder: to, channels: idxs?.map((i) => song.channels[i]!.id), chipRange: args.chipRange })
      const rpbar = rowsPerBar(song.timing)
      const lines = [
        `Piano roll of order rows ${r.fromOrder}..${r.toOrder} (${plural(r.rows, 'row')}, ${r.rows / rpbar} bars), ${r.width}x${r.height} px, ${r.pxPerRow}px per row.${r.truncated ? ` The image was cut at order ${r.toOrder}; pass fromOrder/toOrder to see the rest.` : ''}`,
        'Channels: ' + r.legend.map((l) => `${l.channel}=${l.color} (${l.notes ? plural(l.notes, 'note') : ''}${l.notes && l.drums ? ', ' : ''}${l.drums ? plural(l.drums, 'drum hit') : ''}${!l.notes && !l.drums ? 'empty' : ''})`).join(', ') + '.'
      ]
      if (r.legend.every((l) => l.notes === 0 && l.drums === 0)) lines.push('The song is empty in this range.')
      return imageResult(r.base64, lines.join('\n'))
    }
  }),

  defineTool({
    name: 'analyze_song',
    group: 'reading',
    readOnly: true,
    description:
      'Music-theory and chip-rule report of the whole song: detected key vs the declared key, chord per bar (with Roman numerals), harmonic clashes between channels (minor seconds), notes outside the declared scale, per-channel range/density, and EVERY chip-rule violation (range, instrument kind, effects, budgets), plus short hints. Run it after composing, fix what it lists, and check the declared key (set_song_info) if the detected key differs.',
    input: obj({
      maxClashes: z.number().int().min(1).max(100).optional().describe('How many clashes to list (default 10).'),
      skipChip: z.boolean().optional().describe('Skip the chip-rule section.')
    }),
    handler: (args, ctx) => {
      const song = songSession(ctx).song
      const a = analyzeSong(song, { maxClashes: args.maxClashes ?? 10, skipChip: args.skipChip })
      const out: string[] = []
      out.push(`Analysis of "${song.name}": ${a.rows} rows, ${a.bars} bars.`)
      out.push(`Declared key: ${a.declared.key} ${a.declared.scale}.${a.detected.length ? ` Detected: ${a.detected.slice(0, 3).map((k) => `${k.key} ${k.mode} (${k.correlation.toFixed(2)})`).join(', ')}${a.keyAgrees ? ' (agrees)' : ' (differs: fix the notes or call set_song_info)'}.` : ' No pitched notes yet.'}`)
      const chords = a.chords.filter((c) => c.name)
      if (chords.length) {
        out.push('Chords per bar: ' + chords.map((c) => `${c.bar + 1}:${c.name}${c.roman ? `(${c.roman})` : ''}${c.confidence < 0.6 ? '?' : ''}`).join(' '))
      }
      out.push('Channels:')
      for (const c of a.channels) {
        out.push(`  ${c.id}${c.percussion ? ' (drums)' : ''}: ${c.notes} notes${c.notes ? `, ${c.distinctNotes} distinct, ${c.lowest}..${c.highest}, ${c.density.toFixed(1)} notes/bar, active ${(c.activity * 100).toFixed(0)}% of rows` : ''}`)
      }
      if (a.clashTotal > 0) {
        out.push(`Clashes (${a.clashTotal}):`)
        for (const c of a.clashes) out.push(`  order ${c.order} row ${c.row} (${c.rows} rows): ${c.message}`)
      }
      if (a.outOfScaleTotal > 0) {
        out.push(`Notes outside ${a.declared.key} ${a.declared.scale} (${a.outOfScaleTotal}):`)
        for (const g of a.outOfScale) out.push(`  ${g.channel}: ${g.count}x ${g.notes.join(' ')} (first at order ${g.first.order} row ${g.first.row}: ${g.first.note})`)
      }
      if (!args.skipChip) out.push(a.chipIssues.length ? `Chip issues (${a.chipIssues.length}):\n${formatIssues(a.chipIssues)}` : `Chip rules: no violations for ${song.chip.toUpperCase()}.`)
      if (a.hints.length) out.push('Hints:\n' + a.hints.map((h) => `  - ${h}`).join('\n'))
      return ok(out.join('\n'))
    }
  })
]
