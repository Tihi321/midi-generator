// Electron wiring of the agent runner and the LLM settings: ipcMain handlers and event pushes.
// The logic lives in agent.ts and llm.ts (no Electron there).

import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { AGENT_IPC, LLM_IPC, type AgentSendRequest, type AgentUiEvent, type LlmAddModel } from '../shared/agent'
import { GUIDE } from '../tools'
import { AgentRunner } from './agent'
import { ChatHistoryStore } from './chatHistory'
import { LlmService } from './llm'
import type { ToolBridge } from './toolBridge'

interface IpcLike {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

/**
 * The folder with the seed providers.md / roles.md: `resources/seed/config` when packaged. Unpackaged, `app.getAppPath()`
 * is the project root under `electron-vite dev` but `out/main` when started as `electron out/main/index.js`,
 * so walk up from it until a `seed/config` shows up.
 */
export function resolveSeedConfigDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'seed', 'config')
  let dir = app.getAppPath()
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'seed', 'config')
    if (existsSync(join(candidate, 'providers.md'))) return candidate
    dir = dirname(dir)
  }
  return join(app.getAppPath(), 'seed', 'config')
}

export interface AgentHandles {
  runner: AgentRunner
  llm: LlmService
}

/** Registers `agent:*` and `llm:*`. The LLM layer is created lazily on first use. */
export function registerAgentIpc(ipc: IpcLike, bridge: ToolBridge): AgentHandles {
  const llm = new LlmService({ seedDir: resolveSeedConfigDir() })
  const emit = (ev: AgentUiEvent): void => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(AGENT_IPC.event, ev)
  }
  const chats = new ChatHistoryStore(join(llm.dataDir, 'chats'))
  const runner = new AgentRunner({ bridge, guide: GUIDE, emit, resolveModel: (ref) => llm.resolveModel(ref), chats })

  ipc.handle(AGENT_IPC.send, (_e, req) => runner.send(req as AgentSendRequest))
  ipc.handle(AGENT_IPC.stop, () => runner.stop())
  ipc.handle(AGENT_IPC.reset, () => runner.reset())
  ipc.handle(AGENT_IPC.getState, () => runner.getState())
  ipc.handle(AGENT_IPC.listChats, () => runner.listChats())
  ipc.handle(AGENT_IPC.openChat, (_e, id) => runner.openChat(String(id)))
  ipc.handle(AGENT_IPC.deleteChat, (_e, id) => runner.deleteChat(String(id)))

  ipc.handle(LLM_IPC.overview, () => llm.overview())
  ipc.handle(LLM_IPC.setSelectedModel, async (_e, ref) => {
    await llm.setSelectedModel(typeof ref === 'string' && ref ? ref : null)
  })
  ipc.handle(LLM_IPC.setKey, (_e, providerId, key) => llm.setKey(String(providerId), String(key)))
  ipc.handle(LLM_IPC.deleteKey, (_e, providerId) => llm.deleteKey(String(providerId)))
  ipc.handle(LLM_IPC.reload, () => llm.reload())
  ipc.handle(LLM_IPC.refreshModels, () => llm.refreshModels())
  ipc.handle(LLM_IPC.setContextSize, (_e, tokens) => llm.setContextSize(typeof tokens === 'number' ? tokens : null))
  ipc.handle(LLM_IPC.catalog, (_e, providerId) => llm.catalog(String(providerId)))
  ipc.handle(LLM_IPC.showModels, (_e, refs, shown) => llm.showModels(Array.isArray(refs) ? refs.map(String) : [], shown === true))
  ipc.handle(LLM_IPC.addModel, (_e, cmd) => llm.addModel(cmd as LlmAddModel))
  ipc.handle(LLM_IPC.openConfigFolder, async () => {
    await llm.get().catch(() => undefined) // makes sure the folder exists
    return shell.openPath(llm.configDir)
  })
  return { runner, llm }
}
