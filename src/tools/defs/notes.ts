import { z } from 'zod'
import {
  type Cell,
  type CellDiff,
  type DrumSpec,
  type Effect,
  type Song,
  cloneCell,
  drumToDiffs,
  findInstrumentIndex,
  formatNote,
  instrumentSlug,
  isDrumRole,
  melodyToDiffs,
  parseDrumText,
  parseEffectToken,
  parseMelodyText,
  parseNote,
  parseRole,
  parseTrackerText,
  patternKey,
  requireChannelIndex,
  requireInstrumentIndex,
  resolvePreset,
  ROLE_CHANNELS,
  songChannelDefs,
  transposeDiatonic,
  trackerToDiffs
} from '../../core'
import { defineTool } from '../registry'
import { addInstrumentWithSample, applyDiffs, clearDiffs, formatWarnings } from '../editing'
import { CHANNEL_DESC, ORDER_DESC, channelRef, obj, ok, otherUsers, pickChannel, pickChannels, pickOrder, plural, songSession } from '../util'

const mergeReplace = z.enum(['merge', 'replace'])

/** "P1:0 shares pattern 0 with order 2" style notes: editing a shared pattern changes every order that uses it. */
function sharedNotes(song: Song, channelIds: string[], order: number): string {
  const lines: string[] = []
  for (const id of channelIds) {
    const ci = song.channels.findIndex((c) => c.id === id)
    const pat = song.orders[order]?.[ci]
    if (pat === undefined) continue
    const users = otherUsers(song, ci, pat, order)
    if (users.length > 0) lines.push(`${id} pattern ${pat} is also used by order${users.length > 1 ? 's' : ''} ${users.join(', ')} (edits change those too; set_orders gives a section its own pattern numbers)`)
  }
  return lines.length ? `\nNote: ${lines.join('; ')}.` : ''
}

/**
 * Default drum channel on the sample chips with a V1..Vn layout (ps1, dreamcast): the first ROLE_CHANNELS entry of the legend's
 * role when it names one drum role (kick V13, tom V12, ...), V14 for mixed or unknown roles.
 */
function sampleDrumChannel(song: Song, legend: Record<string, string>): number {
  const table = ROLE_CHANNELS[song.chip]
  const roles = new Set<string>()
  for (const value of Object.values(legend)) {
    for (const tok of value.trim().split(/\s+/)) {
      const role = tok.startsWith('@') ? song.instruments[findInstrumentIndex(song, tok)]?.role : parseRole(tok)
      const id = role && isDrumRole(role) ? table[role]?.[0] : undefined
      if (id !== undefined) roles.add(id)
    }
  }
  const id = roles.size === 1 ? [...roles][0] : 'V14'
  const ci = song.channels.findIndex((c) => c.id === id)
  return ci >= 0 ? ci : song.channels.length - 1
}

function patternList(song: Song, channelIds: string[], order: number): string {
  return channelIds.map((id) => `${id}:${song.orders[order]?.[song.channels.findIndex((c) => c.id === id)]}`).join(' ')
}

function noInstrumentHint(song: Song): string {
  return song.instruments.length === 0 ? '\nHint: the song has no instruments; notes use the channel default sound. add_instrument first for real timbres.' : ''
}

function rowRange(rows: number[]): string {
  if (rows.length === 0) return 'no rows'
  return `rows ${Math.min(...rows)}..${Math.max(...rows)}`
}

// ---------------------------------------------------------------- set_cells input

const fxArg = z.union([
  z.string().min(3).max(3).describe('Three characters: effect code + two hex digits, e.g. "047" (arpeggio), "W02".'),
  obj({ code: z.string().length(1), param: z.number().int().min(0).max(255) })
])

