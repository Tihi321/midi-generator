import { useState } from 'react'
import type { LlmProviderInfo, LlmTestResult } from '../../shared/agent'
import { llmApi } from '../lib/agentApi'
import { useChat } from '../state/chat'

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Add / edit an OpenAI-compatible provider (saved in config/providers.md as `custom: true`, key in the credential store). */
export function ProviderForm({ edit, modelIds, onDone }: { edit?: LlmProviderInfo; modelIds?: string[]; onDone: (savedId?: string) => void }) {
  const [name, setName] = useState(edit?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(edit?.baseUrl ?? 'http://127.0.0.1:7461/v1')
  const [apiKey, setApiKey] = useState('')
  const [free, setFree] = useState(edit?.local ?? true)
  const [jsonSchema, setJsonSchema] = useState(edit?.jsonSchema ?? false)
  const [concurrency, setConcurrency] = useState(String(edit?.concurrency ?? 2))
  const [discover, setDiscover] = useState(edit ? !!edit.discover : true)
  const [enabled, setEnabled] = useState(edit?.enabled ?? true)
  const [models, setModels] = useState((modelIds ?? []).join('\n'))
  const [error, setError] = useState('')
  const [test, setTest] = useState<LlmTestResult | null>(null)
  const [busy, setBusy] = useState(false)

  const par = concurrency.trim().toLowerCase() === 'auto' ? ('auto' as const) : Number(concurrency)
  const valid = name.trim() !== '' && baseUrl.trim() !== '' && (par === 'auto' || (Number.isInteger(par) && par >= 1))

  const save = (): void => {
    setBusy(true)
    setError('')
    useChat
      .getState()
      .saveProvider({
        ...(edit ? { id: edit.id } : {}),
        name,
        baseUrl,
        apiKey,
        free,
        jsonSchema,
        concurrency: par,
        discover,
        enabled,
        models: models.split(/\r?\n|,/).map((s) => s.trim()).filter(Boolean)
      })
      .then(() => onDone(edit?.id))
      .catch((e) => setError(msg(e)))
      .finally(() => setBusy(false))
  }

  return (
    <div className="models-pane provider-form" data-testid="provider-form">
      <div className="hint">{edit ? `Edit ${edit.name}` : 'Add an OpenAI-compatible provider'}. Saved in config/providers.md; the key goes to the credential store.</div>
      <div className="form">
        <label>
          <span>Name</span>
          <input type="text" value={name} placeholder="e.g. ACP proxy (home)" onChange={(e) => setName(e.target.value)} data-testid="provider-name" />
        </label>
        <label>
          <span>Base URL</span>
          <input type="text" value={baseUrl} placeholder="http://127.0.0.1:7461/v1" onChange={(e) => setBaseUrl(e.target.value)} data-testid="provider-url" />
        </label>
        <label>
          <span>API key</span>
          <input
            type="password"
            autoComplete="off"
            value={apiKey}
            placeholder={edit?.keyStatus === 'stored' ? 'Stored: type to replace it' : 'Optional'}
            onChange={(e) => setApiKey(e.target.value)}
            data-testid="provider-key"
          />
        </label>
        <label>
          <span>Parallel requests</span>
          <input type="text" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} data-testid="provider-concurrency" />
        </label>
        <label className="check">
          <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} data-testid="provider-free" />
          free / local (no key needed, no prices)
        </label>
        <label className="check">
          <input type="checkbox" checked={jsonSchema} onChange={(e) => setJsonSchema(e.target.checked)} data-testid="provider-json-schema" />
          send the JSON schema (turn off for servers that reject it)
        </label>
        <label className="check">
          <input type="checkbox" checked={discover} onChange={(e) => setDiscover(e.target.checked)} data-testid="provider-discover" />
          discover models from GET /models
        </label>
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-testid="provider-enabled" />
          enabled
        </label>
        <label>
          <span>Model ids (one per line, optional)</span>
          <textarea rows={4} value={models} onChange={(e) => setModels(e.target.value)} data-testid="provider-models" />
        </label>
      </div>
      <div className="row-buttons">
        <button
          disabled={!baseUrl.trim() || busy}
          onClick={() => {
            setTest(null)
            llmApi.testProvider({ baseUrl, apiKey, ...(edit ? { id: edit.id } : {}) }).then(setTest).catch((e) => setTest({ ok: false, error: msg(e) }))
          }}
          data-testid="provider-test"
        >
          Test
        </button>
        <span className="spacer" />
        <button onClick={() => onDone()} data-testid="provider-cancel">
          Cancel
        </button>
        <button className="primary" disabled={!valid || busy} onClick={save} data-testid="provider-save">
          {busy ? 'Saving...' : 'Save'}
        </button>
      </div>
      {test && <div className={test.ok ? 'hint' : 'error'} data-testid="provider-test-result">{test.ok ? `Reachable, ${test.count} models listed` : test.error}</div>}
      {error && <div className="error" data-testid="provider-error">{error}</div>}
    </div>
  )
}
