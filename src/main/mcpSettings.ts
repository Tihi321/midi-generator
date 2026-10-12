// MCP settings persistence (~/ChiptuneStudio/config/mcp.json), connection snippets and the IPC handlers
// for Settings -> MCP. No Electron import (ipc / send are injected) so it is unit-testable.

import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { DEFAULT_MCP_PORT, MCP_IPC } from '../shared/mcp'
import type { McpSettings, McpSnippets, McpState, McpStatus } from '../shared/mcp'
import { type McpHost, McpHttpServer, createMcpHttpServer } from './mcp'
import { defaultRoot } from './services'

export const DEFAULT_MCP_SETTINGS: McpSettings = { enabled: true, port: DEFAULT_MCP_PORT, token: null }

const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(0).max(65535).default(DEFAULT_MCP_PORT),
  token: z.string().min(1).nullable().default(null)
})

export function defaultConfigDir(): string {
  return join(defaultRoot(), 'config')
}

export function parseSettings(raw: unknown): McpSettings {
  const r = SettingsSchema.safeParse(raw)
  return r.success ? r.data : { ...DEFAULT_MCP_SETTINGS }
}

export async function loadMcpSettings(configDir: string = defaultConfigDir()): Promise<McpSettings> {
  try {
    return parseSettings(JSON.parse(await readFile(join(configDir, 'mcp.json'), 'utf8')))
  } catch {
    return { ...DEFAULT_MCP_SETTINGS }
  }
}

export async function saveMcpSettings(settings: McpSettings, configDir: string = defaultConfigDir()): Promise<void> {
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, 'mcp.json'), JSON.stringify(settings, null, 2) + '\n', 'utf8')
}

/**
 * CHIPTUNE_STUDIO_MCP_PORT overrides the saved port for this run only (used by e2e tests so they do not
 * collide with a running instance). It is applied in memory; mcp.json is only rewritten when the user
 * changes settings.
 */
export function withEnvOverrides(settings: McpSettings, env: NodeJS.ProcessEnv = process.env): McpSettings {
  const raw = env['CHIPTUNE_STUDIO_MCP_PORT']?.trim()
  if (!raw) return settings
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return settings
  return { ...settings, enabled: true, port }
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/** Pure: the ready-to-copy connection snippets. `shimPath` is the absolute path of out/mcp-stdio/index.js. */
export function buildSnippets(settings: McpSettings, status: Pick<McpStatus, 'url'>, shimPath: string): McpSnippets {
  const url = status.url ?? `http://127.0.0.1:${settings.port}/mcp`
  const claudeCode = `claude mcp add --transport http chiptune-studio ${url}` + (settings.token ? ` --header "Authorization: Bearer ${settings.token}"` : '')
  const env: Record<string, string> = { CHIPTUNE_STUDIO_MCP_URL: url }
  if (settings.token) env['CHIPTUNE_STUDIO_MCP_TOKEN'] = settings.token
  const stdioJson = JSON.stringify({ mcpServers: { 'chiptune-studio': { command: 'node', args: [shimPath], env } } }, null, 2)
  return { claudeCode, stdioJson }
}

export interface McpIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface RegisterMcpOptions {
  /** Absolute path of the stdio shim (for the snippets). */
  shimPath: string
  /** Config folder (default ~/ChiptuneStudio/config). */
  configDir?: string
  /** Push `McpState` to the window (channel MCP_IPC.statusChanged). */
  send?: (channel: string, state: McpState) => void
  log?: (msg: string) => void
}

export interface McpController {
  /** Loads settings and starts the server when enabled. */
  start(): Promise<McpState>
  stop(): Promise<void>
  getState(): McpState
  server(): McpHttpServer | null
}

/** Registers the MCP_IPC handlers and returns a controller (start after app ready, stop on quit). */
export function registerMcp(ipc: McpIpc, host: McpHost, opts: RegisterMcpOptions): McpController {
  let settings: McpSettings = { ...DEFAULT_MCP_SETTINGS }
  let server: McpHttpServer | null = null
  let status: McpStatus = { running: false, url: null, sessions: 0 }
  const configDir = opts.configDir ?? defaultConfigDir()

  const getState = (): McpState => ({ settings, status, snippets: buildSnippets(settings, status, opts.shimPath) })
  const push = (): void => opts.send?.(MCP_IPC.statusChanged, getState())

  const stopServer = async (): Promise<void> => {
    const s = server
    server = null
    if (s) await s.stop()
    status = { running: false, url: null, sessions: 0 }
  }

  const startServer = async (): Promise<void> => {
    await stopServer()
    if (!settings.enabled) {
      push()
      return
    }
    const s = createMcpHttpServer({
      host,
      port: settings.port,
      token: settings.token,
      log: opts.log,
      onStatus: (st) => {
        if (server === s) {
          status = st
          push()
        }
      }
    })
    server = s
    status = await s.start()
    push()
  }

  ipc.handle(MCP_IPC.getState, () => getState())
  ipc.handle(MCP_IPC.setSettings, async (_e, patch) => {
    const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<McpSettings>
    const next = parseSettings({ ...settings, ...p })
    const changed = next.enabled !== settings.enabled || next.port !== settings.port || next.token !== settings.token
    settings = next
    await saveMcpSettings(settings, configDir)
    if (changed) await startServer()
    else push()
    return getState()
  })
  ipc.handle(MCP_IPC.regenerateToken, async () => {
    settings = { ...settings, token: generateToken() }
    await saveMcpSettings(settings, configDir)
    await startServer()
    return getState()
  })

  return {
    async start() {
      settings = withEnvOverrides(await loadMcpSettings(configDir))
      await startServer()
      return getState()
    },
    stop: stopServer,
    getState,
    server: () => server
  }
}
