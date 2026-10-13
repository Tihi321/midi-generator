// IPC contract of the built-in agent (chat) and the LLM settings. Shared by main (src/main/agent*.ts,
// src/main/llm*.ts) and the renderer (Chat panel, Settings dialog). Free of DOM, Node and Electron imports.

/** Renderer -> main use `invoke`; `event` is pushed by main (webContents.send). */
export const AGENT_IPC = {
  /** (AgentSendRequest) => AgentSendResponse. Starts a run. */
  send: 'agent:send',
  /** () => void. Aborts the running turn. */
  stop: 'agent:stop',
  /** () => AgentState. Clears the conversation (aborts a running turn first). */
  reset: 'agent:reset',
  /** () => AgentState */
  getState: 'agent:getState',
  /** () => ChatSummary[]. The saved chats (`~/ChiptuneStudio/chats`), newest first. */
  listChats: 'agent:listChats',
  /** (chatId: string) => OpenedChat. Makes a saved chat the current conversation (not while a turn runs). */
  openChat: 'agent:openChat',
  /** (chatId: string) => AgentState. Deletes a saved chat; deleting the current one starts a new conversation. */
  deleteChat: 'agent:deleteChat',
  /** main -> renderer push: AgentUiEvent */
  event: 'agent:event'
} as const

export const LLM_IPC = {
  /** () => LlmOverview. Providers, models, the selected model and key status. */
  overview: 'llm:overview',
  /** (modelRef: string | null) => void. The model the chat uses (null: the role's first available model). */
  setSelectedModel: 'llm:setSelectedModel',
  /** (providerId: string, key: string) => LlmOverview. The key is stored in the credential store and never read back. */
  setKey: 'llm:setKey',
  /** (providerId: string) => LlmOverview */
  deleteKey: 'llm:deleteKey',
  /** () => LlmOverview. Re-reads providers.md / roles.md and asks the providers for their models. */
  reload: 'llm:reload',
  /** () => LlmOverview. Asks the providers for their models again (installed LM Studio models), without re-reading the config files. */
  refreshModels: 'llm:refreshModels',
  /** (tokens: number | null) => LlmOverview. The context LM Studio loads models with; null goes back to providers.md. */
  setContextSize: 'llm:setContextSize',
  /** () => string. Opens ~/ChiptuneStudio/config in the file manager. Resolves to an error message or ''. */
  openConfigFolder: 'llm:openConfigFolder',
  /** (providerId: string) => LlmCatalog. Asks an openai-compat provider for every chat model it lists (Settings > Models > Detect models). */
  catalog: 'llm:catalog',
  /** (refs: string[], shown: boolean) => LlmOverview. Ticks / unticks models of the chat dropdown (config/models.md). A refused tick sets `error`. */
  showModels: 'llm:showModels',
  /** (cmd: LlmAddModel) => LlmOverview. Adds a model by id to config/models.md; rejects when a non-local provider's prices are missing. */
  addModel: 'llm:addModel'
} as const

/** Prefix of the undo label of an agent turn (`Agent: <first words of the prompt>`). */
export const AGENT_TURN_LABEL_PREFIX = 'Agent: '

export interface AgentSendRequest {
  text: string
  /** `provider/model` or an alias. Default: the selected model, else the role's first available one. */
  modelRef?: string | null
}

export type AgentSendResponse = { ok: true; runId: string } | { ok: false; error: string }

export interface AgentState {
  running: boolean
  runId: string | null
  /** Messages in the conversation kept in main (user, assistant and tool messages). */
  messageCount: number
  /** The current conversation; it is saved under this id after its first turn. */
  chatId: string
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** Messages the user sent. */
  turns: number
}

/** A saved chat opened again: replay `events` through the Chat panel's reducer to show it. */
export interface OpenedChat {
  state: AgentState
  events: AgentUiEvent[]
}

export interface AgentUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export type AgentStopReason = 'completed' | 'max_steps' | 'aborted' | 'error'

