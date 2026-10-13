// Chat store: the transcript (pure reducer in chatReducer.ts), the model list and the undo bookkeeping
// of the last agent turn. The conversation itself lives in main; this is only the view of it.

import { create } from 'zustand'
import type { ChatSummary, LlmAddModel, LlmCatalog, LlmOverview } from '../../shared/agent'
import { agentApi, llmApi } from '../lib/agentApi'
import { session } from './session'
import { type ChatState, type TurnUndoInfo, addError, applyEvent, initialChat, replayChat, resetChat } from './chatReducer'

export interface CatalogState extends LlmCatalog {
  loading: boolean
}

export interface ChatStore extends ChatState {
  overview: LlmOverview | null
  overviewError: string | null
  /** The last agent turn's place in the undo history (see canUndoAgentTurn). */
  turn: TurnUndoInfo | null
  draft: string
  /** The conversation in main (saved under this id after its first turn). */
  chatId: string | null
  /** The saved chats, newest first; null until the history is opened. */
  chats: ChatSummary[] | null
  /** What Detect models listed, per provider. */
  catalogs: Record<string, CatalogState>

  setDraft: (text: string) => void
  loadOverview: () => Promise<void>
  /** Asks the providers for their models again (the installed LM Studio models). */
  refreshModels: () => Promise<void>
  setOverview: (o: LlmOverview) => void
  selectModel: (ref: string | null) => Promise<void>
  /** Lists every model a provider has (Settings > Models). */
  detect: (provider: string) => Promise<void>
  /** Ticks or unticks models for the chat dropdown; refusals land in overviewError. */
  showModels: (refs: string[], shown: boolean) => Promise<void>
  /** Adds a model by id; rejects with the reason when the command is invalid. */
  addModel: (cmd: LlmAddModel) => Promise<void>
  send: (text: string) => Promise<void>
  stop: () => Promise<void>
  newChat: () => Promise<void>
  undoTurn: () => void
  loadChats: () => Promise<void>
  /** Shows a saved chat and continues it. */
  openChat: (id: string) => Promise<void>
  deleteChat: (id: string) => Promise<void>
}

let startDepth = 0

export const useChat = create<ChatStore>((set, get) => ({
  ...initialChat(),
  overview: null,
  overviewError: null,
  turn: null,
  draft: '',
  chatId: null,
  chats: null,
  catalogs: {},

  setDraft: (draft) => set({ draft }),
  setOverview: (overview) => set({ overview, overviewError: overview.error ?? null }),

  async loadOverview() {
    try {
      get().setOverview(await llmApi.overview())
    } catch (e) {
      set({ overviewError: e instanceof Error ? e.message : String(e) })
    }
  },

  async refreshModels() {
    try {
      get().setOverview(await llmApi.refreshModels())
    } catch {
      /* keep the list we have */
    }
  },

  async selectModel(ref) {
    const prev = get().overview
    if (prev) set({ overview: { ...prev, selectedModel: ref } })
    try {
      await llmApi.setSelectedModel(ref)
    } catch (e) {
      set((s) => addError(s, e instanceof Error ? e.message : String(e)))
    }
  },

  async detect(provider) {
    const put = (c: CatalogState): void => set((s) => ({ catalogs: { ...s.catalogs, [provider]: c } }))
    put({ models: get().catalogs[provider]?.models ?? [], loading: true })
    try {
      put({ ...(await llmApi.catalog(provider)), loading: false })
    } catch (e) {
      put({ models: [], error: e instanceof Error ? e.message : String(e), loading: false })
    }
  },

  async showModels(refs, shown) {
    if (!refs.length) return
    try {
      get().setOverview(await llmApi.showModels(refs, shown))
    } catch (e) {
      set({ overviewError: e instanceof Error ? e.message : String(e) })
    }
  },

  async addModel(cmd) {
    get().setOverview(await llmApi.addModel(cmd))
  },

  async send(text) {
    const t = text.trim()
    if (!t || get().running) return
    set({ draft: '' })
    try {
      const r = await agentApi.send(t, get().overview?.selectedModel ?? null)
      if (!r.ok) set((s) => addError(s, r.error))
    } catch (e) {
      set((s) => addError(s, e instanceof Error ? e.message : String(e)))
    }
  },

  async stop() {
    try {
      await agentApi.stop()
    } catch {
      /* nothing running */
    }
  },

  async newChat() {
    let chatId: string | null = null
    try {
      chatId = (await agentApi.reset()).chatId
    } catch {
      /* main not ready: still clear the view */
    }
    set({ ...resetChat(), turn: null, chatId })
  },

  async loadChats() {
    try {
      set({ chats: await agentApi.listChats() })
    } catch (e) {
      set((s) => ({ ...addError(s, e instanceof Error ? e.message : String(e)), chats: s.chats ?? [] }))
    }
  },

  async openChat(id) {
    if (get().running) return
    try {
      const opened = await agentApi.openChat(id)
      set({ ...replayChat(opened.events), turn: null, chatId: opened.state.chatId })
    } catch (e) {
      set((s) => addError(s, e instanceof Error ? e.message : String(e)))
    }
  },

  async deleteChat(id) {
    try {
      const st = await agentApi.deleteChat(id)
      if (id === get().chatId) set({ ...resetChat(), turn: null, chatId: st.chatId })
    } catch (e) {
      set((s) => addError(s, e instanceof Error ? e.message : String(e)))
    }
    await get().loadChats()
  },

  undoTurn() {
    if (session.undo()) set({ turn: null })
  }
}))

let started = false

/** Subscribes to the agent's push events once. Call from the app root so events are kept while the Chat tab is hidden. */
export function initChat(): void {
  if (started) return
  started = true
  agentApi.onEvent((ev) => {
    if (ev.type === 'start') startDepth = session.history.undoDepth
    useChat.setState((s) => {
      const next = applyEvent(s, ev)
      if (ev.type === 'done' && ev.runId === s.runId) return { ...next, turn: { startDepth, endDepth: session.history.undoDepth } }
      if (ev.type === 'start') return { ...next, turn: null }
      return next
    })
    // the turn was saved: show it in the history when that is open
    if (ev.type === 'done' && useChat.getState().chats) void useChat.getState().loadChats()
  })
  void useChat.getState().loadOverview()
  void agentApi
    .getState()
    .then((st) => {
      useChat.setState(st.running ? { running: true, runId: st.runId, chatId: st.chatId } : { chatId: st.chatId })
    })
    .catch(() => undefined)
}
