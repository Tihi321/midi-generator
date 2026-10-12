import { z } from 'zod'
import { chatJson } from './json'
import type { ModelRouter } from './router'
import { emptyUsage } from './types'
import type { ChatFn, ChatMessage, ContentPart, ToolCall, ToolDef, Usage } from './types'

/** What a tool returns. Images are only shown to models that can see (see `ModelCapabilities.vision`). */
export interface ToolResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string })[]
  isError?: boolean
}

/** The tools an agent can use. Phase 3's ToolRegistry implements it. */
export interface ToolHost {
  tools(): ToolDef[]
  /** Runs a tool. It may throw: the agent turns that into an error result for the model. */
  execute(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>
}

export interface ModelCapabilities {
  /** Native tool calling. When false the agent uses the JSON-action fallback. */
  tools: boolean
  /** The model can look at images. When false, images in tool results are replaced by a short note. */
  vision: boolean
}

export type AgentStopReason = 'completed' | 'max_steps' | 'aborted' | 'error'

export type AgentEvent =
  | { type: 'step'; step: number; maxSteps: number; mode: 'native' | 'json' }
  /** A piece of the model's text (native mode streams deltas; JSON mode sends the whole `say` at once). */
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  /** `result` is what the tool returned (images included), before truncation and image stripping. */
  | { type: 'tool_result'; id: string; name: string; result: ToolResult; isError: boolean }
  | { type: 'usage'; usage: Usage; costUsd: number; model?: string }
  | { type: 'error'; error: Error }
  | { type: 'done'; reason: AgentStopReason; messages: ChatMessage[]; steps: number }

export interface AgentResult {
  reason: AgentStopReason
  /** The whole conversation without the system message: `history`, the user message and everything this run added. Pass it as `history` next turn. */
  messages: ChatMessage[]
  steps: number
  usage: Usage
  costUsd: number
  /** `provider/model` that answered last, when known. */
  model?: string
  error?: Error
}

export type AgentModelSource =
  | {
      /** Pick the model by role: `modelRef` (the user's choice), then the role's list. Capabilities come from the first model. */
      router: ModelRouter
      role: string
      modelRef?: string | null
    }
  | { chat: ChatFn; capabilities: ModelCapabilities }

export type RunAgentOptions = AgentModelSource & {
  system: string
  /** Earlier messages of the conversation, without the system message. */
  history?: ChatMessage[]
  userMessage: string | ContentPart[]
  host: ToolHost
  /** Model calls per run. Default 25. */
  maxSteps?: number
  signal?: AbortSignal
  onEvent?: (ev: AgentEvent) => void
  /** Text of one tool result longer than this is cut. Default 20000 characters. */
  maxToolResultChars?: number
  maxTokens?: number
  temperature?: number
  /** Force a mode. Default: native when the model supports tools, JSON-action otherwise. */
  mode?: 'native' | 'json'
}

const IMAGE_OMITTED = '[image omitted: this model cannot view images. Use the text tools (read_pattern, get_song) to inspect the song.]'

/** The JSON a model answers with in JSON-action mode. */
export const actionSchema = z.object({
  say: z.string().optional(),
  actions: z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) })).default([]),
  done: z.boolean().default(false)
})
type ActionReply = z.output<typeof actionSchema>

