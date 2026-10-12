export type ContentPart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string /* base64 */ }

/** A tool the model may call. `parameters` is a JSON schema object. */
export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A tool call the model made, fully assembled. */
export interface ToolCall {
  id: string
  name: string
  args: unknown
  /** Opaque provider data that must be sent back with the call (Gemini's thoughtSignature). */
  providerMeta?: unknown
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | {
      role: 'tool'
      toolCallId: string
      /** The tool's name. Optional: Gemini needs it and looks it up from the assistant's toolCalls when missing. */
      name?: string
      content: string | ContentPart[]
      isError?: boolean
    }

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string }

/** Who a request is for. Used by the mock provider to pick a scripted answer. */
export interface RequestMeta {
  role?: string
  task?: string
  agent?: string
}

export interface ChatRequest {
  /** Model id as the provider knows it (without the provider prefix). */
  model: string
  messages: ChatMessage[]
  /** JSON schema for structured output, where the provider supports it. */
  schema?: Record<string, unknown>
  tools?: ToolDef[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  /** Extra JSON fields merged into the request body (per-model `extra_body`). */
  extraBody?: Record<string, unknown> | null
  meta?: RequestMeta
}

export interface Usage {
  /** All input tokens, cached ones included. */
  inputTokens: number
  /** The part of the input that came from the provider's prompt cache. */
  cachedInputTokens: number
  outputTokens: number
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'other'

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: Usage }
  /** Emitted once per call, when its arguments are complete. `argsError` is set when the arguments were not valid JSON (then `args` is `{}`). */
  | { type: 'tool_call'; id: string; name: string; args: unknown; providerMeta?: unknown; argsError?: string }
  | { type: 'finish'; reason: FinishReason }

export interface ProviderClient {
  readonly id: string
  /** Streams the reply: deltas, then tool calls, the finish event and the usage event (when the provider reports it). */
  chat(req: ChatRequest): AsyncGenerator<ChatEvent, void, void>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
    readonly retryAfterMs?: number
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
}

/** The text of a message's content (image parts are dropped). */
export function contentText(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content
  return content
    .map((p) => (p.type === 'text' ? p.text : ''))
    .filter(Boolean)
    .join('\n')
}

export function messageText(m: ChatMessage): string {
  return contentText(m.content)
}

export interface Collected {
  text: string
  usage: Usage
  toolCalls: ToolCall[]
  /** Set when a call's arguments could not be parsed: call id -> the parse error. */
  argErrors: Record<string, string>
  finishReason: FinishReason
}

/** Reads a stream to the end. */
export async function collect(stream: AsyncIterable<ChatEvent>, onDelta?: (text: string) => void): Promise<Collected> {
  let text = ''
  let usage = emptyUsage()
  const toolCalls: ToolCall[] = []
  const argErrors: Record<string, string> = {}
  let finishReason: FinishReason | undefined
  for await (const ev of stream) {
    if (ev.type === 'delta') {
      text += ev.text
      onDelta?.(ev.text)
    } else if (ev.type === 'usage') usage = ev.usage
    else if (ev.type === 'tool_call') {
      toolCalls.push({ id: ev.id, name: ev.name, args: ev.args, ...(ev.providerMeta !== undefined ? { providerMeta: ev.providerMeta } : {}) })
      if (ev.argsError) argErrors[ev.id] = ev.argsError
    } else finishReason = ev.reason
  }
  return { text, usage, toolCalls, argErrors, finishReason: finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop') }
}

/** A rough token count: 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Options of one chat call through a `ChatFn`. */
export interface ChatOpts {
  schema?: Record<string, unknown>
  tools?: ToolDef[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  onDelta?: (text: string) => void
}

export interface ChatResult extends Collected {
  costUsd: number
  /** `provider/model` that answered, when known. */
  model?: string
}

/** One model call, with whatever fallback and routing is behind it. `ModelRouter.chatFn` makes one. */
export type ChatFn = (messages: ChatMessage[], opts?: ChatOpts) => Promise<ChatResult>

/** Maps an HTTP status to a ProviderError. 408, 425, 429 and 5xx can be retried. */
export function httpError(status: number, bodyText: string, retryAfter?: string | null): ProviderError {
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500
  let retryAfterMs: number | undefined
  if (retryAfter) {
    const secs = Number(retryAfter)
    if (Number.isFinite(secs)) retryAfterMs = secs * 1000
  }
  return new ProviderError(`HTTP ${status}: ${bodyText.slice(0, 300)}`, status, retryable, retryAfterMs)
}

/** Converts network failures and timeouts to retryable ProviderErrors. Aborts by the caller pass through. */
export function asProviderError(err: unknown, caller?: AbortSignal): unknown {
  if (caller?.aborted || err instanceof ProviderError) return err
  const e = err as Error
  if (e?.name === 'TimeoutError') return new ProviderError('request timed out', undefined, true)
  if (e?.name === 'AbortError') return err
  return new ProviderError(`network error: ${e?.message ?? String(err)}`, undefined, true)
}

/** Parses tool-call arguments as streamed: '' means no arguments. */
export function parseToolArgs(raw: string): { args: unknown; error?: string } {
  const t = raw.trim()
  if (t === '') return { args: {} }
  try {
    return { args: JSON.parse(t) as unknown }
  } catch (e) {
    return { args: {}, error: `arguments are not valid JSON (${(e as Error).message}): ${t.slice(0, 200)}` }
  }
}

let callSeq = 0
/** An id for a tool call the provider gave none to. */
export function synthesizeCallId(): string {
  return `call_${Date.now().toString(36)}_${(callSeq++).toString(36)}`
}

/** Removes reasoning blocks some models put in their answer. */
export function stripThinking(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const close = t.toLowerCase().lastIndexOf('</think>')
  if (close !== -1) t = t.slice(close + 8)
  return t.replace(/^\s+/, '')
}

/** Streaming filter that drops `<think>...</think>` blocks from text arriving in arbitrary chunks. */
export class ThinkFilter {
  private inThink = false
  private pending = ''

  /** Feeds a chunk, returns the visible part of it (possibly empty). */
  push(chunk: string): string {
    let s = this.pending + chunk
    this.pending = ''
    let out = ''
    for (;;) {
      if (this.inThink) {
        const i = s.toLowerCase().indexOf('</think>')
        if (i === -1) {
          this.pending = keepPartialTag(s, '</think>')
          return out
        }
        s = s.slice(i + 8).replace(/^\s+/, '')
        this.inThink = false
      } else {
        const i = s.toLowerCase().indexOf('<think>')
        if (i === -1) {
          const keep = keepPartialTag(s, '<think>')
          this.pending = keep
          return out + s.slice(0, s.length - keep.length)
        }
        out += s.slice(0, i)
        s = s.slice(i + 7)
        this.inThink = true
      }
    }
  }

  /** The text still held back (a partial tag that never completed). */
  flush(): string {
    const rest = this.inThink ? '' : this.pending
    this.pending = ''
    return rest
  }
}

/** The longest suffix of `s` that is a proper prefix of `tag` (case-insensitive): it might be the start of the tag. */
function keepPartialTag(s: string, tag: string): string {
  const max = Math.min(s.length, tag.length - 1)
  for (let n = max; n > 0; n--) if (tag.startsWith(s.slice(s.length - n).toLowerCase())) return s.slice(s.length - n)
  return ''
}
