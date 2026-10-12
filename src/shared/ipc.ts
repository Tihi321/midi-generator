// Types shared by main, preload and renderer. Keep this file free of DOM and Electron imports.

import type { ToolResult } from './tools'

/** Unsubscribe function returned by `on`. */
export type Unsubscribe = () => void

/** The API the preload script exposes as `window.chiptuneStudio`. */
export interface ChiptuneStudioApi {
  /** Call a main-process handler registered with `ipcMain.handle(channel, ...)`. */
  invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T>
  /** Subscribe to events the main process pushes with `webContents.send(channel, ...)`. */
  on(channel: string, callback: (...args: unknown[]) => void): Unsubscribe
}

/** IPC channel names. */
export const IPC = {
  // Tool bridge. main -> renderer (webContents.send)
  toolsExecute: 'tools:execute',
  toolsTurn: 'tools:turn',
  toolsCancel: 'tools:cancel',
  // Tool bridge. renderer -> main (ipcRenderer.invoke / ipcMain.handle)
  toolsResult: 'tools:result',
  toolsReady: 'tools:ready',
  // ToolServices implemented by main (renderer -> main, invoke)
  fsWriteFile: 'fs:writeFile',
  fsReadFile: 'fs:readFile',
  fsResolveExportPath: 'fs:resolveExportPath',
  fsResolveProjectPath: 'fs:resolveProjectPath'
} as const

/** main -> renderer: run a tool on the live document. */
export interface ToolExecuteRequest {
  requestId: string
  name: string
  args: unknown
}

/** main -> renderer: begin/end one agent turn (all tool calls in between become one undo step). */
export interface ToolTurnRequest {
  requestId: string
  action: 'begin' | 'end' | 'rollback'
  label?: string
}

/** main -> renderer: the request was aborted or timed out; stop working on it. */
export interface ToolCancelRequest {
  requestId: string
}

/** renderer -> main reply to `tools:execute` or `tools:turn`. */
export interface ToolResultPayload {
  requestId: string
  result?: ToolResult
  /** Set when the renderer failed outside the tool itself (the tool's own failures are `result.isError`). */
  error?: string
}
