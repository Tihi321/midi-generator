// Pure helpers of the library UI: the "Save to library" form -> save_as_asset arguments, and card filtering.

import type { Song } from '../../core'
import type { AssetKind, AssetMeta } from '../../tools'
import type { Selection } from './trackerGrid'

export interface SaveAssetForm {
  kind: AssetKind
  name: string
  /** Comma separated. */
  tags: string
  /** Comma separated. */
  moods: string
  notes: string
  /** Instrument index (kind "instrument"). */
  instrument: number
}

export function parseList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((t) => t.trim())
    .filter(Boolean)
}

export interface MotifRange {
  fromOrder: number
  toOrder: number
  fromRow: number
  /** One past the last row. */
  toRow: number
  channels?: string[]
  /** What the dialog tells the user will be saved. */
  label: string
}

/** The motif to save: the tracker selection, else every channel of the cursor's order row. */
export function motifRange(song: Song, selection: Selection | null, cursorOrder: number): MotifRange {
  if (selection) {
    const channels = song.channels.slice(selection.ch1, selection.ch2 + 1).map((c) => c.id)
    return {
      fromOrder: selection.order,
      toOrder: selection.order,
      fromRow: selection.row1,
      toRow: selection.row2 + 1,
      channels,
      label: `Selection: order ${selection.order}, rows ${selection.row1}..${selection.row2}, ${channels.join(' ')}`
    }
  }
  return { fromOrder: cursorOrder, toOrder: cursorOrder, fromRow: 0, toRow: song.patternLength, label: `Order ${cursorOrder}, all rows and channels (select cells in the tracker to save only part)` }
}

/** Arguments of save_as_asset for the dialog's form. */
export function saveArgs(form: SaveAssetForm, song: Song, selection: Selection | null, cursorOrder: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name: form.name.trim(),
    kind: form.kind,
    tags: parseList(form.tags),
    moods: parseList(form.moods),
    ...(form.notes.trim() ? { notes: form.notes.trim() } : {})
  }
  if (form.kind === 'motif') {
    const r = motifRange(song, selection, cursorOrder)
    return { ...base, fromOrder: r.fromOrder, toOrder: r.toOrder, fromRow: r.fromRow, toRow: r.toRow, ...(r.channels ? { channels: r.channels } : {}) }
  }
  if (form.kind === 'instrument') return { ...base, instrument: form.instrument }
  return base
}

/** Every word of the query must match the name, a tag, a mood or the chip. */
export function assetMatches(a: AssetMeta, kind: AssetKind | '', chip: string, query: string): boolean {
  if (kind && a.kind !== kind) return false
  if (chip && a.chip !== chip) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return q.split(/\s+/).every((w) => a.name.toLowerCase().includes(w) || a.tags.some((t) => t.includes(w)) || a.moods.some((m) => m.toLowerCase().includes(w)))
}
