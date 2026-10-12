// Saved chats: `~/ChiptuneStudio/chats/<id>.json`, one file per conversation, written after every turn.
// A file holds the model's messages (to continue the chat) and the UI events (to show it again). No Electron import.

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChatMessage } from '../llm'
import type { AgentUiEvent, ChatSummary } from '../shared/agent'

export interface SavedChat {
  version: 1
  id: string
  /** The first words of the first message. */
  title: string
  createdAt: number
  updatedAt: number
  /** The conversation the model sees (user, assistant and tool messages). */
  messages: ChatMessage[]
  /** The Chat panel's events, replayed to show the transcript again. */
  events: AgentUiEvent[]
}

const ID = /^[A-Za-z0-9-]{1,64}$/

export function chatSummary(c: SavedChat): ChatSummary {
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turns: c.events.filter((e) => e.type === 'start').length }
}

export class ChatHistoryStore {
  /** Read from the folder on the first `list`, then kept up to date by `save` and `delete`. */
  private summaries: Map<string, ChatSummary> | null = null

  constructor(readonly dir: string) {}

  private file(id: string): string {
    if (!ID.test(id)) throw new Error(`Not a chat id: "${id}"`)
    return join(this.dir, `${id}.json`)
  }

  /** The saved chats, newest first. Files that can't be read are skipped. */
  async list(): Promise<ChatSummary[]> {
    if (!this.summaries) {
      const map = new Map<string, ChatSummary>()
      let names: string[] = []
      try {
        names = await readdir(this.dir)
      } catch {
        /* no chats yet */
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const chat = await this.load(name.slice(0, -'.json'.length)).catch(() => null)
        if (chat) map.set(chat.id, chatSummary(chat))
      }
      this.summaries = map
    }
    return [...this.summaries.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async load(id: string): Promise<SavedChat> {
    const raw = JSON.parse(await readFile(this.file(id), 'utf8')) as Partial<SavedChat> | null
    if (!raw || raw.id !== id || !Array.isArray(raw.messages) || !Array.isArray(raw.events)) throw new Error(`${id}.json is not a saved chat`)
    return raw as SavedChat
  }

  /** Writes the chat (to a temporary file first, so a crash never leaves half a file). */
  async save(chat: SavedChat): Promise<void> {
    const file = this.file(chat.id)
    await mkdir(this.dir, { recursive: true })
    await writeFile(`${file}.tmp`, JSON.stringify(chat), 'utf8')
    await rename(`${file}.tmp`, file)
    this.summaries?.set(chat.id, chatSummary(chat))
  }

  async delete(id: string): Promise<void> {
    await rm(this.file(id), { force: true })
    this.summaries?.delete(id)
  }
}
