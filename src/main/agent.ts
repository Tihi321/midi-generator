// The built-in agent runner (main process). It owns the conversation between turns, builds the system
// prompt, wraps each run in one agent turn on the live song (one undo step), forwards events to the
// Chat panel and supports stop. No Electron import: the pieces it needs are injected, so it is unit-testable.
//
// Turn policy: the whole run is ONE undo step ("Agent: <first words>"). Completed, max-steps and
// aborted runs keep their work (Stop leaves what was written so far, undoable as one step). A run that
// ENDS IN AN ERROR is rolled back and its messages are not added to the conversation, so a failed turn
// leaves no half-finished music and no broken history.

import { randomUUID } from 'node:crypto'
import { runAgent } from '../llm'
import type { AgentEvent, AgentModelSource, AgentResult, ChatMessage, ToolHost as LlmToolHost, ToolResult as LlmToolResult } from '../llm'
import { AGENT_TURN_LABEL_PREFIX, type AgentSendResponse, type AgentState, type AgentUiEvent, type AgentUsage, type ChatSummary, type OpenedChat } from '../shared/agent'
import type { ToolHost, ToolResult, TurnToolHost } from '../shared/tools'
import type { ChatHistoryStore } from './chatHistory'

export const MAX_AGENT_STEPS = 25

/** Start of the get_style_context text when the song has no references. */
const NO_STYLE_REFERENCES = 'No style references'

type ImagePart = { type: 'image'; mimeType: string; data: string }

/** An event without its run id (the runner adds it). */
type UiBody = AgentUiEvent extends infer E ? (E extends { runId: string } ? Omit<E, 'runId'> : never) : never

/** Tools that change notes: the model gets a `render_preview` after them when it can see images. */
const WRITING_TOOL_NAMES = new Set(['write_pattern', 'write_melody', 'write_drums', 'set_cells', 'clear_pattern', 'copy_pattern', 'transpose', 'place_asset'])

export function isWritingTool(name: string): boolean {
  return WRITING_TOOL_NAMES.has(name)
}

/** Show the order row a write went to (when it said which); otherwise the whole song (the tool caps the size). */
function previewArgs(args: unknown): Record<string, unknown> {
  const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const order = typeof a['toOrder'] === 'number' ? a['toOrder'] : typeof a['order'] === 'number' ? a['order'] : undefined
  return order === undefined ? {} : { fromOrder: order, toOrder: order }
}

/**
 * Wraps a host so that after a successful writing tool the result also carries a `render_preview` image
 * (a vision model can check its own work). Off (`enabled` false) it returns the host unchanged. The
 * preview is skipped when the host has no `render_preview`, the write failed, the call was aborted, or the
 * preview fails (the write result is returned as it was).
 */
export function withAutoPreview(host: ToolHost, enabled: boolean): ToolHost {
  if (!enabled) return host
  return {
    tools: () => host.tools(),
    async execute(name, args, signal) {
      const result = await host.execute(name, args, signal)
      if (!isWritingTool(name) || result.isError || signal.aborted) return result
      if (!host.tools().some((t) => t.name === 'render_preview')) return result
      if (result.content.some((c) => c.type === 'image')) return result
      try {
        const preview = await host.execute('render_preview', previewArgs(args), signal)
        const images = preview.isError ? [] : preview.content.filter((c) => c.type === 'image')
        if (!images.length) return result
        return { ...result, content: [...result.content, { type: 'text', text: 'Piano-roll preview of the song after this change:' }, ...images] }
      } catch {
        return result
      }
    }
  }
}

/** `Agent: <first words of the prompt>`, the undo label of a turn. */
export function turnLabel(prompt: string): string {
  const words = prompt.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
  const short = words.length > 40 ? `${words.slice(0, 39)}…` : words
  return `${AGENT_TURN_LABEL_PREFIX}${short || 'turn'}`
}

/** Keeps an event for the saved chat; streamed text of one answer is kept as one event. */
function record(events: AgentUiEvent[], ev: AgentUiEvent): void {
  const last = events[events.length - 1]
  if (ev.type === 'text' && last?.type === 'text' && last.runId === ev.runId) events[events.length - 1] = { ...last, text: last.text + ev.text }
  else events.push(ev)
}

function textOf(result: ToolResult | LlmToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
}

const SUMMARY_CHARS = 600
const MAX_IMAGE_CHARS = 3_000_000

