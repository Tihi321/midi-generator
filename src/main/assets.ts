// The asset library on disk: ~/ChiptuneStudio/assets/<slug>/{asset.ctune, thumb.png, meta.md}.
// meta.md is YAML frontmatter (id, name, kind, chip, tags, moods, key, scale, bpm, rowsPerBeat, channels, roles, rows) plus the free-text
// style notes as the markdown body, like the other markdown+frontmatter files of this app.
// No Electron import: `registerAssetIpc` takes an ipcMain-like object and a `send` function.

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { watch as watchFolder } from 'chokidar'
import { parseMd, serializeMd } from '../llm/md'
import { ASSETS_IPC, ASSET_KINDS } from '../shared/assets'
import { matchesAssetFilter, normalizeTags, slugifyAssetName } from '../tools/assetOps'
import { CHIP_IDS } from '../core/types'
import { PITCH_CLASSES } from '../core/notes'
import type { ChipId, PitchClass } from '../core/types'
import type { AssetData, AssetFilter, AssetKind, AssetMeta, AssetSaveInput } from '../tools/services'
import { defaultRoot } from './services'
import type { BridgeIpc } from './toolBridge'

export function defaultAssetsDir(): string {
  return join(defaultRoot(), 'assets')
}

/** Folder-name-safe slug: lowercase letters, digits and dashes. */
export const slugify = slugifyAssetName

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function isValidAssetId(id: string): boolean {
  return ID_RE.test(id)
}

function isKind(v: unknown): v is AssetKind {
  return typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v)
}

function int(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
}

export { normalizeTags }

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : []
}

/** Parse meta.md text. `folderId` is authoritative for the id. Returns null when it cannot be read. */
export function parseMetaFile(folderId: string, text: string): AssetMeta | null {
  let doc
  try {
    doc = parseMd(text, `${folderId}/meta.md`)
  } catch {
    return null
  }
  const d = doc.data
  const notes = doc.body.trim()
  const chip = (CHIP_IDS as readonly string[]).includes(String(d['chip'])) ? (d['chip'] as ChipId) : 'nes'
  const key = (PITCH_CLASSES as readonly string[]).includes(String(d['key'])) ? (d['key'] as PitchClass) : 'C'
  const meta: AssetMeta = {
    id: folderId,
    name: str(d['name'], folderId),
    kind: isKind(d['kind']) ? d['kind'] : 'song',
    chip,
    tags: normalizeTags(d['tags']),
    moods: strList(d['moods']),
    key,
    scale: str(d['scale'], 'major'),
    bpm: int(d['bpm'], 120),
    rowsPerBeat: Math.max(1, int(d['rowsPerBeat'], 4)),
    channels: strList(d['channels']),
    roles: strList(d['roles']),
    rows: Math.max(0, int(d['rows'], 0))
  }
  if (notes) meta.notes = notes
  return meta
}

export function serializeMetaFile(meta: AssetMeta): string {
  return serializeMd(
    {
      id: meta.id,
      name: meta.name,
      kind: meta.kind,
      chip: meta.chip,
      tags: meta.tags,
      moods: meta.moods,
      key: meta.key,
      scale: meta.scale,
      bpm: meta.bpm,
      rowsPerBeat: meta.rowsPerBeat,
      channels: meta.channels,
      roles: meta.roles,
      rows: meta.rows
    },
    meta.notes?.trim() ? `${meta.notes.trim()}
` : ''
  )
}

export const matchesFilter = matchesAssetFilter

export class AssetStore {
  constructor(readonly root: string = defaultAssetsDir()) {}

  private dir(id: string): string {
    if (!isValidAssetId(id)) throw new Error(`Invalid asset id "${id}".`)
    return join(this.root, id)
  }

