// Shared launcher for the Electron e2e tests: an isolated data folder (CHIPTUNE_STUDIO_HOME), its own
// user-data dir and a free MCP port, so a test run never touches ~/ChiptuneStudio or collides with a running app.

import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const projectRoot = path.resolve(__dirname, '../..')

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

export interface LaunchedApp {
  app: ElectronApplication
  page: Page
  /** The isolated "~/ChiptuneStudio" (ends with "ChiptuneStudio"). */
  home: string
  mcpPort: number
  mcpUrl: string
  close: () => Promise<void>
}

export async function launchApp(opts: { configFrom?: string } = {}): Promise<LaunchedApp> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'chiptune-studio-e2e-'))
  const home = path.join(base, 'ChiptuneStudio')
  const userData = path.join(base, 'user-data')
  const mcpPort = await freePort()
  // A copy of an existing config folder (the app then migrates it like a real update); the original is never touched.
  if (opts.configFrom) await cp(opts.configFrom, path.join(home, 'config'), { recursive: true })
  const app = await electron.launch({
    args: [path.join(projectRoot, 'out/main/index.js'), `--user-data-dir=${userData}`],
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RENDERER_URL: '', CHIPTUNE_STUDIO_HOME: home, CHIPTUNE_STUDIO_MCP_PORT: String(mcpPort) }
  })
  const page = await app.firstWindow()
  return {
    app,
    page,
    home,
    mcpPort,
    mcpUrl: `http://127.0.0.1:${mcpPort}/mcp`,
    close: async () => {
      await app.close().catch(() => undefined)
      await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined)
    }
  }
}
