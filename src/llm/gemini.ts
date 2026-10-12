import { parseSse } from './sse'
import { asProviderError, contentText, httpError, ProviderError, synthesizeCallId } from './types'
import type { ChatEvent, ChatMessage, ChatRequest, ContentPart, FinishReason, ProviderClient, ToolChoice } from './types'

export interface GeminiOptions {
  id: string
  baseUrl?: string
  apiKey: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

type Part = Record<string, unknown>
interface Content {
  role: 'user' | 'model'
  parts: Part[]
}

function toParts(parts: ContentPart[]): Part[] {
  return parts.map((p) => (p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: p.mimeType, data: p.data } }))
}

/** Maps our messages to Gemini contents (system messages are handled by the caller). Consecutive tool results become one user turn. */
export function toGeminiContents(messages: ChatMessage[]): Content[] {
  const out: Content[] = []
  const names = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'user') {
      out.push({ role: 'user', parts: typeof m.content === 'string' ? [{ text: m.content }] : toParts(m.content) })
    } else if (m.role === 'assistant') {
      const parts: Part[] = []
      if (m.content) parts.push({ text: m.content })
      for (const c of m.toolCalls ?? []) {
        names.set(c.id, c.name)
        parts.push({
          functionCall: { name: c.name, args: c.args && typeof c.args === 'object' ? c.args : {} },
          ...(c.providerMeta && typeof c.providerMeta === 'object' ? (c.providerMeta as Record<string, unknown>) : {})
        })
      }
      out.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] })
    } else {
      const name = m.name ?? names.get(m.toolCallId) ?? 'tool'
      const text = contentText(m.content)
      const response = m.isError ? { error: text } : { output: text }
      const images = typeof m.content === 'string' ? [] : toParts(m.content.filter((p) => p.type === 'image'))
      const prev = out[out.length - 1]
      const turn = prev && prev.role === 'user' && prev.parts.some((p) => 'functionResponse' in p) ? prev : undefined
      const fr: Part = { functionResponse: { name, response } }
      if (turn) {
        // function responses first, then the images of the results
        const firstNonResponse = turn.parts.findIndex((p) => !('functionResponse' in p))
        if (firstNonResponse === -1) turn.parts.push(fr)
        else turn.parts.splice(firstNonResponse, 0, fr)
        turn.parts.push(...images)
      } else out.push({ role: 'user', parts: [fr, ...images] })
    }
  }
  return out
}

const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'properties', 'required', 'items', 'minItems', 'maxItems', 'minimum', 'maximum', 'anyOf', 'minLength', 'maxLength', 'pattern', 'title'])

/** Reduces a JSON schema to the OpenAPI subset Gemini accepts. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema)
  if (!schema || typeof schema !== 'object') return schema
  const src = schema as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if (!SCHEMA_KEYS.has(k)) continue
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]))
    } else if (k === 'items' || k === 'anyOf') out[k] = toGeminiSchema(v)
    else out[k] = v
  }
  if (Array.isArray(out.type)) {
    const types = (out.type as string[]).filter((t) => t !== 'null')
    if (types.length !== (out.type as string[]).length) out.nullable = true
    out.type = types[0] ?? 'string'
  }
  if ('const' in src && !('enum' in out)) out.enum = [src.const]
  // a schema without `type` (a bare {} or anyOf) is accepted only when it has anyOf
  if (out.type === undefined && out.anyOf === undefined && out.properties !== undefined) out.type = 'object'
  return out
}

function toGeminiToolConfig(c: ToolChoice): unknown {
  if (c === 'auto') return { functionCallingConfig: { mode: 'AUTO' } }
  if (c === 'none') return { functionCallingConfig: { mode: 'NONE' } }
  if (c === 'required') return { functionCallingConfig: { mode: 'ANY' } }
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [c.name] } }
}

/** Native Gemini API (`streamGenerateContent`), streaming. */
export class GeminiClient implements ProviderClient {
  readonly id: string
  private readonly base: string
  private readonly f: typeof fetch

  constructor(private readonly opts: GeminiOptions) {
    this.id = opts.id
    this.base = (opts.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(/\/+$/, '')
    this.f = opts.fetchImpl ?? fetch
  }

  async *chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void> {
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => contentText(m.content))
      .join('\n\n')
    const generationConfig: Record<string, unknown> = {
      ...(req.maxTokens ? { maxOutputTokens: req.maxTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.schema && !req.tools?.length ? { responseMimeType: 'application/json' } : {})
    }
    const body: Record<string, unknown> = {
      contents: toGeminiContents(req.messages),
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig,
      ...(req.extraBody ?? {})
    }
    if (req.tools?.length) {
      body.tools = [
        {
          functionDeclarations: req.tools.map((t) => ({
            name: t.name,
            description: t.description,
            // a tool without parameters must not send an empty object schema
            ...(t.parameters && Object.keys((t.parameters.properties as object | undefined) ?? {}).length ? { parameters: toGeminiSchema(t.parameters) } : {})
          }))
        }
      ]
      if (req.toolChoice) body.toolConfig = toGeminiToolConfig(req.toolChoice)
    }
    const timeout = AbortSignal.timeout(this.opts.timeoutMs ?? 15 * 60_000)
    const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout
    let res: Response
    try {
      res = await this.f(`${this.base}/v1beta/models/${req.model}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    if (!res.ok) throw httpError(res.status, await res.text().catch(() => ''), res.headers.get('retry-after'))
    if (!res.body) throw new ProviderError('empty response body', res.status, true)

    let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    let finish: string | undefined
    let sawCalls = false
    try {
      for await (const msg of parseSse(res.body)) {
        let json: GeminiChunk
        try {
          json = JSON.parse(msg.data) as GeminiChunk
        } catch {
          continue
        }
        const cand = json.candidates?.[0]
        for (const part of cand?.content?.parts ?? []) {
          if (part.text && !part.thought) yield { type: 'delta', text: part.text }
          if (part.functionCall) {
            sawCalls = true
            yield {
              type: 'tool_call',
              id: part.functionCall.id || synthesizeCallId(),
              name: part.functionCall.name,
              args: part.functionCall.args ?? {},
              ...(part.thoughtSignature ? { providerMeta: { thoughtSignature: part.thoughtSignature } } : {})
            }
          }
        }
        if (cand?.finishReason) finish = cand.finishReason
        const u = json.usageMetadata
        if (u) {
          usage = {
            inputTokens: u.promptTokenCount ?? 0,
            cachedInputTokens: u.cachedContentTokenCount ?? 0,
            // Thinking tokens are billed as output.
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)
          }
        }
      }
    } catch (err) {
      throw asProviderError(err, req.signal)
    }
    yield { type: 'finish', reason: finishReason(finish, sawCalls) }
    yield { type: 'usage', usage }
  }
}

function finishReason(finish: string | undefined, sawCalls: boolean): FinishReason {
  if (sawCalls) return 'tool_calls'
  if (finish === 'MAX_TOKENS') return 'length'
  if (finish === undefined || finish === 'STOP') return 'stop'
  return 'other'
}

interface GeminiChunk {
  candidates?: {
    content?: {
      parts?: {
        text?: string
        thought?: boolean
        thoughtSignature?: string
        functionCall?: { id?: string; name: string; args?: unknown }
      }[]
    }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
}
