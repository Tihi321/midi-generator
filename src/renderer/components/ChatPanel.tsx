import { useEffect, useRef, useState } from 'react'
import type { LlmModelInfo } from '../../shared/agent'
import { useSession } from '../hooks/useSession'
import { session } from '../state/session'
import { useChat } from '../state/chat'
import { type ChatItem, canUndoAgentTurn, formatCost, formatTokens } from '../state/chatReducer'

function Badges({ m }: { m: LlmModelInfo | undefined }) {
  if (!m) return null
  return (
    <span className="chat-badges">
      <span className={`badge ${m.tools ? 'on' : 'off'}`} title={m.tools ? 'Native tool calling' : 'No native tool calling: the agent uses JSON actions (slower, less reliable)'}>
        {m.tools ? 'tools' : 'json'}
      </span>
      <span className={`badge ${m.vision ? 'on' : 'off'}`} title={m.vision ? 'Can look at images: gets a preview after each drawing step' : 'Cannot look at images: works from text only'}>
        {m.vision ? 'vision' : 'no vision'}
      </span>
      <span className="badge" title={m.local ? 'Runs on this machine' : 'Remote API'}>
        {m.local ? 'local' : 'remote'}
      </span>
    </span>
  )
}

function ToolCard({ item }: { item: Extract<ChatItem, { kind: 'tool' }> }) {
  const args = item.args === undefined ? '' : JSON.stringify(item.args, null, 2)
  return (
    <details className={`tool-card ${item.status}`} data-testid="tool-card">
      <summary>
        <span className="tool-dot" />
        <span className="tool-title">{item.name}</span>
        <span className="tool-status">{item.status === 'running' ? 'running...' : item.status === 'error' ? 'error' : 'ok'}</span>
        {item.image && <img className="tool-thumb" src={item.image} alt="preview" />}
      </summary>
      {args && <pre className="tool-pre" title="Arguments">{args.length > 4000 ? `${args.slice(0, 4000)}\n...` : args}</pre>}
      {item.summary && <pre className={`tool-pre${item.status === 'error' ? ' error' : ''}`} title="Result">{item.summary}</pre>}
      {item.image && <img className="tool-image" src={item.image} alt="preview" />}
    </details>
  )
}

function Item({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="msg user" data-testid="chat-user">{item.text}</div>
    case 'assistant':
      return <div className={`msg assistant${item.streaming ? ' streaming' : ''}`} data-testid="chat-assistant">{item.text}</div>
    case 'tool':
      return <ToolCard item={item} />
    case 'error':
      return <div className="msg error-msg" data-testid="chat-error">{item.message}</div>
    case 'info':
      return <div className="msg info">{item.text}</div>
  }
}

function when(ms: number): string {
  const d = new Date(ms)
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString()
}

/** The saved chats: open one to continue it, or delete it. */
function ChatHistory({ onOpened }: { onOpened: () => void }) {
  const chat = useChat()
  useEffect(() => {
    void useChat.getState().loadChats()
  }, [])
  if (!chat.chats) return <div className="chat-history"><p className="hint">Loading...</p></div>
  if (chat.chats.length === 0) return <div className="chat-history"><p className="hint">No saved chats yet. A chat is saved after its first message.</p></div>
  return (
    <div className="chat-history" data-testid="chat-history">
      {chat.chats.map((c) => (
        <div key={c.id} className={`chat-history-row${c.id === chat.chatId ? ' current' : ''}`}>
          <button
            className="chat-history-open"
            disabled={chat.running}
            title={chat.running ? 'Wait for the agent or stop it first' : 'Show this chat and continue it'}
            onClick={() => void chat.openChat(c.id).then(onOpened)}
            data-testid="chat-history-open"
          >
            <span className="chat-history-title">{c.title}</span>
            <span className="chat-history-meta">
              {c.turns} {c.turns === 1 ? 'message' : 'messages'} - {when(c.updatedAt)}
            </span>
          </button>
          <button title="Delete this chat" disabled={chat.running && c.id === chat.chatId} onClick={() => void chat.deleteChat(c.id)} data-testid="chat-history-delete">
            Delete
          </button>
        </div>
      ))}
    </div>
  )
}

