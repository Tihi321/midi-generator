import { createServer } from 'node:http'
import type { Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AnthropicClient, toAnthropicMessages } from '../../src/llm/anthropic'
import { GeminiClient, toGeminiContents, toGeminiSchema } from '../../src/llm/gemini'
import { MockProvider } from '../../src/llm/mock'
import { OpenAiCompatClient, toOpenAiMessages } from '../../src/llm/openaiCompat'
import { collect, ThinkFilter } from '../../src/llm/types'
import type { ChatMessage, ToolDef } from '../../src/llm/types'

const tools: ToolDef[] = [
  {
    name: 'write_pattern',
    description: 'Draws a grid',
    parameters: { type: 'object', properties: { x: { type: 'integer' }, rows: { type: 'array', items: { type: 'string' } } }, required: ['x'], additionalProperties: false, $schema: 'x' }
  }
]

const conversation: ChatMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'draw a tree' },
  {
    role: 'assistant',
    content: 'ok',
    toolCalls: [
      { id: 'c1', name: 'write_pattern', args: { x: 1 } },
      { id: 'c2', name: 'render_preview', args: {} }
    ]
  },
  { role: 'tool', toolCallId: 'c1', name: 'write_pattern', content: 'drawn 12 pixels' },
  { role: 'tool', toolCallId: 'c2', name: 'render_preview', content: [{ type: 'text', text: 'preview' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' }] },
  { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'BBBB' }] }
]

describe('message mapping', () => {
  it('OpenAI: tool calls, tool messages, images as data URLs (tool images follow as a user message)', () => {
    const out = toOpenAiMessages(conversation) as Record<string, unknown>[]
    expect(out[0]).toEqual({ role: 'system', content: 'sys' })
    expect(out[2]).toEqual({
      role: 'assistant',
      content: 'ok',
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'write_pattern', arguments: '{"x":1}' } },
        { id: 'c2', type: 'function', function: { name: 'render_preview', arguments: '{}' } }
      ]
    })
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'drawn 12 pixels' })
    expect(out[4]).toEqual({ role: 'tool', tool_call_id: 'c2', content: 'preview' })
    // the image of the tool result comes after the whole run of tool messages
    expect(out[5]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Image(s) returned by tool render_preview:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
      ]
    })
    expect(out[6]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BBBB' } }
      ]
    })
  })

  it('OpenAI: the reasoning kept on a tool call goes back as reasoning_content; other providerMeta shapes are ignored', () => {
    const call = (providerMeta: unknown): ChatMessage[] => [{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', args: {}, providerMeta }] }]
    expect(toOpenAiMessages(call({ reasoningContent: 'I should draw' }))[0]).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'I should draw' })
    expect(toOpenAiMessages(call({ thoughtSignature: 'sig' }))[0]).not.toHaveProperty('reasoning_content')
    expect(toOpenAiMessages(call({ reasoningContent: 5 }))[0]).not.toHaveProperty('reasoning_content')
    expect(toOpenAiMessages(call(undefined))[0]).not.toHaveProperty('reasoning_content')
  })

  it('Gemini: only a thoughtSignature of the providerMeta goes into the part', () => {
    const out = toGeminiContents([{ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', args: {}, providerMeta: { reasoningContent: 'hmm' } }] }])
    expect(out[0]!.parts[0]).toEqual({ functionCall: { name: 'x', args: {} } })
  })

  it('Anthropic: tool_use blocks, consecutive tool results merged into one user message, base64 images', () => {
    const out = toAnthropicMessages(conversation)
    expect(out).toHaveLength(4) // system dropped
    expect(out[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'c1', name: 'write_pattern', input: { x: 1 } },
        { type: 'tool_use', id: 'c2', name: 'render_preview', input: {} }
      ]
    })
    expect(out[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'c1', content: 'drawn 12 pixels' },
        {
          type: 'tool_result',
          tool_use_id: 'c2',
          content: [
            { type: 'text', text: 'preview' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
          ]
        }
      ]
    })
    expect(out[3]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBBB' } }
      ]
    })
  })

  it('Anthropic: an error tool result sets is_error', () => {
    const out = toAnthropicMessages([{ role: 'tool', toolCallId: 'x', content: 'boom', isError: true }])
    expect(out[0]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }])
  })

  it('Gemini: functionCall / functionResponse (names looked up by call id, merged into one user turn), inlineData images', () => {
    const out = toGeminiContents(conversation.map((m) => (m.role === 'tool' ? { ...m, name: undefined } : m)))
    expect(out[0]).toEqual({ role: 'user', parts: [{ text: 'draw a tree' }] })
    expect(out[1]).toEqual({
      role: 'model',
      parts: [{ text: 'ok' }, { functionCall: { name: 'write_pattern', args: { x: 1 } } }, { functionCall: { name: 'render_preview', args: {} } }]
    })
    expect(out[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'write_pattern', response: { output: 'drawn 12 pixels' } } },
        { functionResponse: { name: 'render_preview', response: { output: 'preview' } } },
        { inlineData: { mimeType: 'image/png', data: 'AAAA' } }
      ]
    })
    expect(out[3]).toEqual({ role: 'user', parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'BBBB' } }] })
  })

  it('Gemini: schema reduced to the supported subset', () => {
    expect(toGeminiSchema(tools[0]!.parameters)).toEqual({
      type: 'object',
      properties: { x: { type: 'integer' }, rows: { type: 'array', items: { type: 'string' } } },
      required: ['x']
    })
    expect(toGeminiSchema({ type: ['string', 'null'], const: 'a' })).toEqual({ type: 'string', nullable: true, enum: ['a'] })
  })
})

