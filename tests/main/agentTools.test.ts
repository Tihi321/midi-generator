// The agent loop (mock provider) driving the REAL tool registry over a SongSession.

import { describe, expect, it } from 'vitest'
import { MockProvider } from '../../src/llm/mock'
import { collect } from '../../src/llm/types'
import type { ChatFn, ChatMessage } from '../../src/llm/types'
import { AgentRunner } from '../../src/main/agent'
import type { AgentUiEvent } from '../../src/shared/agent'
import { GUIDE } from '../../src/tools'
import { memoryHost } from '../mcp/helpers'

function mockChat(mock: MockProvider): ChatFn {
  return async (messages, o = {}) => {
    const r = await collect(mock.chat({ model: 'mock', messages, tools: o.tools, toolChoice: o.toolChoice, schema: o.schema, signal: o.signal }), o.onDelta)
    return { ...r, costUsd: 0 }
  }
}

const content = (m: ChatMessage): string => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('|'))

function setup(vision: boolean) {
  const mem = memoryHost()
  const mock = new MockProvider('mock', { chunkDelayMs: 0 })
  const events: AgentUiEvent[] = []
  const runner = new AgentRunner({
    bridge: mem.host,
    guide: GUIDE,
    emit: (e) => events.push(e),
    resolveModel: async () => ({ source: { chat: mockChat(mock), capabilities: { tools: true, vision } }, vision })
  })
  return { ...mem, mock, events, runner }
}

