import { describe, expect, it } from 'vitest'
import type { AgentUiEvent } from '../../src/shared/agent'
import { type ChatState, addError, applyEvent, canUndoAgentTurn, formatCost, formatTokens, initialChat, replayChat, resetChat } from '../../src/renderer/state/chatReducer'

const R = 'run1'
const usage = { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }

function play(events: AgentUiEvent[], from: ChatState = initialChat()): ChatState {
  return events.reduce(applyEvent, from)
}
const start: AgentUiEvent = { runId: R, type: 'start', label: 'Agent: hi', text: 'hi' }

describe('chat reducer', () => {
  it('replays a saved chat; a turn that never finished shows as stopped', () => {
    const s = replayChat([start, { runId: R, type: 'text', text: 'half' }, { runId: R, type: 'tool_call', id: 'c1', name: 'write_pattern', args: {} }])
    expect(s).toMatchObject({ running: false, step: null, lastReason: 'aborted' })
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'info'])
    expect(s.items[2]).toMatchObject({ status: 'error' })
  })

  it('start adds the user message and marks the run', () => {
    const s = play([start])
    expect(s).toMatchObject({ running: true, runId: R })
    expect(s.items).toMatchObject([{ kind: 'user', text: 'hi' }])
  })

  it('merges text deltas into one assistant message and splits after a tool call', () => {
    const s = play([
      start,
      { runId: R, type: 'step', step: 1, maxSteps: 25, mode: 'native' },
      { runId: R, type: 'text', text: 'Let me ' },
      { runId: R, type: 'text', text: 'draw.' },
      { runId: R, type: 'tool_call', id: 'c1', name: 'write_pattern', args: { x: 1 } },
      { runId: R, type: 'step', step: 2, maxSteps: 25, mode: 'native' },
      { runId: R, type: 'text', text: 'Done.' }
    ])
    expect(s.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(s.items[1]).toMatchObject({ text: 'Let me draw.', streaming: false })
    expect(s.items[3]).toMatchObject({ text: 'Done.', streaming: true })
    expect(s.step).toEqual({ step: 2, maxSteps: 25 })
  })

  it('fills the tool card from its result, with the preview image', () => {
    const s = play([
      start,
      { runId: R, type: 'tool_call', id: 'c1', name: 'write_pattern', args: { x: 1 } },
      { runId: R, type: 'tool_call', id: 'c2', name: 'render_preview', args: {} },
      { runId: R, type: 'tool_result', id: 'c2', name: 'render_preview', isError: false, summary: 'image', image: 'data:image/png;base64,AA' },
      { runId: R, type: 'tool_result', id: 'c1', name: 'write_pattern', isError: true, summary: 'bad args' }
    ])
    expect(s.items[1]).toMatchObject({ kind: 'tool', callId: 'c1', status: 'error', summary: 'bad args', args: { x: 1 } })
    expect(s.items[2]).toMatchObject({ kind: 'tool', callId: 'c2', status: 'ok', image: 'data:image/png;base64,AA' })
  })

  it('adds up usage and cost over events and runs', () => {
    const s = play([
      start,
      { runId: R, type: 'usage', usage, costUsd: 0.1, model: 'a/b' },
      { runId: R, type: 'usage', usage, costUsd: 0.2 },
      { runId: R, type: 'done', reason: 'completed', steps: 2, usage, costUsd: 0.3 }
    ])
    expect(s.usage).toEqual({ inputTokens: 200, cachedInputTokens: 0, outputTokens: 40 })
    expect(s.costUsd).toBeCloseTo(0.3)
    expect(s.model).toBe('a/b')
    const s2 = play([{ runId: 'run2', type: 'start', label: 'l', text: 'again' }, { runId: 'run2', type: 'usage', usage, costUsd: 0.1 }], s)
    expect(s2.costUsd).toBeCloseTo(0.4)
    expect(s2.items.filter((i) => i.kind === 'user')).toHaveLength(2)
  })

  it('done stops the run, closes streaming text and cancels unfinished tool cards', () => {
    const s = play([
      start,
      { runId: R, type: 'text', text: 'x' },
      { runId: R, type: 'tool_call', id: 'c1', name: 'write_pattern', args: {} },
      { runId: R, type: 'done', reason: 'aborted', steps: 1, usage, costUsd: 0 }
    ])
    expect(s).toMatchObject({ running: false, step: null, lastReason: 'aborted' })
    expect(s.items.find((i) => i.kind === 'tool')).toMatchObject({ status: 'error', summary: 'cancelled' })
    expect(s.items.some((i) => i.kind === 'assistant' && i.streaming)).toBe(false)
    expect(s.items[s.items.length - 1]).toMatchObject({ kind: 'info' })
  })

  it('shows an error once even when both the error and done events carry it', () => {
    const s = play([start, { runId: R, type: 'error', message: 'boom' }, { runId: R, type: 'done', reason: 'error', steps: 1, usage, costUsd: 0, error: 'boom' }])
    expect(s.items.filter((i) => i.kind === 'error')).toHaveLength(1)
    expect(s.running).toBe(false)
  })

  it('ignores events of another run (after New chat) until a new run starts', () => {
    const s = play([{ runId: R, type: 'text', text: 'late' }, { runId: R, type: 'done', reason: 'aborted', steps: 0, usage, costUsd: 0 }], resetChat())
    expect(s.items).toEqual([])
    expect(s.running).toBe(false)
  })

  it('addError appends an inline error', () => {
    expect(addError(initialChat(), 'no model').items).toMatchObject([{ kind: 'error', message: 'no model' }])
  })

  it('gives every item a unique id', () => {
    const s = play([start, { runId: R, type: 'text', text: 'a' }, { runId: R, type: 'tool_call', id: 'c', name: 't', args: {} }, { runId: R, type: 'text', text: 'b' }])
    expect(new Set(s.items.map((i) => i.id)).size).toBe(s.items.length)
  })
})

describe('format helpers', () => {
  it('formats tokens and cost', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(45678)).toBe('46k')
    expect(formatCost(0)).toBe('$0')
    expect(formatCost(0.004)).toBe('<$0.01')
    expect(formatCost(1.234)).toBe('$1.23')
  })
})

describe('canUndoAgentTurn', () => {
  it('is on only while the history still ends at the last turn', () => {
    const turn = { startDepth: 3, endDepth: 4 }
    expect(canUndoAgentTurn(turn, 4, 'whatever', true)).toBe(true)
    expect(canUndoAgentTurn(turn, 5, 'Pencil', true)).toBe(false) // the user edited afterwards
    expect(canUndoAgentTurn(turn, 3, undefined, true)).toBe(false) // already undone
    expect(canUndoAgentTurn({ startDepth: 3, endDepth: 3 }, 3, 'Pencil', true)).toBe(false) // a turn that changed nothing
    expect(canUndoAgentTurn(turn, 4, 'x', false)).toBe(false)
    expect(canUndoAgentTurn(null, 4, 'Agent: draw a tree', true)).toBe(true) // by label
    expect(canUndoAgentTurn(null, 4, 'Pencil', true)).toBe(false)
  })
})
