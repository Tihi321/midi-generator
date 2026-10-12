import { describe, expect, it } from 'vitest'
import { createDefaultRegistry, createToolHost, resultText } from '../../src/tools'
import { setup } from './helpers'

describe('ToolRegistry (generic)', () => {
  it('the default registry has the music tools with unique snake_case names and strict schemas', () => {
    const list = createDefaultRegistry().list()
    expect(list.length).toBeGreaterThanOrEqual(35)
    expect(new Set(list.map((t) => t.name)).size).toBe(list.length)
    for (const t of list) expect(t.description.length, t.name).toBeGreaterThan(20)
  })

  it('exposes JSON-schema defs for every tool', () => {
    const { registry } = setup()
    const defs = registry.defs()
    expect(defs.map((d) => d.name)).toEqual(['get_song', 'write_pattern'])
    expect(defs[1]!.parameters).toMatchObject({ type: 'object', properties: { note: { type: 'string' } } })
  })

  it('reports bad arguments and unknown tools as error results', async () => {
    const { call } = setup()
    const bad = await call('write_pattern', {})
    expect(bad.isError).toBe(true)
    expect(resultText(bad)).toMatch(/Invalid arguments for write_pattern/)
    const extra = await call('write_pattern', { note: 'C-4', nope: 1 })
    expect(resultText(extra)).toMatch(/Unrecognized argument/)
    const unknown = await call('write_patern', {})
    expect(unknown.isError).toBe(true)
    expect(resultText(unknown)).toMatch(/Unknown tool/)
  })

  it('accepts a JSON string as arguments', async () => {
    const { call, state } = setup()
    await call('write_pattern', '{"note":"E-5"}')
    expect(state.notes).toEqual(['E-5'])
  })

  it('makes one tool call one undo step and rolls back a failed call', async () => {
    const { call, session } = setup()
    const cell = (): unknown => session.song.patterns.get('P1:0')?.rows[0]
    await call('write_pattern', { note: 'A-3' })
    expect(session.history.undoDepth).toBe(1)
    expect(session.undoLabel()).toBe('write_pattern')
    expect(cell()).toEqual({ note: 57 })
    const bad = await call('write_pattern', { note: 'bad' })
    expect(bad.isError).toBe(true)
    expect(session.history.undoDepth).toBe(1) // rolled back: no new step
    expect(session.song.patterns.get('P1:0')?.rows[1]).toBeNull()
    session.undo()
    expect(cell()).toBeFalsy()
  })

  it('groups an agent turn into one undo step through the host, or rolls it back', async () => {
    const { registry, session, services } = setup()
    const host = createToolHost(registry, () => ({ session, services }))
    const sig = new AbortController().signal
    await host.beginTurn('Agent: test')
    expect(session.turnActive).toBe(true)
    await host.execute('write_pattern', { note: 'A-3' }, sig)
    await host.execute('write_pattern', { note: 'B-3' }, sig)
    await host.endTurn()
    expect(session.turnActive).toBe(false)
    expect(session.history.undoDepth).toBe(1)
    expect(session.undoLabel()).toBe('Agent: test')
    session.undo()
    expect(session.song.patterns.get('P1:0')).toBeUndefined()

    await host.beginTurn('Agent: rolled back')
    await host.execute('write_pattern', { note: 'C-4' }, sig)
    await host.endTurn({ rollback: true })
    expect(session.history.undoDepth).toBe(0)
    expect(session.song.patterns.get('P1:0')).toBeUndefined()
  })

  it('runs read-only tools without a transaction and rejects a cancelled call', async () => {
    const { call } = setup()
    expect(resultText(await call('get_song'))).toBe('notes: (none)')
    const ac = new AbortController()
    ac.abort()
    expect((await call('write_pattern', { note: 'C-4' }, ac.signal)).isError).toBe(true)
  })
})