const cellArg = obj({
  channel: channelRef.describe(CHANNEL_DESC),
  row: z.number().int().min(0).max(255).describe('Row within the pattern (0-based).'),
  order: z.number().int().min(0).optional().describe('Order row (default: the call\'s order).'),
  pattern: z.number().int().min(0).max(255).optional().describe('Write to this pattern number of the channel instead of an order row.'),
  note: z.union([z.number().int().min(0).max(127), z.string()]).optional().describe('MIDI number, a note name ("C-4", "F#3", "Db5"), "off" (===) or "rel" (^^^).'),
  inst: z.union([z.number().int().min(0), z.string()]).optional().describe('Instrument index or name.'),
  vol: z.number().int().min(0).max(15).optional().describe('Volume 0..15.'),
  fx: z.array(fxArg).max(4).optional().describe('Effects, e.g. ["047","W02"].'),
  clear: z.boolean().optional().describe('true: empty this row (ignores the other fields).')
})

function toCell(song: Song, c: z.output<typeof cellArg>, where: string): Cell | null {
  if (c.clear) return null
  const cell: Cell = {}
  if (c.note !== undefined) {
    if (typeof c.note === 'number') cell.note = c.note
    else {
      const t = c.note.trim()
      const l = t.toLowerCase()
      if (t === '===' || l === 'off') cell.note = 'off'
      else if (t === '^^^' || l === 'rel') cell.note = 'rel'
      else {
        const n = parseNote(t)
        if (n === null) throw new Error(`${where}: "${c.note}" is not a note. Use C-4, C#4, Db4, "off" or "rel", or a MIDI number.`)
        cell.note = n
      }
    }
  }
  if (c.inst !== undefined) cell.inst = requireInstrumentIndex(song, c.inst)
  if (c.vol !== undefined) cell.vol = c.vol
  if (c.fx) {
    const fx: Effect[] = c.fx.map((f) => {
      if (typeof f === 'string') {
        const e = parseEffectToken(f)
        if (!e) throw new Error(`${where}: "${f}" is not an effect. Use three characters: code + two hex digits, e.g. "047", "4A2", "W02".`)
        return e
      }
      const code = f.code.toUpperCase()
      return { code: code as Effect['code'], param: f.param }
    })
    cell.fx = fx
  }
  return Object.keys(cell).length ? cell : null
}

/** Channel indices whose cells transpose/copy-transpose should skip (noise/percussion). */
function isPitched(song: Song, ci: number): boolean {
  const k = song.channels[ci]!.kind
  return k !== 'noise' && k !== 'psg-noise' && k !== 'dpcm'
}

function shiftNote(song: Song, note: number, args: { semitones?: number; degrees?: number }, where: string): number {
  const n = args.degrees !== undefined ? transposeDiatonic(note, args.degrees, song.meta.key, song.meta.scale) : note + (args.semitones ?? 0)
  if (n < 0 || n > 127) throw new Error(`${where}: ${formatNote(note)} would become MIDI ${n}, outside 0..127.`)
  return n
}

function transposeCell(song: Song, cell: Cell, args: { semitones?: number; degrees?: number }, where: string): Cell {
  const out = cloneCell(cell)
  if (typeof out.note === 'number') out.note = shiftNote(song, out.note, args, where)
  return out
}

function checkShift(args: { semitones?: number; degrees?: number }): void {
  if ((args.semitones === undefined) === (args.degrees === undefined)) {
    throw new Error('Pass exactly one of "semitones" (chromatic shift, e.g. 12 = up an octave) or "degrees" (diatonic scale steps in the song key, e.g. 2 = up a third).')
  }
}

const shiftDesc = {
  semitones: z.number().int().min(-60).max(60).optional().describe('Chromatic shift in semitones (12 = one octave up).'),
  degrees: z.number().int().min(-28).max(28).optional().describe('Diatonic shift in scale steps of the song key/scale (e.g. 2 = a third up, -7 = an octave down in a 7-note scale).')
}

