// Electron glue for the MCP server: registers the MCP IPC handlers, starts the server with the ToolBridge
// as host, and pushes status to the windows. Kept out of index.ts so that file only gets one call.
import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import type { ToolBridge } from './toolBridge'
import { type McpController, registerMcp } from './mcpSettings'

/** Absolute path of the stdio shim (the build output next to the app; no asar, see electron-builder.yml). */
export function shimPath(): string {
  return join(app.getAppPath(), 'out', 'mcp-stdio', 'index.js')
}

export function startMcp(bridge: ToolBridge): McpController {
  const controller = registerMcp(ipcMain, bridge, {
    shimPath: shimPath(),
    send: (channel, state) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, state)
    },
    log: (m) => console.warn(`[mcp] ${m}`)
  })
  void controller.start()
  app.on('before-quit', () => void controller.stop())
  return controller
}
