// MCP server settings and status, shared by main (src/main/mcp*.ts) and the renderer's Settings → MCP tab.
// Keep this file free of DOM, Node and Electron imports.

export const DEFAULT_MCP_PORT = 7458

/** IPC channels for the MCP server. Renderer -> main use `invoke`; `statusChanged` is pushed by main. */
export const MCP_IPC = {
  /** () => McpState */
  getState: 'mcp:getState',
  /** (patch: Partial<McpSettings>) => McpState. Restarts the server when enabled/port/token change. */
  setSettings: 'mcp:setSettings',
  /** () => McpState. Generates a new random bearer token, saves it and restarts the server. */
  regenerateToken: 'mcp:regenerateToken',
  /** main -> renderer push: McpState */
  statusChanged: 'mcp:statusChanged'
} as const

export interface McpSettings {
  /** Start the server with the app. Default true. */
  enabled: boolean
  /** Port on 127.0.0.1. Default 7458. */
  port: number
  /** Optional bearer token. When set, clients must send `Authorization: Bearer <token>`. */
  token: string | null
}

export interface McpStatus {
  running: boolean
  /** e.g. http://127.0.0.1:7458/mcp when running. */
  url: string | null
  /** Set when the server failed to start (e.g. port in use). */
  error?: string
  /** Number of open MCP sessions. */
  sessions: number
}

/** Ready-to-copy connection snippets for the Settings → MCP tab. */
export interface McpSnippets {
  /** `claude mcp add --transport http chiptune-studio http://127.0.0.1:7458/mcp` (+ header when a token is set). */
  claudeCode: string
  /** JSON block for Claude Desktop's `mcpServers` using the stdio shim. */
  stdioJson: string
}

export interface McpState {
  settings: McpSettings
  status: McpStatus
  snippets: McpSnippets
}