describe('AgentRunner over the real tools', () => {
  it('puts the guide and the current song in the system prompt', async () => {
    const t = setup(false)
    t.mock.script(['hi'])
    t.runner.send({ text: 'compose something' })
    await t.runner.whenIdle()
    const system = content(t.mock.requests[0]!.messages[0]!)
    expect(system).toContain('Chiptune Studio quick guide')
    expect(system).toContain('## Current song')
    expect(system).toContain('Song "Untitled" (NES, strict)')
    expect(system).not.toContain('Style context')
  })

  it('a turn of write_pattern calls is ONE undo step, and every call lands in the song', async () => {
    const t = setup(false)
    t.mock.script([
      {
        toolCalls: [
          { id: 'a', name: 'add_instrument', args: { preset: 'lead', channel: 'P1' } },
          { id: 'b', name: 'write_pattern', args: { text: 'channels: P1\n0 | C-5 @lead v12\n4 | E-5\n8 | G-5' } },
          { id: 'c', name: 'write_pattern', args: { text: 'channels: P1\n12 | C-6', order: 0 } },
          { id: 'd', name: 'write_pattern', args: { text: 'channels: TR\n0 | C-0 v9' } } // fails (strict): reported to the model, nothing written
        ]
      },
      'I wrote a short phrase.'
    ])
    t.runner.send({ text: 'write a short phrase on P1' })
    await t.runner.whenIdle()
    const rows = t.session.song.patterns.get('P1:0')!.rows
    expect([rows[0]?.note, rows[4]?.note, rows[8]?.note, rows[12]?.note]).toEqual([72, 76, 79, 84])
    expect(t.session.song.patterns.has('TR:0')).toBe(false)
    expect(t.session.history.undoDepth).toBe(1)
    expect(t.session.undoLabel()).toMatch(/^Agent: write a short phrase/)
    const results = t.events.filter((e): e is Extract<AgentUiEvent, { type: 'tool_result' }> => e.type === 'tool_result')
    expect(results.map((r) => [r.name, r.isError])).toEqual([['add_instrument', false], ['write_pattern', false], ['write_pattern', false], ['write_pattern', true]])
    expect(results[3]!.summary).toMatch(/Chip rules|Invalid tracker text/)
    // the failed call's error reaches the model on the next request
    const toolMsgs = t.mock.requests[1]!.messages.filter((m) => m.role === 'tool')
    expect(toolMsgs.map(content).join('\n')).toMatch(/Wrote 3 cells/)
    t.session.undo()
    expect(t.session.song.patterns.size).toBe(0)
    expect(t.session.song.instruments).toHaveLength(0)
  })

  it('a vision model gets a piano-roll image after a writing tool, a text-only model does not', async () => {
    for (const vision of [true, false]) {
      const t = setup(vision)
      t.mock.script([{ toolCalls: [{ id: 'a', name: 'write_drums', args: { legend: { K: 'kick' }, steps: 'K...', repeat: 16 } }] }, 'done'])
      t.runner.send({ text: 'add a beat' })
      await t.runner.whenIdle()
      expect(t.session.song.instruments.map((i) => i.name)).toEqual(['kick'])
      const second = t.mock.requests[1]!.messages.filter((m) => m.role === 'tool').map(content).join('\n')
      if (vision) expect(second).toMatch(/Piano-roll preview of the song after this change[\s\S]*\[image\]/)
      else expect(second).not.toContain('[image]')
    }
  })
  describe('style references', () => {
    async function withReference(vision: boolean) {
      const t = setup(vision)
      // compose a reference song with the tools, save it, then start a fresh song that points at it
      const run = async (name: string, args: Record<string, unknown>): Promise<void> => {
        const r = await t.host.execute(name, args, new AbortController().signal)
        if (r.isError) throw new Error(`${name}: ${JSON.stringify(r.content)}`)
      }
      await run('new_song', { chip: 'gb', name: 'Shop', key: 'F', scale: 'major', bpm: 100 })
      await run('add_instrument', { preset: 'lead', channel: 'P1' })
      await run('write_melody', { channel: 'P1', melody: '@lead F5:2 A5:2 C6:4' })
      await run('save_as_asset', { name: 'Chill shop', kind: 'song', notes: 'Bouncy and warm.' })
      await run('save_as_asset', { name: 'Shop lick', kind: 'motif', channels: ['P1'] })
      await run('new_song', { chip: 'nes', name: 'Next' })
      await run('set_style_reference', { ids: ['chill-shop'] })
      return t
    }

    it('injects get_style_context into the system prompt and the reference image into the first message of a vision model', async () => {
      const t = await withReference(true)
      t.mock.script(['ok', 'again'])
      t.runner.send({ text: 'write a town theme' })
      await t.runner.whenIdle()
      const system = content(t.mock.requests[0]!.messages[0]!)
      expect(system).toContain('## Style context')
      expect(system).toContain('Reference 1: "Chill shop"')
      expect(system).toMatch(/Chip: GB \| 100 BPM/)
      expect(system).toContain('Bouncy and warm.')
      const user = t.mock.requests[0]!.messages.find((m) => m.role === 'user')!
      expect(content(user)).toBe('write a town theme|Preview images of the style reference assets (same order as in the style context):|[image]')
      t.runner.send({ text: 'and a second one' })
      await t.runner.whenIdle()
      const users = t.mock.requests[1]!.messages.filter((m) => m.role === 'user').map(content)
      expect(users.join('|')).not.toMatch(/\[image\][\s\S]*\[image\]/)
    })

    it('a text-only model gets the context text but no image', async () => {
      const t = await withReference(false)
      t.mock.script(['ok'])
      t.runner.send({ text: 'write a town theme' })
      await t.runner.whenIdle()
      expect(content(t.mock.requests[0]!.messages[0]!)).toContain('## Style context')
      expect(content(t.mock.requests[0]!.messages.find((m) => m.role === 'user')!)).toBe('write a town theme')
    })

    it('place_asset is a writing tool: a vision model sees the piano roll after it', async () => {
      for (const vision of [true, false]) {
        const t = await withReference(vision)
        t.mock.script([{ toolCalls: [{ id: 'a', name: 'place_asset', args: { id: 'shop-lick' } }] }, 'done'])
        t.runner.send({ text: 'place it' })
        await t.runner.whenIdle()
        expect(t.session.song.patterns.get('P1:0')!.rows[0]!.note).toBe(72) // F5 moves to C5: key F -> C is -5 semitones
        const second = t.mock.requests[1]!.messages.filter((m) => m.role === 'tool').map(content).join('|')
        expect(second).toMatch(/Placed motif "Shop lick"/)
        if (vision) expect(second).toMatch(/Piano-roll preview[\s\S]*\[image\]/)
        else expect(second).not.toContain('[image]')
      }
    })
  })
})
