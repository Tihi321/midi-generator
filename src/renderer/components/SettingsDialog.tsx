import { useCallback, useEffect, useState } from 'react'
import type { LlmOverview, LlmProviderInfo } from '../../shared/agent'
import type { McpState } from '../../shared/mcp'
import { llmApi, mcpApi } from '../lib/agentApi'
import { useChat } from '../state/chat'
import { useUi } from '../state/ui'
import { Modal, NumberField } from './Controls'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function KeyRow({ provider, onChange, busy }: { provider: LlmProviderInfo; onChange: (o: LlmOverview) => void; busy: boolean }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const env = provider.apiKeyEnv
  if (!env) return null
  const status =
    provider.keyStatus === 'env' ? `set by the environment variable ${env} (not shown)` : provider.keyStatus === 'stored' ? 'stored in the credential store (not shown)' : 'not set'
  return (
    <div className="key-row">
      <div className="hint" data-testid={`key-status-${provider.id}`}>
        API key ({env}): {status}
      </div>
      <div className="row-buttons">
        <input
          type="password"
          autoComplete="off"
          placeholder={provider.keyStatus === 'stored' ? 'Type a new key to replace it' : 'Paste the API key'}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          data-testid={`key-input-${provider.id}`}
        />
        <button
          disabled={!value.trim() || busy}
          data-testid={`key-save-${provider.id}`}
          onClick={() => {
            setError('')
            llmApi
              .setKey(provider.id, value)
              .then((o) => {
                setValue('')
                onChange(o)
              })
              .catch((e) => setError(msg(e)))
          }}
        >
          Save key
        </button>
        <button
          disabled={provider.keyStatus !== 'stored' || busy}
          title="Remove the key from the credential store"
          onClick={() => {
            setError('')
            llmApi.deleteKey(provider.id).then(onChange).catch((e) => setError(msg(e)))
          }}
        >
          Delete key
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function ContextSizeRow({ overview, busy, run }: { overview: LlmOverview; busy: boolean; run: (p: Promise<LlmOverview>) => void }) {
  const loaders = overview.providers.filter((p) => p.loadsModels).map((p) => p.id)
  const servers = overview.providers.filter((p) => p.serverContext)
  return (
    <div className="form" data-testid="llm-context">
      <label>
        <span>Context size (tokens)</span>
        <span className="row-buttons">
          <NumberField value={overview.contextSize} min={2048} max={1048576} width={100} onCommit={(n) => run(llmApi.setContextSize(n))} testId="llm-context-size" />
          <button disabled={busy || !overview.contextSizeSet} title="Use lmstudio_context and load_context from providers.md again" onClick={() => run(llmApi.setContextSize(null))}>
            From providers.md
          </button>
        </span>
      </label>
      <div className="hint">
        {loaders.length > 0 ? `${loaders.join(', ')} loads its models with this context; a model loaded with less is loaded again on the next message.` : 'No provider here loads its models.'}
        {servers.map((p) => ` ${p.id} runs with ${p.serverContext} tokens (set in its own setup).`).join('')}
      </div>
    </div>
  )
}

function ProvidersTab() {
  const setOverview = useChat((s) => s.setOverview)
  const [overview, setLocal] = useState<LlmOverview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const apply = useCallback(
    (o: LlmOverview) => {
      setLocal(o)
      setOverview(o)
    },
    [setOverview]
  )
  useEffect(() => {
    llmApi.overview().then(apply).catch((e) => setError(msg(e)))
  }, [apply])

  const run = (p: Promise<LlmOverview>): void => {
    setBusy(true)
    setError('')
    p.then(apply)
      .catch((e) => setError(msg(e)))
      .finally(() => setBusy(false))
  }
  const modelByRef = new Map((overview?.models ?? []).map((m) => [m.ref, m]))

  return (
    <div className="settings-tab" data-testid="settings-providers">
      <div className="row-buttons">
        <button disabled={busy} onClick={() => run(llmApi.reload())} title="Re-read providers.md and roles.md and ask local providers (LM Studio...) for their models" data-testid="llm-reload">
          {busy ? 'Reloading...' : 'Reload config and discover models'}
        </button>
        <button onClick={() => void llmApi.openConfigFolder().then((r) => r && setError(r)).catch((e) => setError(msg(e)))} data-testid="llm-open-config">
          Open config folder
        </button>
      </div>
      {overview?.configDir && <div className="hint">Edit providers.md and roles.md in {overview.configDir}</div>}
      {overview && overview.contextSize > 0 && <ContextSizeRow overview={overview} busy={busy} run={run} />}
      {(error || overview?.error) && <div className="error" data-testid="llm-error">{error || overview?.error}</div>}
      {!overview && !error && <div className="hint">Loading providers...</div>}
      {overview?.providers.map((p) => (
        <div className="provider-card" key={p.id} data-testid={`provider-${p.id}`}>
          <div className="provider-head">
            <strong>{p.id}</strong>
            <span className="badge">{p.kind}</span>
            <span className="badge">{p.local ? 'local' : 'remote'}</span>
            <span className={`badge ${p.available ? 'on' : 'off'}`}>{p.available ? 'available' : 'unavailable'}</span>
          </div>
          {p.baseUrl && <div className="hint mono">{p.baseUrl}</div>}
          {!p.available && p.unavailableReason && <div className="hint">{p.unavailableReason}</div>}
          {p.models.length > 0 ? (
            <div className="provider-models">
              {p.models.map((ref) => {
                const m = modelByRef.get(ref)
                return (
                  <span className="model-chip" key={ref} title={ref}>
                    {m?.id ?? ref}
                    {m?.tools ? <span className="badge on">tools</span> : null}
                    {m?.vision ? <span className="badge on">vision</span> : null}
                    {m?.priceIn !== undefined ? <span className="badge">${m.priceIn}/{m.priceOut}</span> : null}
                  </span>
                )
              })}
            </div>
          ) : (
            <div className="hint">No models listed.</div>
          )}
          <KeyRow provider={p} onChange={apply} busy={busy} />
        </div>
      ))}
    </div>
  )
}

function CopyBlock({ label, text, testId }: { label: string; text: string; testId: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="copy-block">
      <div className="row-buttons">
        <span className="label">{label}</span>
        <span className="spacer" />
        <button
          data-testid={testId}
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="result">{text}</pre>
    </div>
  )
}

function McpTab() {
  const [state, setState] = useState<McpState | null>(null)
  const [unavailable, setUnavailable] = useState('')
  const [error, setError] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [token, setToken] = useState('')

  useEffect(() => {
    let alive = true
    mcpApi
      .getState()
      .then((s) => alive && setState(s))
      .catch((e) => alive && setUnavailable(msg(e)))
    const off = mcpApi.onStatus((s) => alive && setState(s))
    return () => {
      alive = false
      off()
    }
  }, [])
  useEffect(() => setToken(state?.settings.token ?? ''), [state?.settings.token])

  if (!state) {
    return (
      <div className="settings-tab" data-testid="settings-mcp">
        {unavailable ? <div className="error" data-testid="mcp-unavailable">MCP server unavailable: {unavailable}</div> : <div className="hint">Loading...</div>}
      </div>
    )
  }
  const patch = (p: Parameters<typeof mcpApi.setSettings>[0]): void => {
    setError('')
    mcpApi.setSettings(p).then(setState).catch((e) => setError(msg(e)))
  }
  const { settings, status, snippets } = state
  return (
    <div className="settings-tab" data-testid="settings-mcp">
      <p className="hint">Lets other AI tools (Claude Code, Claude Desktop...) draw in this editor through the same tools as the built-in agent. The server only listens on 127.0.0.1.</p>
      <div className="form">
        <label className="check">
          <input type="checkbox" checked={settings.enabled} onChange={(e) => patch({ enabled: e.target.checked })} data-testid="mcp-enabled" />
          Enable the MCP server
        </label>
        <label>
          <span>Port</span>
          <NumberField value={settings.port} min={1} max={65535} width={80} onCommit={(port) => patch({ port })} testId="mcp-port" />
        </label>
        <label>
          <span>Bearer token</span>
          <span className="row-buttons">
            <input
              type={showToken ? 'text' : 'password'}
              autoComplete="off"
              value={token}
              placeholder="none (no authentication)"
              onChange={(e) => setToken(e.target.value)}
              onBlur={() => token !== (settings.token ?? '') && patch({ token: token.trim() || null })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              data-testid="mcp-token"
            />
            <button onClick={() => setShowToken((v) => !v)} data-testid="mcp-token-toggle">{showToken ? 'Hide' : 'Show'}</button>
            <button onClick={() => mcpApi.regenerateToken().then(setState).catch((e) => setError(msg(e)))} data-testid="mcp-token-regen">Regenerate</button>
            <button disabled={!settings.token} onClick={() => patch({ token: null })} data-testid="mcp-token-clear">Clear</button>
          </span>
        </label>
      </div>
      <div className={`result ${status.error ? 'error' : status.running ? 'ok' : ''}`} data-testid="mcp-status">
        {status.running ? `Running at ${status.url ?? ''} - ${status.sessions} session${status.sessions === 1 ? '' : 's'}` : settings.enabled ? 'Not running' : 'Stopped'}
        {status.error ? `\n${status.error}` : ''}
      </div>
      {error && <div className="error">{error}</div>}
      <CopyBlock label="Claude Code" text={snippets.claudeCode} testId="mcp-copy-claude-code" />
      <CopyBlock label="Claude Desktop (stdio)" text={snippets.stdioJson} testId="mcp-copy-stdio" />
    </div>
  )
}

type Tab = 'providers' | 'mcp'

export function SettingsDialog() {
  const openDialog = useUi((s) => s.openDialog)
  const dataDir = useChat((s) => s.overview?.dataDir)
  const [tab, setTab] = useState<Tab>('providers')
  return (
    <Modal title="Settings" onClose={() => openDialog(null)} testId="settings-dialog" wide>
      <div className="tabs">
        <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')} data-testid="settings-tab-providers">Providers</button>
        <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')} data-testid="settings-tab-mcp">MCP</button>
      </div>
      {tab === 'providers' ? <ProvidersTab /> : <McpTab />}
      <div className="hint" data-testid="settings-data-dir">
        Data folder (read-only): <span className="mono">{dataDir ?? '~/ChiptuneStudio'}</span>
      </div>
    </Modal>
  )
}