describe('ThinkFilter', () => {
  it('drops think blocks, also when tags are split across chunks', () => {
    const f = new ThinkFilter()
    const out = ['Hel', 'lo <thi', 'nk>secret', ' stuff</th', 'ink> world', ' a <b'].map((c) => f.push(c)).join('') + f.flush()
    expect(out).toBe('Hello world a <b')
  })
})

describe('mock provider with tool calls', () => {
  it('streams tool calls with synthesized ids and finish reason', async () => {
    const mock = new MockProvider('mock')
    mock.onAny({ text: 'ok', toolCalls: [{ name: 'a', args: { n: 1 } }, { name: 'b', id: 'fixed' }] })
    const r = await collect(mock.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }))
    expect(r.text).toBe('ok')
    expect(r.toolCalls.map((c) => [c.name, c.args])).toEqual([['a', { n: 1 }], ['b', {}]])
    expect(r.toolCalls[0]!.id).toMatch(/^call_/)
    expect(r.toolCalls[1]!.id).toBe('fixed')
    expect(r.finishReason).toBe('tool_calls')
  })
})

describe('HTTP clients against fake servers', () => {
  let server: Server
  let base: string
  let lastBody: Record<string, unknown> = {}
  let lastHeaders: Record<string, unknown> = {}
  let handler: (url: string, res: ServerResponse) => void = () => undefined

  beforeEach(async () => {
    server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        lastBody = data ? (JSON.parse(data) as Record<string, unknown>) : {}
        lastHeaders = req.headers
        handler(req.url ?? '', res)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterEach(async () => {
    await new Promise((r) => server.close(r))
  })

  const sse = (res: ServerResponse, lines: string[]) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const l of lines) res.write(l)
    res.end()
  }

  it('OpenAI-compatible: streams text, asks for usage, reads cached tokens, sends extra_body and the key', async () => {
    handler = (_u, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":7,"prompt_cache_hit_tokens":60}}\n\n',
        'data: [DONE]\n\n'
      ])
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1', apiKey: 'sk-test' })
    const r = await collect(c.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], extraBody: { thinking: false }, maxTokens: 50 }))
    expect(r.text).toBe('Hello')
    expect(r.usage).toEqual({ inputTokens: 100, cachedInputTokens: 60, outputTokens: 7 })
    expect(r.finishReason).toBe('stop')
    expect(lastBody).toMatchObject({ model: 'm', stream: true, stream_options: { include_usage: true }, thinking: false, max_tokens: 50 })
    expect(lastHeaders.authorization).toBe('Bearer sk-test')
  })

  it('OpenAI-compatible: text with <think> blocks is cleaned; reasoning_content is not text', async () => {
    handler = (_u, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"reasoning_content":"hmm"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<think>plan "}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"it</think>Done"}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' })
    expect((await collect(c.chat({ model: 'm', messages: [] }))).text).toBe('Done')
  })

  it('OpenAI-compatible: the reasoning of a tool-calling turn rides on its first tool call (reasoning_content and reasoning)', async () => {
    handler = (_u, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"reasoning_content":"think "}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":"more"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"a","arguments":"{}"}},{"index":1,"id":"t2","function":{"name":"b","arguments":"{}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' })
    const r = await collect(c.chat({ model: 'm', messages: [] }))
    expect(r.toolCalls.map((t) => t.providerMeta)).toEqual([{ reasoningContent: 'think more' }, undefined])
    // no reasoning: no providerMeta
    handler = (_u, res) => sse(res, ['data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"a","arguments":"{}"}}]}}]}\n\n', 'data: [DONE]\n\n'])
    expect((await collect(c.chat({ model: 'm', messages: [] }))).toolCalls[0]).not.toHaveProperty('providerMeta')
  })

  it('OpenAI-compatible: listModelInfo reads OpenRouter prices (per token to per 1M), modalities and supported parameters; sends extra headers', async () => {
    handler = (_u, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          data: [
            { id: 'a/b:free', context_length: 131072, top_provider: { max_completion_tokens: 8192 }, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'max_tokens'] },
            { id: 'c/d', pricing: { prompt: '0.0000003', completion: '0.0000012', input_cache_read: '0.00000006' }, architecture: { output_modalities: ['text', 'image'] }, supported_parameters: ['max_tokens'] },
            { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' } },
            { id: 'plain' },
            { nope: true }
          ]
        })
      )
    }
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1', extraHeaders: { 'X-Title': 'Chiptune Studio' } })
    const list = await c.listModelInfo()
    expect(list).toHaveLength(4)
    expect(list[0]).toEqual({ id: 'a/b:free', context: 131072, maxOutput: 8192, price: { in: 0, out: 0, cachedIn: undefined }, textOnly: true, tools: true, vision: true })
    expect(list[1]!.price!.in).toBeCloseTo(0.3)
    expect(list[1]!.price!.out).toBeCloseTo(1.2)
    expect(list[1]!.price!.cachedIn).toBeCloseTo(0.06)
    expect(list[1]).toMatchObject({ textOnly: false, tools: false, vision: undefined })
    expect(list[2]!.price).toBeUndefined()
    expect(list[3]).toMatchObject({ id: 'plain', textOnly: true, tools: undefined, vision: undefined })
    expect(lastHeaders['x-title']).toBe('Chiptune Studio')
    expect(await c.listModels()).toEqual(['a/b:free', 'c/d', 'openrouter/auto', 'plain'])
  })

  it('OpenAI-compatible: sends the JSON schema as response_format unless jsonSchema is false', async () => {
    handler = (_u, res) => sse(res, ['data: {"choices":[{"delta":{"content":"{}"}}]}\n\n', 'data: [DONE]\n\n'])
    const schema = { type: 'object' }
    const messages = [{ role: 'user' as const, content: 'hi' }]
    await collect(new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' }).chat({ model: 'm', messages, schema }))
    expect(lastBody.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema } })
    await collect(new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1', jsonSchema: false }).chat({ model: 'm', messages, schema }))
    expect(lastBody).not.toHaveProperty('response_format')
  })

  it('OpenAI-compatible: sends tools and tool_choice, assembles fragmented tool_calls by index', async () => {
    handler = (_u, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"role":"assistant","content":"Drawing. "}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"write_pattern","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"get_song","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"3,\\"rows\\":[\\"ab\\"]}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n',
        'data: [DONE]\n\n'
      ])
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' })
    const r = await collect(c.chat({ model: 'm', messages: [{ role: 'user', content: 'go' }], tools, toolChoice: 'auto' }))
    expect(r.text).toBe('Drawing. ')
    expect(r.toolCalls).toEqual([
      { id: 'call_a', name: 'write_pattern', args: { x: 3, rows: ['ab'] } },
      { id: 'call_b', name: 'get_song', args: {} } // arguments '' -> {}
    ])
    expect(r.finishReason).toBe('tool_calls')
    expect(r.usage.outputTokens).toBe(5)
    expect(lastBody.tools).toEqual([{ type: 'function', function: { name: 'write_pattern', description: 'Draws a grid', parameters: tools[0]!.parameters } }])
    expect(lastBody.tool_choice).toBe('auto')
  })

  it('OpenAI-compatible: tolerates missing ids and a forced tool; sends the conversation mapped', async () => {
    handler = (_u, res) =>
      sse(res, [
        // no index, no id: each chunk with a name starts a new call; the rest is the same call
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"a","arguments":"{\\"k\\""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":":1}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"id":"zzz","function":{"name":"b","arguments":"{not json"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ])
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' })
    const events = []
    for await (const ev of c.chat({ model: 'm', messages: conversation, tools, toolChoice: { name: 'write_pattern' } })) events.push(ev)
    const calls = events.filter((e) => e.type === 'tool_call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: 'a', args: { k: 1 } })
    expect(calls[0]!.type === 'tool_call' && calls[0]!.id).toMatch(/^call_/)
    expect(calls[1]).toMatchObject({ id: 'zzz', name: 'b', args: {} })
    expect(calls[1]!.type === 'tool_call' && calls[1]!.argsError).toMatch(/not valid JSON/)
    expect(lastBody.tool_choice).toEqual({ type: 'function', function: { name: 'write_pattern' } })
    expect((lastBody.messages as unknown[]).length).toBe(7)
  })

  it('OpenAI-compatible: 429 becomes a retryable error, 400 does not; model list and LM Studio info work', async () => {
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' })
    handler = (_u, res) => {
      res.writeHead(429, { 'retry-after': '2' })
      res.end('slow down')
    }
    await expect(collect(c.chat({ model: 'm', messages: [] }))).rejects.toMatchObject({ status: 429, retryable: true, retryAfterMs: 2000 })
    handler = (_u, res) => {
      res.writeHead(400)
      res.end('bad')
    }
    await expect(collect(c.chat({ model: 'm', messages: [] }))).rejects.toMatchObject({ status: 400, retryable: false })
    handler = (u, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        !u.includes('/api/v0/')
          ? '{"data":[{"id":"a"},{"id":"b"}]}'
          : '{"data":[{"id":"a","type":"vlm","capabilities":["tool_use"],"loaded_context_length":32768},{"id":"b","type":"llm","state":"not-loaded"}]}'
      )
    }
    expect(await c.listModels()).toEqual(['a', 'b'])
    // the same fake answers /api/v0/models: capabilities and loaded context
    const info = await c.localModelInfo()
    expect(info.get('a')).toMatchObject({ loadedContext: 32768, tools: true, vision: true })
    expect(info.get('b')).toMatchObject({ vision: false })
    expect([...(await c.contextLengths()).entries()]).toEqual([['a', 32768]])
  })

  it('OpenAI-compatible: stopping at the token limit without any text is a clear error', async () => {
    handler = (_u, res) =>
      sse(res, [
        'data: {"choices":[{"delta":{"reasoning_content":"thinking..."},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":6560,"completion_tokens":1631}}\n\n',
        'data: [DONE]\n\n'
      ])
    const c = new OpenAiCompatClient({ id: 'x', baseUrl: base + '/v1' })
    await expect(collect(c.chat({ model: 'm', messages: [] }))).rejects.toThrow(/stopped at its token limit without an answer \(6560 tokens in, 1631 out\).*context window/)
  })

  it('LM Studio: a model that is not loaded is loaded first with the settings, once for parallel requests', async () => {
    const loaded = new Set<string>(['already'])
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      calls.push(`${init?.method ?? 'GET'} ${u.replace('http://lm.test', '')}${init?.method === 'POST' && u.endsWith('/load') ? ' ' + String(init.body) : ''}`)
      if (u.endsWith('/api/v1/models')) {
        return new Response(JSON.stringify({ models: ['already', 'cold'].map((key) => ({ key, type: 'llm', loaded_instances: loaded.has(key) ? [{ id: key }] : [] })) }))
      }
      if (u.endsWith('/api/v1/models/load')) {
        await new Promise((r) => setTimeout(r, 20))
        loaded.add(JSON.parse(String(init!.body)).model)
        return new Response(JSON.stringify({ status: 'loaded' }))
      }
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const c = new OpenAiCompatClient({ id: 'lm', baseUrl: 'http://lm.test/v1', fetchImpl, loadConfig: () => ({ parallel: 4, context: 32768, ttlMinutes: 60 }) })
    expect((await collect(c.chat({ model: 'already', messages: [] }))).text).toBe('ok')
    expect(calls.filter((x) => x.startsWith('POST') && x.includes('/load'))).toEqual([])
    calls.length = 0
    const both = await Promise.all([collect(c.chat({ model: 'cold', messages: [] })), collect(c.chat({ model: 'cold', messages: [] }))])
    expect(both.map((b) => b.text)).toEqual(['ok', 'ok'])
    expect(calls.filter((x) => x.includes('/load'))).toEqual(['POST /api/v1/models/load {"model":"cold","context_length":32768,"parallel":4}'])
    await expect(collect(c.chat({ model: 'missing', messages: [] }))).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/LM Studio has no model "missing": download it first/) })
  })

  it('LM Studio: a model loaded with a smaller context than the settings is unloaded and loaded again', async () => {
    const instances = new Map<string, number>([['small', 32768], ['big', 131072]])
    const calls: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url).replace('http://lm.test', '')
      if (init?.method === 'POST' && u.startsWith('/api/')) calls.push(`${u} ${String(init.body)}`)
      if (u === '/api/v1/models') {
        return new Response(
          JSON.stringify({
            models: ['small', 'big'].map((key) => ({ key, type: 'llm', loaded_instances: instances.has(key) ? [{ id: key, config: { context_length: instances.get(key) } }] : [] }))
          })
        )
      }
      if (u === '/api/v1/models/unload') {
        instances.delete(JSON.parse(String(init!.body)).instance_id)
        return new Response('{}')
      }
      if (u === '/api/v1/models/load') {
        const b = JSON.parse(String(init!.body))
        instances.set(b.model, b.context_length)
        return new Response('{}')
      }
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    }) as unknown as typeof fetch
    const c = new OpenAiCompatClient({ id: 'lm', baseUrl: 'http://lm.test/v1', fetchImpl, loadConfig: () => ({ parallel: 1, context: 131072, ttlMinutes: 60 }) })
    await collect(c.chat({ model: 'big', messages: [] }))
    expect(calls).toEqual([])
    await collect(c.chat({ model: 'small', messages: [] }))
    expect(calls).toEqual(['/api/v1/models/unload {"instance_id":"small"}', '/api/v1/models/load {"model":"small","context_length":131072,"parallel":1}'])
    expect(instances.get('small')).toBe(131072)
  })

  it('Anthropic: reads text deltas and usage including cache reads; sends tools and mapped messages', async () => {
    handler = (_u, res) =>
      sse(res, [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":90,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n'
      ])
    const c = new AnthropicClient({ id: 'a', baseUrl: base, apiKey: 'k' })
    const r = await collect(c.chat({ model: 'claude', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], tools, toolChoice: 'required' }))
    expect(r.text).toBe('Hi there')
    expect(r.usage).toEqual({ inputTokens: 100, cachedInputTokens: 90, outputTokens: 12 })
    expect(r.finishReason).toBe('stop')
    expect(lastBody).toMatchObject({ system: 'sys', stream: true, messages: [{ role: 'user', content: 'hi' }], tool_choice: { type: 'any' } })
    expect(lastBody.tools).toEqual([{ name: 'write_pattern', description: 'Draws a grid', input_schema: tools[0]!.parameters }])
    expect(lastHeaders['x-api-key']).toBe('k')
  })

  it('Anthropic: tool_use blocks with input_json_delta fragments become tool calls', async () => {
    handler = (_u, res) =>
      sse(res, [
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Sure."}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_pattern","input":{}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"x\\": 4, \\"ro"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"ws\\": [\\"a.\\"]}"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":1}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_2","name":"get_song","input":{}}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":2}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}\n\n'
      ])
    const c = new AnthropicClient({ id: 'a', baseUrl: base, apiKey: 'k' })
    const r = await collect(c.chat({ model: 'claude', messages: conversation, tools }))
    expect(r.text).toBe('Sure.')
    expect(r.toolCalls).toEqual([
      { id: 'toolu_1', name: 'write_pattern', args: { x: 4, rows: ['a.'] } },
      { id: 'toolu_2', name: 'get_song', args: {} }
    ])
    expect(r.finishReason).toBe('tool_calls')
    expect(r.usage.outputTokens).toBe(30)
  })

  it('Gemini: reads parts and usage metadata (thinking counts as output); sends declarations', async () => {
    handler = (u, res) => {
      expect(u).toContain('/v1beta/models/gem:streamGenerateContent?alt=sse')
      sse(res, [
        'data: {"candidates":[{"content":{"parts":[{"text":"One "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"two"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":5,"thoughtsTokenCount":20,"cachedContentTokenCount":10}}\n\n'
      ])
    }
    const c = new GeminiClient({ id: 'g', baseUrl: base, apiKey: 'k' })
    const r = await collect(c.chat({ model: 'gem', messages: [{ role: 'user', content: 'hi' }], tools, toolChoice: 'auto' }))
    expect(r.text).toBe('One two')
    expect(r.usage).toEqual({ inputTokens: 50, cachedInputTokens: 10, outputTokens: 25 })
    expect(lastHeaders['x-goog-api-key']).toBe('k')
    expect(lastBody.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'write_pattern',
            description: 'Draws a grid',
            parameters: { type: 'object', properties: { x: { type: 'integer' }, rows: { type: 'array', items: { type: 'string' } } }, required: ['x'] }
          }
        ]
      }
    ])
    expect(lastBody.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } })
  })

  it('Gemini: functionCall parts become tool calls (ids synthesized, thought signature kept)', async () => {
    handler = (_u, res) =>
      sse(res, [
        'data: {"candidates":[{"content":{"parts":[{"text":"Let me draw."},{"functionCall":{"name":"write_pattern","args":{"x":2}},"thoughtSignature":"sig1"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"get_song"}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":8,"candidatesTokenCount":4}}\n\n'
      ])
    const c = new GeminiClient({ id: 'g', baseUrl: base, apiKey: 'k' })
    const r = await collect(c.chat({ model: 'gem', messages: [{ role: 'user', content: 'go' }], tools }))
    expect(r.text).toBe('Let me draw.')
    expect(r.toolCalls).toHaveLength(2)
    expect(r.toolCalls[0]).toMatchObject({ name: 'write_pattern', args: { x: 2 }, providerMeta: { thoughtSignature: 'sig1' } })
    expect(r.toolCalls[0]!.id).toMatch(/^call_/)
    expect(r.toolCalls[1]).toMatchObject({ name: 'get_song', args: {} })
    expect(r.finishReason).toBe('tool_calls')
    // the signature goes back with the call
    expect(toGeminiContents([{ role: 'assistant', content: '', toolCalls: [r.toolCalls[0]!] }])[0]!.parts).toEqual([
      { functionCall: { name: 'write_pattern', args: { x: 2 } }, thoughtSignature: 'sig1' }
    ])
  })
})
