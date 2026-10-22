import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { IPC, type OpenSongRequest } from '../shared/ipc'
import { type NodeServices, registerServices } from './services'
import { ToolBridge } from './toolBridge'
import { startMcp } from './mcpApp'
import { registerAgentIpc } from './agentIpc'
import { startAssets } from './assetsApp'
import { headlessPort, parseCli } from './cli'
import { startHeadless } from './headless'

/** The tool bridge to the renderer's live song; the agent runner and MCP server use it as their ToolHost. */
const toolBridge = new ToolBridge()
let services: NodeServices | null = null
let mainWindow: BrowserWindow | null = null

/** A song to open (command line or second launch) that the renderer has not taken yet. */
let pendingOpen: OpenSongRequest | null = null
/** True while the renderer listens for `app:open` (reset on every (re)load). */
let rendererReady = false

const cli = parseCli(process.argv)
for (const w of cli.warnings) console.warn(`[cli] ${w}`)

export function getToolBridge(): ToolBridge {
  return toolBridge
}

export function getServices(): NodeServices | null {
  return services
}

function focusWindow(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function deliverOpen(req: OpenSongRequest): void {
  const win = mainWindow
  if (rendererReady && win && !win.isDestroyed()) win.webContents.send(IPC.appOpen, req)
  else pendingOpen = req
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Chiptune Studio',
    icon: join(app.getAppPath(), 'build/icon.png'),
    backgroundColor: '#14161c',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow = win
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())

  // The renderer reports `tools:ready` again after every (re)load; until then calls wait.
  toolBridge.setTarget(win.webContents)
  win.webContents.on('did-start-loading', () => {
    rendererReady = false
    toolBridge.setTarget(win.webContents)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
    rendererReady = false
    toolBridge.setTarget(null)
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

/**
 * `--mcp-only`: the MCP server with no window. Tools run here in the main process on a headless song session
 * (see headless.ts). It takes no single-instance lock, so it can run next to the app window (on another port).
 */
function runHeadless(): void {
  app.disableHardwareAcceleration()
  if (process.platform === 'darwin') app.dock?.hide()
  // No window ever opens, so there is no `window-all-closed`; being explicit keeps the app alive if that changes.
  app.on('window-all-closed', () => undefined)
  void app.whenReady().then(async () => {
    const { port, warning } = headlessPort(cli)
    if (warning) console.warn(warning)
    const h = await startHeadless({ port, log: (m) => console.warn(`[mcp] ${m}`) })
    if (!h.status.running) {
      console.error(`MCP server failed to start: ${h.status.error ?? 'unknown error'}`)
      app.exit(1)
      return
    }
    process.stdout.write(`MCP listening on ${h.status.url}\n`)
    app.on('before-quit', () => void h.stop())
  })
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => app.quit())
}

function runWindowed(): void {
  // One window at a time: a second launch (e.g. `--open song.ctune` from VN Studio) hands its song to this one.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }
  app.on('second-instance', (_e, argv, cwd) => {
    const second = parseCli(argv, cwd)
    for (const w of second.warnings) console.warn(`[cli] ${w}`)
    if (second.open) deliverOpen(second.open)
    focusWindow()
  })

  pendingOpen = cli.open ?? null

  void app.whenReady().then(() => {
    services = registerServices(ipcMain)
    startAssets()
    toolBridge.registerIpc(ipcMain)
    // A port that is already taken (e.g. by a headless server) shows up as an MCP status error; it never throws.
    startMcp(toolBridge)
    registerAgentIpc(ipcMain, toolBridge)
    ipcMain.handle(IPC.appRendererReady, () => {
      rendererReady = true
      const p = pendingOpen
      pendingOpen = null
      return p
    })
    ipcMain.handle(IPC.appFocus, () => focusWindow())
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => toolBridge.dispose())

  app.on('window-all-closed', () => {
    app.quit()
  })
}

if (cli.mcpOnly) runHeadless()
else runWindowed()