export function ChatPanel() {
  useSession()
  const chat = useChat()
  const scroller = useRef<HTMLDivElement>(null)
  const models = chat.overview?.models ?? []
  const selectedRef = chat.overview?.selectedModel ?? ''
  const active = models.find((m) => m.ref === (selectedRef || chat.overview?.defaultModel))
  const canUndo = canUndoAgentTurn(chat.turn, session.history.undoDepth, session.undoLabel(), session.canUndo())
  const [showHistory, setShowHistory] = useState(false)

  useEffect(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat.items])

  const submit = (): void => {
    if (chat.draft.trim() && !chat.running) void chat.send(chat.draft)
  }

  return (
    <section className="panel chat-panel" data-testid="chat-panel">
      <header className="panel-head">
        <span className="label">Chat</span>
        <span className="spacer" />
        <button title="Undo everything the agent did in its last turn (one step)" disabled={chat.running || !canUndo} onClick={chat.undoTurn} data-testid="chat-undo-turn">
          Undo agent turn
        </button>
        <button className={showHistory ? 'active' : ''} title="Saved chats: open one to continue it" onClick={() => setShowHistory((v) => !v)} data-testid="chat-history-toggle">
          History
        </button>
        <button
          title="Start a new conversation"
          onClick={() => {
            setShowHistory(false)
            void chat.newChat()
          }}
          data-testid="chat-new"
        >
          New chat
        </button>
      </header>
      <div className="chat-model">
        <select
          value={selectedRef}
          onChange={(e) => void chat.selectModel(e.target.value || null)}
          onFocus={() => void chat.refreshModels()}
          disabled={chat.running}
          title="Model for this chat"
          data-testid="chat-model"
        >
          <option value="">{chat.overview?.defaultModel ? `Default (${chat.overview.defaultModel})` : 'Default (no model available)'}</option>
          {models.map((m) => (
            <option key={m.ref} value={m.ref} disabled={!m.available} title={m.unavailableReason}>
              {m.ref}
              {m.available ? '' : ' (unavailable)'}
            </option>
          ))}
        </select>
        <Badges m={active} />
      </div>
      {chat.overviewError && <div className="msg error-msg">{chat.overviewError}</div>}
      {showHistory && <ChatHistory onOpened={() => setShowHistory(false)} />}
      <div className="chat-log" ref={scroller} data-testid="chat-log" hidden={showHistory}>
        {chat.items.length === 0 && (
          <p className="hint">Ask the agent to compose something, for example: "a heroic NES overworld theme at 120 BPM". Enter sends, Shift+Enter adds a line.</p>
        )}
        {chat.items.map((it) => (
          <Item key={it.id} item={it} />
        ))}
      </div>
      <div className="chat-usage" data-testid="chat-usage">
        {chat.running && chat.step ? `step ${chat.step.step}/${chat.step.maxSteps} - ` : ''}
        {formatTokens(chat.usage.inputTokens)} in / {formatTokens(chat.usage.outputTokens)} out - {formatCost(chat.costUsd)}
        {chat.model ? ` - ${chat.model}` : ''}
      </div>
      <div className="chat-input">
        <textarea
          value={chat.draft}
          rows={3}
          placeholder="Message the agent..."
          onChange={(e) => chat.setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          data-testid="chat-input"
        />
        {chat.running ? (
          <button className="primary" onClick={() => void chat.stop()} data-testid="chat-stop">Stop</button>
        ) : (
          <button className="primary" disabled={!chat.draft.trim()} onClick={submit} data-testid="chat-send">Send</button>
        )}
      </div>
    </section>
  )
}
