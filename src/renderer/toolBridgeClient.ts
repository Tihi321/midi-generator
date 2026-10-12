// Renderer side of the tool bridge: runs the tool calls that main forwards (chat agent, MCP) on the live
// session, and provides the ToolServices backed by main over IPC. Imports nothing from src/llm
// or Node, so it typechecks under tsconfig.web.json.

import { IPC, type ChiptuneStudioApi, type ToolCancelRequest, type ToolExecuteRequest, type ToolResultPayload, type ToolTurnRequest, type Unsubscribe } from '../shared/ipc'
import { type ToolRegistry, type ToolSession, createToolHost } from '../tools/registry'
import { renderSong } from '../core/synth'
import { ASSETS_IPC } from '../shared/assets'
import type { AssetData, AssetMeta, AssetService, AudioService, ToolServices } from '../tools/services'

function defaultApi(): ChiptuneStudioApi {
  return (globalThis as unknown as { chiptuneStudio: ChiptuneStudioApi }).chiptuneStudio
}

/**
 * Audio for environments without an audio engine (tests, Node): renders in-process and cannot play. The app
 * passes the real one (src/renderer/audioService.ts: render Worker + AudioWorklet) from main.tsx.
 */
export function createHeadlessAudio(): AudioService {
  return {
    render: async (song, opts = {}) => {
      const r = renderSong(song, { sampleRate: opts.sampleRate ?? 44100, loops: opts.loops ?? 1, fadeOutSec: opts.fadeOutSec ?? 0, stems: opts.stems ?? false })
      return { sampleRate: r.sampleRate, L: r.L, R: r.R, stems: r.stems, loopStart: r.loopStart, loopEnd: r.loopEnd }
    },
    play: async () => {
      throw new Error('Playback is not available here: there is no audio output.')
    },
    stop: async () => undefined,
    position: async () => ({ playing: false, order: 0, row: 0, seconds: 0 })
  }
}

/** The asset library in main (src/main/assets.ts) over IPC. */
export function createIpcAssets(api: ChiptuneStudioApi = defaultApi()): AssetService {
  return {
    list: (filter) => api.invoke<AssetMeta[]>(ASSETS_IPC.list, filter ?? null),
    get: (id) => api.invoke<AssetData | null>(ASSETS_IPC.get, id),
    save: (input) => api.invoke<AssetMeta>(ASSETS_IPC.save, input),
    delete: (id) => api.invoke<boolean>(ASSETS_IPC.delete, id),
    thumbnail: async (id) => {
      const r = await api.invoke<Uint8Array | ArrayBuffer | null>(ASSETS_IPC.thumbnail, id)
      return r === null || r === undefined ? null : r instanceof Uint8Array ? r : new Uint8Array(r)
    }
  }
}

/** ToolServices that call the main process (src/main/services.ts) through `window.chiptuneStudio.invoke`. */
export function createIpcServices(api: ChiptuneStudioApi = defaultApi(), audio: AudioService = createHeadlessAudio()): ToolServices {
  return {
    writeFile: (path, data) => api.invoke<void>(IPC.fsWriteFile, path, data),
    readFile: async (path) => {
      const r = await api.invoke<Uint8Array | ArrayBuffer>(IPC.fsReadFile, path)
      return r instanceof Uint8Array ? r : new Uint8Array(r)
    },
    resolveExportPath: (name, dir) => api.invoke<string>(IPC.fsResolveExportPath, name, dir),
    resolveProjectPath: (name, dir) => api.invoke<string>(IPC.fsResolveProjectPath, name, dir),
    audio,
    assets: createIpcAssets(api)
  }
}

/**
 * Start answering `tools:execute` / `tools:turn` / `tools:cancel` from main, then announce `tools:ready`.
 * Returns a function that stops listening. Call it once, after the registry and session exist.
 */
export function startToolBridge(registry: ToolRegistry, session: ToolSession, services: ToolServices, api: ChiptuneStudioApi = defaultApi()): () => void {
  const host = createToolHost(registry, () => ({ session, services }))
  const inFlight = new Map<string, AbortController>()
  const unsubs: Unsubscribe[] = []

  const reply = (payload: ToolResultPayload): void => {
    void api.invoke(IPC.toolsResult, payload).catch(() => undefined)
  }
  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

  unsubs.push(
    api.on(IPC.toolsExecute, (raw) => {
      const req = raw as ToolExecuteRequest
      const controller = new AbortController()
      inFlight.set(req.requestId, controller)
      host
        .execute(req.name, req.args, controller.signal)
        .then((result) => reply({ requestId: req.requestId, result }))
        .catch((e: unknown) => reply({ requestId: req.requestId, error: message(e) }))
        .finally(() => inFlight.delete(req.requestId))
    })
  )

  unsubs.push(
    api.on(IPC.toolsTurn, (raw) => {
      const req = raw as ToolTurnRequest
      Promise.resolve()
        .then(() => {
          if (req.action === 'begin') return host.beginTurn(req.label)
          return host.endTurn({ rollback: req.action === 'rollback' })
        })
        .then(() => reply({ requestId: req.requestId }))
        .catch((e: unknown) => reply({ requestId: req.requestId, error: message(e) }))
    })
  )

  unsubs.push(
    api.on(IPC.toolsCancel, (raw) => {
      const req = raw as ToolCancelRequest
      inFlight.get(req.requestId)?.abort()
    })
  )

  void api.invoke(IPC.toolsReady).catch(() => undefined)

  return () => {
    for (const u of unsubs) u()
    for (const c of inFlight.values()) c.abort()
    inFlight.clear()
  }
}
