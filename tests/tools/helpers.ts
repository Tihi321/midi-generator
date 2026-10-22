import { z } from 'zod'
import { type Cell, type Song, createCellsCommand, createSong, parseNote, parseProject, serializeProject } from '../../src/core'
import { SongSession, ToolRegistry, createDefaultRegistry, createMemoryToolServices, defineTool, resultText, textResult } from '../../src/tools'
import type { ToolResult } from '../../src/tools'

/**
 * A tiny fake tool set for the infrastructure tests (registry, bridge, MCP server, stdio relay): `write_pattern`
 * writes one note into P1 pattern 0 through a real command, so undo, rollback and agent turns are real.
 */
export function fakeTools() {
  const state = { notes: [] as string[] }
  const registry = new ToolRegistry([
    defineTool({
      name: 'get_song',
      description: 'Fake read-only song summary.',
      group: 'song',
      readOnly: true,
      input: z.strictObject({}),
      handler: () => textResult(`notes: ${state.notes.join(',') || '(none)'}`)
    }),
    defineTool({
      name: 'write_pattern',
      description: 'Fake writing tool: appends a note.',
      group: 'notes',
      input: z.strictObject({ note: z.string() }),
      handler: (a, ctx) => {
        const session = ctx.session as SongSession
        const note = parseNote(a.note)
        session.execute(createCellsCommand(session.song, [{ channel: 'P1', pattern: 0, row: state.notes.length % 64, cell: { note: note ?? 60 } }], 'Fake write'))
        state.notes.push(a.note)
        return a.note === 'bad' ? { content: [{ type: 'text', text: 'bad note' }], isError: true } : textResult(`wrote ${a.note}`)
      }
    })
  ])
  return { registry, state }
}

/** Infrastructure setup: fake tools over a real SongSession. */
export function setup() {
  const session = new SongSession(createSong({ chip: 'nes', name: 'fake' }))
  const services = createMemoryToolServices()
  const { registry, state } = fakeTools()
  const call = (name: string, args: unknown = {}, signal?: AbortSignal): Promise<ToolResult> => registry.execute(name, args, { session, services, signal })
  return { session, services, registry, state, call }
}

/** Real default registry over a SongSession and in-memory services (the music tools). */
export function songSetup(opts: { song?: Song; chip?: Parameters<typeof createSong>[0]['chip']; patternLength?: number } = {}) {
  const song = opts.song ?? createSong({ chip: opts.chip ?? 'nes', name: 'test', patternLength: opts.patternLength ?? 64 })
  const session = new SongSession(song)
  const services = createMemoryToolServices()
  const registry = createDefaultRegistry()
  const call = (name: string, args: unknown = {}, signal?: AbortSignal): Promise<ToolResult> => registry.execute(name, args, { session, services, signal })
  /** Call and fail the test if the tool returned an error. */
  const ok = async (name: string, args: unknown = {}): Promise<ToolResult> => {
    const r = await call(name, args)
    if (r.isError) throw new Error(`${name} failed: ${resultText(r)}`)
    return r
  }
  /** Text of a call (errors included). */
  const text = async (name: string, args: unknown = {}): Promise<string> => resultText(await call(name, args))
  return { song: session.song, session, services, registry, call, ok, text }
}

export { resultText }

/** Canonical text of the whole song (for "did this change anything" checks). */
export function snapshot(song: Song): string {
  return serializeProject(parseProject(serializeProject(song)), false)
}

/** One channel of a song as a linear list of cells (one entry per song row, orders unrolled). */
export function channelRows(song: Song, channelId: string): (Cell | null)[] {
  const ci = song.channels.findIndex((c) => c.id === channelId)
  const out: (Cell | null)[] = []
  for (const order of song.orders) {
    const pat = song.patterns.get(`${channelId}:${order[ci]!}`)
    for (let r = 0; r < song.patternLength; r++) out.push(pat?.rows[r] ?? null)
  }
  return out
}