  async list(filter?: AssetFilter): Promise<AssetMeta[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const out: AssetMeta[] = []
    for (const e of entries) {
      if (!e.isDirectory() || !isValidAssetId(e.name)) continue
      try {
        const meta = parseMetaFile(e.name, await readFile(join(this.root, e.name, 'meta.md'), 'utf8'))
        if (meta && matchesAssetFilter(meta, filter)) out.push(meta)
      } catch {
        /* a folder without readable meta.md is not an asset */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  async getMeta(id: string): Promise<AssetMeta | null> {
    if (!isValidAssetId(id)) return null
    try {
      return parseMetaFile(id, await readFile(join(this.dir(id), 'meta.md'), 'utf8'))
    } catch {
      return null
    }
  }

  async get(id: string): Promise<AssetData | null> {
    const meta = await this.getMeta(id)
    if (!meta) return null
    try {
      const project = await readFile(join(this.dir(id), 'asset.ctune'), 'utf8')
      return { ...meta, project }
    } catch {
      return null
    }
  }

  /** Reserve a new folder named after `name` (adds -2, -3, ... when taken). */
  private async claimFolder(name: string): Promise<string> {
    await mkdir(this.root, { recursive: true })
    const base = slugify(name)
    for (let n = 1; n < 10_000; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      try {
        await mkdir(join(this.root, id))
        return id
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
    }
    throw new Error(`Could not find a free folder name for asset "${name}".`)
  }

  /** Save an asset. With `meta.id` an existing asset is overwritten (a missing one is created under that id). */
  async save(input: AssetSaveInput): Promise<AssetMeta> {
    const name = input.meta.name.trim()
    if (!name) throw new Error('An asset needs a name.')
    let id = input.meta.id
    if (id) {
      if (!isValidAssetId(id)) throw new Error(`Invalid asset id "${id}": use lowercase letters, digits, "-" and "_".`)
      await mkdir(this.dir(id), { recursive: true })
    } else {
      id = await this.claimFolder(name)
    }
    const meta: AssetMeta = {
      id,
      name,
      kind: isKind(input.meta.kind) ? input.meta.kind : 'song',
      chip: input.meta.chip,
      tags: normalizeTags(input.meta.tags),
      moods: strList(input.meta.moods),
      key: input.meta.key,
      scale: input.meta.scale,
      bpm: input.meta.bpm,
      rowsPerBeat: input.meta.rowsPerBeat,
      channels: strList(input.meta.channels),
      roles: strList(input.meta.roles),
      rows: input.meta.rows,
      ...(input.meta.notes?.trim() ? { notes: input.meta.notes.trim() } : {})
    }
    const dir = this.dir(id)
    await writeFile(join(dir, 'asset.ctune'), input.project, 'utf8')
    if (input.thumbnail) await writeFile(join(dir, 'thumb.png'), input.thumbnail)
    await writeFile(join(dir, 'meta.md'), serializeMetaFile(meta), 'utf8')
    return meta
  }

  async delete(id: string): Promise<boolean> {
    if (!isValidAssetId(id)) return false
    if (!(await this.getMeta(id))) return false
    await rm(this.dir(id), { recursive: true, force: true })
    return true
  }

  async thumbnail(id: string): Promise<Uint8Array | null> {
    if (!isValidAssetId(id)) return null
    try {
      const buf = await readFile(join(this.dir(id), 'thumb.png'))
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    } catch {
      return null
    }
  }

  /** Watch the library folder (chokidar); `onChange` is debounced. Returns a function that stops watching. */
  async watch(onChange: () => void, debounceMs = 200): Promise<() => Promise<void>> {
    await mkdir(this.root, { recursive: true })
    let timer: ReturnType<typeof setTimeout> | null = null
    const fire = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        onChange()
      }, debounceMs)
    }
    const watcher = watchFolder(this.root, { ignoreInitial: true, depth: 2 })
    watcher.on('all', fire)
    watcher.on('error', () => undefined)
    return async () => {
      if (timer) clearTimeout(timer)
      await watcher.close()
    }
  }
}

/** Register the assets:* handlers. `notify` is called after save/delete from the UI/tools (so the panel refreshes at once). */
export function registerAssetIpc(ipc: BridgeIpc, store: AssetStore, notify: () => void = () => undefined): AssetStore {
  ipc.handle(ASSETS_IPC.list, (_e, filter) => store.list((filter ?? undefined) as AssetFilter | undefined))
  ipc.handle(ASSETS_IPC.get, (_e, id) => store.get(String(id)))
  ipc.handle(ASSETS_IPC.save, async (_e, input) => {
    const i = input as AssetSaveInput
    const thumb = i.thumbnail as unknown
    const thumbnail = thumb instanceof Uint8Array ? thumb : thumb ? new Uint8Array(thumb as ArrayBuffer) : undefined
    const meta = await store.save({ meta: i.meta, project: String(i.project), thumbnail })
    notify()
    return meta
  })
  ipc.handle(ASSETS_IPC.delete, async (_e, id) => {
    const ok = await store.delete(String(id))
    if (ok) notify()
    return ok
  })
  ipc.handle(ASSETS_IPC.thumbnail, (_e, id) => store.thumbnail(String(id)))
  return store
}
