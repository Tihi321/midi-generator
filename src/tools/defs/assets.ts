// Library tools: list_assets, get_asset, save_as_asset, place_asset, set_style_reference, get_style_context.
// There is deliberately no delete_asset tool: deleting from the library is a UI action (as in Pixel Studio).

import { z } from 'zod'
import { type RefLink, type Song, CHIP_IDS, formatTrackerText, requireChannelIndex, requireChipId, serializeProject } from '../../core'
import type { ToolResult } from '../../shared/tools'
import {
  type AssetBuildInfo,
  buildInstrumentAsset,
  buildMotifAsset,
  buildSongAsset,
  createSetReferencesCommand,
  describeAssetSong,
  describeTiming,
  drumLines,
  loadAssetSong,
  mainChannels,
  metaOf,
  normalizeTags,
  placeInstrumentAsset,
  placeMotifAsset,
  progressionText,
  requireAssets,
  resolveAsset,
  sampleTracker,
  summarizeInstrument,
  thumbnailOf
} from '../assetOps'
import { defineTool, jsonResult } from '../registry'
import { renderPianoRoll } from '../render'
import type { AssetData, AssetKind } from '../services'
import { channelRef, instrumentRef, obj, ok, plural, songSession } from '../util'

const kindSchema = z.enum(['song', 'motif', 'instrument'])
const MAX_GET_ASSET_ROWS = 32
const MAX_CONTEXT_IMAGES = 4

function image(base64: string): ToolResult['content'][number] {
  return { type: 'image', mimeType: 'image/png', data: base64 }
}

function preview(song: Song): string {
  return renderPianoRoll(song, { maxWidth: 800 }).base64
}

function instrumentsText(song: Song): string {
  if (song.instruments.length === 0) return 'Instruments: none.'
  return ['Instruments:', ...song.instruments.map((x, i) => `  ${summarizeInstrument(x, i)}`)].join('\n')
}

