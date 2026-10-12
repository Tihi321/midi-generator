import { ProviderLimiter } from './limiter'
import { costOf } from './registry'
import type { ModelInfo, ModelRegistry } from './registry'
import { emptyUsage, isAbortError, ProviderError } from './types'
import type { ChatFn, ChatMessage, ChatOpts, ChatResult, FinishReason, RequestMeta, ToolCall, ToolChoice, ToolDef, Usage } from './types'

export interface CandidateOptions {
  /** The user's own `provider/model` (or alias) pick. Goes first. */
  agentModel?: string | null
  /** Models of this family go last. */
  avoidFamily?: string | null
  /** Keep only models that support native tool calling. */
  requireTools?: boolean
}

export interface RoutedRequest {
  messages: ChatMessage[]
  schema?: Record<string, unknown>
  tools?: ToolDef[]
  toolChoice?: ToolChoice
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
  meta?: RequestMeta
}

export type RoutedEvent =
  | { type: 'attempt'; model: ModelInfo; attempt: number }
  | { type: 'delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown; providerMeta?: unknown; argsError?: string }
  | { type: 'done'; model: ModelInfo; usage: Usage; costUsd: number; ms: number; finishReason: FinishReason }

export interface RouterOptions {
  /** Retries on the same model for retryable errors before falling back. Default 2. */
  retries?: number
  /** First backoff in ms. Doubled each retry. Default 1000. */
  backoffMs?: number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
      },
      { once: true }
    )
  })

/**
 * Picks models for a role and calls them with fallback: retries with backoff on 429, 5xx and timeouts,
 * then the next model in the list. Respects provider concurrency and rpm limits.
 */
export class ModelRouter {
  readonly limiter: ProviderLimiter
  private readonly opts: Required<Omit<RouterOptions, 'now'>>

  constructor(
    readonly registry: ModelRegistry,
    opts: RouterOptions = {},
    limiter?: ProviderLimiter
  ) {
    this.limiter = limiter ?? new ProviderLimiter(opts.now)
    this.opts = { retries: opts.retries ?? 2, backoffMs: opts.backoffMs ?? 1000, sleep: opts.sleep ?? defaultSleep }
  }

  /** Ordered models for a role: the user's pick, then the role's list. Unavailable providers are dropped. */
  candidates(role: string, o: CandidateOptions = {}): ModelInfo[] {
    const refs = [...(o.agentModel ? [this.registry.resolve(o.agentModel)] : []), ...this.registry.roleModelRefs(role)]
    const seen = new Set<string>()
    const list: ModelInfo[] = []
    for (const ref of refs) {
      if (seen.has(ref)) continue
      seen.add(ref)
      const m = this.registry.getModel(ref)
      if (m && m.provider.available && m.provider.client && (!o.requireTools || m.tools)) list.push(m)
    }
    if (o.avoidFamily) {
      const keep = list.filter((m) => m.family !== o.avoidFamily)
      const avoid = list.filter((m) => m.family === o.avoidFamily)
      return [...keep, ...avoid]
    }
    return list
  }

