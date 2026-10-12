import { parseSse } from './sse'
import { asProviderError, contentText, httpError, ProviderError, parseToolArgs, synthesizeCallId } from './types'
import type { ChatEvent, ChatMessage, ChatRequest, ContentPart, FinishReason, ProviderClient, ToolChoice } from './types'

export interface AnthropicOptions {
  id: string
  baseUrl?: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

type Block = Record<string, unknown>

function toBlocks(parts: ContentPart[]): Block[] {
  return parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } }))
}

/** Maps our messages to the Anthropic format (system messages are handled by the caller). Consecutive tool results become one user message. */
export function toAnthropicMessages(messages: ChatMessage[]): { role: 'user' | 'assistant'; content: string | Block[] }[] {
  const out: { role: 'user' | 'assistant'; content: string | Block[] }[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : toBlocks(m.content) })
    } else if (m.role === 'assistant') {
      if (!m.toolCalls?.length) out.push({ role: 'assistant', content: m.content })
      else {
        const blocks: Block[] = []
        if (m.content) blocks.push({ type: 'text', text: m.content })
        for (const c of m.toolCalls) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args && typeof c.args === 'object' ? c.args : {} })
        out.push({ role: 'assistant', content: blocks })
      }
    } else {
      const result: Block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: typeof m.content === 'string' ? m.content : toBlocks(m.content),
        ...(m.isError ? { is_error: true } : {})
      }
      const prev = out[out.length - 1]
      if (prev && prev.role === 'user' && Array.isArray(prev.content) && prev.content.length && prev.content.every((b) => b.type === 'tool_result')) prev.content.push(result)
      else out.push({ role: 'user', content: [result] })
    }
  }
  return out
}

function toAnthropicToolChoice(c: ToolChoice): unknown {
  if (c === 'auto') return { type: 'auto' }
  if (c === 'none') return { type: 'none' }
  if (c === 'required') return { type: 'any' }
  return { type: 'tool', name: c.name }
}

/** Native Anthropic Messages API, streaming. */
export class AnthropicClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch

  constructor(private readonly opts: AnthropicOptions) {
    this.id = opts.id
    this.base = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => contentText(m.content))
      .join('\n\n')
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      messages: toAnthropicMessages(req.messages),
      ...(system ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.extraBody ?? {})
    }
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }))
      if (req.toolChoice) body.tool_choice = toAnthropicToolChoice(req.toolChoice)
    }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15 * 60_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.f(`${this.base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    if (!res.body) throw new ProviderError('empty response body', res.status, true)

    let inputTokens = 0
    let cached = 0
    let outputTokens = 0
    let stopReason: string | undefined
    let sawCalls = false
    const tools = new Map<number, { id: string; name: string; json: string }>()
    try {
      for await (const msg of parseSse(res.body)) {
        let json: AnthropicEvent
        try {
          json = JSON.parse(msg.data) as AnthropicEvent
        } catch {
          continue
        }
        if (json.type === 'message_start' && json.message?.usage) {
          const u = json.message.usage
          cached = u.cache_read_input_tokens ?? 0
          // Anthropic reports uncached, cache-write and cache-read input separately.
          inputTokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached
          outputTokens = u.output_tokens ?? 0
        } else if (json.type === 'content_block_start' && json.content_block?.type === 'tool_use') {
          tools.set(json.index ?? 0, { id: json.content_block.id ?? '', name: json.content_block.name ?? '', json: '' })
        } else if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text) {
          yield { type: 'delta', text: json.delta.text }
        } else if (json.type === 'content_block_delta' && json.delta?.type === 'input_json_delta') {
          const t = tools.get(json.index ?? 0)
          if (t) t.json += json.delta.partial_json ?? ''
        } else if (json.type === 'content_block_stop') {
          const t = tools.get(json.index ?? 0)
          if (t) {
            tools.delete(json.index ?? 0)
            const { args, error } = parseToolArgs(t.json)
            sawCalls = true
            yield { type: 'tool_call', id: t.id || synthesizeCallId(), name: t.name, args, ...(error ? { argsError: error } : {}) }
          }
        } else if (json.type === 'message_delta') {
          if (json.usage?.output_tokens !== undefined) outputTokens = json.usage.output_tokens
          if (json.delta?.stop_reason) stopReason = json.delta.stop_reason
        } else if (json.type === 'error') {
          throw new ProviderError(`provider error: ${JSON.stringify(json.error).slice(0, 300)}`, undefined, true)
        }
      }
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    yield { type: 'finish', reason: finishReason(stopReason, sawCalls) }
    yield { type: 'usage', usage: { inputTokens, cachedInputTokens: cached, outputTokens } }
  }
}

function finishReason(stop: string | undefined, sawCalls: boolean): FinishReason {
  if (sawCalls || stop === 'tool_use') return 'tool_calls'
  if (stop === 'max_tokens') return 'length'
  if (stop === 'end_turn' || stop === 'stop_sequence' || stop === undefined) return 'stop'
  return 'other'
}

interface AnthropicEvent {
  type: string
  index?: number
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  content_block?: { type?: string; id?: string; name?: string }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  usage?: { output_tokens?: number }
  error?: unknown
}
