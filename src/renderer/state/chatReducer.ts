// Pure chat transcript logic: turns the agent's push events into messages and tool cards. No React,
// zustand or window access here, so it is unit-tested (tests/renderer/chat*.test.ts).

import { AGENT_TURN_LABEL_PREFIX, type AgentStopReason, type AgentUiEvent, type AgentUsage } from '../../shared/agent'

export type ToolCardStatus = 'running' | 'ok' | 'error'

export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | { kind: 'tool'; id: string; callId: string; name: string; args: unknown; status: ToolCardStatus; summary?: string; image?: string }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'info'; id: string; text: string }

export interface ChatState {
  items: ChatItem[]
  /** The run being shown; events of other runs are ignored (they belong to a conversation that was reset). */
  runId: string | null
  running: boolean
  /** `step 3/25` while running. */
  step: { step: number; maxSteps: number } | null
  usage: AgentUsage
  costUsd: number
  model: string | null
  lastReason: AgentStopReason | null
  seq: number
}

export const emptyUsage = (): AgentUsage => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 })

export function initialChat(): ChatState {
  return { items: [], runId: null, running: false, step: null, usage: emptyUsage(), costUsd: 0, model: null, lastReason: null, seq: 0 }
}

/** The conversation was reset: nothing is shown and events of the old run are ignored from now on. */
export function resetChat(): ChatState {
  return initialChat()
}

type ItemBody = ChatItem extends infer U ? (U extends { id: string } ? Omit<U, 'id'> : never) : never

function withId(state: ChatState, item: ItemBody, items: ChatItem[]): ChatState {
  const seq = state.seq + 1
  return { ...state, seq, items: [...items, { ...item, id: `c${seq}` } as ChatItem] }
}

/** Marks the last assistant message as finished (a step ended or a tool was called). */
function closeStreaming(items: ChatItem[]): ChatItem[] {
  const last = items[items.length - 1]
  if (last && last.kind === 'assistant' && last.streaming) return [...items.slice(0, -1), { ...last, streaming: false }]
  return items
}

/** Adds an error line (a failed `agent:send`, for example). */
export function addError(state: ChatState, message: string): ChatState {
  return withId(state, { kind: 'error', message }, closeStreaming(state.items))
}

export function applyEvent(state: ChatState, ev: AgentUiEvent): ChatState {
  if (ev.type === 'start') {
    // A new run: keep the earlier transcript.
    const base = { ...state, runId: ev.runId, running: true, step: null, lastReason: null }
    return withId(base, { kind: 'user', text: ev.text }, closeStreaming(state.items))
  }
  if (ev.runId !== state.runId) return state

  switch (ev.type) {
    case 'step':
      return { ...state, step: { step: ev.step, maxSteps: ev.maxSteps }, items: closeStreaming(state.items) }
    case 'text': {
      if (!ev.text) return state
      const last = state.items[state.items.length - 1]
      if (last && last.kind === 'assistant' && last.streaming) {
        return { ...state, items: [...state.items.slice(0, -1), { ...last, text: last.text + ev.text }] }
      }
      return withId(state, { kind: 'assistant', text: ev.text, streaming: true }, state.items)
    }
    case 'tool_call':
      return withId(state, { kind: 'tool', callId: ev.id, name: ev.name, args: ev.args, status: 'running' }, closeStreaming(state.items))
    case 'tool_result': {
      const idx = state.items.findIndex((i) => i.kind === 'tool' && i.callId === ev.id && i.status === 'running')
      const status: ToolCardStatus = ev.isError ? 'error' : 'ok'
      if (idx < 0) {
        return withId(state, { kind: 'tool', callId: ev.id, name: ev.name, args: undefined, status, summary: ev.summary, image: ev.image }, state.items)
      }
      const items = [...state.items]
      const card = items[idx] as Extract<ChatItem, { kind: 'tool' }>
      items[idx] = { ...card, status, summary: ev.summary, image: ev.image }
      return { ...state, items }
    }
    case 'usage':
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + ev.usage.inputTokens,
          cachedInputTokens: state.usage.cachedInputTokens + ev.usage.cachedInputTokens,
          outputTokens: state.usage.outputTokens + ev.usage.outputTokens
        },
        costUsd: state.costUsd + ev.costUsd,
        model: ev.model ?? state.model
      }
    case 'error': {
      const last = state.items[state.items.length - 1]
      if (last && last.kind === 'error' && last.message === ev.message) return state
      return addError(state, ev.message)
    }
    case 'done': {
      let next: ChatState = { ...state, running: false, step: null, lastReason: ev.reason, items: closeStreaming(state.items).map((i) => (i.kind === 'tool' && i.status === 'running' ? { ...i, status: 'error' as const, summary: i.summary ?? 'cancelled' } : i)) }
      if (ev.error) {
        const last = next.items[next.items.length - 1]
        if (!(last && last.kind === 'error' && last.message === ev.error)) next = addError(next, ev.error)
      }
      if (ev.reason === 'aborted') next = withId(next, { kind: 'info', text: 'Stopped. What was drawn so far is kept (one undo step).' }, next.items)
      else if (ev.reason === 'max_steps') next = withId(next, { kind: 'info', text: `Stopped after ${ev.steps} steps (the limit). Ask it to continue if needed.` }, next.items)
      else if (ev.reason === 'error') next = withId(next, { kind: 'info', text: 'The turn failed and its changes were rolled back.' }, next.items)
      return next
    }
  }
}

/** A saved chat shown again: its events replayed. A turn that never finished (the app was closed) shows as stopped. */
export function replayChat(events: AgentUiEvent[]): ChatState {
  let state = initialChat()
  for (const ev of events) state = applyEvent(state, ev)
  if (state.running && state.runId) state = applyEvent(state, { type: 'done', runId: state.runId, reason: 'aborted', steps: 0, usage: emptyUsage(), costUsd: 0 })
  return state
}

/** Compact token count: 1234 -> "1.2k". */
export function formatTokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function formatCost(usd: number): string {
  if (usd <= 0) return '$0'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

/** What the "Undo agent turn" button needs to know about the last turn. */
export interface TurnUndoInfo {
  /** Undo depth before the turn and after it was closed. */
  startDepth: number
  endDepth: number
}

/**
 * The button is on when the newest undo step is the last agent turn: the history is still exactly where the
 * turn left it and the turn added a step. A step labelled "Agent: ..." counts too (a turn the user left open).
 */
export function canUndoAgentTurn(turn: TurnUndoInfo | null, undoDepth: number, undoLabel: string | undefined, canUndo: boolean): boolean {
  if (!canUndo) return false
  if (turn && turn.endDepth > turn.startDepth && undoDepth === turn.endDepth) return true
  return !!undoLabel && undoLabel.startsWith(AGENT_TURN_LABEL_PREFIX)
}