export const noteTools = [
  defineTool({
    name: 'write_pattern',
    group: 'notes',
    description:
      'Write notes with TRACKER TEXT (the main writing tool; up to 64 rows per call). Lines are rows; channels are separated by "|"; the first line can name the channels. A cell holds tokens in any order: a note (C-4, C#4, Db4), === note off, ^^^ release, @instrument (@lead or @3), vNN volume 0-15, and three-character effects like 047 (arpeggio), 4A2 (vibrato), W02 (timbre/duty). "." is an empty cell. Row numbers are optional (rows count from 0). Example:\n' +
      'channels: P1 | TR | NO\n 0 | E-5 @lead v12 | A-2 @bass | C-4 @kick\n 4 | G-5 | . | C-4 @snare\n 8 | A-5 4A2 | ===\n' +
      'Writes to the patterns the order row plays (default: the cursor\'s order row). mode "merge" (default) only touches the cells you list; "replace" first clears the listed channels\' patterns. One note per cell: chords on one channel are arpeggios (047). Errors list every problem with line, channel and fix.',
    input: obj({
      text: z.string().min(1).describe('Tracker text, see the tool description.'),
      order: z.number().int().min(0).optional().describe(ORDER_DESC),
      pattern: z.number().int().min(0).max(255).optional().describe('Write to this pattern number of the listed channels instead of an order row.'),
      mode: mergeReplace.optional().describe('"merge" (default) or "replace" (clear the listed channels\' patterns first).')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const parsed = parseTrackerText(args.text, song)
      const order = args.pattern === undefined ? pickOrder(session, args.order) : undefined
      const diffs = trackerToDiffs(song, parsed, args.pattern !== undefined ? { pattern: args.pattern } : { order }, args.mode ?? 'merge')
      const rep = applyDiffs(session, diffs, 'Write pattern')
      const rows = parsed.rows.map((r) => r.row)
      const where = order !== undefined ? `order ${order} (${patternList(song, parsed.channels, order)})` : `pattern ${args.pattern}`
      return ok(
        `Wrote ${plural(rep.written, 'cell')} (${rep.changed} changed) to ${where} on ${parsed.channels.join(', ')}, ${rowRange(rows)}.` +
          formatWarnings(rep.warnings) +
          (order !== undefined ? sharedNotes(song, parsed.channels, order) : '') +
          noInstrumentHint(song) +
          '\nHint: render_preview or read_pattern shows the result; analyze_song checks it.'
      )
    }
  }),

  defineTool({
    name: 'write_melody',
    group: 'notes',
    description:
      'Write ONE channel as a compact melody string; lengths are in rows. Tokens: note names (E5 F#5 Db4; C-4 style works), :N length in rows (default 1), r or === rest/note off, ^^^ release, ~:N tie (hold the previous note N more rows), @lead instrument and vN volume (apply to the following notes), {A4 C5 E5}:8 a chord (on a one-voice chip it becomes the lowest note plus an arpeggio 0xy), !4A2 effect on that note. Example: "@lead v12 E5:2 G5:2 A5:4 r:2 G5 F#5 E5:4 ~:4 {A4 C5 E5}:8 D5:4!4A2". Starts at startRow (default 0) of the order row\'s pattern. wrap:true continues into the following order rows (they must exist). clear:true empties the channel\'s pattern first. 16 rows = 1 bar at the default timing.',
    input: obj({
      melody: z.string().min(1).describe('The melody string.'),
      channel: channelRef.optional().describe(`${CHANNEL_DESC} Default: the cursor's channel.`),
      order: z.number().int().min(0).optional().describe(ORDER_DESC),
      startRow: z.number().int().min(0).optional().describe('Row of the first note within the pattern (default 0).'),
      wrap: z.boolean().optional().describe('Continue into the next order rows when the melody is longer than the pattern.'),
      defaultLength: z.number().int().min(1).max(64).optional().describe('Length in rows of notes without ":N" (default 1).'),
      clear: z.boolean().optional().describe('Empty the channel\'s pattern(s) before writing (default false: merge).')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const ci = pickChannel(session, args.channel)
      const order = pickOrder(session, args.order)
      const parsed = parseMelodyText(args.melody, song, ci, { startRow: args.startRow, wrap: args.wrap, defaultLength: args.defaultLength })
      const diffs: CellDiff[] = []
      if (args.clear) {
        for (let k = 0; k < parsed.orderSpan; k++) {
          const pat = song.orders[order + k]?.[ci]
          if (pat !== undefined) diffs.push(...clearDiffs(song, parsed.channel, pat))
        }
      }
      diffs.push(...melodyToDiffs(song, parsed, order))
      const rep = applyDiffs(session, diffs, 'Write melody')
      const notes = parsed.placements.filter((p) => typeof p.cell.note === 'number').length
      const last = Math.max(0, ...parsed.placements.map((p) => p.orderOffset * song.patternLength + p.row))
      return ok(
        `Wrote ${plural(notes, 'note')} (${rep.changed} cells changed) to ${parsed.channel} at order ${order}; the melody spans ${parsed.totalRows} rows${parsed.orderSpan > 1 ? ` over ${parsed.orderSpan} order rows` : ''} (last event at row ${last}).` +
          (parsed.warnings.length ? `\nMelody notes: ${parsed.warnings.join('; ')}` : '') +
          formatWarnings(rep.warnings) +
          sharedNotes(song, [parsed.channel], order) +
          noInstrumentHint(song)
      )
    }
  }),

  defineTool({
    name: 'write_drums',
    group: 'notes',
    description:
      'Write a drum pattern as steps: one character per row, "." = rest. The legend maps characters to drum sounds: an instrument ("@kick"), or a ROLE (kick, snare, hihat/hat, openhat, crash, tom, clap) for which the right chip preset is ADDED AUTOMATICALLY if the song has none (the result says what was added). A legend value may add a note (C-4) and volume (v8). "repeat" repeats the whole steps string (16 steps x repeat 4 = one 64-row pattern). Default channel: the noise channel (PC Engine: C6; SNES: V8; PS1/Dreamcast: the voice of the drum role, kick V13, snare V14, hat V15, mixed V14). Example: {"legend":{"K":"kick","S":"snare","h":"hat v8"},"steps":"K.h.S.h.K.KhS.h.","repeat":4}. For ready-made grooves see get_drum_pattern. The noise channel plays one hit per row (priority: crash > snare > kick > hat in a combined string).',
    input: obj({
      legend: z.record(z.string().min(1), z.string().min(1)).describe('Step character -> "@instrument" | role | "off", optionally with a note (C-4) and a volume (v8).'),
      steps: z.string().min(1).describe('Step string, one character per row ("." rest). Spaces and "|" are ignored for grouping.'),
      channel: channelRef.optional().describe(`${CHANNEL_DESC} Default: the noise channel (PC Engine: C6; SNES: V8).`),
      repeat: z.number().int().min(1).max(256).optional().describe('Times the steps repeat (default 1).'),
      startRow: z.number().int().min(0).optional().describe('First row in the pattern (default 0).'),
      rowsPerStep: z.number().int().min(1).max(16).optional().describe('Rows per step character (default 1).'),
      order: z.number().int().min(0).optional().describe(ORDER_DESC),
      wrap: z.boolean().optional().describe('Continue into the next order rows when the steps run past the pattern end.'),
      clear: z.boolean().optional().describe('Empty the channel\'s pattern(s) first (default false: merge).')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const defs = songChannelDefs(song)
      let ci: number
      if (args.channel !== undefined) ci = requireChannelIndex(song, args.channel)
      else {
        ci = defs.findIndex((d) => d.noise || d.kind === 'noise' || d.kind === 'psg-noise')
        // PC Engine drums live on C6 (noise-capable); SNES drums are samples, conventionally on the last voice.
        if (ci < 0 && (song.chip === 'pce' || song.chip === 'snes')) ci = song.channels.length - 1
        // PS1 and Dreamcast: the drum role's own voice (kick V13, snare V14, ...), V14 for a mixed legend.
        if (ci < 0 && (song.chip === 'ps1' || song.chip === 'dreamcast')) ci = sampleDrumChannel(song, args.legend)
        if (ci < 0) throw new Error(`This chip has no noise channel; pass "channel" (${song.channels.map((c) => c.id).join(', ')}).`)
      }
      const channel = song.channels[ci]!
      const order = pickOrder(session, args.order)
      const spec: DrumSpec = { channel: channel.id, legend: args.legend, steps: args.steps, repeat: args.repeat, startRow: args.startRow, rowsPerStep: args.rowsPerStep }
      let parsed = parseDrumText(spec, song, { wrap: args.wrap })
      const added: string[] = []
      if (parsed.needs.length > 0) {
        const kind = defs[ci]?.kind
        const roles = [...new Set(parsed.needs.map((n) => n.role))]
        for (const role of roles) {
          const inst = resolvePreset(song.chip, role, kind)
          const taken = (name: string): boolean => song.instruments.some((x) => instrumentSlug(x.name) === instrumentSlug(name))
          let name = inst.name
          if (taken(name)) name = `${inst.name}-${channel.id.toLowerCase()}`
          for (let n = 2; taken(name); n++) name = `${inst.name}-${channel.id.toLowerCase()}${n}`
          inst.name = name
          const res = addInstrumentWithSample(session, inst)
          added.push(`@${res.index} ${name} (${inst.kind}, preset ${inst.presetId ?? role})${res.sampleAdded ? ` + sample "${res.sampleAdded}"` : ''}`)
        }
        parsed = parseDrumText(spec, song, { wrap: args.wrap })
      }
      const diffs: CellDiff[] = []
      if (args.clear) {
        for (let k = 0; k < parsed.orderSpan; k++) {
          const pat = song.orders[order + k]?.[ci]
          if (pat !== undefined) diffs.push(...clearDiffs(song, channel.id, pat))
        }
      }
      diffs.push(...drumToDiffs(song, parsed, order))
      const rep = applyDiffs(session, diffs, 'Write drums')
      const hits = parsed.placements.length
      const stepCount = Array.from(args.steps).filter((c) => !/\s/.test(c) && c !== '|').length
      const covered = parsed.totalRows
      return ok(
        `Wrote ${plural(hits, 'drum hit')} (${rep.changed} cells changed) to ${channel.id} at order ${order}, covering ${covered} of ${song.patternLength} rows.` +
          (added.length ? `\nAdded instruments for the roles: ${added.join('; ')}.` : '') +
          (covered < song.patternLength && !args.wrap && (args.repeat ?? 1) === 1 ? `\nHint: the ${stepCount} steps fill only part of the ${song.patternLength}-row pattern; pass "repeat": ${Math.floor((song.patternLength - (args.startRow ?? 0)) / Math.max(1, stepCount * (args.rowsPerStep ?? 1)))} to fill it.` : '') +
          formatWarnings(rep.warnings) +
          sharedNotes(song, [channel.id], order)
      )
    }
  }),

  defineTool({
    name: 'set_cells',
    group: 'notes',
    description:
      'Edit individual cells (touch-ups; up to 256 per call). Each entry replaces the WHOLE cell at (channel, row) of the order row\'s pattern: give note (MIDI number, "C-4", "off", "rel"), inst (index or name), vol (0-15) and fx (["047"]); clear:true empties it. Use write_pattern for blocks of music. Example: {"cells":[{"channel":"P1","row":8,"note":"G-5","inst":"lead","vol":12},{"channel":"NO","row":12,"clear":true}],"order":1}.',
    input: obj({
      cells: z.array(cellArg).min(1).max(256).describe('Cells to set.'),
      order: z.number().int().min(0).optional().describe(`${ORDER_DESC} Per-cell "order"/"pattern" override it.`)
    }),
    handler: ({ cells, order }, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const defaultOrder = pickOrder(session, order)
      const diffs: CellDiff[] = cells.map((c, i) => {
        const ci = requireChannelIndex(song, c.channel)
        const ch = song.channels[ci]!
        let pattern: number
        if (c.pattern !== undefined) pattern = c.pattern
        else {
          const o = pickOrder(session, c.order ?? defaultOrder)
          pattern = song.orders[o]![ci]!
        }
        return { channel: ch.id, pattern, row: c.row, cell: toCell(song, c, `cells[${i}] (${ch.id} row ${c.row})`) }
      })
      const rep = applyDiffs(session, diffs, 'Set cells')
      const cleared = diffs.filter((d) => !d.cell).length
      return ok(`Set ${plural(diffs.length - cleared, 'cell')}${cleared ? ` and cleared ${cleared}` : ''} (${rep.changed} changed).` + formatWarnings(rep.warnings) + noInstrumentHint(song))
    }
  }),

  defineTool({
    name: 'clear_pattern',
    group: 'notes',
    description:
      'Empty patterns: the patterns an order row plays (or an explicit pattern number) on the listed channels (default all), optionally only rows fromRow..toRow-1. Example: {"order":2,"channels":["P1","P2"]} or {"order":0,"fromRow":32}.',
    input: obj({
      order: z.number().int().min(0).optional().describe(ORDER_DESC),
      pattern: z.number().int().min(0).max(255).optional().describe('Clear this pattern number on the listed channels instead of an order row.'),
      channels: z.array(channelRef).optional().describe('Channels to clear (default: all).'),
      fromRow: z.number().int().min(0).optional().describe('First row to clear (default 0).'),
      toRow: z.number().int().min(1).optional().describe('One past the last row to clear (default: pattern end).')
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const idxs = pickChannels(song, args.channels)
      const order = args.pattern === undefined ? pickOrder(session, args.order) : undefined
      const diffs: CellDiff[] = []
      for (const ci of idxs) {
        const ch = song.channels[ci]!
        const pat = args.pattern ?? song.orders[order!]![ci]!
        diffs.push(...clearDiffs(song, ch.id, pat, args.fromRow, args.toRow))
      }
      const rep = applyDiffs(session, diffs, 'Clear pattern')
      const ids = idxs.map((i) => song.channels[i]!.id)
      return ok(`Cleared ${plural(rep.changed, 'cell')} on ${ids.join(', ')} ${order !== undefined ? `at order ${order}` : `in pattern ${args.pattern}`}${rep.changed === 0 ? ' (they were already empty)' : ''}.` + (order !== undefined ? sharedNotes(song, ids, order) : ''))
    }
  }),

  defineTool({
    name: 'copy_pattern',
    group: 'notes',
    description:
      'Copy the music of one order row to another (the destination patterns are overwritten unless mode "merge"), optionally transposed: semitones (chromatic) or degrees (diatonic steps in the song key). Noise/drum channels are copied without transposing. Both order rows must exist and use different pattern numbers per channel (use duplicate_order to make a new row). Example: {"fromOrder":1,"toOrder":3,"degrees":2} copies section 1 into order 3 a third higher; {"fromOrder":0,"toOrder":2,"channels":["P1"],"semitones":12} copies only P1 an octave up.',
    input: obj({
      fromOrder: z.number().int().min(0).describe('Source order row.'),
      toOrder: z.number().int().min(0).describe('Destination order row.'),
      channels: z.array(channelRef).optional().describe('Channels to copy (default: all).'),
      fromRow: z.number().int().min(0).optional().describe('First row to copy (default 0).'),
      toRow: z.number().int().min(1).optional().describe('One past the last row to copy (default: pattern end).'),
      mode: mergeReplace.optional().describe('"replace" (default): the destination rows fromRow..toRow are emptied first. "merge": only non-empty source cells are written.'),
      ...shiftDesc
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      const from = pickOrder(session, args.fromOrder)
      const to = pickOrder(session, args.toOrder)
      const shifting = args.semitones !== undefined || args.degrees !== undefined
      if (shifting) checkShift(args)
      const idxs = pickChannels(song, args.channels)
      const lo = Math.max(0, args.fromRow ?? 0)
      const hi = Math.min(song.patternLength, args.toRow ?? song.patternLength)
      const diffs: CellDiff[] = []
      const skipped: string[] = []
      const done: string[] = []
      for (const ci of idxs) {
        const ch = song.channels[ci]!
        const src = song.orders[from]![ci]!
        const dst = song.orders[to]![ci]!
        if (src === dst) {
          skipped.push(`${ch.id} (both orders use pattern ${src})`)
          continue
        }
        if ((args.mode ?? 'replace') === 'replace') diffs.push(...clearDiffs(song, ch.id, dst, lo, hi))
        const pat = song.patterns.get(patternKey(ch.id, src))
        pat?.rows.forEach((cell, r) => {
          if (!cell || r < lo || r >= hi) return
          diffs.push({ channel: ch.id, pattern: dst, row: r, cell: shifting && isPitched(song, ci) ? transposeCell(song, cell, args, `${ch.id} row ${r}`) : cloneCell(cell) })
        })
        done.push(ch.id)
      }
      if (done.length === 0) {
        throw new Error(`Nothing copied: ${skipped.join('; ') || 'no channels'}. Orders ${from} and ${to} share their patterns; give order ${to} its own pattern numbers with set_orders or use duplicate_order.`)
      }
      const rep = applyDiffs(session, diffs, 'Copy pattern')
      return ok(
        `Copied order ${from} to order ${to} on ${done.join(', ')} (rows ${lo}..${hi - 1}${shifting ? `, ${args.degrees !== undefined ? `${args.degrees > 0 ? '+' : ''}${args.degrees} scale steps` : `${args.semitones! > 0 ? '+' : ''}${args.semitones} semitones`}` : ''}); ${rep.changed} cells changed.` +
          (skipped.length ? `\nSkipped: ${skipped.join('; ')}.` : '') +
          formatWarnings(rep.warnings) +
          sharedNotes(song, done, to)
      )
    }
  }),

  defineTool({
    name: 'transpose',
    group: 'notes',
    description:
      'Transpose notes in place: semitones (chromatic, 12 = octave) or degrees (diatonic scale steps in the song\'s key/scale, e.g. 2 = a third up, so the music stays in key). Applies to the patterns of one order row (default: the cursor\'s) or to the whole song (allOrders), on the chosen channels (default: all pitched channels; noise/drum channels are never transposed). Note-offs are unchanged. In strict songs a result outside a channel\'s range fails with a fix. Example: {"semitones":-12,"channels":["P1"]} or {"degrees":1,"allOrders":true}.',
    input: obj({
      order: z.number().int().min(0).optional().describe(ORDER_DESC),
      allOrders: z.boolean().optional().describe('Transpose every pattern used by any order row (each pattern once).'),
      channels: z.array(channelRef).optional().describe('Channels (default: all pitched channels).'),
      fromRow: z.number().int().min(0).optional().describe('First row (default 0).'),
      toRow: z.number().int().min(1).optional().describe('One past the last row (default: pattern end).'),
      ...shiftDesc
    }),
    handler: (args, ctx) => {
      const session = songSession(ctx)
      const song = session.song
      checkShift(args)
      const idxs = pickChannels(song, args.channels).filter((ci) => isPitched(song, ci))
      if (idxs.length === 0) throw new Error('No pitched channels to transpose (noise and drum channels are skipped).')
      const orders = args.allOrders ? song.orders.map((_, i) => i) : [pickOrder(session, args.order)]
      const lo = Math.max(0, args.fromRow ?? 0)
      const hi = Math.min(song.patternLength, args.toRow ?? song.patternLength)
      const diffs: CellDiff[] = []
      const seen = new Set<string>()
      for (const o of orders) {
        for (const ci of idxs) {
          const ch = song.channels[ci]!
          const pat = song.orders[o]![ci]!
          const key = `${ch.id}:${pat}`
          if (seen.has(key)) continue
          seen.add(key)
          song.patterns.get(patternKey(ch.id, pat))?.rows.forEach((cell, r) => {
            if (!cell || typeof cell.note !== 'number' || r < lo || r >= hi) return
            diffs.push({ channel: ch.id, pattern: pat, row: r, cell: transposeCell(song, cell, args, `${ch.id} pattern ${pat} row ${r}`) })
          })
        }
      }
      if (diffs.length === 0) return ok('No notes found to transpose in that range.')
      const rep = applyDiffs(session, diffs, 'Transpose')
      const how = args.degrees !== undefined ? `${args.degrees > 0 ? '+' : ''}${args.degrees} scale steps (${song.meta.key} ${song.meta.scale})` : `${args.semitones! > 0 ? '+' : ''}${args.semitones} semitones`
      return ok(`Transposed ${plural(rep.changed, 'note')} by ${how} on ${idxs.map((i) => song.channels[i]!.id).join(', ')} (${args.allOrders ? 'all orders' : `order ${orders[0]}`}).` + formatWarnings(rep.warnings))
    }
  })
]

