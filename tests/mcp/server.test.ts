import { request } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { McpHttpServer } from '../../src/main/mcp'
import { readWav } from '../../src/core'
import { GUIDE, GUIDE_SHORT, createDefaultRegistry } from '../../src/tools'
import { startServer } from './helpers'

type Started = Awaited<ReturnType<typeof startServer>>
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

async function connect(s: Started, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(s.url, { requestInit: headers ? { headers } : undefined })
  await client.connect(transport)
  cleanup.push(async () => {
    await client.close().catch(() => undefined)
  })
  return client
}

async function start(opts: Parameters<typeof startServer>[0] = {}): Promise<Started> {
  const s = await startServer(opts)
  cleanup.push(() => s.server.stop())
  return s
}

function raw(port: number, opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: opts.path ?? '/mcp', method: opts.method ?? 'POST', headers: opts.headers }, (res) => {
      let body = ''
      res.on('data', (d) => (body += d))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } }
})
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }

describe('MCP HTTP server', () => {
  it('serves instructions, tools, resources, prompts and runs the tools end to end', async () => {
    const s = await start()
    const client = await connect(s)
    expect(client.getInstructions()).toBe(GUIDE_SHORT)
    expect(s.server.sessionCount()).toBe(1)

    const { tools } = await client.listTools()
    expect(tools.length).toBe(createDefaultRegistry().list().length)
    for (const n of ['get_song', 'new_song', 'write_pattern', 'write_melody', 'write_drums', 'render_preview', 'export_wav', 'undo']) {
      expect(tools.map((t) => t.name)).toContain(n)
    }
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object')
      expect(t.description).toBeTruthy()
    }
    expect(tools.find((t) => t.name === 'write_pattern')!.inputSchema.properties).toHaveProperty('text')

    const { resources } = await client.listResources()
    expect(resources.map((r) => r.uri)).toEqual(['chiptune-studio://guide', 'chiptune-studio://song', 'chiptune-studio://presets', 'chiptune-studio://assets'])
    const guide = await client.readResource({ uri: 'chiptune-studio://guide' })
    expect(guide.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: GUIDE })

    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name)).toEqual(['compose_track', 'remix_to_chip', 'match_style'])
    const compose = await client.getPrompt({ name: 'compose_track', arguments: { mood: 'spooky', chip: 'gb', length: '32 bars' } })
    expect(JSON.stringify(compose.messages)).toMatch(/spooky[\s\S]*get_mood_recipe[\s\S]*write_drums/)
    await expect(client.getPrompt({ name: 'compose_track', arguments: {} })).rejects.toThrow(/mood/)

    // Tool calls: new_song + instruments + write_pattern + export_wav on the live session
    const call = async (name: string, args: Record<string, unknown>): Promise<{ isError?: boolean; text: string }> => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ type: string; text?: string }> }
      return { isError: r.isError, text: r.content.map((c) => c.text ?? '').join('\n') }
    }
    expect((await call('new_song', { chip: 'nes', name: 'mcp song', bpm: 120 })).isError).toBeFalsy()
    expect((await call('add_instrument', { preset: 'lead', channel: 'P1' })).isError).toBeFalsy()
    const w = await call('write_pattern', { text: 'channels: P1\n 0 | C-5 @lead v12\n 4 | E-5\n 8 | G-5\n12 | ===' })
    expect(w.isError).toBeFalsy()
    expect(w.text).toMatch(/Wrote 4 cells/)
    expect(s.session.song.name).toBe('mcp song')
    expect(s.session.history.undoDepth).toBe(3) // new_song, add_instrument, write_pattern: one step per call
    const e = await call('export_wav', { path: 'mcp-song' })
    expect(e.isError).toBeFalsy()
    const wav = readWav(s.services.files.get('/mem/exports/mcp-song.wav')!)
    expect(wav.numChannels).toBe(2)
    expect(wav.loops).toHaveLength(1)
    expect((await client.readResource({ uri: 'chiptune-studio://song' })).contents[0]).toMatchObject({ text: expect.stringContaining('mcp song') })
    expect((await client.readResource({ uri: 'chiptune-studio://presets' })).contents[0]).toMatchObject({ text: expect.stringContaining('nes.lead.duty25') })

    // Errors pass through as isError results
    const bad = await call('write_pattern', { text: 'channels: TR\n 0 | C-5 v8' })
    expect(bad.isError).toBe(true)
    expect(bad.text).toMatch(/triangle|volume/i)
    expect((await client.callTool({ name: 'write_pattern', arguments: {} })).isError).toBe(true)
    expect((await client.callTool({ name: 'nope', arguments: {} })).isError).toBe(true)
  })

  it('closes sessions and reports the count', async () => {
    const s = await start()
    const t = new StreamableHTTPClientTransport(s.url)
    const a = new Client({ name: 'a', version: '1' })
    await a.connect(t)
    await connect(s)
    expect(s.server.getStatus().sessions).toBe(2)
    await t.terminateSession()
    await a.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(s.server.getStatus().sessions).toBe(1)
  })

  it('returns 404 for other paths', async () => {
    const s = await start()
    expect((await raw(s.port, { path: '/other', method: 'GET' })).status).toBe(404)
  })

  it('enforces the bearer token', async () => {
    const s = await start({ token: 'secret-token' })
    expect((await raw(s.port, { headers: JSON_HEADERS, body: INIT })).status).toBe(401)
    expect((await raw(s.port, { headers: { ...JSON_HEADERS, Authorization: 'Bearer wrong' }, body: INIT })).status).toBe(401)
    const client = await connect(s, { Authorization: 'Bearer secret-token' })
    expect((await client.listTools()).tools.length).toBeGreaterThan(30)
    await expect(connect(s)).rejects.toThrow()
  })

  it('rejects a bad Host or Origin header (DNS rebinding)', async () => {
    const s = await start()
    expect((await raw(s.port, { headers: { ...JSON_HEADERS, Host: 'evil.example.com' }, body: INIT })).status).toBe(403)
    expect((await raw(s.port, { headers: { ...JSON_HEADERS, Origin: 'https://evil.example.com' }, body: INIT })).status).toBe(403)
    expect((await raw(s.port, { headers: { ...JSON_HEADERS, Host: `localhost:${s.port}` }, body: INIT })).status).toBe(200)
  })

  it('reports EADDRINUSE as status.error without throwing', async () => {
    const s = await start()
    const second = new McpHttpServer({ host: s.host, port: s.port })
    const st = await second.start()
    expect(st.running).toBe(false)
    expect(st.error).toMatch(/in use/)
    await second.stop()
  })

  it('stop() closes the server and sessions, and start() works again', async () => {
    const s = await start()
    await connect(s)
    await s.server.stop()
    expect(s.server.getStatus()).toMatchObject({ running: false, url: null, sessions: 0 })
    expect((await s.server.start()).running).toBe(true)
  })

  it('maps a throwing host to an isError result', async () => {
    const s = await start({
      host: {
        tools: () => [{ name: 'boom', description: 'x', parameters: { type: 'object', properties: {} } }],
        execute: () => Promise.reject(new Error('kaput'))
      }
    })
    const client = await connect(s)
    const r = (await client.callTool({ name: 'boom', arguments: {} })) as { isError?: boolean; content: Array<{ text: string }> }
    expect(r.isError).toBe(true)
    expect(r.content[0]!.text).toContain('kaput')
  })
})
