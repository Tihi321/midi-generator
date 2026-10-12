// ToolBridge: the main-process ToolHost. It forwards tool calls to the renderer (which owns the live
// song), correlates the replies by requestId, and handles timeouts, cancellation, agent turns and
// renderer readiness. No Electron import: it talks to a minimal `{ send }` target and is fed results
// through `handleResult` / `handleReady` (wired to ipcMain.handle in src/main/index.ts), so it can be
// unit-tested with a fake target.

import { randomUUID } from 'node:crypto'
import { IPC } from '../shared/ipc'
import type { ToolCancelRequest, ToolExecuteRequest, ToolResultPayload, ToolTurnRequest } from '../shared/ipc'
import type { ToolDef, ToolResult, TurnToolHost } from '../shared/tools'
import { createDefaultRegistry } from '../tools/defs'

/** Where requests are sent: `webContents` satisfies this (`send(channel, ...args)`). */
export interface BridgeTarget {
  send(channel: string, payload: unknown): void
}

/** The subset of `ipcMain` used to register the reply channels. */
export interface BridgeIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface ToolBridgeOptions {
  /** Where to send requests. Can be set later with `setTarget`. */
  target?: BridgeTarget | null
  /** Per-call timeout (default 60 000 ms). */
  timeoutMs?: number
  /** How long a call waits for the renderer to report ready (default 20 000 ms). */
  readyTimeoutMs?: number
  /** Tool definitions advertised to LLMs / MCP (default: the default registry's). */
  tools?: ToolDef[] | (() => ToolDef[])
  /** Treat the target as ready right away (tests). */
  assumeReady?: boolean
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000
export const DEFAULT_READY_TIMEOUT_MS = 20_000

interface Pending {
  resolve: (p: ToolResultPayload) => void
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export class ToolBridge implements TurnToolHost {
  private target: BridgeTarget | null
  private readonly timeoutMs: number
  private readonly readyTimeoutMs: number
  private readonly toolSource: ToolDef[] | (() => ToolDef[]) | undefined
  private cachedTools: ToolDef[] | null = null
  private ready: boolean
  private readyWaiters: Array<() => void> = []
  private pending = new Map<string, Pending>()

  constructor(opts: ToolBridgeOptions = {}) {
    this.target = opts.target ?? null
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    this.toolSource = opts.tools
    this.ready = opts.assumeReady ?? false
  }

  // ------------------------------------------------------------ wiring

  /** Point the bridge at a (new) renderer. Readiness is reset and calls still in flight are failed. */
  setTarget(target: BridgeTarget | null): void {
    this.target = target
    this.ready = false
    this.failAll('The editor window was reloaded or closed; run the tool again.')
  }

  /** The renderer reported that its registry is listening (`tools:ready`). */
  handleReady(): void {
    this.ready = true
    const waiters = this.readyWaiters
    this.readyWaiters = []
    for (const w of waiters) w()
  }

  isReady(): boolean {
    return this.ready && this.target !== null
  }

  /** A reply from the renderer (`tools:result`). Unknown or late request ids are ignored. */
  handleResult(payload: ToolResultPayload): void {
    const p = payload && typeof payload === 'object' ? this.pending.get(payload.requestId) : undefined
    if (p) p.resolve(payload)
  }

  /** Register the `tools:result` and `tools:ready` handlers on an ipcMain-like object. */
  registerIpc(ipc: BridgeIpc): void {
    ipc.handle(IPC.toolsResult, (_e, payload) => {
      this.handleResult(payload as ToolResultPayload)
    })
    ipc.handle(IPC.toolsReady, () => {
      this.handleReady()
    })
  }

  // ------------------------------------------------------------ ToolHost

  tools(): ToolDef[] {
    const src = this.toolSource
    if (typeof src === 'function') return src()
    if (src) return src
    this.cachedTools ??= createDefaultRegistry().defs()
    return this.cachedTools
  }

  async execute(name: string, args: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const requestId = randomUUID()
    const ready = await this.waitReady(signal)
    if (ready) return errorResult(ready)
    const request: ToolExecuteRequest = { requestId, name, args }
    const reply = await this.roundTrip(requestId, IPC.toolsExecute, request, `Tool ${name}`, signal)
    if (reply.kind === 'aborted') return errorResult(`${name} was cancelled.`)
    if (reply.kind === 'timeout') return errorResult(`${name} timed out after ${Math.round(this.timeoutMs / 1000)} s without an answer from the editor.`)
    if (reply.kind === 'failed') return errorResult(`${name} failed: ${reply.message}`)
    const p = reply.payload
    if (p.error) return errorResult(`${name} failed in the editor: ${p.error}`)
    return p.result ?? errorResult(`${name} returned no result.`)
  }

  async beginTurn(label?: string): Promise<void> {
    await this.turn({ action: 'begin', label })
  }

  async endTurn(opts?: { rollback?: boolean }): Promise<void> {
    await this.turn({ action: opts?.rollback ? 'rollback' : 'end' })
  }

  /** Fail everything in flight (app shutdown). */
  dispose(): void {
    this.failAll('The tool bridge was shut down.')
    this.target = null
  }

  // ------------------------------------------------------------ internals

  private async turn(req: Omit<ToolTurnRequest, 'requestId'>): Promise<void> {
    const requestId = randomUUID()
    const notReady = await this.waitReady()
    if (notReady) {
      // Nothing to group or roll back when the editor is not there.
      if (req.action === 'begin') throw new Error(notReady)
      return
    }
    const reply = await this.roundTrip(requestId, IPC.toolsTurn, { requestId, ...req }, `Agent turn ${req.action}`)
    if (reply.kind === 'timeout') throw new Error(`The editor did not answer the agent turn "${req.action}" request in time.`)
    if (reply.kind === 'failed') throw new Error(reply.message)
    if (reply.kind === 'ok' && reply.payload.error) throw new Error(reply.payload.error)
  }

  /** Resolves to an error message when the renderer never became ready (or the call was aborted), else undefined. */
  private async waitReady(signal?: AbortSignal): Promise<string | undefined> {
    if (this.isReady()) return undefined
    if (signal?.aborted) return 'The call was cancelled before it started.'
    return new Promise<string | undefined>((resolve) => {
      const done = (msg?: string): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.readyWaiters = this.readyWaiters.filter((w) => w !== onReady)
        resolve(msg)
      }
      const onReady = (): void => done(this.isReady() ? undefined : 'The editor is not available.')
      const onAbort = (): void => done('The call was cancelled before the editor was ready.')
      const timer = setTimeout(() => done('The Chiptune Studio editor window is not ready (it did not report in). Open the app window and try again.'), this.readyTimeoutMs)
      this.readyWaiters.push(onReady)
      signal?.addEventListener('abort', onAbort, { once: true })
      // Ready may have flipped while setting up.
      if (this.isReady()) done()
    })
  }

