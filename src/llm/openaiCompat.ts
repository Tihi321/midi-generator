import { execFile } from 'node:child_process'
import { parseSse } from './sse'
import { asProviderError, contentText, httpError, ProviderError, parseToolArgs, synthesizeCallId, ThinkFilter } from './types'
import type { ChatEvent, ChatMessage, ChatRequest, ContentPart, FinishReason, ProviderClient, ToolChoice, Usage } from './types'

export interface OpenAiCompatOptions {
  id: string
  baseUrl: string
  apiKey?: string
  /** Total time allowed for one request. Default 15 minutes. */
  timeoutMs?: number
  fetchImpl?: typeof fetch
  /** Send `schema` as `response_format`. Default true. False for servers that fail a bad answer instead of constraining it. */
  jsonSchema?: boolean
  /** LM Studio: before a chat request, load the model if it isn't loaded yet, with these settings. */
  loadConfig?: (model: string) => { parallel: number; context: number; ttlMinutes: number }
  /** LM Studio's `lms` command line. It loads with an idle time (`--ttl`), which the REST load can't; without it the REST API is used. */
  lmsPath?: string
}

/** What LM Studio's `GET /api/v0/models` says about a model. */
export interface LocalModelInfo {
  id: string
  /** The context window the model is loaded with. */
  loadedContext?: number
  /** From `capabilities: ['tool_use']`. */
  tools?: boolean
  /** From `type: 'vlm'`. */
  vision?: boolean
  /** False for an embedding model (`type: 'embeddings'`) and a speculative-decoding draft model (`arch: 'dflash'`). */
  chat?: boolean
}

const LOAD_TIMEOUT_MS = 10 * 60_000

function headers(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (apiKey) h.authorization = `Bearer ${apiKey}`
  return h
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

function dataUrl(p: Extract<ContentPart, { type: 'image' }>): string {
  return `data:${p.mimeType};base64,${p.data}`
}

function toOpenAiParts(parts: ContentPart[]): unknown[] {
  return parts.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: dataUrl(p) } }))
}

/**
 * Maps our messages to the OpenAI chat format. OpenAI tool messages carry text only, so the images of tool results
 * follow the run of tool messages as one user message.
 */
export function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = []
  let pendingImages: { name: string; parts: ContentPart[] }[] = []
  const flush = () => {
    if (!pendingImages.length) return
    const content: unknown[] = []
    for (const p of pendingImages) {
      content.push({ type: 'text', text: `Image(s) returned by tool ${p.name}:` })
      content.push(...toOpenAiParts(p.parts))
    }
    out.push({ role: 'user', content })
    pendingImages = []
  }
  for (const m of messages) {
    if (m.role !== 'tool') flush()
    if (m.role === 'system') out.push({ role: 'system', content: m.content })
    else if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : toOpenAiParts(m.content) })
    } else if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.toolCalls?.length && !m.content ? null : m.content }
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } }))
      }
      out.push(msg)
    } else {
      const images = typeof m.content === 'string' ? [] : m.content.filter((p) => p.type === 'image')
      const text = contentText(m.content)
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.isError && !text.startsWith('Error') ? `Error: ${text}` : text || (images.length ? '(see image)' : '') })
      if (images.length) pendingImages.push({ name: m.name ?? m.toolCallId, parts: images })
    }
  }
  flush()
  return out
}

function toOpenAiToolChoice(c: ToolChoice): unknown {
  return typeof c === 'string' ? c : { type: 'function', function: { name: c.name } }
}

