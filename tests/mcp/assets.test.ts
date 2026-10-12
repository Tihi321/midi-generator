import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { PROMPTS, RESOURCES, buildPrompt, readResource } from '../../src/main/mcpContent'
import { startServer } from './helpers'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function connected() {
  const s = await startServer()
  cleanup.push(() => s.server.stop())
  const client = new Client({ name: 'test', version: '1' })
  await client.connect(new StreamableHTTPClientTransport(s.url))
  cleanup.push(async () => {
    await client.close().catch(() => undefined)
  })
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> }
    return { isError: r.isError, text: r.content.map((c) => c.text ?? '').join('\n'), content: r.content }
  }
  return { s, client, call }
}

describe('library over MCP', () => {
  it('exposes the assets resource, which lists the library', async () => {
    const { s, client, call } = await connected()
    expect(RESOURCES.map((r) => r.uri)).toContain('chiptune-studio://assets')
    const empty = await client.readResource({ uri: 'chiptune-studio://assets' })
    expect(empty.contents[0]).toMatchObject({ text: expect.stringMatching(/^0 assets/) })
    await call('new_song', { chip: 'nes', name: 'MCP song', key: 'D', scale: 'dorian' })
    await call('add_instrument', { preset: 'lead', channel: 'P1' })
    await call('write_melody', { channel: 'P1', melody: '@lead D5:2 F5:2 A5:4' })
    const saved = await call('save_as_asset', { name: 'Dorian lick', kind: 'motif', channels: ['P1'], moods: ['chill'] })
    expect(saved.isError).toBeFalsy()
    expect(saved.text).toMatch(/id dorian-lick/)
    expect(s.services.assets.items.has('dorian-lick')).toBe(true)
    const list = await client.readResource({ uri: 'chiptune-studio://assets' })
    const text = (list.contents[0] as { text: string }).text
    expect(text).toMatch(/^1 asset/)
    expect(text).toContain('"id":"dorian-lick"')
    // read through the content module too
    const direct = await readResource({ tools: () => [], execute: (n, a) => s.host.execute(n, a, new AbortController().signal) }, '', 'chiptune-studio://assets')
    expect(direct?.text).toContain('dorian-lick')
    // style context over MCP, with the preview image
    await call('set_style_reference', { ids: ['dorian-lick'] })
    const ctx = await call('get_style_context', {})
    expect(ctx.text).toMatch(/Reference 1: "Dorian lick"/)
    expect(ctx.content.some((c) => c.type === 'image')).toBe(true)
  })

  it('match_style is a prompt that points at the style tools', async () => {
    const { client } = await connected()
    expect(PROMPTS.map((p) => p.name)).toContain('match_style')
    const { prompts } = await client.listPrompts()
    const p = prompts.find((x) => x.name === 'match_style')!
    expect(p.arguments?.map((a) => `${a.name}${a.required ? '*' : ''}`)).toEqual(['asset*', 'mood'])
    const got = await client.getPrompt({ name: 'match_style', arguments: { asset: 'hero-theme', mood: 'chill shop' } })
    const text = JSON.stringify(got.messages)
    expect(text).toMatch(/hero-theme/)
    expect(text).toMatch(/chill shop/)
    expect(text).toMatch(/set_style_reference[\s\S]*get_style_context[\s\S]*new_song[\s\S]*write_drums|get_style_context[\s\S]*new_song/)
    await expect(client.getPrompt({ name: 'match_style', arguments: {} })).rejects.toThrow(/asset/)
  })

  it('remix_to_chip uses convert_chip', () => {
    const text = buildPrompt('remix_to_chip', { chip: 'snes' })!
    expect(text).toMatch(/convert_chip \{"chip":"snes"\}/)
    expect(text).toMatch(/analyze_song/)
    expect(text).toMatch(/idioms/)
  })
})
