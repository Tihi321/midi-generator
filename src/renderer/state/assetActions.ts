// UI actions of the asset library. Every one that changes the song runs the matching tool (save_as_asset,
// place_asset, set_style_reference) through lib/tools.ts, so the UI and the LLM behave identically (one undo
// step each). Opening a song asset replaces the song (one undo step too).

import { createId, parseProject } from '../../core'
import type { AssetKind, AssetMeta } from '../../tools'
import { type SaveAssetForm, saveArgs } from '../lib/assetForm'
import { AGENT_BUSY_MESSAGE, runUiTool, uiServices } from '../lib/tools'
import { currentSelection } from './actions'
import { session } from './session'
import { useUi } from './ui'

function report(message: string): void {
  useUi.getState().setStatus(message)
}

/** Open the "Save to library" dialog (optionally preset to a kind and instrument). */
export function openSaveAsset(kind?: AssetKind, instrument?: number): void {
  const ui = useUi.getState()
  ui.set({ assetDraft: { kind: kind ?? 'song', instrument: instrument ?? Math.max(0, session.currentInstrument) } })
  ui.openDialog('saveAsset')
}

export async function saveAsAsset(form: SaveAssetForm): Promise<boolean> {
  const r = await runUiTool('save_as_asset', saveArgs(form, session.song, currentSelection(), session.cursor.order))
  report(r.ok ? `Saved ${form.kind} "${form.name.trim()}" to the library` : r.message)
  return r.ok
}

/** Place a motif at the cursor, or add an instrument asset. */
export async function placeAsset(asset: AssetMeta): Promise<boolean> {
  const args = asset.kind === 'motif' ? { id: asset.id, order: session.cursor.order, row: session.cursor.row } : { id: asset.id }
  const r = await runUiTool('place_asset', args)
  report(r.message)
  return r.ok
}

/** Open a song asset as the current song (undo brings the previous song back). */
export async function openSongAsset(asset: AssetMeta): Promise<boolean> {
  if (session.turnActive) {
    report(AGENT_BUSY_MESSAGE)
    return false
  }
  try {
    const data = await uiServices().assets?.get(asset.id)
    if (!data) throw new Error(`Asset "${asset.id}" not found.`)
    const song = parseProject(data.project)
    song.id = createId('song')
    session.replaceSong(song, { history: 'record', label: `Open asset ${asset.name}` })
    useUi.getState().set({ projectPath: null })
    report(`Opened "${asset.name}" as a new song (undo restores the previous one)`)
    return true
  } catch (e) {
    report(e instanceof Error ? e.message : String(e))
    return false
  }
}

export async function setReference(id: string, on: boolean): Promise<boolean> {
  const r = await runUiTool('set_style_reference', { ids: [id], action: on ? 'add' : 'remove' })
  report(r.message)
  return r.ok
}

export async function deleteAsset(id: string): Promise<boolean> {
  try {
    const ok = await uiServices().assets!.delete(id)
    report(ok ? 'Asset deleted' : 'Asset not found')
    return ok
  } catch (e) {
    report(e instanceof Error ? e.message : String(e))
    return false
  }
}
