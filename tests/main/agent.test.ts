import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockProvider } from '../../src/llm/mock'
import { collect } from '../../src/llm/types'
import type { ChatFn, ChatMessage } from '../../src/llm/types'
import { AgentRunner, chatTitle, isWritingTool, turnLabel, withAutoPreview } from '../../src/main/agent'
import { ChatHistoryStore } from '../../src/main/chatHistory'
import { replayChat } from '../../src/renderer/state/chatReducer'
import type { AgentUiEvent } from '../../src/shared/agent'
import type { ToolDef, ToolResult, TurnToolHost } from '../../src/shared/tools'

const def = (name: string): ToolDef => ({ name, description: name, parameters: { type: 'object', properties: {} } })
const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] })
const PNG: ToolResult = { content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }

interface FakeBridge extends TurnToolHost {
  log: string[]
  calls: { name: string; args: unknown }[]
  endArgs: ({ rollback?: boolean } | undefined)[]
  style: ToolResult
}

function makeBridge(names = ['get_song', 'write_pattern', 'render_preview', 'read_pattern'], opts: { turnError?: string } = {}): FakeBridge {
  const b: FakeBridge = {
    log: [],
    calls: [],
    endArgs: [],
    style: text('STYLE use db16'),
    tools: () => names.map(def),
    async execute(name, args) {
      b.calls.push({ name, args })
      if (name === 'get_song') return text('SONG nes 120bpm')
      if (name === 'get_style_context') return b.style
      if (name === 'render_preview') return PNG
      return text(`${name} ok`)
    },
    async beginTurn(label) {
      if (opts.turnError) throw new Error(opts.turnError)
      b.log.push(`begin:${label}`)
    },
    async endTurn(o) {
      b.log.push('end')
      b.endArgs.push(o)
    }
  }
  return b
}

function mockChat(mock: MockProvider): ChatFn {
  return async (messages, o = {}) => {
    const r = await collect(mock.chat({ model: 'mock', messages, tools: o.tools, toolChoice: o.toolChoice, schema: o.schema, signal: o.signal }), o.onDelta)
    return { ...r, costUsd: 0.5 }
  }
}

const content = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('|'))

