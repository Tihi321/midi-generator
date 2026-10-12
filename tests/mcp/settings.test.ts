import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_IPC } from '../../src/shared/mcp'
import type { McpState } from '../../src/shared/mcp'
import { buildSnippets, generateToken, loadMcpSettings, parseSettings, registerMcp, saveMcpSettings, withEnvOverrides } from '../../src/main/mcpSettings'
import { memoryHost } from './helpers'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ps-mcp-'))
  dirs.push(d)
  return d
}

describe('buildSnippets', () => {
  it('builds the Claude Code command and stdio JSON', () => {
    const s = buildSnippets({ enabled: true, port: 7458, token: null }, { url: 'http://127.0.0.1:7458/mcp' }, 'C:\\app\\out\\mcp-stdio\\index.js')
    expect(s.claudeCode).toBe('claude mcp add --transport http chiptune-studio http://127.0.0.1:7458/mcp')
    expect(JSON.parse(s.stdioJson).mcpServers['chiptune-studio']).toEqual({
      command: 'node',
      args: ['C:\\app\\out\\mcp-stdio\\index.js'],
      env: { CHIPTUNE_STUDIO_MCP_URL: 'http://127.0.0.1:7458/mcp' }
    })
  })
  it('adds the header and token env when a token is set, and falls back to the port when not running', () => {
    const s = buildSnippets({ enabled: true, port: 9000, token: 'abc' }, { url: null }, '/x/index.js')
    expect(s.claudeCode).toBe('claude mcp add --transport http chiptune-studio http://127.0.0.1:9000/mcp --header "Authorization: Bearer abc"')
    expect(JSON.parse(s.stdioJson).mcpServers['chiptune-studio'].env).toEqual({ CHIPTUNE_STUDIO_MCP_URL: 'http://127.0.0.1:9000/mcp', CHIPTUNE_STUDIO_MCP_TOKEN: 'abc' })
  })
})

describe('settings persistence', () => {
  it('defaults when missing or invalid, and round-trips', async () => {
    const dir = await tmp()
    expect(await loadMcpSettings(dir)).toEqual({ enabled: true, port: 7458, token: null })
    expect(parseSettings({ port: 'nope' })).toEqual({ enabled: true, port: 7458, token: null })
    await saveMcpSettings({ enabled: false, port: 8123, token: 'tok' }, dir)
    expect(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))).toEqual({ enabled: false, port: 8123, token: 'tok' })
    expect(await loadMcpSettings(dir)).toEqual({ enabled: false, port: 8123, token: 'tok' })
    expect(parseSettings({ enabled: false })).toEqual({ enabled: false, port: 7458, token: null })
  })
  it('generates 32-byte hex tokens', () => {
    expect(generateToken()).toMatch(/^[0-9a-f]{64}$/)
    expect(generateToken()).not.toBe(generateToken())
  })
})

describe('registerMcp', () => {
  it('starts, applies settings (restart), regenerates the token and pushes status', async () => {
    const dir = await tmp()
    await saveMcpSettings({ enabled: true, port: 0, token: null }, dir)
    const handlers = new Map<string, (e: unknown, ...a: unknown[]) => unknown>()
    const pushed: McpState[] = []
    const ctl = registerMcp({ handle: (c, l) => void handlers.set(c, l) }, memoryHost().host, {
      shimPath: '/shim/index.js',
      configDir: dir,
      send: (c, s) => {
        expect(c).toBe(MCP_IPC.statusChanged)
        pushed.push(s)
      }
    })
    try {
      const st = await ctl.start()
      expect(st.status.running).toBe(true)
      expect(st.status.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
      expect((await handlers.get(MCP_IPC.getState)!(null)) as McpState).toMatchObject({ settings: { enabled: true } })

      const withToken = (await handlers.get(MCP_IPC.regenerateToken)!(null)) as McpState
      expect(withToken.settings.token).toMatch(/^[0-9a-f]{64}$/)
      expect(withToken.status.running).toBe(true)
      expect(withToken.snippets.claudeCode).toContain(`Bearer ${withToken.settings.token}`)
      expect((await loadMcpSettings(dir)).token).toBe(withToken.settings.token)

      const off = (await handlers.get(MCP_IPC.setSettings)!(null, { enabled: false })) as McpState
      expect(off.status.running).toBe(false)
      expect(off.settings.enabled).toBe(false)
      expect(pushed.length).toBeGreaterThan(0)
      expect(pushed.at(-1)!.status.running).toBe(false)
    } finally {
      await ctl.stop()
    }
  })
})

describe('CHIPTUNE_STUDIO_MCP_PORT', () => {
  const base = { enabled: false, port: 7458, token: 'tok' }
  it('overrides the port in memory and ignores bad values', () => {
    expect(withEnvOverrides(base, {})).toEqual(base)
    expect(withEnvOverrides(base, { CHIPTUNE_STUDIO_MCP_PORT: '9123' })).toEqual({ enabled: true, port: 9123, token: 'tok' })
    for (const bad of ['', 'abc', '0', '70000', '12.5']) expect(withEnvOverrides(base, { CHIPTUNE_STUDIO_MCP_PORT: bad })).toEqual(base)
  })

  it('the server listens on the override port and mcp.json is not rewritten', async () => {
    const dir = await tmp()
    await saveMcpSettings({ enabled: true, port: 7458, token: null }, dir)
    const free = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, '127.0.0.1', () => {
        const port = (srv.address() as { port: number }).port
        srv.close(() => resolve(port))
      })
    })
    const prev = process.env['CHIPTUNE_STUDIO_MCP_PORT']
    process.env['CHIPTUNE_STUDIO_MCP_PORT'] = String(free)
    const ctl = registerMcp({ handle: () => undefined }, memoryHost().host, { shimPath: '/shim/index.js', configDir: dir })
    try {
      const st = await ctl.start()
      expect(st.status.url).toBe(`http://127.0.0.1:${free}/mcp`)
      expect(JSON.parse(await readFile(join(dir, 'mcp.json'), 'utf8'))).toEqual({ enabled: true, port: 7458, token: null })
    } finally {
      await ctl.stop()
      if (prev === undefined) delete process.env['CHIPTUNE_STUDIO_MCP_PORT']
      else process.env['CHIPTUNE_STUDIO_MCP_PORT'] = prev
    }
  })
})