  private roundTrip(
    requestId: string,
    channel: string,
    payload: unknown,
    _what: string,
    signal?: AbortSignal
  ): Promise<{ kind: 'ok'; payload: ToolResultPayload } | { kind: 'timeout' } | { kind: 'aborted' } | { kind: 'failed'; message: string }> {
    return new Promise((resolve) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(requestId)
      }
      const cancelRemote = (): void => {
        try {
          const cancel: ToolCancelRequest = { requestId }
          this.target?.send(IPC.toolsCancel, cancel)
        } catch {
          /* window gone */
        }
      }
      const onAbort = (): void => {
        cleanup()
        cancelRemote()
        resolve({ kind: 'aborted' })
      }
      this.pending.set(requestId, {
        resolve: (p) => {
          cleanup()
          // A synthetic failure (window gone) carries `error` and no result.
          resolve({ kind: 'ok', payload: p })
        }
      })
      const timer = setTimeout(() => {
        cleanup()
        cancelRemote()
        resolve({ kind: 'timeout' })
      }, this.timeoutMs)
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      try {
        if (!this.target) throw new Error('No editor window.')
        this.target.send(channel, payload)
      } catch (e) {
        cleanup()
        resolve({ kind: 'failed', message: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  private failAll(message: string): void {
    for (const [requestId, p] of [...this.pending]) p.resolve({ requestId, error: message })
  }
}
