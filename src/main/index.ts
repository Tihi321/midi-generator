import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import { type NodeServices, registerServices } from './services'
import { ToolBridge } from './toolBridge'
import { startMcp } from './mcpApp'
import { registerAgentIpc } from './agentIpc'
import { startAssets } from './assetsApp'

/** The tool bridge to the renderer's live song; the agent runner and MCP server use it as their ToolHost. */
const toolBridge = new ToolBridge()
let services: NodeServices | null = null

export function getToolBridge(): ToolBridge {
  return toolBridge
}

export function getServices(): NodeServices | null {
  return services
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Chiptune Studio',
    backgroundColor: '#14161c',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => win.show())

  // The renderer reports `tools:ready` again after every (re)load; until then calls wait.
  toolBridge.setTarget(win.webContents)
  win.webContents.on('did-start-loading', () => toolBridge.setTarget(win.webContents))
  win.on('closed', () => toolBridge.setTarget(null))

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void win.loadURL(devUrl)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return win
}

void app.whenReady().then(() => {
  services = registerServices(ipcMain)
  startAssets()
  toolBridge.registerIpc(ipcMain)
  startMcp(toolBridge)
  registerAgentIpc(ipcMain, toolBridge)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => toolBridge.dispose())

app.on('window-all-closed', () => {
  app.quit()
})
