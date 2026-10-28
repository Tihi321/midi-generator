import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_RESULT_NUDGES, NO_TOOLS_REFUSAL, runAgent, toolResultContent } from '../../src/llm/agent'
import type { AgentEvent, ResultCheck, ToolHost, ToolResult } from '../../src/llm/agent'
import { MockProvider } from '../../src/llm/mock'
import type { MockReply } from '../../src/llm/mock'
import { ModelRegistry } from '../../src/llm/registry'
import { ModelRouter } from '../../src/llm/router'
import { collect } from '../../src/llm/types'
import type { ChatFn, ChatMessage, ChatResult, ToolDef } from '../../src/llm/types'

const toolDefs: ToolDef[] = [
  { name: 'draw', description: 'Draws', parameters: { type: 'object', properties: { n: { type: 'number' } } } },
  { name: 'preview', description: 'Renders a preview image', parameters: { type: 'object', properties: {} } }
]

/** A host that records its calls. `handlers` override what a tool does. */
function makeHost(handlers: Record<string, (args: unknown, signal: AbortSignal) => Promise<ToolResult> | ToolResult> = {}) {
  const calls: { name: string; args: unknown }[] = []
  const host: ToolHost = {
    tools: () => toolDefs,
    async execute(name, args, signal) {
      calls.push({ name, args })
      const h = handlers[name]
      return h ? h(args, signal) : { content: [{ type: 'text', text: `${name} ok` }] }
    }
  }
  return { host, calls }
}

/** A ChatFn straight over a scripted mock provider. */
function mockChat(mock: MockProvider): ChatFn {
  return async (messages, o = {}) => {
    const r = await collect(mock.chat({ model: 'mock', messages, tools: o.tools, toolChoice: o.toolChoice, schema: o.schema, signal: o.signal }), o.onDelta)
    return { ...r, costUsd: 0 }
  }
}

const text = (m: ChatMessage) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('|'))