  /**
   * Streams a reply, falling back through `models`.
   * After a failed attempt the consumer sees a new `attempt` event and should drop the text and tool calls so far.
   */
  async *chat(models: ModelInfo[], req: RoutedRequest): AsyncGenerator<RoutedEvent, void, void> {
    if (models.length === 0) throw new ProviderError(`no available model${req.meta?.role ? ` for role ${req.meta.role}` : ''}`)
    let lastError: unknown
    let attempts = 0
    const failures: string[] = []
    for (const model of models) {
      for (let retry = 0; retry <= this.opts.retries; retry++) {
        if (req.signal?.aborted) throw abort()
        const provider = model.provider
        let acquired = false
        const started = Date.now()
        try {
          await this.limiter.acquire(provider, req.signal)
          acquired = true
          const wait = this.limiter.rpmWaitMs(provider)
          if (wait > 0) await this.opts.sleep(wait, req.signal)
          this.limiter.noteRequest(provider)
          attempts++
          yield { type: 'attempt', model, attempt: attempts }
          let usage = emptyUsage()
          let finishReason: FinishReason = 'stop'
          let sawCalls = false
          for await (const ev of provider.client!.chat({
            model: model.id,
            messages: req.messages,
            schema: req.schema,
            tools: req.tools,
            toolChoice: req.toolChoice,
            maxTokens: req.maxTokens,
            temperature: req.temperature,
            signal: req.signal,
            extraBody: model.extraBody,
            meta: req.meta
          })) {
            if (ev.type === 'delta') yield { type: 'delta', text: ev.text }
            else if (ev.type === 'tool_call') {
              sawCalls = true
              yield ev
            } else if (ev.type === 'finish') finishReason = ev.reason
            else usage = ev.usage
          }
          yield { type: 'done', model, usage, costUsd: costOf(model, usage), ms: Date.now() - started, finishReason: sawCalls ? 'tool_calls' : finishReason }
          return
        } catch (err) {
          if (isAbortError(err) || req.signal?.aborted) throw err
          lastError = err
          // a request too big for this model fails the same way every time: go straight to the next model
          const retryable = err instanceof ProviderError && err.retryable && !isContextError(err)
          if (!retryable || retry === this.opts.retries) {
            failures.push(`${model.ref}: ${err instanceof Error ? err.message : String(err)}`)
            break
          }
          const delay = (err as ProviderError).retryAfterMs ?? this.opts.backoffMs * 2 ** retry
          await this.opts.sleep(delay, req.signal)
        } finally {
          if (acquired) this.limiter.release(provider)
        }
      }
    }
    // with more than one model, say why each one failed: the last error alone hides the real cause
    if (failures.length > 1) throw new ProviderError(`all models failed. ${failures.map((f) => f.slice(0, 400)).join(' | ')}`)
    throw lastError instanceof Error ? lastError : new ProviderError('all models failed')
  }

  /** Reads `chat` to the end. The text and tool calls of a failed attempt are dropped from the result (`onDelta` has already seen that text). */
  async complete(models: ModelInfo[], req: RoutedRequest, onDelta?: (text: string) => void): Promise<ChatResult & { model: string; modelInfo: ModelInfo }> {
    let text = ''
    let toolCalls: ToolCall[] = []
    let argErrors: Record<string, string> = {}
    let done: Extract<RoutedEvent, { type: 'done' }> | undefined
    for await (const ev of this.chat(models, req)) {
      if (ev.type === 'attempt') {
        text = ''
        toolCalls = []
        argErrors = {}
      } else if (ev.type === 'delta') {
        text += ev.text
        onDelta?.(ev.text)
      } else if (ev.type === 'tool_call') {
        toolCalls.push({ id: ev.id, name: ev.name, args: ev.args, ...(ev.providerMeta !== undefined ? { providerMeta: ev.providerMeta } : {}) })
        if (ev.argsError) argErrors[ev.id] = ev.argsError
      } else done = ev
    }
    if (!done) throw new ProviderError('the model returned nothing')
    return { text, toolCalls, argErrors, usage: done.usage, costUsd: done.costUsd, finishReason: done.finishReason, model: done.model.ref, modelInfo: done.model }
  }

  /**
   * A `ChatFn` over these models, or over the models of a role (`{ role, agentModel }`). Fallback and retries happen inside it.
   * `meta` is passed to every request.
   */
  chatFn(target: ModelInfo[] | { role: string; agentModel?: string | null; requireTools?: boolean }, meta?: RequestMeta): ChatFn {
    return (messages: ChatMessage[], o: ChatOpts = {}) => {
      const models = Array.isArray(target) ? target : this.candidates(target.role, target)
      const role = Array.isArray(target) ? meta?.role : target.role
      return this.complete(
        models,
        { messages, schema: o.schema, tools: o.tools, toolChoice: o.toolChoice, maxTokens: o.maxTokens, temperature: o.temperature, signal: o.signal, meta: { ...meta, ...(role ? { role } : {}) } },
        o.onDelta
      )
    }
  }
}

/** The request is larger than the model's context window, or the model ran out of tokens before answering. */
export function isContextError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /exceed_context_size|exceeds the available context|context (size|length|window)|maximum context|n_ctx|token limit without an answer/i.test(msg)
}

function abort(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
}
