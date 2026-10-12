import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createRelay } from '../../src/mcp-stdio/relay'
import { GUIDE_SHORT } from '../../src/tools'
import { startServer } from './helpers'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

/** A Client wired to the relay through an in-memory pair (the relay plays the stdio server). */
async function viaRelay(url: string, token?: string): Promise<{ client: Client; clientSide: InMemoryTransport; logs: string[] }> {
  const [clientSide, stdioSide] = InMemoryTransport.createLinkedPair()
  const logs: string[] = []
  const relay = createRelay({ url, token, stdio: stdioSide, log: (m) => logs.push(m) })
  await relay.start()
  const client = new Client({ name: 'stdio-test', version: '1' })
  cleanup.push(async () => {
    await client.close().catch(() => undefined)
    await relay.close()
  })
  return { client, clientSide, logs }
}

describe('stdio shim relay', () => {
  it('relays initialize, tools and tool calls to the HTTP server', async () => {
    const s = await startServer({ token: 'tok' })
    cleanup.push(() => s.server.stop())
    const { client, clientSide } = await viaRelay(s.url.href, 'tok')
    await client.connect(clientSide)
    expect(client.getInstructions()).toBe(GUIDE_SHORT)
    expect((await client.listTools()).tools.length).toBeGreaterThan(30)
    const r = await client.callTool({ name: 'new_song', arguments: { chip: 'gb', name: 'via relay' } })
    expect(r.isError).toBeFalsy()
    expect(s.session.song.chip).toBe('gb')
    expect(s.session.song.name).toBe('via relay')
  })

  it('answers with a clear JSON-RPC error when the app is not running', async () => {
    // A port nothing listens on: start then stop a server to get a free one.
    const s = await startServer()
    const url = s.url.href
    await s.server.stop()
    const { client, clientSide, logs } = await viaRelay(url)
    await expect(client.connect(clientSide)).rejects.toThrow(/Chiptune Studio is not running/)
    expect(logs.join('\n')).toMatch(/Chiptune Studio is not running/)
  })

  it('reports a rejected token', async () => {
    const s = await startServer({ token: 'right' })
    cleanup.push(() => s.server.stop())
    const { client, clientSide } = await viaRelay(s.url.href, 'wrong')
    await expect(client.connect(clientSide)).rejects.toThrow(/token/i)
  })
})