describe('agent loop, native tool calling', () => {
  let mock: MockProvider
  beforeEach(() => {
    mock = new MockProvider('mock', { chunkDelayMs: 1 })
  })
  const native = { capabilities: { tools: true, vision: false } }

  it('runs the tools the model asks for, feeds the results back and stops when it answers in text', async () => {
    mock.script([
      { text: 'Starting. ', toolCalls: [{ name: 'draw', args: { n: 1 }, id: 'c1' }, { name: 'draw', args: { n: 2 }, id: 'c2' }] },
      { toolCalls: [{ name: 'preview', id: 'c3' }] },
      'All done.'
    ])
    const { host, calls } = makeHost()
    const events: AgentEvent[] = []
    const res = await runAgent({
      chat: mockChat(mock),
      ...native,
      system: 'You draw.',
      history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'yes' }],
      userMessage: 'draw two things',
      host,
      onEvent: (e) => events.push(e)
    })
    expect(res.reason).toBe('completed')
    expect(res.steps).toBe(3)
    expect(calls).toEqual([
      { name: 'draw', args: { n: 1 } },
      { name: 'draw', args: { n: 2 } },
      { name: 'preview', args: {} }
    ])
    // event order
    expect(events.map((e) => e.type).filter((t) => t !== 'usage' && t !== 'text')).toEqual([
      'step', 'tool_call', 'tool_result', 'tool_call', 'tool_result',
      'step', 'tool_call', 'tool_result',
      'step', 'done'
    ])
    expect(events.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : '')).join('')).toBe('Starting. All done.')
    const done = events.at(-1)!
    expect(done.type === 'done' && done.messages).toBe(res.messages)
    // messages: history + user + (assistant + 2 tool) + (assistant + tool) + assistant
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant'])
    expect(res.messages[3]).toMatchObject({ role: 'assistant', content: 'Starting. ', toolCalls: [{ id: 'c1', name: 'draw' }, { id: 'c2', name: 'draw' }] })
    expect(res.messages[4]).toMatchObject({ role: 'tool', toolCallId: 'c1', name: 'draw', content: 'draw ok' })
    // the model saw the system prompt, the tools and the earlier results
    const last = mock.requests.at(-1)!
    expect(last.messages[0]).toEqual({ role: 'system', content: 'You draw.' })
    expect(last.tools?.map((t) => t.name)).toEqual(['draw', 'preview'])
    expect(last.messages.filter((m) => m.role === 'tool')).toHaveLength(3)
    expect(mock.requests).toHaveLength(3)
    expect(res.usage.outputTokens).toBeGreaterThan(0)
  })

  it('tool errors go back to the model as error results; unknown tools and bad arguments too', async () => {
    mock.script([
      { toolCalls: [{ name: 'draw', id: 'a' }, { name: 'preview', id: 'b' }, { name: 'nope', id: 'c' }] },
      'recovered'
    ])
    const { host } = makeHost({
      draw: () => {
        throw new Error('canvas is locked')
      },
      preview: () => ({ content: [{ type: 'text', text: 'layer missing' }], isError: true })
    })
    const events: AgentEvent[] = []
    const res = await runAgent({ chat: mockChat(mock), ...native, system: 's', userMessage: 'go', host, onEvent: (e) => events.push(e) })
    expect(res.reason).toBe('completed')
    const tools = res.messages.filter((m) => m.role === 'tool')
    expect(tools.map((m) => [m.role === 'tool' && m.isError, text(m)])).toEqual([
      [true, 'Tool draw failed: canvas is locked'],
      [true, 'layer missing'],
      [true, 'Unknown tool "nope". Available tools: draw, preview']
    ])
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.type === 'tool_result' && e.isError)).toEqual([true, true, true])
    expect(res.error).toBeUndefined()
  })

  it('arguments that were not valid JSON are an error result, the tool does not run', async () => {
    let n = 0
    const base = { usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }, costUsd: 0 }
    const chat: ChatFn = async (): Promise<ChatResult> =>
      n++ === 0
        ? { ...base, text: '', toolCalls: [{ id: 'x', name: 'draw', args: {} }], argErrors: { x: 'arguments are not valid JSON' }, finishReason: 'tool_calls' }
        : { ...base, text: 'ok', toolCalls: [], argErrors: {}, finishReason: 'stop' }
    const { host, calls } = makeHost()
    const res = await runAgent({ chat, ...native, system: 's', userMessage: 'go', host })
    expect(calls).toEqual([])
    expect(text(res.messages.find((m) => m.role === 'tool')!)).toMatch(/Invalid arguments for draw: arguments are not valid JSON/)
  })

  it('stops at maxSteps', async () => {
    mock.onAny({ toolCalls: [{ name: 'draw' }] })
    const { host, calls } = makeHost()
    const events: AgentEvent[] = []
    const res = await runAgent({ chat: mockChat(mock), ...native, system: 's', userMessage: 'go', host, maxSteps: 3, onEvent: (e) => events.push(e) })
    expect(res.reason).toBe('max_steps')
    expect(res.steps).toBe(3)
    expect(calls).toHaveLength(3)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'max_steps' })
    // every tool call has its result, so the history is valid to continue from
    expect(res.messages.filter((m) => m.role === 'assistant')).toHaveLength(3)
    expect(res.messages.filter((m) => m.role === 'tool')).toHaveLength(3)
  })

  it('abort during a tool: the rest of the calls are cancelled, the history stays valid', async () => {
    mock.script([{ toolCalls: [{ name: 'draw', id: 'a' }, { name: 'draw', id: 'b' }] }, 'never'])
    const ac = new AbortController()
    const { host, calls } = makeHost({
      draw: (_a, signal) =>
        new Promise((_resolve, reject) => {
          setTimeout(() => ac.abort(), 5)
          signal.addEventListener('abort', () => reject(new Error('stopped')))
        })
    })
    const res = await runAgent({ chat: mockChat(mock), ...native, system: 's', userMessage: 'go', host, signal: ac.signal })
    expect(res.reason).toBe('aborted')
    expect(calls).toHaveLength(1)
    const tools = res.messages.filter((m) => m.role === 'tool')
    expect(tools.map((m) => m.role === 'tool' && m.toolCallId)).toEqual(['a', 'b'])
    expect(text(tools[1]!)).toMatch(/aborted/)
    expect(mock.requests).toHaveLength(1)
  })

  it('abort while the model is answering ends the run as aborted', async () => {
    mock.onAny({ text: 'x'.repeat(200), chunks: 20, chunkDelayMs: 20 })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    const events: AgentEvent[] = []
    const res = await runAgent({ chat: mockChat(mock), ...native, system: 's', userMessage: 'go', host: makeHost().host, signal: ac.signal, onEvent: (e) => events.push(e) })
    expect(res.reason).toBe('aborted')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'done', reason: 'aborted' })
    // already aborted before it starts
    const again = await runAgent({ chat: mockChat(mock), ...native, system: 's', userMessage: 'go', host: makeHost().host, signal: ac.signal })
    expect(again.reason).toBe('aborted')
    expect(again.steps).toBe(0)
  })

  it('a provider failure ends the run with an error event, and the conversation so far is returned', async () => {
    const chat: ChatFn = async () => {
      throw new Error('HTTP 500: boom')
    }
    const events: AgentEvent[] = []
    const res = await runAgent({ chat, ...native, system: 's', userMessage: 'go', host: makeHost().host, onEvent: (e) => events.push(e) })
    expect(res.reason).toBe('error')
    expect(res.error?.message).toMatch(/boom/)
    expect(events.map((e) => e.type)).toEqual(['step', 'error', 'done'])
    expect(res.messages).toEqual([{ role: 'user', content: 'go' }])
  })

  it('images in tool results: shown to vision models, replaced by a note otherwise; long text is cut', async () => {
    const image: ToolResult = { content: [{ type: 'text', text: 'rendered' }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }] }
    for (const vision of [false, true]) {
      const m = new MockProvider('mock', { chunkDelayMs: 1 })
      m.script([{ toolCalls: [{ name: 'preview', id: 'p' }] }, 'seen'])
      const { host } = makeHost({ preview: () => image })
      const events: AgentEvent[] = []
      const res = await runAgent({ chat: mockChat(m), capabilities: { tools: true, vision }, system: 's', userMessage: 'go', host, onEvent: (e) => events.push(e) })
      const tool = res.messages.find((x) => x.role === 'tool')!
      if (vision) {
        expect(tool.content).toEqual([{ type: 'text', text: 'rendered' }, { type: 'image', mimeType: 'image/png', data: 'QUJD' }])
      } else {
        expect(typeof tool.content).toBe('string')
        expect(text(tool)).toMatch(/^rendered\n\[image omitted: this model cannot view images/)
      }
      // the event still carries the original result for the UI
      expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ result: image })
    }
    expect(toolResultContent({ content: [{ type: 'text', text: 'abcdefghij' }] }, false, 4)).toBe('abcd\n...[truncated 6 more characters]')
    expect(toolResultContent({ content: [] }, true, 10)).toBe('(no output)')
  })

  it('picks the model by role through the router: the first model decides the mode', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ps-agent-'))
    try {
      await writeFile(
        path.join(dir, 'providers.md'),
        '---\nkind: providers\nproviders:\n  - id: mock\n    kind: mock\n    models:\n      - id: native\n        tools: true\n      - id: plain\n        tools: false\n      - id: native2\n        tools: true\n---\n'
      )
      await writeFile(path.join(dir, 'roles.md'), '---\nkind: roles\nroles:\n  composer:\n    models: [mock/native, mock/plain, mock/native2]\n  empty:\n    models: []\n---\n')
      const registry = new ModelRegistry(dir, { mock })
      await registry.load()
      const router = new ModelRouter(registry)
      mock.script([{ toolCalls: [{ name: 'draw', args: { n: 7 } }] }, 'done'])
      const { host, calls } = makeHost()
      const res = await runAgent({ router, role: 'composer', system: 's', userMessage: 'go', host })
      expect(res.reason).toBe('completed')
      expect(calls).toEqual([{ name: 'draw', args: { n: 7 } }])
      expect(res.model).toBe('mock/native')
      expect(mock.requests[0]!.tools).toHaveLength(2)
      // the user's own pick goes first and decides the mode
      mock.reset()
      mock.onAny('{"actions":[],"done":true}')
      const res2 = await runAgent({ router, role: 'composer', modelRef: 'mock/plain', system: 's', userMessage: 'go', host })
      expect(res2.reason).toBe('completed')
      expect(mock.requests[0]!.tools).toBeUndefined()
      // no model for the role
      const res3 = await runAgent({ router, role: 'empty', system: 's', userMessage: 'go', host })
      expect(res3).toMatchObject({ reason: 'error', steps: 0 })
      expect(res3.error?.message).toMatch(/no available model/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('agent loop, JSON-action fallback', () => {
  const json = { capabilities: { tools: false, vision: false } }
  const reply = (o: object): MockReply => JSON.stringify(o)

  it('describes the tools in the system prompt, runs the actions and feeds the results back as user messages', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([
      reply({ say: 'Drawing now', actions: [{ tool: 'draw', args: { n: 1 } }, { tool: 'preview', args: {} }], done: false }),
      reply({ say: 'Finished', actions: [], done: true })
    ])
    const { host, calls } = makeHost()
    const events: AgentEvent[] = []
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 'You draw.', userMessage: 'go', host, onEvent: (e) => events.push(e) })
    expect(res.reason).toBe('completed')
    expect(res.steps).toBe(2)
    expect(calls).toEqual([{ name: 'draw', args: { n: 1 } }, { name: 'preview', args: {} }])
    // no native tools are sent; the tools are in the system prompt
    const first = mock.requests[0]!
    expect(first.tools).toBeUndefined()
    const sys = text(first.messages[0]!)
    expect(sys).toContain('You draw.')
    expect(sys).toContain('- draw: Draws')
    expect(sys).toContain('- preview: Renders a preview image')
    expect(sys).toMatch(/"actions"/)
    // the results came back as a user message
    const second = mock.requests[1]!
    expect(second.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(text(second.messages.at(-1)!)).toBe('Results of your actions:\n#1 draw:\ndraw ok\n#2 preview:\npreview ok')
    expect(events.filter((e) => e.type === 'text').map((e) => e.type === 'text' && e.text)).toEqual(['Drawing now', 'Finished'])
    expect(events.filter((e) => e.type === 'tool_call').map((e) => e.type === 'tool_call' && e.id)).toEqual(['json_1_0', 'json_1_1'])
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(res.messages.some((m) => m.role === 'tool')).toBe(false)
  })

  it('done: true with actions runs them and stops; an unknown tool is an error result; errors are reported to the model', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([
      reply({ actions: [{ tool: 'bogus', args: {} }, { tool: 'draw', args: {} }], done: false }),
      reply({ actions: [{ tool: 'draw', args: { n: 2 } }], done: true }),
      reply({ actions: [], done: true })
    ])
    const { host, calls } = makeHost({ draw: (a) => ((a as { n?: number }).n === 2 ? { content: [{ type: 'text', text: 'bad' }], isError: true } : { content: [{ type: 'text', text: 'fine' }] }) })
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host })
    expect(res.reason).toBe('completed')
    expect(res.steps).toBe(4) // the failed last action sent it back twice before the model could end (MDI-08)
    expect(calls).toHaveLength(2)
    expect(text(mock.requests[1]!.messages.at(-1)!)).toMatch(/#1 bogus \(error\):\nUnknown tool "bogus"[^\n]*\n#2 draw:\nfine/)
    expect(text(res.messages.find((m) => m.role === 'user' && text(m).includes('#1 draw (error):\nbad'))!)).toMatch(/Your last action failed/)
  })

  it('repairs a reply that is not JSON, and takes JSON out of a code fence', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script(['I will draw something!', '```json\n{"say":"ok","actions":[],"done":true}\n```'])
    const events: AgentEvent[] = []
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host: makeHost().host, onEvent: (e) => events.push(e) })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(2) // the repair retry
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: 'ok' }])
  })

  it('repairs a broken reply twice before giving up, and tells the model its JSON actions are not host tool calls (MDI-08)', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script(['{"say": "a" "b"}', '{"say": broken', '{"say":"ok","actions":[],"done":true}'])
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host: makeHost().host })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(3)
    expect(text(mock.requests[0]!.messages[0]!)).toMatch(/run by this application, not by your own host/)
    const bad = new MockProvider('mock', { chunkDelayMs: 1 })
    bad.onAny('not json at all')
    const res2 = await runAgent({ chat: mockChat(bad), ...json, system: 's', userMessage: 'go', host: makeHost().host })
    expect(res2.reason).toBe('error')
    expect(res2.error?.message).toMatch(/after two repair attempts/)
    expect(bad.requests).toHaveLength(3)
  })

  it('nudges a model that refuses on its first JSON reply, at most twice and never after an action ran', async () => {
    const refuse = reply({ say: "I can't modify the song because this request disallows tool calls.", actions: [], done: true })
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([refuse, reply({ actions: [{ tool: 'draw', args: {} }], done: false }), reply({ actions: [], done: true })])
    const { host, calls } = makeHost({ draw: () => ({ content: [{ type: 'text', text: 'fine' }] }) })
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host })
    expect(res.reason).toBe('completed')
    expect(calls).toHaveLength(1)
    expect(mock.requests).toHaveLength(3)
    expect(text(mock.requests[1]!.messages.at(-1)!)).toMatch(/plain-text JSON protocol/)
    // two refusals in a row: nudged twice, then the run ends
    const stubborn = new MockProvider('mock', { chunkDelayMs: 1 })
    stubborn.onAny(refuse)
    const res2 = await runAgent({ chat: mockChat(stubborn), ...json, system: 's', userMessage: 'go', host: makeHost().host })
    expect(res2.reason).toBe('completed')
    expect(stubborn.requests).toHaveLength(3)
    // after an action ran, a "cannot use tools" answer is a normal end
    const late = new MockProvider('mock', { chunkDelayMs: 1 })
    late.script([reply({ actions: [{ tool: 'draw', args: {} }], done: false }), refuse])
    const res3 = await runAgent({ chat: mockChat(late), ...json, system: 's', userMessage: 'go', host: makeHost({ draw: () => ({ content: [{ type: 'text', text: 'ok' }] }) }).host })
    expect(res3.reason).toBe('completed')
    expect(late.requests).toHaveLength(2)
  })

  it('NO_TOOLS_REFUSAL matches explicit refusals only', () => {
    for (const t of [
      "I can't use tools in this text-only request.",
      'I can’t use tools in this request.',
      "I can't modify the document without using tools.",
      'This request disallows tool calls.',
      'I am unable to call tools here.',
      'I cannot run any tools.',
      'This is a text-only request.',
      'Tool use was disabled for this turn.',
      'I was told not to use tools.',
      'I was asked not to use any tools here.'
    ])
      expect(NO_TOOLS_REFUSAL.test(t), t).toBe(true)
    for (const t of [
      'No tool needed: the answer is 42.',
      'There is no tool for that, so here is a description.',
      'I can use tools to draw it.',
      'Drawing the heart with the tools now.',
      'Nothing to do, the song is finished.',
      ''
    ])
      expect(NO_TOOLS_REFUSAL.test(t), t).toBe(false)
  })

  it('sends the model back when it ends the turn while its last action failed (at most twice, and not after a later success)', async () => {
    const bad = { content: [{ type: 'text' as const, text: 'melody too long' }], isError: true }
    const ok = { content: [{ type: 'text' as const, text: 'fine' }] }
    const first = (x: unknown): boolean => (x as { n: number }).n === 1
    // 1) no actions after a failed action: nudged, the model retries, succeeds, ends
    const a = new MockProvider('mock', { chunkDelayMs: 1 })
    a.script([reply({ actions: [{ tool: 'draw', args: { n: 1 } }], done: false }), reply({ say: 'Done!', actions: [], done: true }), reply({ actions: [{ tool: 'draw', args: { n: 2 } }], done: false }), reply({ actions: [], done: true })])
    const hostA = makeHost({ draw: (x) => (first(x) ? bad : ok) })
    const ra = await runAgent({ chat: mockChat(a), ...json, system: 's', userMessage: 'go', host: hostA.host })
    expect(ra.reason).toBe('completed')
    expect(hostA.calls).toHaveLength(2)
    expect(text(a.requests[2]!.messages.at(-1)!)).toMatch(/last action failed[\s\S]*melody too long/)
    // 2) done: true together with a failing action: the results message carries the nudge and the run goes on
    const b = new MockProvider('mock', { chunkDelayMs: 1 })
    b.script([reply({ actions: [{ tool: 'draw', args: { n: 1 } }], done: true }), reply({ actions: [{ tool: 'draw', args: { n: 2 } }], done: true })])
    const hostB = makeHost({ draw: (x) => (first(x) ? bad : ok) })
    const rb = await runAgent({ chat: mockChat(b), ...json, system: 's', userMessage: 'go', host: hostB.host })
    expect(rb.reason).toBe('completed')
    expect(hostB.calls).toHaveLength(2)
    expect(text(b.requests[1]!.messages.at(-1)!)).toMatch(/last action failed/)
    // 3) a model that keeps ending on the error is nudged twice, then allowed to end
    const c = new MockProvider('mock', { chunkDelayMs: 1 })
    c.script([reply({ actions: [{ tool: 'draw', args: {} }], done: false }), ...Array.from({ length: 4 }, () => reply({ actions: [], done: true }))])
    const rc = await runAgent({ chat: mockChat(c), ...json, system: 's', userMessage: 'go', host: makeHost({ draw: () => bad }).host })
    expect(rc.reason).toBe('completed')
    expect(c.requests).toHaveLength(4)
    // 4) a later success clears the error: no nudge
    const d = new MockProvider('mock', { chunkDelayMs: 1 })
    d.script([reply({ actions: [{ tool: 'draw', args: { n: 1 } }, { tool: 'draw', args: { n: 2 } }], done: false }), reply({ actions: [], done: true })])
    const rd = await runAgent({ chat: mockChat(d), ...json, system: 's', userMessage: 'go', host: makeHost({ draw: (x) => (first(x) ? bad : ok) }).host })
    expect(rd.reason).toBe('completed')
    expect(d.requests).toHaveLength(2)
  })

  it('stops at maxSteps and on abort; vision models get images as image parts', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.onAny(reply({ actions: [{ tool: 'preview', args: {} }], done: false }))
    const image: ToolResult = { content: [{ type: 'image', mimeType: 'image/png', data: 'QUJD' }] }
    const { host, calls } = makeHost({ preview: () => image })
    const res = await runAgent({ chat: mockChat(mock), capabilities: { tools: false, vision: true }, system: 's', userMessage: 'go', host, maxSteps: 2 })
    expect(res.reason).toBe('max_steps')
    expect(calls).toHaveLength(2)
    expect(mock.requests[1]!.messages.at(-1)!.content).toEqual([
      { type: 'text', text: 'Results of your actions:' },
      { type: 'text', text: '#1 preview:' },
      { type: 'image', mimeType: 'image/png', data: 'QUJD' }
    ])
    // without vision: a note instead
    const res2 = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host, maxSteps: 2 })
    expect(text(res2.messages.at(-1)!)).toMatch(/image omitted/)

    const ac = new AbortController()
    const slow = makeHost({ preview: () => { ac.abort(); return image } })
    const res3 = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host: slow.host, signal: ac.signal })
    expect(res3.reason).toBe('aborted')
  })

  it('a history with tool messages from native mode is flattened to text', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.onAny(reply({ actions: [], done: true }))
    const history: ChatMessage[] = [
      { role: 'user', content: 'draw' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'draw', args: { n: 1 } }] },
      { role: 'tool', toolCallId: 'c', name: 'draw', content: 'ok' },
      { role: 'assistant', content: 'done' }
    ]
    await runAgent({ chat: mockChat(mock), ...json, system: 's', history, userMessage: 'again', host: makeHost().host })
    const sent = mock.requests[0]!.messages
    expect(sent.some((m) => m.role === 'tool')).toBe(false)
    expect(sent.some((m) => m.role === 'assistant' && 'toolCalls' in m)).toBe(false)
    expect(text(sent[2]!)).toContain('"tool":"draw"')
    expect(text(sent[3]!)).toBe('Result of draw:\nok')
  })
})

