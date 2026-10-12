// Typed wrappers over window.chiptuneStudio for the agent, the LLM settings and the MCP settings.
// Every call tolerates a missing handler (the main side may not have registered it): it rejects, and callers show a message.

import { AGENT_IPC, LLM_IPC, type AgentSendResponse, type AgentState, type AgentUiEvent, type ChatSummary, type LlmOverview, type OpenedChat } from '../../shared/agent'
import { MCP_IPC, type McpSettings, type McpState } from '../../shared/mcp'

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (!window.chiptuneStudio) return Promise.reject(new Error('Not running inside Electron.'))
  return window.chiptuneStudio.invoke<T>(channel, ...args)
}

export const agentApi = {
  send: (text: string, modelRef: string | null) => invoke<AgentSendResponse>(AGENT_IPC.send, { text, modelRef }),
  stop: () => invoke<void>(AGENT_IPC.stop),
  reset: () => invoke<AgentState>(AGENT_IPC.reset),
  getState: () => invoke<AgentState>(AGENT_IPC.getState),
  listChats: () => invoke<ChatSummary[]>(AGENT_IPC.listChats),
  openChat: (id: string) => invoke<OpenedChat>(AGENT_IPC.openChat, id),
  deleteChat: (id: string) => invoke<AgentState>(AGENT_IPC.deleteChat, id),
  onEvent: (cb: (ev: AgentUiEvent) => void): (() => void) => (window.chiptuneStudio ? window.chiptuneStudio.on(AGENT_IPC.event, (ev) => cb(ev as AgentUiEvent)) : () => undefined)
}

export const llmApi = {
  overview: () => invoke<LlmOverview>(LLM_IPC.overview),
  setSelectedModel: (ref: string | null) => invoke<void>(LLM_IPC.setSelectedModel, ref),
  setKey: (providerId: string, key: string) => invoke<LlmOverview>(LLM_IPC.setKey, providerId, key),
  deleteKey: (providerId: string) => invoke<LlmOverview>(LLM_IPC.deleteKey, providerId),
  reload: () => invoke<LlmOverview>(LLM_IPC.reload),
  refreshModels: () => invoke<LlmOverview>(LLM_IPC.refreshModels),
  setContextSize: (tokens: number | null) => invoke<LlmOverview>(LLM_IPC.setContextSize, tokens),
  openConfigFolder: () => invoke<string>(LLM_IPC.openConfigFolder)
}

export const mcpApi = {
  getState: () => invoke<McpState>(MCP_IPC.getState),
  setSettings: (patch: Partial<McpSettings>) => invoke<McpState>(MCP_IPC.setSettings, patch),
  regenerateToken: () => invoke<McpState>(MCP_IPC.regenerateToken),
  onStatus: (cb: (s: McpState) => void): (() => void) => (window.chiptuneStudio ? window.chiptuneStudio.on(MCP_IPC.statusChanged, (s) => cb(s as McpState)) : () => undefined)
}
