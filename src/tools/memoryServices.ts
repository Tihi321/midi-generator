// In-memory ToolServices for tests: files live in a Map, export/project paths are virtual, and audio renders
// in-process with renderSong (playback is a recorded fake).

import { cloneSong, renderSong } from '../core'
import type { Song } from '../core'
import { matchesAssetFilter, normalizeTags, slugifyAssetName } from './assetOps'
import type { AssetData, AssetMeta, AssetService, AudioRenderOptions, AudioRenderResult, AudioService, PlaybackPosition, ToolServices } from './services'

export interface MemoryAudio extends AudioService {
  /** Every offline render requested so far (options only). */
  renders: AudioRenderOptions[]
  /** Every play() call. */
  played: Array<{ from?: { order: number; row?: number }; opts?: { loop?: boolean } }>
  /** Number of stop() calls. */
  stops: number
  playing: boolean
}

export interface MemoryAssets extends AssetService {
  /** The stored assets by id (project text and thumbnail included). */
  items: Map<string, AssetData & { thumbnail?: Uint8Array }>
}

export function createMemoryAssets(): MemoryAssets {
  const items = new Map<string, AssetData & { thumbnail?: Uint8Array }>()
  const strip = (a: AssetData & { thumbnail?: Uint8Array }): AssetMeta => {
    const { project: _p, thumbnail: _t, ...meta } = a
    void _p
    void _t
    return meta
  }
  return {
    items,
    async list(filter) {
      return [...items.values()]
        .map(strip)
        .filter((m) => matchesAssetFilter(m, filter))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    },
    async get(id) {
      const a = items.get(id)
      if (!a) return null
      const { thumbnail: _t, ...data } = a
      void _t
      return { ...data }
    },
    async save(input) {
      const name = input.meta.name.trim()
      if (!name) throw new Error('An asset needs a name.')
      let id = input.meta.id
      if (!id) {
        const base = slugifyAssetName(name)
        id = base
        for (let n = 2; items.has(id); n++) id = `${base}-${n}`
      }
      const meta: AssetMeta = { ...input.meta, id, name, tags: normalizeTags(input.meta.tags) }
      items.set(id, { ...meta, project: input.project, ...(input.thumbnail ? { thumbnail: input.thumbnail } : {}) })
      return meta
    },
    async delete(id) {
      return items.delete(id)
    },
    async thumbnail(id) {
      return items.get(id)?.thumbnail ?? null
    }
  }
}

export interface MemoryToolServices extends ToolServices {
  /** Every file written so far, by absolute (virtual) path. */
  files: Map<string, Uint8Array>
  audio: MemoryAudio
  assets: MemoryAssets
}

export function createMemoryAudio(): MemoryAudio {
  const audio: MemoryAudio = {
    renders: [],
    played: [],
    stops: 0,
    playing: false,
    async render(song: Song, opts: AudioRenderOptions = {}): Promise<AudioRenderResult> {
      audio.renders.push({ ...opts })
      const r = renderSong(cloneSong(song), { sampleRate: opts.sampleRate, loops: opts.loops, fadeOutSec: opts.fadeOutSec, stems: opts.stems })
      return { sampleRate: r.sampleRate, L: r.L, R: r.R, stems: r.stems, loopStart: r.loopStart, loopEnd: r.loopEnd }
    },
    async play(from, opts) {
      audio.played.push({ from, opts })
      audio.playing = true
    },
    async stop() {
      audio.stops++
      audio.playing = false
    },
    async position(): Promise<PlaybackPosition> {
      const last = audio.played[audio.played.length - 1]
      return { playing: audio.playing, order: last?.from?.order ?? 0, row: last?.from?.row ?? 0, seconds: 0 }
    }
  }
  return audio
}

export function createMemoryToolServices(opts: { exportDir?: string; projectDir?: string } = {}): MemoryToolServices {
  const files = new Map<string, Uint8Array>()
  const exportDir = opts.exportDir ?? '/mem/exports'
  const projectDir = opts.projectDir ?? '/mem/projects'
  const place = (base: string, name: string, dir?: string): string => {
    if (/^([a-zA-Z]:)?[\\/]/.test(name)) return name
    const folder = dir ? (/^([a-zA-Z]:)?[\\/]/.test(dir) ? dir : `${base}/${dir}`) : base
    return `${folder.replace(/[\\/]+$/, '')}/${name}`
  }
  return {
    files,
    audio: createMemoryAudio(),
    assets: createMemoryAssets(),
    async writeFile(path, data) {
      files.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data)
    },
    async readFile(path) {
      const f = files.get(path)
      if (!f) throw new Error(`File not found: ${path}`)
      return f
    },
    resolveExportPath: async (name, dir) => place(exportDir, name, dir),
    resolveProjectPath: async (name, dir) => place(projectDir, name, dir)
  }
}