/** What main pushes to the Chat panel. Every event carries the run it belongs to. */
export type AgentUiEvent = { runId: string } & (
  | { type: 'start'; label: string; text: string }
  | { type: 'step'; step: number; maxSteps: number; mode: 'native' | 'json' }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | {
      type: 'tool_result'
      id: string
      name: string
      isError: boolean
      /** The text of the result, cut to a short length. */
      summary: string
      /** A preview image (`data:image/png;base64,...`) when the tool returned one. */
      image?: string
    }
  | { type: 'usage'; usage: AgentUsage; costUsd: number; model?: string }
  | { type: 'error'; message: string }
  | { type: 'done'; reason: AgentStopReason; steps: number; usage: AgentUsage; costUsd: number; model?: string; error?: string }
)

export interface LlmModelInfo {
  /** `provider/model`. */
  ref: string
  provider: string
  id: string
  label: string
  tools: boolean
  vision: boolean
  local: boolean
  available: boolean
  unavailableReason?: string
  /** USD per 1M tokens, when the config has a price. */
  priceIn?: number
  priceOut?: number
  /** In the chat's dropdown: a providers.md model unless unticked, a discovered one only when ticked, a picked one always. */
  shown: boolean
  /** providers.md, found by the provider's `discover`, or added in Settings > Models. */
  source: 'config' | 'discovered' | 'picked'
  /** Context window in tokens, when known. */
  context?: number
  /** Local, or priced 0 / 0. */
  free: boolean
}

export type KeyStatus = 'none' | 'stored' | 'env'

export interface LlmProviderInfo {
  id: string
  kind: string
  enabled: boolean
  local: boolean
  baseUrl?: string
  /** The credential-store account / environment variable of the key; absent when the provider needs none. */
  apiKeyEnv?: string
  available: boolean
  unavailableReason?: string
  /** Where the key comes from. Never the key itself. */
  keyStatus: KeyStatus
  /** `provider/model` refs. */
  models: string[]
  /** The context window the running server reports (Strata). */
  serverContext?: number
  /** Chiptune Studio loads this provider's models (LM Studio): with `LlmOverview.contextSize`. */
  loadsModels: boolean
  /** An openai-compat provider: Detect models (`LLM_IPC.catalog`) can list its models. */
  canList: boolean
  /** `providers.md` `discover`: true (the list is the server's), 'free' (its price-0 models are added), false. */
  discover: boolean | 'free'
}

/** One model of a provider's own list (`LLM_IPC.catalog`). */
export interface LlmCatalogModel {
  id: string
  /** `provider/model`. */
  ref: string
  context?: number
  /** USD per 1M tokens as the provider lists them; 0 for a local provider; absent when it lists none. */
  priceIn?: number
  priceOut?: number
  tools?: boolean
  vision?: boolean
  /** Can be ticked: local, or it has a listed price. Others need Add by id with a price. */
  pickable: boolean
}

export interface LlmCatalog {
  models: LlmCatalogModel[]
  /** Why the list could not be read (no key, server down ...). */
  error?: string
}

export interface LlmAddModel {
  provider: string
  id: string
  /** USD per 1M tokens, required for a non-local provider. */
  priceIn?: number
  priceOut?: number
  context?: number
  tools?: boolean
  vision?: boolean
}

export interface LlmOverview {
  providers: LlmProviderInfo[]
  models: LlmModelInfo[]
  /** The model chosen for the chat, null for the role's default. */
  selectedModel: string | null
  /** What runs when `selectedModel` is null: the role's first available model. */
  defaultModel: string | null
  configDir: string
  dataDir: string
  /** Context window (tokens) LM Studio models are loaded with. */
  contextSize: number
  /** True when it comes from Settings, false when from providers.md (`lmstudio_context`). */
  contextSizeSet: boolean
  /** Set when providers.md or roles.md could not be read. */
  error?: string
}