describe('AgentRunner', () => {
  let mock: MockProvider
  let bridge: FakeBridge
  let events: AgentUiEvent[]
  let vision: boolean
  const make = (b = bridge) =>
    new AgentRunner({
      bridge: b,
      guide: 'GUIDE-TEXT',
      emit: (e) => events.push(e),
      resolveModel: async () => ({ source: { chat: mockChat(mock), capabilities: { tools: true, vision } }, vision })
    })

  beforeEach(() => {
    mock = new MockProvider('mock', { chunkDelayMs: 1 })
    bridge = makeBridge()
    events = []
    vision = false
  })

  it('builds the system prompt from the guide and the current song, and skips style context without the tool', async () => {
    mock.script(['hello'])
    const runner = make()
    expect(runner.send({ text: 'draw a tree' }).ok).toBe(true)
    await runner.whenIdle()
    const system = content(mock.requests[0]!.messages[0]!)
    expect(system).toContain('GUIDE-TEXT')
    expect(system).toContain('SONG nes 120bpm')
    expect(system).not.toContain('Style context')
    expect(bridge.calls.map((c) => c.name)).toEqual(['get_song'])
  })

  it('adds get_style_context when the tool exists', async () => {
    bridge = makeBridge(['get_song', 'get_style_context'])
    mock.script(['ok'])
    const runner = make()
    runner.send({ text: 'go' })
    await runner.whenIdle()
    expect(content(mock.requests[0]!.messages[0]!)).toContain('STYLE use db16')
  })

  it('puts the style reference images on the first user message of vision models only', async () => {
    for (const v of [true, false]) {
      vision = v
      bridge = makeBridge(['get_song', 'get_style_context'])
      bridge.style = { content: [{ type: 'text', text: 'STYLE use db16' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] }
      mock.reset()
      mock.script(['ok', 'again'])
      const runner = make()
      runner.send({ text: 'go' })
      await runner.whenIdle()
      const user = mock.requests[0]!.messages.find((m) => m.role === 'user')!
      if (v) expect(content(user)).toBe('go|Preview images of the style reference assets (same order as in the style context):|[image]')
      else expect(user.content).toBe('go')
      // later messages of the same conversation do not repeat the images
      runner.send({ text: 'next' })
      await runner.whenIdle()
      const second = mock.requests[1]!.messages.filter((m) => m.role === 'user').pop()!
      expect(second.content).toBe('next')
    }
  })

  it('leaves out the style context when the song has no references', async () => {
    bridge = makeBridge(['get_song', 'get_style_context'])
    bridge.style = text('No style references are set on this song.')
    mock.script(['ok'])
    const runner = make()
    runner.send({ text: 'go' })
    await runner.whenIdle()
    expect(content(mock.requests[0]!.messages[0]!)).not.toContain('Style context')
  })

  it('wraps the run in exactly one agent turn, ended without rollback', async () => {
    mock.script([{ toolCalls: [{ name: 'write_pattern', id: 'a' }, { name: 'write_pattern', id: 'b' }] }, 'done'])
    const runner = make()
    runner.send({ text: 'draw a big green tree with a trunk please now' })
    await runner.whenIdle()
    expect(bridge.log).toEqual(['begin:Agent: draw a big green tree with', 'end'])
    expect(bridge.endArgs).toEqual([{ rollback: false }])
    expect(bridge.calls.filter((c) => c.name === 'write_pattern')).toHaveLength(2)
  })

  it('forwards events and ends with a single done after the turn is closed', async () => {
    mock.script([{ text: 'Drawing', toolCalls: [{ name: 'write_pattern', id: 'a', args: { x: 1 } }], usage: { inputTokens: 10, outputTokens: 5 } }, 'All done'])
    const runner = make()
    const res = runner.send({ text: 'go' })
    if (!res.ok) throw new Error('send failed')
    await runner.whenIdle()
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('start')
    expect(types.filter((t) => t === 'done')).toHaveLength(1)
    expect(types[types.length - 1]).toBe('done')
    expect(events.every((e) => e.runId === res.runId)).toBe(true)
    expect(events.find((e) => e.type === 'tool_call')).toMatchObject({ name: 'write_pattern', args: { x: 1 } })
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ name: 'write_pattern', isError: false, summary: 'write_pattern ok' })
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('DrawingAll done')
    const done = events[events.length - 1] as Extract<AgentUiEvent, { type: 'done' }>
    expect(done).toMatchObject({ reason: 'completed', steps: 2, usage: { inputTokens: expect.any(Number) } })
    expect(done.costUsd).toBeCloseTo(1)
    expect(bridge.log[bridge.log.length - 1]).toBe('end')
  })

  it('appends a preview image after writing tools for vision models only', async () => {
    for (const v of [true, false]) {
      vision = v
      events = []
      bridge.calls.length = 0
      mock.reset()
      mock.script([{ toolCalls: [{ name: 'write_pattern', id: 'a' }, { name: 'read_pattern', id: 'b' }] }, 'ok'])
      const runner = make()
      runner.send({ text: 'go' })
      await runner.whenIdle()
      const results = events.filter((e) => e.type === 'tool_result') as Extract<AgentUiEvent, { type: 'tool_result' }>[]
      expect(results[0]!.image, `vision=${v}`).toBe(v ? 'data:image/png;base64,AAAA' : undefined)
      expect(results[1]!.image).toBeUndefined()
      expect(bridge.calls.filter((c) => c.name === 'render_preview')).toHaveLength(v ? 1 : 0)
    }
  })

  it('rejects a second send while running, and stop aborts the run (work kept, no rollback)', async () => {
    mock.script([{ text: 'x'.repeat(200), chunks: 200, chunkDelayMs: 20 }])
    const runner = make()
    expect(runner.send({ text: 'first' }).ok).toBe(true)
    expect(runner.getState().running).toBe(true)
    const second = runner.send({ text: 'second' })
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/still working/) })
    await new Promise((r) => setTimeout(r, 30))
    runner.stop()
    await runner.whenIdle()
    expect(runner.getState().running).toBe(false)
    const done = events[events.length - 1] as Extract<AgentUiEvent, { type: 'done' }>
    expect(done.reason).toBe('aborted')
    expect(bridge.endArgs).toEqual([{ rollback: false }])
    // idle again: a new send works
    mock.reset()
    mock.script(['fine'])
    expect(runner.send({ text: 'third' }).ok).toBe(true)
    await runner.whenIdle()
  })

  it('keeps the conversation between turns and clears it on reset', async () => {
    mock.script(['first answer', 'second answer'])
    const runner = make()
    runner.send({ text: 'one' })
    await runner.whenIdle()
    expect(runner.getState().messageCount).toBe(2)
    runner.send({ text: 'two' })
    await runner.whenIdle()
    const second = mock.requests[1]!.messages.map((m) => `${m.role}:${content(m)}`)
    expect(second.slice(1)).toEqual(['user:one', 'assistant:first answer', 'user:two'])
    expect(runner.getState().messageCount).toBe(4)
    expect(runner.reset().messageCount).toBe(0)
    mock.script(['fresh'])
    runner.send({ text: 'three' })
    await runner.whenIdle()
    expect(mock.requests[2]!.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('rolls back and forgets a turn that ends in an error', async () => {
    mock.script([() => Promise.reject(new Error('provider down'))])
    const runner = make()
    runner.send({ text: 'go' })
    await runner.whenIdle()
    expect(bridge.endArgs).toEqual([{ rollback: true }])
    expect(runner.getState().messageCount).toBe(0)
    expect(events.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringContaining('provider down') })
    expect(events[events.length - 1]).toMatchObject({ type: 'done', reason: 'error', error: expect.stringContaining('provider down') })
  })

  it('reports a turn that cannot start (editor not available) as an error without calling the model', async () => {
    bridge = makeBridge(undefined, { turnError: 'The editor is not available.' })
    const runner = make()
    runner.send({ text: 'go' })
    await runner.whenIdle()
    expect(mock.requests).toHaveLength(0)
    expect(events[events.length - 1]).toMatchObject({ type: 'done', reason: 'error', error: 'The editor is not available.' })
    expect(runner.getState().running).toBe(false)
  })

  it('reset during a run aborts it and drops its messages', async () => {
    mock.script([{ text: 'y'.repeat(100), chunks: 100, chunkDelayMs: 20 }])
    const runner = make()
    runner.send({ text: 'go' })
    await new Promise((r) => setTimeout(r, 30))
    runner.reset()
    await runner.whenIdle()
    expect(runner.getState().messageCount).toBe(0)
  })

  it('rejects an empty message', () => {
    expect(make().send({ text: '   ' })).toMatchObject({ ok: false })
  })
})