function summarize(result: ToolResult | LlmToolResult): { summary: string; image?: string } {
  const text = textOf(result)
  const summary = text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS)}… (+${text.length - SUMMARY_CHARS} chars)` : text
  const img = result.content.find((c) => c.type === 'image')
  const image = img && img.type === 'image' && img.data.length <= MAX_IMAGE_CHARS ? `data:${img.mimeType};base64,${img.data}` : undefined
  return { summary: summary || (img ? '(image)' : '(no output)'), ...(image ? { image } : {}) }
}

export interface ResolvedAgentModel {
  source: AgentModelSource
  vision: boolean
}

export interface AgentRunnerOptions {
  /** The live song (the ToolBridge). */
  bridge: TurnToolHost
  /** The guide text (GUIDE), first part of the system prompt. */
  guide: string
  /** Receives every UI event. */
  emit: (ev: AgentUiEvent) => void
  /** Picks the model for a run. */
  resolveModel: (modelRef: string | null | undefined) => Promise<ResolvedAgentModel>
  maxSteps?: number
  /** Replace the loop (tests). */
  run?: typeof runAgent
  /** Where conversations are saved after every turn. None: nothing is saved. */
  chats?: ChatHistoryStore
}

/** A conversation: what the model sees and what the Chat panel was sent. */
interface Conversation {
  id: string
  title: string
  createdAt: number
  history: ChatMessage[]
  events: AgentUiEvent[]
}

const newConversation = (): Conversation => ({ id: randomUUID(), title: '', createdAt: Date.now(), history: [], events: [] })

/** The chat's title: the first words of its first message. */
export function chatTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t.length > 60 ? `${t.slice(0, 59)}…` : t || 'Chat'
}

export class AgentRunner {
  private convo = newConversation()
  private current: { runId: string; abort: AbortController; done: Promise<void> } | null = null

  constructor(private readonly opts: AgentRunnerOptions) {}

  getState(): AgentState {
    return { running: this.current !== null, runId: this.current?.runId ?? null, messageCount: this.convo.history.length, chatId: this.convo.id }
  }

  /** The conversation kept between turns (a copy). */
  messages(): ChatMessage[] {
    return [...this.convo.history]
  }

  /** Starts a run and returns right away; events stream through `emit`. Only one run at a time. */
  send(req: { text: string; modelRef?: string | null }): AgentSendResponse {
    const text = (req.text ?? '').trim()
    if (!text) return { ok: false, error: 'Write a message first.' }
    if (this.current) return { ok: false, error: 'The agent is still working on the previous message. Stop it or wait.' }
    const runId = randomUUID()
    const abort = new AbortController()
    const done = this.execute(this.convo, runId, text, req.modelRef, abort).catch(() => undefined)
    this.current = { runId, abort, done }
    return { ok: true, runId }
  }

  /** Aborts the running turn (no-op when idle). */
  stop(): void {
    this.current?.abort.abort()
  }

  /** Starts a new conversation. A running turn is aborted first; it ends in the conversation it started in (and is saved there). */
  reset(): AgentState {
    this.current?.abort.abort()
    this.convo = newConversation()
    return this.getState()
  }

  /** The saved chats, newest first. */
  async listChats(): Promise<ChatSummary[]> {
    return this.opts.chats ? this.opts.chats.list() : []
  }

  /** Continues a saved chat: it becomes the current conversation. Returns its events for the Chat panel to replay. */
  async openChat(id: string): Promise<OpenedChat> {
    if (!this.opts.chats) throw new Error('Chats are not saved here.')
    if (this.current) throw new Error('The agent is still working. Stop it or wait, then open the chat.')
    const chat = await this.opts.chats.load(id)
    this.convo = { id: chat.id, title: chat.title, createdAt: chat.createdAt, history: chat.messages, events: chat.events }
    return { state: this.getState(), events: chat.events }
  }

  /** Deletes a saved chat. Deleting the current conversation starts a new one. */
  async deleteChat(id: string): Promise<AgentState> {
    if (id === this.convo.id) {
      if (this.current) throw new Error('The agent is working in this chat. Stop it first.')
      this.convo = newConversation()
    }
    await this.opts.chats?.delete(id)
    return this.getState()
  }

  /** Resolves when the current run (if any) has finished. */
  async whenIdle(): Promise<void> {
    while (this.current) await this.current.done
  }

  private async execute(convo: Conversation, runId: string, text: string, modelRef: string | null | undefined, abort: AbortController): Promise<void> {
    const { bridge, emit } = this.opts
    if (!convo.title) convo.title = chatTitle(text)
    const deliver = (ev: AgentUiEvent): void => {
      try {
        emit(ev)
      } catch {
        /* a listener must not break the run */
      }
    }
    // `done` goes out after the chat is saved, so the history the panel asks for then has this turn
    let done: AgentUiEvent | null = null
    const send = (body: UiBody): void => {
      const ev = { ...body, runId } as AgentUiEvent
      record(convo.events, ev)
      if (ev.type === 'done') done = ev
      else deliver(ev)
    }
    const label = turnLabel(text)
    send({ type: 'start', label, text })
    const zero: AgentUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
    const fail = (message: string): void => {
      send({ type: 'error', message })
      send({ type: 'done', reason: 'error', steps: 0, usage: zero, costUsd: 0, error: message })
    }

    let turnOpen = false
    try {
      let model: ResolvedAgentModel
      try {
        model = await this.opts.resolveModel(modelRef)
      } catch (err) {
        return fail(`Could not set up the language models: ${err instanceof Error ? err.message : String(err)}`)
      }
      const { system, styleImages } = await this.buildSystem(abort.signal)
      if (abort.signal.aborted) {
        send({ type: 'done', reason: 'aborted', steps: 0, usage: zero, costUsd: 0 })
        return
      }
      try {
        await bridge.beginTurn(label)
        turnOpen = true
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }

      const host: LlmToolHost = withAutoPreview(bridge, model.vision)
      const result: AgentResult = await (this.opts.run ?? runAgent)({
        ...model.source,
        system,
        history: convo.history,
        // Vision models see the style reference images once, with the first message of a conversation.
        userMessage:
          model.vision && styleImages.length > 0 && convo.history.length === 0
            ? [{ type: 'text', text }, { type: 'text', text: 'Preview images of the style reference assets (same order as in the style context):' }, ...styleImages]
            : text,
        host,
        maxSteps: this.opts.maxSteps ?? MAX_AGENT_STEPS,
        signal: abort.signal,
        onEvent: (ev) => this.forward(ev, send)
      })

      let endError: string | undefined
      try {
        await bridge.endTurn({ rollback: result.reason === 'error' })
      } catch (err) {
        endError = `Could not close the agent turn: ${err instanceof Error ? err.message : String(err)}`
      }
      turnOpen = false
      if (result.reason !== 'error') convo.history = result.messages
      const error = result.error?.message ?? endError
      send({
        type: 'done',
        reason: result.reason,
        steps: result.steps,
        usage: result.usage,
        costUsd: result.costUsd,
        ...(result.model ? { model: result.model } : {}),
        ...(error ? { error } : {})
      })
    } catch (err) {
      // Not expected: runAgent never throws. Keep the song consistent anyway.
      if (turnOpen) await Promise.resolve(bridge.endTurn({ rollback: true })).catch(() => undefined)
      fail(err instanceof Error ? err.message : String(err))
    } finally {
      this.current = null
      await this.save(convo)
      if (done) deliver(done)
    }
  }

  private async save(convo: Conversation): Promise<void> {
    if (!this.opts.chats || convo.events.length === 0) return
    try {
      await this.opts.chats.save({ version: 1, id: convo.id, title: convo.title, createdAt: convo.createdAt, updatedAt: Date.now(), messages: convo.history, events: convo.events })
    } catch (err) {
      console.warn(`[agent] could not save the chat: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private forward(ev: AgentEvent, send: (ev: UiBody) => void): void {
    switch (ev.type) {
      case 'step':
        send({ type: 'step', step: ev.step, maxSteps: ev.maxSteps, mode: ev.mode })
        break
      case 'text':
        send({ type: 'text', text: ev.text })
        break
      case 'tool_call':
        send({ type: 'tool_call', id: ev.id, name: ev.name, args: ev.args })
        break
      case 'tool_result':
        send({ type: 'tool_result', id: ev.id, name: ev.name, isError: ev.isError, ...summarize(ev.result) })
        break
      case 'usage':
        send({ type: 'usage', usage: ev.usage, costUsd: ev.costUsd, ...(ev.model ? { model: ev.model } : {}) })
        break
      case 'error':
        send({ type: 'error', message: ev.error.message })
        break
      case 'done':
        break // main sends its own `done` after the turn is closed
    }
  }

  /** GUIDE + the current song (get_song) + style context (get_style_context, when references exist). */
  private async buildSystem(signal: AbortSignal): Promise<{ system: string; styleImages: ImagePart[] }> {
    const { bridge, guide } = this.opts
    const parts = [guide]
    const call = async (name: string): Promise<ToolResult | null> => {
      try {
        const r = await bridge.execute(name, {}, signal)
        return r.isError ? null : r
      } catch {
        return null
      }
    }
    const doc = await call('get_song')
    const docText = doc ? textOf(doc) : ''
    parts.push(docText ? `## Current song\n\n${docText}` : '## Current song\n\n(not available: call get_song yourself)')
    let styleImages: ImagePart[] = []
    if (bridge.tools().some((t) => t.name === 'get_style_context')) {
      const style = await call('get_style_context')
      const styleText = style ? textOf(style) : ''
      // "No style references are set ..." is not worth the tokens.
      if (style && styleText && !styleText.startsWith(NO_STYLE_REFERENCES)) {
        parts.push(`## Style context\n\n${styleText}`)
        styleImages = style.content.filter((c): c is ImagePart => c.type === 'image').slice(0, 4)
      }
    }
    return { system: parts.join('\n\n'), styleImages }
  }
}