export const assetTools = [
  defineTool({
    name: 'list_assets',
    group: 'assets',
    readOnly: true,
    description:
      'List the saved assets in the library: songs, motifs (a few channels of a section) and instruments, each with id, name, kind, chip, key/scale, BPM, moods, tags, channels, roles and length. Optional filters: kind, chip, tags (assets with ALL tags), mood, text (every word must match name/tags/moods/notes). Use the ids with get_asset, place_asset, set_style_reference and get_style_context.',
    input: obj({
      kind: kindSchema.optional().describe('Only assets of this kind.'),
      chip: z.string().optional().describe(`Only assets for this chip (${CHIP_IDS.join(', ')}).`),
      tags: z.array(z.string()).optional().describe('Only assets that have all of these tags.'),
      mood: z.string().optional().describe('Only assets with this mood, e.g. "spooky".'),
      text: z.string().optional().describe('Free-text search over name, tags, moods and notes.')
    }),
    handler: async (args, ctx) => {
      const svc = requireAssets(ctx.services)
      const list = await svc.list({ kind: args.kind, chip: args.chip ? requireChipId(args.chip) : undefined, tags: args.tags, mood: args.mood, text: args.text })
      return jsonResult(list.map(metaOf), `${plural(list.length, 'asset')}${list.length ? '' : ' (the library is empty or nothing matches the filter)'}.`)
    }
  }),

  defineTool({
    name: 'get_asset',
    group: 'assets',
    readOnly: true,
    description: `Look at one asset: its metadata and notes, its instruments (presets and parameters), up to ${MAX_GET_ASSET_ROWS} rows of tracker text for each main channel and a piano-roll preview image. Does not change the song; use place_asset to put a motif or instrument into it.`,
    input: obj({
      id: z.string().min(1).describe('Asset id (or exact name). See list_assets.'),
      order: z.number().int().min(0).optional().describe('Order row of the asset to show (default: the first with notes).'),
      fromRow: z.number().int().min(0).optional().describe('First row to show (default 0).')
    }),
    handler: async (args, ctx) => {
      const svc = requireAssets(ctx.services)
      const asset = await resolveAsset(svc, args.id)
      const song = loadAssetSong(asset)
      const lines: string[] = []
      lines.push(`Asset "${asset.name}" (id ${asset.id}, ${asset.kind}, ${asset.chip.toUpperCase()}): ${describeTiming(song)}; key ${asset.key} ${asset.scale}; ${asset.rows} rows.`)
      if (asset.moods.length || asset.tags.length) lines.push(`Moods: ${asset.moods.join(', ') || '-'} | tags: ${asset.tags.join(', ') || '-'}`)
      if (asset.channels.length) lines.push(`Channels with notes: ${asset.channels.join(', ')}`)
      if (asset.notes) lines.push(`Notes: ${asset.notes}`)
      lines.push(instrumentsText(song))
      const sample = sampleTracker(song, MAX_GET_ASSET_ROWS)
      let order = sample.order
      let from = 0
      let text = sample.text
      if (args.order !== undefined || args.fromRow !== undefined) {
        order = Math.min(args.order ?? sample.order, song.orders.length - 1)
        from = args.fromRow ?? 0
        text = formatTrackerText(song, { order, channels: sample.channels.length ? sample.channels : undefined, fromRow: from, toRow: Math.min(from + MAX_GET_ASSET_ROWS, song.patternLength) })
      }
      lines.push(`Tracker text (order ${order}, rows ${from}..${Math.min(from + MAX_GET_ASSET_ROWS, song.patternLength) - 1}):`, text)
      const res = ok(lines.join('\n'))
      res.content.push(image(preview(song)))
      return res
    }
  }),

  defineTool({
    name: 'save_as_asset',
    group: 'assets',
    readOnly: true,
    description:
      'Save music in the asset library so it can be reused (place_asset) or used as a style reference (set_style_reference). kind "song": the whole song. kind "motif": some channels of an order range (fromOrder..toOrder, default the cursor order) and row range (fromRow..toRow); it keeps its key so place_asset can transpose it. kind "instrument": one instrument (`instrument` index or name) plus the sample slot it needs. Give it a name, tags, moods and style notes (what makes it recognisable). Pass `id` to overwrite an existing asset. Writes to the library only, not to the song.',
    input: obj({
      name: z.string().min(1).describe('Asset name, e.g. "heroic overworld".'),
      kind: kindSchema.describe('song, motif or instrument.'),
      tags: z.array(z.string()).optional().describe('Search tags, e.g. ["boss","fast"].'),
      moods: z.array(z.string()).optional().describe('Moods (default: the song\'s moods), e.g. ["spooky"].'),
      notes: z.string().optional().describe('Free-text style notes: groove, harmony, instrumentation, what to imitate.'),
      id: z.string().optional().describe('Overwrite this existing asset id.'),
      channels: z.array(channelRef).optional().describe('Motif: channels to take (default: all channels with notes in the range).'),
      fromOrder: z.number().int().min(0).optional().describe('Motif: first order row (default: the cursor order).'),
      toOrder: z.number().int().min(0).optional().describe('Motif: last order row, inclusive (default: fromOrder).'),
      fromRow: z.number().int().min(0).optional().describe('Motif: first row within each pattern (default 0).'),
      toRow: z.number().int().min(1).optional().describe('Motif: one past the last row (default: the pattern end).'),
      instrument: instrumentRef.optional().describe('Instrument: index, "@name" or name (default: the current instrument).')
    }),
    handler: async (args, ctx) => {
      const svc = requireAssets(ctx.services)
      const session = songSession(ctx)
      const song = session.song
      const info: AssetBuildInfo = {
        name: args.name.trim(),
        tags: normalizeTags(args.tags ?? []),
        moods: (args.moods ?? song.meta.moods).map((m) => m.trim().toLowerCase()).filter(Boolean),
        ...(args.notes?.trim() ? { notes: args.notes.trim() } : {})
      }
      let asset: Song
      const kind = args.kind as AssetKind
      if (kind === 'song') {
        asset = buildSongAsset(song, info)
        if (asset.orders.length === 0) throw new Error('The song has no order rows.')
      } else if (kind === 'motif') {
        const fromOrder = args.fromOrder ?? session.cursor.order
        const toOrder = args.toOrder ?? fromOrder
        if (fromOrder >= song.orders.length || toOrder >= song.orders.length || toOrder < fromOrder) {
          throw new Error(`Order range ${fromOrder}..${toOrder} is invalid: the song has ${song.orders.length} order row(s) (0..${song.orders.length - 1}).`)
        }
        const fromRow = args.fromRow ?? 0
        const toRow = Math.min(args.toRow ?? song.patternLength, song.patternLength)
        if (fromRow >= toRow) throw new Error(`Row range ${fromRow}..${toRow} is empty (patterns have ${song.patternLength} rows).`)
        const channels = args.channels?.map((c) => requireChannelIndex(song, c))
        asset = buildMotifAsset(song, info, { channels, fromOrder, toOrder, fromRow, toRow })
      } else {
        const ref = args.instrument ?? (session.currentInstrument >= 0 ? session.currentInstrument : undefined)
        if (ref === undefined) throw new Error('Pass `instrument` (index or name) for kind "instrument"; the song has no current instrument.')
        asset = buildInstrumentAsset(song, ref, info)
      }
      const facts = describeAssetSong(asset, kind)
      const meta = await svc.save({
        meta: { name: info.name, kind, tags: info.tags, moods: info.moods, ...facts, ...(info.notes ? { notes: info.notes } : {}), ...(args.id ? { id: args.id } : {}) },
        project: serializeProject(asset),
        thumbnail: thumbnailOf(asset)
      })
      return ok(
        `Saved ${kind} asset "${meta.name}" (id ${meta.id}, ${meta.chip.toUpperCase()}, key ${meta.key} ${meta.scale}${meta.rows ? `, ${plural(meta.rows, 'row')}` : ''}${meta.channels.length ? `, channels ${meta.channels.join('/')}` : ''}). Use place_asset or set_style_reference with this id.`
      )
    }
  }),

  defineTool({
    name: 'place_asset',
    group: 'assets',
    description:
      'Put a saved asset into the open song (one undo step). Motif: its notes are written into the song starting at order/row (default: the cursor), transposed from the motif\'s key to the song\'s key (chromatic by default; `diatonic` true maps scale degrees onto the song\'s scale), and the instruments it needs are added (on another chip the role\'s preset is used and you are told). Channels map by id on the same chip, by role on another chip; `channels` overrides. Instrument asset: adds the instrument (and its sample slot) when the chip matches, otherwise the preset for its role on this chip. Song asset: refused; use open_project, or set_style_reference + a new song in that style. Example: {"id":"heroic-motif","order":2,"row":0}.',
    input: obj({
      id: z.string().min(1).describe('Asset id (or exact name). See list_assets.'),
      order: z.number().int().min(0).optional().describe('Motif: first order row (default: the cursor order).'),
      row: z.number().int().min(0).optional().describe('Motif: first row within the pattern (default: the cursor row).'),
      channels: z.array(channelRef).optional().describe('Motif: target channels, one per channel of the motif that has notes, in the motif\'s channel order (default: automatic).'),
      diatonic: z.boolean().optional().describe('Map by scale degree into the song\'s scale instead of shifting by semitones.'),
      semitones: z.number().int().min(-48).max(48).optional().describe('Extra semitones after the key transposition (e.g. 12 = an octave up).'),
      mode: z.enum(['replace', 'merge']).optional().describe('"replace" (default): the rows the motif covers are emptied first. "merge": only its notes are written.')
    }),
    handler: async (args, ctx) => {
      const svc = requireAssets(ctx.services)
      const session = songSession(ctx)
      const asset = await resolveAsset(svc, args.id)
      if (asset.kind === 'song') {
        throw new Error(`"${asset.name}" is a whole song asset and cannot be placed into the open song. Use open_project with its .ctune (the asset folder holds asset.ctune), or call set_style_reference {"ids":["${asset.id}"]} and write a new song in its style (get_style_context).`)
      }
      const song = loadAssetSong(asset)
      if (asset.kind === 'instrument') return ok(placeInstrumentAsset(session, asset, song).text)
      const order = args.order ?? session.cursor.order
      if (order >= session.song.orders.length) throw new Error(`Order ${order} not found; the song has ${session.song.orders.length} order row(s).`)
      const text = placeMotifAsset(session, asset, song, {
        order,
        row: args.row ?? (args.order === undefined ? session.cursor.row : 0),
        channels: args.channels,
        diatonic: args.diatonic ?? false,
        semitones: args.semitones ?? 0,
        mode: args.mode ?? 'replace'
      })
      return ok(text)
    }
  }),

  defineTool({
    name: 'set_style_reference',
    group: 'assets',
    description:
      'Attach saved assets to this song as style references (or detach them). get_style_context then tells you the chip, tempo, groove, key, instruments, drums, chords and notes of each reference so you can match its style. action: "add" (default), "remove", "set" (exactly these) or "clear" (all). One undo step.',
    input: obj({
      ids: z.array(z.string().min(1)).optional().describe('Asset ids (or exact names). Needed for add, remove and set.'),
      action: z.enum(['add', 'remove', 'set', 'clear']).optional().describe('Default "add".'),
      note: z.string().optional().describe('A note for the added references, e.g. "match the bass groove".')
    }),
    handler: async (args, ctx) => {
      const svc = requireAssets(ctx.services)
      const session = songSession(ctx)
      const action = args.action ?? 'add'
      if (action !== 'clear' && (!args.ids || args.ids.length === 0)) throw new Error(`action "${action}" needs \`ids\` (see list_assets).`)
      const current: RefLink[] = session.song.references.map((r) => ({ ...r }))
      let next: RefLink[]
      if (action === 'clear') next = []
      else if (action === 'remove') {
        const all = await svc.list()
        const gone = new Set<string>()
        for (const id of args.ids!) {
          gone.add(id.trim())
          const byName = all.find((a) => a.name.toLowerCase() === id.trim().toLowerCase())
          if (byName) gone.add(byName.id)
        }
        next = current.filter((r) => !gone.has(r.assetId))
      } else {
        const resolved: AssetData[] = []
        for (const id of args.ids!) resolved.push(await resolveAsset(svc, id))
        const wanted = new Set(resolved.map((a) => a.id))
        next = action === 'set' ? current.filter((r) => wanted.has(r.assetId)) : current
        for (const a of resolved) {
          const link = next.find((r) => r.assetId === a.id)
          if (link) {
            if (args.note !== undefined) link.note = args.note
          } else next.push(args.note ? { assetId: a.id, note: args.note } : { assetId: a.id })
        }
      }
      session.execute(createSetReferencesCommand(session.song, next))
      const list = next.length ? next.map((r) => r.assetId).join(', ') : '(none)'
      return ok(`Style references are now: ${list}.${next.length ? ' Call get_style_context to see what to match.' : ''}`)
    }
  }),

  defineTool({
    name: 'get_style_context',
    group: 'assets',
    readOnly: true,
    description:
      'Everything needed to write music in the style of the reference assets: for each one the chip, timing and groove, key and scale, moods, instruments with presets and parameters, drum step strings, the chord progression, 16-32 rows of tracker text per main channel and the user\'s notes (plus preview images for models that can see). Uses the song\'s style references (set_style_reference) or the asset `ids` you give. Call it before composing when references exist: match the tempo feel, groove, instrumentation, harmony and register rather than copying notes.',
    input: obj({
      ids: z.array(z.string().min(1)).optional().describe("Asset ids (or exact names). Default: the song's style references.")
    }),
    handler: async (args, ctx) => {
      const svc = requireAssets(ctx.services)
      const session = songSession(ctx)
      const refs = session.song.references
      const ids = args.ids && args.ids.length ? args.ids : refs.map((r) => r.assetId)
      if (ids.length === 0) {
        return ok('No style references are set on this song. Use list_assets to browse the library and set_style_reference to attach assets, or pass `ids` to get_style_context.')
      }
      const blocks: string[] = []
      const missing: string[] = []
      const images: ToolResult['content'] = []
      let n = 0
      for (const id of ids) {
        let asset: AssetData
        try {
          asset = await resolveAsset(svc, id)
        } catch {
          missing.push(id)
          continue
        }
        const song = loadAssetSong(asset)
        n++
        const link = refs.find((r) => r.assetId === asset.id)
        const lines: string[] = []
        lines.push(`Reference ${n}: "${asset.name}" (id ${asset.id}, ${asset.kind})`)
        lines.push(`  Chip: ${asset.chip.toUpperCase()} | ${describeTiming(song)} | key ${asset.key} ${asset.scale}`)
        lines.push(`  Moods: ${asset.moods.join(', ') || '-'} | tags: ${asset.tags.join(', ') || '-'} | length: ${asset.rows} rows | channels: ${asset.channels.join(', ') || '-'}`)
        const prog = asset.kind === 'instrument' ? '' : progressionText(song)
        if (prog) lines.push(`  Chord progression: ${prog}`)
        lines.push(...instrumentsText(song).split('\n').map((l) => `  ${l}`))
        const drums = asset.kind === 'instrument' ? [] : drumLines(song)
        if (drums.length) lines.push('  Drums (steps, one character per row):', ...drums.map((d) => `    ${d}`))
        if (asset.kind !== 'instrument') {
          const mc = mainChannels(song)
          const s = sampleTracker(song, mc.length > 3 ? 16 : 32, false)
          if (s.channels.length) lines.push(`  Tracker sample (order ${s.order}, ${s.channels.join(' | ')}):`, ...s.text.split('\n').map((l) => `    ${l}`))
        }
        if (asset.notes) lines.push(`  User notes: ${asset.notes}`)
        if (link?.note) lines.push(`  Reference note: ${link.note}`)
        blocks.push(lines.join('\n'))
        if (images.length < MAX_CONTEXT_IMAGES) images.push(image(preview(song)))
      }
      if (blocks.length === 0) throw new Error(`None of the style references could be found (${missing.join(', ')}). Use list_assets.`)
      const head = `Style context from ${plural(blocks.length, 'reference asset')}. Match their tempo feel, groove, instrumentation, harmony and register; do not copy the notes.`
      const res = ok([head, ...blocks, ...(missing.length ? [`Missing references: ${missing.join(', ')}.`] : [])].join('\n\n'))
      res.content.push(...images)
      return res
    }
  })
]
