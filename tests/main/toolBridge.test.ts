import { describe, expect, it, vi } from 'vitest'
import { ToolBridge } from '../../src/main/toolBridge'
import { IPC } from '../../src/shared/ipc'
import { createDefaultRegistry } from '../../src/tools'
import type { ToolCancelRequest, ToolExecuteRequest, ToolTurnRequest } from '../../src/shared/ipc'

interface Sent {
  channel: string
  payload: unknown
}

function fake() {
  const sent: Sent[] = []
  const target = { send: (channel: string, payload: unknown) => void sent.push({ channel, payload }) }
  const bridge = new ToolBridge({
    target,
    assumeReady: true,
    timeoutMs: 1000,
    readyTimeoutMs: 500,
    tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }]
  })
  const last = <T>(channel: string): T => [...sent].reverse().find((s) => s.channel === channel)!.payload as T
  return { sent, target, bridge, last }
}

const text = (s: string) => ({ content: [{ type: 'text' as const, text: s }] })

describe('ToolBridge', () => {
  it('sends tools:execute and resolves with the matching reply', async () => {
    const { bridge, last, sent } = fake()
    const p1 = bridge.execute('write_pattern', { a: 1 }, new AbortController().signal)
    const p2 = bridge.execute('read_pattern', {}, new AbortController().signal)
    await Promise.resolve()
    const reqs = sent.map((s) => s.payload as ToolExecuteRequest)
    expect(reqs.map((r) => r.name)).toEqual(['write_pattern', 'read_pattern'])
    expect(reqs[0]!.args).toEqual({ a: 1 })
    expect(reqs[0]!.requestId).not.toBe(reqs[1]!.requestId)
    // answer out of order
    bridge.handleResult({ requestId: reqs[1]!.requestId, result: text('second') })
    bridge.handleResult({ requestId: reqs[0]!.requestId, result: text('first') })
    expect((await p1).content[0]).toEqual({ type: 'text', text: 'first' })
    expect((await p2).content[0]).toEqual({ type: 'text', text: 'second' })
    expect(last<ToolExecuteRequest>(IPC.toolsExecute).name).toBe('read_pattern')
    // late / unknown replies are ignored
    bridge.handleResult({ requestId: 'nope', result: text('x') })
  })

  it('turns a renderer-level error into an error result', async () => {
    const { bridge, last } = fake()
    const p = bridge.execute('x', {}, new AbortController().signal)
    await Promise.resolve()
    bridge.handleResult({ requestId: last<ToolExecuteRequest>(IPC.toolsExecute).requestId, error: 'boom' })
    const r = await p
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toContain('boom')
  })

  it('times out, sends tools:cancel and ignores a late reply', async () => {
    vi.useFakeTimers()
    try {
      const { bridge, last } = fake()
      const p = bridge.execute('slow', {}, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(0)
      const id = last<ToolExecuteRequest>(IPC.toolsExecute).requestId
      await vi.advanceTimersByTimeAsync(1001)
      const r = await p
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r)).toMatch(/timed out/)
      expect(last<ToolCancelRequest>(IPC.toolsCancel).requestId).toBe(id)
      bridge.handleResult({ requestId: id, result: text('late') })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses a 60 s timeout by default', async () => {
    vi.useFakeTimers()
    try {
      const sent: Sent[] = []
      const bridge = new ToolBridge({ target: { send: (c, p) => void sent.push({ channel: c, payload: p }) }, assumeReady: true })
      const p = bridge.execute('slow', {}, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(sent.some((s) => s.channel === IPC.toolsCancel)).toBe(false)
      await vi.advanceTimersByTimeAsync(1_500)
      expect((await p).isError).toBe(true)
      expect(sent.some((s) => s.channel === IPC.toolsCancel)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('abort sends tools:cancel and resolves with an error result', async () => {
    const { bridge, last } = fake()
    const c = new AbortController()
    const p = bridge.execute('x', {}, c.signal)
    await Promise.resolve()
    const id = last<ToolExecuteRequest>(IPC.toolsExecute).requestId
    c.abort()
    const r = await p
    expect(r.isError).toBe(true)
    expect(last<ToolCancelRequest>(IPC.toolsCancel).requestId).toBe(id)
  })

  it('an already-aborted signal sends nothing to the renderer', async () => {
    const { bridge, sent } = fake()
    const c = new AbortController()
    c.abort()
    const r = await bridge.execute('x', {}, c.signal)
    expect(r.isError).toBe(true)
    expect(sent.some((s) => s.channel === IPC.toolsExecute)).toBe(false)
  })

  it('beginTurn / endTurn use tools:turn and wait for the reply', async () => {
    const { bridge, sent } = fake()
    const begin = bridge.beginTurn('Agent turn')
    await Promise.resolve()
    const b = sent[0]!.payload as ToolTurnRequest
    expect(sent[0]!.channel).toBe(IPC.toolsTurn)
    expect(b).toMatchObject({ action: 'begin', label: 'Agent turn' })
    bridge.handleResult({ requestId: b.requestId })
    await begin
    const end = bridge.endTurn({ rollback: true })
    await Promise.resolve()
    const e = sent[1]!.payload as ToolTurnRequest
    expect(e.action).toBe('rollback')
    bridge.handleResult({ requestId: e.requestId })
    await end
    const end2 = bridge.endTurn()
    await Promise.resolve()
    expect((sent[2]!.payload as ToolTurnRequest).action).toBe('end')
    bridge.handleResult({ requestId: (sent[2]!.payload as ToolTurnRequest).requestId, error: 'bad' })
    await expect(end2).rejects.toThrow('bad')
  })

  it('queues calls until the renderer reports ready', async () => {
    const sent: Sent[] = []
    const bridge = new ToolBridge({ target: { send: (c, p) => void sent.push({ channel: c, payload: p }) }, timeoutMs: 1000, readyTimeoutMs: 500 })
    const p = bridge.execute('x', {}, new AbortController().signal)
    await Promise.resolve()
    expect(sent).toHaveLength(0)
    bridge.handleReady()
    await Promise.resolve()
    await Promise.resolve()
    expect(sent).toHaveLength(1)
    bridge.handleResult({ requestId: (sent[0]!.payload as ToolExecuteRequest).requestId, result: text('ok') })
    expect((await p).isError).toBeFalsy()
  })

  it('fails with a clear error when the renderer never becomes ready', async () => {
    vi.useFakeTimers()
    try {
      const bridge = new ToolBridge({ target: { send: () => undefined }, readyTimeoutMs: 500 })
      const p = bridge.execute('x', {}, new AbortController().signal)
      await vi.advanceTimersByTimeAsync(501)
      const r = await p
      expect(r.isError).toBe(true)
      expect(JSON.stringify(r)).toMatch(/not ready/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('setTarget resets readiness and fails calls in flight', async () => {
    const { bridge, target } = fake()
    const p = bridge.execute('x', {}, new AbortController().signal)
    await Promise.resolve()
    bridge.setTarget(target)
    expect(bridge.isReady()).toBe(false)
    const r = await p
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toMatch(/reloaded/)
  })

  it('reports a send failure as an error result', async () => {
    const bridge = new ToolBridge({
      target: {
        send: () => {
          throw new Error('destroyed')
        }
      },
      assumeReady: true
    })
    const r = await bridge.execute('x', {}, new AbortController().signal)
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toContain('destroyed')
  })

  it('registers the reply channels on an ipc object', async () => {
    const { bridge, last } = fake()
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    bridge.registerIpc({ handle: (c, l) => void handlers.set(c, l) })
    expect([...handlers.keys()].sort()).toEqual([IPC.toolsReady, IPC.toolsResult].sort())
    const p = bridge.execute('x', {}, new AbortController().signal)
    await Promise.resolve()
    handlers.get(IPC.toolsResult)!({}, { requestId: last<ToolExecuteRequest>(IPC.toolsExecute).requestId, result: text('via ipc') })
    expect(JSON.stringify(await p)).toContain('via ipc')
  })

  it('advertises the default registry tools when none are injected', () => {
    const names = new ToolBridge().tools().map((t) => t.name)
    expect(names.length).toBe(createDefaultRegistry().list().length)
    expect(names.length).toBeGreaterThanOrEqual(35)
    for (const n of ['get_song', 'new_song', 'write_pattern', 'write_melody', 'write_drums', 'render_preview', 'export_wav']) expect(names).toContain(n)
  })
})