describe('end-of-run result check (MDI-09)', () => {
  const json = { capabilities: { tools: false, vision: false } }
  const reply = (o: object): MockReply => JSON.stringify(o)
  /** A "song" with a counter; `draw` changes it only when `effect` is true. */
  const song = (effect: boolean) => {
    let n = 0
    const { host, calls } = makeHost({ draw: () => { if (effect) n++; return { content: [{ type: 'text', text: 'ok' }] } } })
    const resultCheck: ResultCheck = { mutates: (t) => t === 'draw', snapshot: () => `n=${n}` }
    return { host, calls, resultCheck }
  }
  const nudgeText = /the song is unchanged/

  it('json mode: sends the model back when it ends after a mutating action that left the song unchanged (done:true)', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([reply({ actions: [{ tool: 'draw', args: {} }], done: true }), reply({ actions: [{ tool: 'draw', args: {} }], done: false }), reply({ actions: [], done: true })])
    let n = 0
    const { host } = makeHost({ draw: () => { if (mock.requests.length > 1) n++; return { content: [{ type: 'text', text: 'ok' }] } } })
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host, resultCheck: { mutates: (t) => t === 'draw', snapshot: () => `n=${n}` } })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(3)
    expect(text(mock.requests[1]!.messages.at(-1)!)).toMatch(nudgeText)
  })

  it('json mode: fires on an empty-actions end too, capped at MAX_RESULT_NUDGES', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    const end = reply({ say: 'done', actions: [], done: true })
    mock.script([reply({ actions: [{ tool: 'draw', args: {} }], done: false }), end, end, end])
    const s = song(false)
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host: s.host, resultCheck: s.resultCheck })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(1 + 1 + MAX_RESULT_NUDGES)
    expect(res.messages.filter((m) => m.role === 'user' && nudgeText.test(text(m)))).toHaveLength(MAX_RESULT_NUDGES)
  })

  it('does not fire on a run without a mutating action (Q&A), nor when the song changed', async () => {
    const qa = new MockProvider('mock', { chunkDelayMs: 1 })
    qa.script([reply({ actions: [{ tool: 'preview', args: {} }], done: false }), reply({ say: 'It is C major.', actions: [], done: true })])
    const s1 = song(false)
    const r1 = await runAgent({ chat: mockChat(qa), ...json, system: 's', userMessage: 'which key?', host: s1.host, resultCheck: s1.resultCheck })
    expect(r1.reason).toBe('completed')
    expect(qa.requests).toHaveLength(2)
    const changed = new MockProvider('mock', { chunkDelayMs: 1 })
    changed.script([reply({ actions: [{ tool: 'draw', args: {} }], done: false }), reply({ actions: [], done: true })])
    const s2 = song(true)
    const r2 = await runAgent({ chat: mockChat(changed), ...json, system: 's', userMessage: 'go', host: s2.host, resultCheck: s2.resultCheck })
    expect(r2.reason).toBe('completed')
    expect(changed.requests).toHaveLength(2)
    expect(r2.messages.some((m) => nudgeText.test(text(m)))).toBe(false)
  })

  it('the error guard comes first: a failed last action is nudged with the error text, the result guard follows after it', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.onAny(reply({ actions: [], done: true }))
    mock.script([reply({ actions: [{ tool: 'draw', args: {} }], done: true })])
    const { host } = makeHost({ draw: () => ({ content: [{ type: 'text', text: 'boom' }], isError: true }) })
    const resultCheck: ResultCheck = { mutates: () => true, snapshot: () => 'same' }
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host, resultCheck })
    expect(res.reason).toBe('completed')
    const users = res.messages.filter((m) => m.role === 'user').map(text)
    expect(users[1]).toMatch(/Your last action failed[\s\S]*boom/)
    expect(users[1]).not.toMatch(nudgeText)
    expect(users.findIndex((u) => nudgeText.test(u))).toBeGreaterThan(1)
    expect(users.filter((u) => nudgeText.test(u))).toHaveLength(MAX_RESULT_NUDGES)
  })

  it('native mode shares the check: a text answer after an unchanged mutating call is sent back, once the song changes it ends', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([{ toolCalls: [{ name: 'draw', args: {}, id: 'c1' }] }, 'All done.', { toolCalls: [{ name: 'draw', args: {}, id: 'c2' }] }, 'Really done.'])
    let n = 0
    const { host } = makeHost({ draw: () => { if (mock.requests.length > 2) n++; return { content: [{ type: 'text', text: 'ok' }] } } })
    const res = await runAgent({ chat: mockChat(mock), capabilities: { tools: true, vision: false }, system: 's', userMessage: 'go', host, resultCheck: { mutates: () => true, snapshot: () => `n=${n}` } })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(4)
    expect(text(mock.requests[2]!.messages.at(-1)!)).toMatch(nudgeText)
  })

  it('the refusal nudge fires after a read-only action when no mutating action ran yet, not after a mutating one', async () => {
    const refuse = reply({ say: 'The tool connection is unavailable: tool use was disabled.', actions: [], done: true })
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([reply({ actions: [{ tool: 'preview', args: {} }], done: false }), refuse, reply({ actions: [{ tool: 'draw', args: {} }], done: false }), reply({ actions: [], done: true })])
    let n = 0
    const { host } = makeHost({ draw: () => { n++; return { content: [{ type: 'text', text: 'ok' }] } } })
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host, resultCheck: { mutates: (t) => t === 'draw', snapshot: () => `n=${n}` } })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(4)
    expect(text(mock.requests[2]!.messages.at(-1)!)).toMatch(/plain-text JSON protocol/)
    // after a mutating action the same sentence is a normal end
    const late = new MockProvider('mock', { chunkDelayMs: 1 })
    late.script([reply({ actions: [{ tool: 'draw', args: {} }], done: false }), refuse])
    let m = 0
    const h2 = makeHost({ draw: () => { m++; return { content: [{ type: 'text', text: 'ok' }] } } })
    const r2 = await runAgent({ chat: mockChat(late), ...json, system: 's', userMessage: 'go', host: h2.host, resultCheck: { mutates: (t) => t === 'draw', snapshot: () => `m=${m}` } })
    expect(r2.reason).toBe('completed')
    expect(late.requests).toHaveLength(2)
  })

  it('a check that cannot read the state is off', async () => {
    const mock = new MockProvider('mock', { chunkDelayMs: 1 })
    mock.script([reply({ actions: [{ tool: 'draw', args: {} }], done: true })])
    const res = await runAgent({ chat: mockChat(mock), ...json, system: 's', userMessage: 'go', host: makeHost().host, resultCheck: { mutates: () => true, snapshot: () => { throw new Error('no state') } } })
    expect(res.reason).toBe('completed')
    expect(mock.requests).toHaveLength(1)
  })
})