/** Describes the tools and the reply format for models without native tool calling. */
export function jsonModeInstructions(tools: ToolDef[]): string {
  const list = tools.map((t) => `- ${t.name}: ${t.description}\n  args (JSON schema): ${JSON.stringify(t.parameters)}`).join('\n')
  return [
    'You act through tools, but this model has no native tool calling, so you call them with JSON.',
    'Every reply must be ONE JSON object and nothing else (no code fences):',
    '{"say": "<short message to the user, optional>", "actions": [{"tool": "<tool name>", "args": { ... }}], "done": <true|false>}',
    'The actions run in order. You then get their results in the next message and can continue.',
    'Set "done": true when the task is finished (and use an empty actions list to just answer). Use only the tools listed below, with the exact argument names.',
    '',
    'Tools:',
    list || '(none)'
  ].join('\n')
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (err instanceof Error && err.name === 'AbortError')
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} more characters]`
}

/** The message content the model gets for a tool result: images only for vision models, long text cut. */
export function toolResultContent(result: ToolResult, vision: boolean, maxChars: number): string | ContentPart[] {
  const parts: ContentPart[] = []
  let sawImage = false
  for (const c of result.content) {
    if (c.type === 'text') parts.push({ type: 'text', text: truncate(c.text, maxChars) })
    else if (vision) {
      sawImage = true
      parts.push(c)
    } else parts.push({ type: 'text', text: IMAGE_OMITTED })
  }
  if (!sawImage) return parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n') || '(no output)'
  return parts
}

/** For JSON-action mode: tool messages and tool calls in the history become plain text, which any model accepts. */
function flattenToolMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const calls = JSON.stringify({ actions: m.toolCalls.map((c) => ({ tool: c.name, args: c.args })) })
      out.push({ role: 'assistant', content: m.content ? `${m.content}\n${calls}` : calls })
    } else if (m.role === 'tool') {
      const body = m.content
      const label = `Result of ${m.name ?? 'tool'}${m.isError ? ' (error)' : ''}:`
      out.push({ role: 'user', content: typeof body === 'string' ? `${label}\n${body}` : [{ type: 'text', text: label }, ...body] })
    } else out.push(m)
  }
  return out
}

/**
 * Runs one agent turn: the model answers, calls tools through `host`, gets the results, and repeats until it stops
 * calling tools (native mode) or says it is done (JSON-action mode), `maxSteps` model calls were made, or `signal` aborts.
 * Never throws: failures end the run with `reason: 'error'` (and an `error` event). A tool that throws or reports an
 * error gives the model an error result, and the run goes on.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const maxSteps = opts.maxSteps ?? 25
  const maxChars = opts.maxToolResultChars ?? 20_000
  const signal = opts.signal ?? new AbortController().signal
  const emit = (ev: AgentEvent) => {
    try {
      opts.onEvent?.(ev)
    } catch {
      /* a listener must not break the run */
    }
  }
  const convo: ChatMessage[] = [...(opts.history ?? []), { role: 'user', content: opts.userMessage }]
  let usage = emptyUsage()
  let costUsd = 0
  let model: string | undefined
  let steps = 0

  const finish = (reason: AgentStopReason, error?: Error): AgentResult => {
    if (error) emit({ type: 'error', error })
    emit({ type: 'done', reason, messages: convo, steps })
    return { reason, messages: convo, steps, usage, costUsd, model, ...(error ? { error } : {}) }
  }

  // which model, and what it can do
  let chat: ChatFn
  let caps: ModelCapabilities
  if ('router' in opts) {
    const candidates = opts.router.candidates(opts.role, { agentModel: opts.modelRef })
    const primary = candidates[0]
    if (!primary) return finish('error', new Error(`no available model for role "${opts.role}": check config/providers.md and the API keys`))
    caps = { tools: primary.tools, vision: primary.vision }
    // fall back only to models that can do what the first one does: the tool mode was chosen for it
    const same = candidates.filter((m) => m.tools === caps.tools && m.vision === caps.vision)
    chat = opts.router.chatFn(same, { role: opts.role, agent: 'agent' })
  } else {
    chat = opts.chat
    caps = opts.capabilities
  }
  const note = (r: { usage: Usage; costUsd: number; model?: string }) => {
    usage = { inputTokens: usage.inputTokens + r.usage.inputTokens, cachedInputTokens: usage.cachedInputTokens + r.usage.cachedInputTokens, outputTokens: usage.outputTokens + r.usage.outputTokens }
    costUsd += r.costUsd
    if (r.model) model = r.model
    emit({ type: 'usage', usage: r.usage, costUsd: r.costUsd, model: r.model })
  }

  const native = opts.mode ? opts.mode === 'native' : caps.tools
  const tools = opts.host.tools()
  const toolNames = new Set(tools.map((t) => t.name))

  /** Runs one tool call and returns the raw result. Never throws. */
  const runTool = async (id: string, name: string, args: unknown, argsError?: string): Promise<ToolResult> => {
    emit({ type: 'tool_call', id, name, args })
    let result: ToolResult
    if (argsError) result = errorResult(`Invalid arguments for ${name}: ${argsError}`)
    else if (!toolNames.has(name)) result = errorResult(`Unknown tool "${name}". Available tools: ${[...toolNames].join(', ') || '(none)'}`)
    else {
      try {
        result = await opts.host.execute(name, args, signal)
      } catch (err) {
        result = errorResult(signal.aborted ? 'Cancelled: the run was aborted.' : `Tool ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    emit({ type: 'tool_result', id, name, result, isError: !!result.isError })
    return result
  }

  if (native) {
    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) return finish('aborted')
      steps = step
      emit({ type: 'step', step, maxSteps, mode: 'native' })
      let r
      try {
        r = await chat([{ role: 'system', content: opts.system }, ...convo], {
          tools,
          toolChoice: 'auto',
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
          signal,
          onDelta: (text) => emit({ type: 'text', text })
        })
      } catch (err) {
        if (isAbort(err, signal)) return finish('aborted')
        return finish('error', err instanceof Error ? err : new Error(String(err)))
      }
      note(r)
      const calls: ToolCall[] = r.toolCalls
      convo.push({ role: 'assistant', content: r.text, ...(calls.length ? { toolCalls: calls } : {}) })
      if (!calls.length) return finish('completed')
      let aborted = false
      for (const call of calls) {
        if (aborted || signal.aborted) {
          aborted = true
          convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: 'Cancelled: the run was aborted before this tool ran.', isError: true })
          continue
        }
        const result = await runTool(call.id, call.name, call.args, r.argErrors?.[call.id])
        convo.push({ role: 'tool', toolCallId: call.id, name: call.name, content: toolResultContent(result, caps.vision, maxChars), ...(result.isError ? { isError: true } : {}) })
      }
      if (aborted || signal.aborted) return finish('aborted')
    }
    return finish('max_steps')
  }

  // JSON-action fallback
  const system = `${opts.system}\n\n${jsonModeInstructions(tools)}`
  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted) return finish('aborted')
    steps = step
    emit({ type: 'step', step, maxSteps, mode: 'json' })
    let reply: ActionReply
    try {
      const r = await chatJson(chat, [{ role: 'system', content: system }, ...flattenToolMessages(convo)], actionSchema, { maxTokens: opts.maxTokens, temperature: opts.temperature, signal })
      note({ usage: r.chat.usage, costUsd: r.cost, model: r.chat.model })
      reply = r.value
    } catch (err) {
      if (isAbort(err, signal)) return finish('aborted')
      return finish('error', err instanceof Error ? err : new Error(String(err)))
    }
    convo.push({ role: 'assistant', content: JSON.stringify(reply) })
    if (reply.say) emit({ type: 'text', text: reply.say })
    if (!reply.actions.length) return finish('completed')
    const parts: ContentPart[] = [{ type: 'text', text: 'Results of your actions:' }]
    let aborted = false
    for (const [i, action] of reply.actions.entries()) {
      const label = `#${i + 1} ${action.tool}`
      if (aborted || signal.aborted) {
        aborted = true
        parts.push({ type: 'text', text: `${label} (error):\nCancelled: the run was aborted before this action ran.` })
        continue
      }
      const result = await runTool(`json_${step}_${i}`, action.tool, action.args)
      const content = toolResultContent(result, caps.vision, maxChars)
      const head = `${label}${result.isError ? ' (error)' : ''}:`
      if (typeof content === 'string') parts.push({ type: 'text', text: `${head}\n${content}` })
      else parts.push({ type: 'text', text: head }, ...content)
    }
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')
    convo.push({ role: 'user', content: parts.some((p) => p.type === 'image') ? parts : text })
    if (aborted || signal.aborted) return finish('aborted')
    if (reply.done) return finish('completed')
  }
  return finish('max_steps')
}
