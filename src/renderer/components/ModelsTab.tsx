import { useMemo, useState } from 'react'
import type { LlmModelInfo, LlmProviderInfo } from '../../shared/agent'
import { useChat } from '../state/chat'
import { Badges } from './Badges'

interface Row {
  ref: string
  id: string
  context?: number
  priceIn?: number
  priceOut?: number
  tools: boolean
  vision: boolean
  /** In the chat's dropdown now. */
  shown: boolean
  source: LlmModelInfo['source'] | 'listed'
  /** It can be ticked: known, local, or listed with a price. */
  pickable: boolean
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A short word for why a provider can't be used. */
function shortReason(p: LlmProviderInfo): string {
  if (!p.enabled) return 'off'
  if (p.unavailableReason?.startsWith('no key')) return 'no key'
  return 'unavailable'
}

function formatContext(n?: number): string {
  if (!n) return ''
  return n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`
}

function formatPrice(r: Row, local: boolean): string {
  if (local) return 'local'
  if (r.priceIn === undefined || r.priceOut === undefined) return 'no price'
  if (r.priceIn === 0 && r.priceOut === 0) return 'free'
  const f = (x: number): string => `$${+x.toPrecision(3)}`
  return `${f(r.priceIn)} / ${f(r.priceOut)}`
}

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v))

/** Settings > Models: tick which models the chat dropdown offers (saved in config/models.md), detect a provider's models, add one by id. */
export function ModelsTab() {
  const overview = useChat((s) => s.overview)
  const catalogs = useChat((s) => s.catalogs)
  const [provider, setProvider] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [freeOnly, setFreeOnly] = useState(false)
  const [shownOnly, setShownOnly] = useState(false)
  const [add, setAdd] = useState({ id: '', priceIn: '', priceOut: '', context: '' })
  const [addError, setAddError] = useState('')

  const providers = useMemo(() => (overview?.providers ?? []).filter((p) => p.kind !== 'mock'), [overview])
  const models = overview?.models
  const current = providers.find((p) => p.id === provider) ?? providers.find((p) => p.available) ?? providers[0]
  const catalog = current ? catalogs[current.id] : undefined
  const local = !!current?.local

  const rows = useMemo<Row[]>(() => {
    if (!current) return []
    const out = new Map<string, Row>()
    for (const m of models ?? []) {
      if (m.provider !== current.id) continue
      out.set(m.ref, { ref: m.ref, id: m.id, context: m.context, priceIn: m.priceIn, priceOut: m.priceOut, tools: m.tools, vision: m.vision, shown: m.shown, source: m.source, pickable: true })
    }
    for (const c of catalog?.models ?? []) {
      const known = out.get(c.ref)
      if (known) out.set(c.ref, { ...known, context: known.context ?? c.context })
      else out.set(c.ref, { ref: c.ref, id: c.id, context: c.context, priceIn: c.priceIn, priceOut: c.priceOut, tools: !!c.tools, vision: !!c.vision, shown: false, source: 'listed', pickable: c.pickable })
    }
    return [...out.values()].sort((a, b) => a.id.localeCompare(b.id))
  }, [current, models, catalog])

  if (!overview) return <div className="settings-tab" data-testid="settings-models"><div className="hint">Loading providers...</div></div>
  const chat = useChat.getState()
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const visible = rows.filter(
    (r) => words.every((w) => r.id.toLowerCase().includes(w)) && (!freeOnly || local || (r.priceIn === 0 && r.priceOut === 0)) && (!shownOnly || r.shown)
  )
  const toShow = visible.filter((r) => !r.shown && r.pickable).map((r) => r.ref)
  const toHide = visible.filter((r) => r.shown).map((r) => r.ref)

  const priceOk = (v: string): boolean => num(v) !== undefined && num(v)! >= 0
  const canAdd = !!current && add.id.trim() !== '' && (local || (priceOk(add.priceIn) && priceOk(add.priceOut)))
  const addModel = (): void => {
    if (!current || !canAdd) return
    setAddError('')
    chat
      .addModel({ provider: current.id, id: add.id.trim(), priceIn: num(add.priceIn), priceOut: num(add.priceOut), context: num(add.context) })
      .then(() => setAdd({ id: '', priceIn: '', priceOut: '', context: '' }))
      .catch((e) => setAddError(msg(e)))
  }

  const status = !current
    ? ''
    : !current.available
      ? current.unavailableReason?.startsWith('no key')
        ? 'No key: store it in the Providers tab'
        : (current.unavailableReason ?? 'not available')
      : !current.canList
        ? "Can't list its models: add them by id below"
        : catalog?.error
          ? `Could not list: ${catalog.error}`
          : catalog && !catalog.loading
            ? `${catalog.models.length} listed, ${rows.filter((r) => r.shown).length} ticked`
            : 'Detect models lists everything it has'

  return (
    <div className="settings-tab" data-testid="settings-models">
      <div className="hint">Tick the models the chat's model list offers. Saved in config/models.md.</div>
      <div className="models-body">
        <div className="models-providers">
          {providers.map((p) => (
            <button
              key={p.id}
              className={p.id === current?.id ? 'primary' : ''}
              onClick={() => setProvider(p.id)}
              title={p.available ? undefined : p.unavailableReason}
              data-testid={`models-provider-${p.id}`}
            >
              <span>{p.id}</span>
              <span className="hint">{p.available ?`${(models ?? []).filter((m) => m.provider === p.id && m.shown).length} ticked` : shortReason(p)}</span>
            </button>
          ))}
        </div>
        {current ? (
          <div className="models-pane">
            <div className="row-buttons">
              <input type="text" value={filter} placeholder="Filter, e.g. qwen free" onChange={(e) => setFilter(e.target.value)} data-testid="models-filter" />
              {current.canList && (
                <button
                  disabled={!current.available || catalog?.loading}
                  onClick={() => void chat.detect(current.id)}
                  title={`Ask ${current.id} for every model it has`}
                  data-testid="models-detect"
                >
                  {catalog?.loading ? 'Detecting...' : 'Detect models'}
                </button>
              )}
            </div>
            <div className="row-buttons">
              {!local && (
                <label className="check">
                  <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} data-testid="models-free" />
                  free only
                </label>
              )}
              <label className="check">
                <input type="checkbox" checked={shownOnly} onChange={(e) => setShownOnly(e.target.checked)} data-testid="models-shown" />
                ticked only
              </label>
              <span className="spacer" />
              <button disabled={!toShow.length} onClick={() => void chat.showModels(toShow, true)} data-testid="models-tick-all">
                Tick all {toShow.length || ''}
              </button>
              <button disabled={!toHide.length} onClick={() => void chat.showModels(toHide, false)} data-testid="models-untick-all">
                Untick all {toHide.length || ''}
              </button>
            </div>
            <div className="hint" data-testid="models-status">{status}</div>
            <div className="models-list" data-testid="models-list">
              {visible.map((r) => (
                <label
                  key={r.ref}
                  className={`model-row${r.pickable ? '' : ' disabled'}`}
                  title={r.pickable ? r.ref : 'No listed price, so it cannot be ticked: add it by id below with its price'}
                  data-testid={`models-row-${r.ref}`}
                >
                  <input type="checkbox" checked={r.shown} disabled={!r.pickable} onChange={(e) => void chat.showModels([r.ref], e.target.checked)} />
                  <span className="model-id">{r.id}</span>
                  <span className="hint">{formatContext(r.context)}</span>
                  <span className={r.priceIn === 0 && r.priceOut === 0 && !local ? 'free' : 'hint'}>{formatPrice(r, local)}</span>
                  <Badges m={{ tools: r.tools, vision: r.vision, local }} compact />
                  <span className="hint">{r.source}</span>
                </label>
              ))}
              {!visible.length && <div className="hint" style={{ padding: 6 }}>{catalog?.loading ? 'Asking the provider...' : 'No models here.'}</div>}
            </div>
            {overview.error && <div className="error" data-testid="models-error">{overview.error}</div>}
            <div className="hint">Add a model by its id{local ? '' : ', with its price in USD per 1M tokens (0 and 0 for a free one)'}:</div>
            <div className="row-buttons">
              <input
                type="text"
                value={add.id}
                placeholder={current.id === 'openrouter' ? 'e.g. qwen/qwen3-235b-a22b:free' : 'model id'}
                onChange={(e) => setAdd({ ...add, id: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && addModel()}
                data-testid="models-add-id"
              />
              {!local && (
                <>
                  <input type="number" min={0} step="any" value={add.priceIn} placeholder="$ in" onChange={(e) => setAdd({ ...add, priceIn: e.target.value })} data-testid="models-add-in" />
                  <input type="number" min={0} step="any" value={add.priceOut} placeholder="$ out" onChange={(e) => setAdd({ ...add, priceOut: e.target.value })} data-testid="models-add-out" />
                </>
              )}
              <input type="number" min={0} value={add.context} placeholder="context" onChange={(e) => setAdd({ ...add, context: e.target.value })} data-testid="models-add-context" />
              <button disabled={!canAdd} onClick={addModel} data-testid="models-add">
                Add
              </button>
            </div>
            {addError && <div className="error" data-testid="models-add-error">{addError}</div>}
          </div>
        ) : (
          <div className="hint">No model providers in providers.md.</div>
        )}
      </div>
    </div>
  )
}