export class OpenAiCompatClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch
  /** Loads in progress, so parallel requests for one model load it once. */
  private loading = new Map<string, Promise<void>>()

  constructor(private readonly opts: OpenAiCompatOptions) {
    this.id = opts.id
    this.base = opts.baseUrl.replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    if (this.opts.loadConfig) await this.ensureLoaded(req.model, req.signal)
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAiMessages(req.messages),
      stream: true,
      stream_options: { include_usage: true },
      ...(req.extraBody ?? {})
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens
    if (req.temperature !== undefined) body.temperature = req.temperature
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))
      if (req.toolChoice) body.tool_choice = toOpenAiToolChoice(req.toolChoice)
    }
    if (req.schema && this.opts.jsonSchema !== false && !req.tools?.length) {
      body.response_format = { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: req.schema } }
    }
    const signal = withTimeout(req.signal, this.opts.timeoutMs ?? 15 * 60_000)
    let res: Response
    try {
      res = await this.f(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: headers(this.opts.apiKey),
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    if (!res.body) throw new ProviderError('empty response body', res.status, true)

    let usage: Usage | undefined
    let finish: string | null = null
    let emitted = false
    const think = new ThinkFilter()
    // Streamed tool calls: id and name come in the first fragment, the arguments in pieces after it.
    const calls: { index: number | undefined; id: string; name: string; args: string }[] = []
    const byIndex = new Map<number, (typeof calls)[number]>()
    let lastCall: (typeof calls)[number] | undefined
    try {
      for await (const msg of parseSse(res.body)) {
        if (msg.data.trim() === '[DONE]') break
        let json: OpenAiChunk
        try {
          json = JSON.parse(msg.data) as OpenAiChunk
        } catch {
          continue
        }
        if (json.error) throw new ProviderError(`provider error: ${JSON.stringify(json.error).slice(0, 300)}`, undefined, true)
        const choice = json.choices?.[0]
        const text = choice?.delta?.content
        if (choice?.finish_reason) finish = choice.finish_reason
        if (text) {
          const visible = think.push(text)
          if (visible) {
            emitted = true
            yield { type: 'delta', text: visible }
          }
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          let call = tc.index !== undefined ? byIndex.get(tc.index) : tc.id ? undefined : lastCall
          // a server that reuses an index for a new call (a different id) starts a new one
          if (call && tc.id && call.id && call.id !== tc.id) call = undefined
          if (!call) {
            call = { index: tc.index, id: tc.id ?? '', name: '', args: '' }
            calls.push(call)
            if (tc.index !== undefined) byIndex.set(tc.index, call)
          }
          if (tc.id && !call.id) call.id = tc.id
          if (tc.function?.name) call.name += tc.function.name
          if (typeof tc.function?.arguments === 'string') call.args += tc.function.arguments
          lastCall = call
        }
        if (json.usage) usage = toUsage(json.usage)
      }
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    const tail = think.flush()
    if (tail) {
      emitted = true
      yield { type: 'delta', text: tail }
    }
    const complete = calls.filter((c) => c.name)
    if (!emitted && !complete.length && finish === 'length') {
      throw new ProviderError(
        `the model stopped at its token limit without an answer (${usage?.inputTokens ?? '?'} tokens in, ${usage?.outputTokens ?? '?'} out): a thinking model used up the answer budget, or the loaded model's context window is too small for this request`
      )
    }
    for (const c of complete) {
      const { args, error } = parseToolArgs(c.args)
      yield { type: 'tool_call', id: c.id || synthesizeCallId(), name: c.name, args, ...(error ? { argsError: error } : {}) }
    }
    yield { type: 'finish', reason: finishReason(finish, complete.length > 0) }
    if (usage) yield { type: 'usage', usage }
  }

  /** LM Studio: loads `model` with `loadConfig` unless it is loaded already. A model LM Studio doesn't have fails at once (not retryable). */
  private async ensureLoaded(model: string, signal?: AbortSignal): Promise<void> {
    let p = this.loading.get(model)
    if (!p) {
      p = this.loadIfNeeded(model, this.opts.loadConfig!(model)).finally(() => this.loading.delete(model))
      this.loading.set(model, p)
    }
    try {
      await p
    } catch (err) {
      throw asProviderError(err, signal)
    }
  }

  private async loadIfNeeded(model: string, cfg: { parallel: number; context: number; ttlMinutes: number }): Promise<void> {
    const root = this.base.replace(/\/v1$/, '')
    const res = await this.f(`${root}/api/v1/models`, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok) return // not LM Studio's API: send the request as it is
    const json = (await res.json()) as { models?: { key: string; type?: string; loaded_instances?: { id: string; config?: { context_length?: unknown } }[] }[] }
    const m = json.models?.find((x) => x.key === model || x.loaded_instances?.some((i) => i.id === model))
    if (!m) throw new ProviderError(`LM Studio has no model "${model}": download it first (lms get ${model})`)
    const instances = m.loaded_instances ?? []
    // loaded with at least the context the settings ask for (or LM Studio doesn't say): use it as it is
    if (instances.some((i) => !(Number(i.config?.context_length) < cfg.context))) return
    // loaded with a smaller context: unload it and load it again with the one asked for
    for (const i of instances) await this.unload(root, i.id)
    if (this.opts.lmsPath) {
      const args = ['load', model, '-c', String(cfg.context), '--parallel', String(cfg.parallel), '--ttl', String(cfg.ttlMinutes * 60), '-y']
      await new Promise<void>((resolve, reject) =>
        execFile(this.opts.lmsPath!, args, { timeout: LOAD_TIMEOUT_MS, windowsHide: true }, (err, _out, stderr) =>
          err ? reject(new ProviderError(`LM Studio could not load ${model}: ${(String(stderr).trim() || err.message).slice(0, 300)}`)) : resolve()
        )
      )
      return
    }
    const load = await this.f(`${root}/api/v1/models/load`, {
      method: 'POST',
      headers: headers(this.opts.apiKey),
      body: JSON.stringify({ model, context_length: cfg.context, parallel: cfg.parallel }),
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS)
    })
    if (!load.ok) throw new ProviderError(`LM Studio could not load ${model}: HTTP ${load.status} ${(await load.text().catch(() => '')).slice(0, 300)}`, load.status)
  }

  private async unload(root: string, instance: string): Promise<void> {
    if (this.opts.lmsPath) {
      await new Promise<void>((resolve, reject) =>
        execFile(this.opts.lmsPath!, ['unload', instance], { timeout: 60_000, windowsHide: true }, (err, _out, stderr) =>
          err ? reject(new ProviderError(`LM Studio could not unload ${instance}: ${(String(stderr).trim() || err.message).slice(0, 300)}`)) : resolve()
        )
      )
      return
    }
    const res = await this.f(`${root}/api/v1/models/unload`, {
      method: 'POST',
      headers: headers(this.opts.apiKey),
      body: JSON.stringify({ instance_id: instance }),
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) throw new ProviderError(`LM Studio could not unload ${instance}: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}`, res.status)
  }

  /** LM Studio only (`GET /api/v0/models`): what it says about each model. Empty for other servers. */
  async localModelInfo(signal?: AbortSignal): Promise<Map<string, LocalModelInfo>> {
    const out = new Map<string, LocalModelInfo>()
    try {
      const origin = new URL(this.base).origin
      const res = await this.f(`${origin}/api/v0/models`, { headers: headers(this.opts.apiKey), signal: withTimeout(signal, 3000) })
      if (!res.ok) return out
      const json = (await res.json()) as { data?: { id: string; type?: string; arch?: string; capabilities?: string[]; loaded_context_length?: number }[] }
      for (const m of json.data ?? []) {
        out.set(m.id, {
          id: m.id,
          loadedContext: m.loaded_context_length,
          tools: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : undefined,
          vision: m.type ? m.type === 'vlm' : undefined,
          chat: m.type !== 'embeddings' && !/dflash|draft/i.test(m.arch ?? '')
        })
      }
    } catch {
      /* not LM Studio */
    }
    return out
  }

  /** LM Studio only: the context window each loaded model has. Empty for other servers. */
  async contextLengths(signal?: AbortSignal): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    for (const [id, m] of await this.localModelInfo(signal)) if (m.loadedContext) out.set(id, m.loadedContext)
    return out
  }

  /** Lists the model ids the server offers (`GET /models`). */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await this.f(`${this.base}/models`, { headers: headers(this.opts.apiKey), signal: withTimeout(signal, 5000) })
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''))
    const json = (await res.json()) as { data?: { id: string }[] }
    return (json.data ?? []).map((m) => m.id)
  }
}

function finishReason(finish: string | null, hasCalls: boolean): FinishReason {
  if (hasCalls) return 'tool_calls'
  if (finish === 'length') return 'length'
  if (finish === 'stop' || finish === null) return 'stop'
  return 'other'
}

interface OpenAiChunk {
  choices?: {
    delta?: {
      content?: string | null
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string | null } }[]
    }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    prompt_cache_hit_tokens?: number
  } | null
  error?: unknown
}

function toUsage(u: NonNullable<OpenAiChunk['usage']>): Usage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    cachedInputTokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0
  }
}
