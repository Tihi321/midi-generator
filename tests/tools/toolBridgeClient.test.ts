import { describe, expect, it } from 'vitest'
import { ToolBridge } from '../../src/main/toolBridge'
import { createIpcServices, startToolBridge } from '../../src/renderer/toolBridgeClient'
import { IPC, type ChiptuneStudioApi, type ToolResultPayload } from '../../src/shared/ipc'
import { setup } from './helpers'

/** Wire a ToolBridge (main) to startToolBridge (renderer) through a fake IPC. */
function wire() {
  const t = setup()
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const invoked: Array<{ channel: string; args: unknown[] }> = []
  const ref: { bridge: ToolBridge | null } = { bridge: null }
  const api: ChiptuneStudioApi = {
    invoke: async (channel, ...args) => {
      invoked.push({ channel, args })
      if (channel === IPC.toolsResult) ref.bridge!.handleResult(args[0] as ToolResultPayload)
      if (channel === IPC.toolsReady) ref.bridge!.handleReady()
      return undefined as never
    },
    on: (channel, cb) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), cb])
      return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((x) => x !== cb))
    }
  }
  const bridge = new ToolBridge({ target: { send: (c, p) => (listeners.get(c) ?? []).forEach((l) => l(p)) } })
  ref.bridge = bridge
  const stop = startToolBridge(t.registry, t.session, t.services, api)
  return { ...t, bridge, api, invoked, stop, listeners }
}

describe('renderer tool bridge client', () => {
  it('announces ready, runs tools and replies', async () => {
    const w = wire()
    expect(w.invoked[0]!.channel).toBe(IPC.toolsReady)
    expect(w.bridge.isReady()).toBe(true)
    const r = await w.bridge.execute('write_pattern', { note: 'C-4' }, new AbortController().signal)
    expect(r.isError).toBeFalsy()
    expect(w.state.notes).toEqual(['C-4'])
    const bad = await w.bridge.execute('write_pattern', {}, new AbortController().signal)
    expect(bad.isError).toBe(true)
  })

  it('opens and closes agent turns on the session', async () => {
    const w = wire()
    const sig = new AbortController().signal
    await w.bridge.beginTurn('Agent turn')
    expect(w.session.turnActive).toBe(true)
    await w.bridge.execute('write_pattern', { note: 'D-4' }, sig)
    await w.bridge.execute('write_pattern', { note: 'E-4' }, sig)
    await w.bridge.endTurn()
    expect(w.session.turnActive).toBe(false)
    expect(w.session.history.undoDepth).toBe(1)
    await w.bridge.beginTurn()
    await w.bridge.execute('write_pattern', { note: 'F-4' }, sig)
    await w.bridge.endTurn({ rollback: true })
    expect(w.session.history.undoDepth).toBe(1)
  })

  it('stops listening after stop()', async () => {
    const w = wire()
    w.stop()
    expect((w.listeners.get(IPC.toolsExecute) ?? []).length).toBe(0)
    expect((w.listeners.get(IPC.toolsTurn) ?? []).length).toBe(0)
    expect((w.listeners.get(IPC.toolsCancel) ?? []).length).toBe(0)
  })

  it('creates IPC-backed ToolServices', async () => {
    const calls: Array<{ channel: string; args: unknown[] }> = []
    const api: ChiptuneStudioApi = {
      invoke: async (channel, ...args) => {
        calls.push({ channel, args })
        if (channel === IPC.fsResolveExportPath) return '/x/exports/a.wav' as never
        if (channel === IPC.fsReadFile) return new Uint8Array([9]) as never
        return undefined as never
      },
      on: () => () => undefined
    }
    const s = createIpcServices(api)
    expect(await s.resolveExportPath('a.wav', 'sub')).toBe('/x/exports/a.wav')
    await s.writeFile('/x/a', 'data')
    expect(Array.from(await s.readFile('/x/a'))).toEqual([9])
    expect(calls.map((c) => c.channel)).toEqual([IPC.fsResolveExportPath, IPC.fsWriteFile, IPC.fsReadFile])
    expect(calls[0]!.args).toEqual(['a.wav', 'sub'])
  })
})