describe('chat history', () => {
  let dir: string
  let mock: MockProvider
  let events: AgentUiEvent[]
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ps-chats-'))
    mock = new MockProvider('mock', { chunkDelayMs: 1 })
    events = []
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))
  const make = (chats: ChatHistoryStore) =>
    new AgentRunner({
      bridge: makeBridge(),
      guide: 'G',
      emit: (e) => events.push(e),
      resolveModel: async () => ({ source: { chat: mockChat(mock), capabilities: { tools: true, vision: false } }, vision: false }),
      chats
    })

  it('saves a chat after every turn, lists it, and continues it after a restart', async () => {
    mock.script([{ text: 'first answer', chunks: 4 }, 'second answer', 'third answer'])
    const runner = make(new ChatHistoryStore(dir))
    expect(await runner.listChats()).toEqual([])
    const chatId = runner.getState().chatId
    runner.send({ text: 'draw a red  tree please' })
    await runner.whenIdle()
    runner.send({ text: 'make it bigger' })
    await runner.whenIdle()
    expect(await runner.listChats()).toMatchObject([{ id: chatId, title: 'draw a red tree please', turns: 2 }])
    // the streamed answer is kept as one text event, and `done` reached the panel after the save
    const saved = await new ChatHistoryStore(dir).load(chatId)
    expect(saved.events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual(['first answer', 'second answer'])
    expect(events[events.length - 1]).toMatchObject({ type: 'done' })

    // a new runner (the app restarted) opens it: same transcript, and the model gets the earlier messages
    const again = make(new ChatHistoryStore(dir))
    expect(again.getState().chatId).not.toBe(chatId)
    const opened = await again.openChat(chatId)
    expect(opened.state).toMatchObject({ chatId, messageCount: 4 })
    const shown = replayChat(opened.events)
    expect(shown.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(shown.running).toBe(false)
    again.send({ text: 'and add apples' })
    await again.whenIdle()
    expect(mock.requests[2]!.messages.slice(1).map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    expect((await again.listChats())[0]).toMatchObject({ id: chatId, turns: 3 })
  })

  it('a new chat is saved separately; deleting the current chat starts a new one', async () => {
    mock.script(['a', 'b'])
    const chats = new ChatHistoryStore(dir)
    const runner = make(chats)
    runner.send({ text: 'one' })
    await runner.whenIdle()
    const first = runner.getState().chatId
    runner.reset()
    expect(await readdir(dir)).toHaveLength(1) // an empty conversation is not saved
    runner.send({ text: 'two' })
    await runner.whenIdle()
    const second = runner.getState().chatId
    expect((await runner.listChats()).map((c) => c.id)).toEqual([second, first])
    const st = await runner.deleteChat(second)
    expect(st.chatId).not.toBe(second)
    expect(st.messageCount).toBe(0)
    expect((await runner.listChats()).map((c) => c.id)).toEqual([first])
    await expect(runner.openChat('../evil')).rejects.toThrow(/Not a chat id/)
  })

  it('skips files that are not chats, and refuses to open one while a turn runs', async () => {
    await writeFile(path.join(dir, 'junk.json'), '{"x":1}', 'utf8')
    mock.script(['a', { text: 'y'.repeat(50), chunks: 50, chunkDelayMs: 10 }])
    const runner = make(new ChatHistoryStore(dir))
    runner.send({ text: 'one' })
    await runner.whenIdle()
    const id = runner.getState().chatId
    expect((await runner.listChats()).map((c) => c.id)).toEqual([id])
    runner.send({ text: 'two' })
    await expect(runner.openChat(id)).rejects.toThrow(/still working/)
    await expect(runner.deleteChat(id)).rejects.toThrow(/Stop it first/)
    runner.stop()
    await runner.whenIdle()
  })

  it('a title is the first words of the first message', () => {
    expect(chatTitle('  a\n tree ')).toBe('a tree')
    expect(chatTitle('x'.repeat(80))).toHaveLength(60)
    expect(chatTitle('')).toBe('Chat')
  })
})

describe('withAutoPreview', () => {
  const signal = new AbortController().signal
  function host(names = ['write_pattern', 'write_melody', 'render_preview', 'read_pattern', 'get_song'], fail: string[] = []) {
    const calls: string[] = []
    const h = {
      tools: () => names.map(def),
      async execute(name: string): Promise<ToolResult> {
        calls.push(name)
        if (name === 'render_preview') return PNG
        if (fail.includes(name)) return { content: [{ type: 'text', text: 'boom' }], isError: true }
        return text(`${name} ok`)
      }
    }
    return { h, calls }
  }
  const hasImage = (r: ToolResult): boolean => r.content.some((c) => c.type === 'image')

  it('classifies writing tools', () => {
    for (const n of ['write_pattern', 'write_melody', 'write_drums', 'set_cells', 'clear_pattern', 'copy_pattern', 'transpose', 'place_asset']) expect(isWritingTool(n), n).toBe(true)
    for (const n of ['get_song', 'read_pattern', 'render_preview', 'list_presets', 'undo']) expect(isWritingTool(n), n).toBe(false)
  })

  it('returns the host itself when disabled', () => {
    const { h } = host()
    expect(withAutoPreview(h, false)).toBe(h)
  })

  it('appends a render_preview image to writing tools only', async () => {
    const { h, calls } = host()
    const w = withAutoPreview(h, true)
    expect(hasImage(await w.execute('write_pattern', {}, signal))).toBe(true)
    expect(hasImage(await w.execute('write_melody', {}, signal))).toBe(true)
    expect(calls.filter((c) => c === 'render_preview')).toHaveLength(2)
    expect(hasImage(await w.execute('read_pattern', {}, signal))).toBe(false)
    expect(hasImage(await w.execute('get_song', {}, signal))).toBe(false)
    expect(calls.filter((c) => c === 'render_preview')).toHaveLength(2)
    expect(w.tools()).toEqual(h.tools())
  })

  it('skips the preview when the draw failed, was aborted, or the host has no render_preview', async () => {
    const failing = host(undefined, ['write_pattern'])
    expect(hasImage(await withAutoPreview(failing.h, true).execute('write_pattern', {}, signal))).toBe(false)
    expect(failing.calls).toEqual(['write_pattern'])
    const none = host(['write_pattern'])
    expect(hasImage(await withAutoPreview(none.h, true).execute('write_pattern', {}, signal))).toBe(false)
    const ac = new AbortController()
    ac.abort()
    const aborted = host()
    expect(hasImage(await withAutoPreview(aborted.h, true).execute('write_pattern', {}, ac.signal))).toBe(false)
    expect(aborted.calls).toEqual(['write_pattern'])
  })
})

describe('turnLabel', () => {
  it('uses the first words of the prompt', () => {
    expect(turnLabel('  draw   a knight  ')).toBe('Agent: draw a knight')
    expect(turnLabel('')).toBe('Agent: turn')
    expect(turnLabel('x'.repeat(100)).length).toBeLessThanOrEqual('Agent: '.length + 40)
  })
})
