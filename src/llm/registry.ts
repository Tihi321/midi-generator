import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AnthropicClient } from './anthropic'
import { modelsSchema, providersSchema, rolesSchema } from './config'
import type { ModelsConfig, ProviderEntry, RolesConfig } from './config'
import { GeminiClient } from './gemini'
import { resolveKey } from './keys'
import type { KeyResolver } from './keys'
import { parseMdWith } from './md'
import { MockProvider } from './mock'
import { OpenAiCompatClient } from './openaiCompat'
import type { ListedModel } from './openaiCompat'
import { computeCost } from './pricing'
import type { ProviderClient } from './types'

export { computeCost } from './pricing'

export interface ProviderInfo {
  id: string
  /** Label for the UI (`name` of providers.md), the id when missing. */
  name: string
  /** Added in the UI (`custom: true`). */
  custom: boolean
  kind: ProviderEntry['kind']
  enabled: boolean
  local: boolean
  baseUrl?: string
  apiKeyEnv?: string
  concurrency: number
  /** `concurrency: auto`: `concurrency` follows the server's own slot count (see `syncServerSlots`). */
  concurrencyAuto: boolean
  /** The context window the server says it runs with (Strata's `/status`), from the last `syncServerSlots`. */
  serverContext?: number
  rpm?: number
  /** `true`: the list is what the server has. `free`: the server's price-0 models are added, nothing is dropped. */
  discover: boolean | 'free'
  /** `discover` leaves out ids containing one of these words (any case). */
  discoverSkip: string[]
  /** Send the JSON schema as `response_format` (`openai-compat`). */
  jsonSchema: boolean
  /** LM Studio: the registry loads a model that isn't loaded yet. */
  loadModels: boolean
  /** Enabled and (local, mock or has a key). */
  available: boolean
  unavailableReason?: string
  client?: ProviderClient
}

export interface ModelInfo {
  /** `provider/model`. */
  ref: string
  provider: ProviderInfo
  id: string
  family: string
  context?: number
  maxOutput?: number
  /** USD per 1M tokens (display only). */
  priceIn: number
  priceOut: number
  priceCachedIn: number
  /** Native tool calling. */
  tools: boolean
  /** Accepts images. */
  vision: boolean
  extraBody: Record<string, unknown> | null
  discovered: boolean
  /** Where it comes from: providers.md, a provider's `discover`, or config/models.md `picked`. */
  source: 'config' | 'discovered' | 'picked'
  /** In the chat's model dropdown: only a ticked model: in `shown` of models.md (providers.md and discovered models), or picked (always). */
  shown: boolean
  /** LM Studio: this model's own load settings (`load_context`, `load_parallel`), over the provider defaults. */
  loadContext?: number
  loadParallel?: number
}

export interface RegistryOptions {
  keys?: KeyResolver
  fetchImpl?: typeof fetch
  /** Reuse a mock provider so tests can script it. */
  mock?: MockProvider
  /** LM Studio's `lms` command line, used to load models. Default: `~/.lmstudio/bin/lms(.exe)` when it exists. `null`: use the REST API. */
  lmsPath?: string | null
}

export interface LmLoadSettings {
  parallel: number
  context: number
  ttlMinutes: number
}

/** The default config folder: `~/ChiptuneStudio/config` (or `$CHIPTUNE_STUDIO_HOME/config` when that variable is set). */
export function defaultConfigDir(): string {
  const override = process.env['CHIPTUNE_STUDIO_HOME']?.trim()
  return path.join(override ? path.resolve(override) : path.join(os.homedir(), 'ChiptuneStudio'), 'config')
}

export const CONFIG_FILES = ['providers.md', 'roles.md', 'models.md'] as const

/** Creates `configDir` and copies the seed config files that are missing there. Existing files are never overwritten. Returns the files it wrote. */
export async function ensureConfigDir(configDir: string, seedDir?: string): Promise<string[]> {
  await fs.mkdir(configDir, { recursive: true })
  const written: string[] = []
  for (const name of CONFIG_FILES) {
    const dest = path.join(configDir, name)
    if (existsSync(dest)) continue
    if (!seedDir) throw new Error(`${dest} is missing and no seed config folder was given`)
    await fs.copyFile(path.join(seedDir, name), dest)
    written.push(name)
  }
  return written
}

function defaultLmsPath(): string | undefined {
  const p = path.join(os.homedir(), '.lmstudio', 'bin', process.platform === 'win32' ? 'lms.exe' : 'lms')
  return existsSync(p) ? p : undefined
}

/** A model that costs money: not local and with a price. */
export function isPaidModel(m: ModelInfo): boolean {
  return !m.provider.local && (m.priceIn > 0 || m.priceOut > 0 || m.priceCachedIn > 0)
}

export class ModelRegistry {
  providers = new Map<string, ProviderInfo>()
  models = new Map<string, ModelInfo>()
  roles: RolesConfig = { kind: 'roles', aliases: {}, roles: {} }
  readonly mock: MockProvider
  /** The slot counts servers reported for `concurrency: auto` providers, kept across config reloads. */
  private serverSlots = new Map<string, number>()
  private lmLoad: LmLoadSettings = { parallel: 1, context: 32768, ttlMinutes: 60 }
  /** The models providers.md lists, kept so a model that shows up on its server later gets its settings back. */
  private configured = new Map<string, ModelInfo>()
  /** Per `discover` provider: the model ids its server reported at the last discovery that answered. Its list is only these. */
  private installed = new Map<string, Set<string>>()
  /** The context windows servers reported (see `syncServerSlots`), kept across config reloads. */
  private serverContexts = new Map<string, number>()
  /** The context size from the app's settings: LM Studio loads every model with it, over providers.md. */
  private contextOverride: number | null = null
  /** config/models.md: the ticked and unticked models (empty when the file doesn't exist). */
  private choices: ModelsConfig = { kind: 'models', shown: [], hidden: [], picked: [] }
  /** What `catalog` listed per provider, so a later pick knows the price and context. */
  private catalogs = new Map<string, ListedModel[]>()

  /** `configDir` holds providers.md and roles.md (see `ensureConfigDir`). */
  constructor(
    readonly configDir: string,
    private readonly opts: RegistryOptions = {}
  ) {
    this.mock = opts.mock ?? new MockProvider('mock')
  }

  /** (Re)reads providers.md, roles.md and models.md (optional). Throws, and keeps the previous state, if a file is invalid. */
  async load(): Promise<void> {
    const provFile = path.join(this.configDir, 'providers.md')
    const rolesFile = path.join(this.configDir, 'roles.md')
    const prov = parseMdWith(await fs.readFile(provFile, 'utf8'), providersSchema, provFile)
    const roles = parseMdWith(await fs.readFile(rolesFile, 'utf8'), rolesSchema, rolesFile)
    const modelsFile = path.join(this.configDir, 'models.md')
    // a missing models.md means no choices: old config folders keep working
    const choices: ModelsConfig = existsSync(modelsFile)
      ? parseMdWith(await fs.readFile(modelsFile, 'utf8'), modelsSchema, modelsFile).data
      : { kind: 'models', shown: [], hidden: [], picked: [] }
    const shown = new Set(choices.shown)
    const keys = this.opts.keys ?? resolveKey
    const discoveredBefore = [...this.models.values()].filter((m) => m.discovered)
    this.lmLoad = { parallel: prov.data.lmstudio_parallel, context: prov.data.lmstudio_context, ttlMinutes: prov.data.lmstudio_ttl_minutes }

    const providers = new Map<string, ProviderInfo>()
    const models = new Map<string, ModelInfo>()
    for (const p of prov.data.providers) {
      const info: ProviderInfo = {
        id: p.id,
        name: p.name ?? p.id,
        custom: p.custom,
        kind: p.kind,
        enabled: p.enabled,
        local: p.local,
        baseUrl: p.base_url,
        apiKeyEnv: p.api_key_env,
        concurrency: p.concurrency === 'auto' ? (this.serverSlots.get(p.id) ?? 1) : p.concurrency,
        concurrencyAuto: p.concurrency === 'auto',
        serverContext: this.serverContexts.get(p.id),
        rpm: p.rpm,
        discover: p.discover,
        discoverSkip: p.discover_skip,
        jsonSchema: p.json_schema,
        loadModels: p.load_models,
        available: false
      }
      this.setupClient(info, keys)
      providers.set(p.id, info)
      for (const m of p.models) {
        const ref = `${p.id}/${m.id}`
        models.set(ref, {
          ref,
          provider: info,
          id: m.id,
          family: m.family,
          // a model the registry loads itself gets the context window it loads it with
          context: p.load_models ? Math.min(m.context ?? Infinity, this.contextOverride ?? m.load_context ?? this.lmLoad.context) : m.context,
          loadContext: m.load_context,
          loadParallel: m.load_parallel,
          maxOutput: m.max_output,
          priceIn: m.price_in,
          priceOut: m.price_out,
          priceCachedIn: m.price_cached_in ?? m.price_in,
          tools: m.tools ?? !p.local,
          vision: m.vision,
          extraBody: m.extra_body ?? null,
          discovered: false,
          source: 'config',
          shown: shown.has(ref)
        })
      }
    }
    // models picked in the Models settings; providers.md wins when it lists the model too
    for (const m of choices.picked) {
      const info = providers.get(m.provider)
      const ref = `${m.provider}/${m.id}`
      if (!info || models.has(ref)) continue
      models.set(ref, {
        ref,
        provider: info,
        id: m.id,
        family: m.family,
        context: m.context,
        maxOutput: m.max_output,
        priceIn: info.local ? 0 : m.price_in,
        priceOut: info.local ? 0 : m.price_out,
        priceCachedIn: info.local ? 0 : (m.price_cached_in ?? m.price_in),
        tools: m.tools ?? !info.local,
        vision: m.vision,
        extraBody: m.extra_body ?? null,
        discovered: false,
        source: 'picked',
        shown: true
      })
    }
    this.choices = choices
    this.providers = providers
    this.models = models
    this.configured = new Map(models)
    this.roles = roles.data
    // Keep what discovery found earlier, so a config reload does not forget it.
    for (const d of discoveredBefore) {
      const prov = this.providers.get(d.provider.id)
      if (prov && !this.models.has(d.ref)) this.models.set(d.ref, { ...d, provider: prov, shown: shown.has(d.ref) })
    }
    for (const p of this.providers.values()) this.dropMissing(p)
  }

  /** A `discover` provider lists only the models its server reported last time (none of the configured ones it doesn't have). */
  private dropMissing(p: ProviderInfo): void {
    const ids = p.discover === true ? this.installed.get(p.id) : undefined
    if (!ids) return
    for (const [ref, m] of this.models) if (m.provider === p && !ids.has(m.id)) this.models.delete(ref)
  }

  private setupClient(info: ProviderInfo, keys: KeyResolver): void {
    if (!info.enabled) {
      info.unavailableReason = 'disabled in config/providers.md'
      return
    }
    if (info.kind === 'mock') {
      info.client = this.mock
      info.available = true
      return
    }
    let apiKey: string | undefined
    if (info.apiKeyEnv) {
      apiKey = keys(info.apiKeyEnv)
      if (!apiKey && !info.local) {
        info.unavailableReason = `no key (set ${info.apiKeyEnv} or enter it in Settings)`
        return
      }
    }
    const fetchImpl = this.opts.fetchImpl
    if (info.kind === 'openai-compat') {
      if (!info.baseUrl) {
        info.unavailableReason = 'no base_url'
        return
      }
      info.client = new OpenAiCompatClient({
        id: info.id,
        baseUrl: info.baseUrl,
        apiKey,
        fetchImpl,
        extraHeaders: isOpenRouter(info.baseUrl) ? OPENROUTER_HEADERS : undefined,
        jsonSchema: info.jsonSchema,
        loadConfig: info.loadModels ? (model) => this.loadConfigFor(info.id, model) : undefined,
        lmsPath: info.loadModels ? (this.opts.lmsPath === null ? undefined : (this.opts.lmsPath ?? defaultLmsPath())) : undefined
      })
    } else if (info.kind === 'anthropic') {
      info.client = new AnthropicClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    } else if (info.kind === 'gemini') {
      info.client = new GeminiClient({ id: info.id, baseUrl: info.baseUrl, apiKey: apiKey ?? '', fetchImpl })
    }
    info.available = true
  }

  /**
   * Asks every provider with `discover` set which models it has.
   * `discover: true` (LM Studio, Ollama): the provider's list is exactly its installed models, with the settings providers.md gives them,
   * and the unknown ones with the family guessed from the id. Configured models the server doesn't have are left out, and so are embedding
   * and draft models. LM Studio also reports tool and vision support.
   * `discover: free` (OpenRouter): adds the text models listed at price 0, with their context, tools and vision; nothing is dropped.
   * Discovered models only reach the chat's dropdown once ticked (`shown`).
   */
  async discover(signal?: AbortSignal): Promise<{ provider: string; found: number; error?: string }[]> {
    const out: { provider: string; found: number; error?: string }[] = []
    const shown = new Set(this.choices.shown)
    for (const p of this.providers.values()) {
      if (!p.discover || !p.available || !(p.client instanceof OpenAiCompatClient)) continue
      try {
        const listed = await p.client.listModelInfo(signal)
        if (p.discover === 'free') {
          const found = new Set<string>()
          for (const m of listed) {
            if (!m.textOnly || /embed/i.test(m.id) || skipsDiscovered(p, m.id) || !m.price || m.price.in !== 0 || m.price.out !== 0) continue
            const ref = `${p.id}/${m.id}`
            found.add(ref)
            if (this.models.has(ref)) continue
            const known = this.configured.get(ref)
            this.models.set(
              ref,
              known
                ? { ...known, provider: p }
                : {
                    ref,
                    provider: p,
                    id: m.id,
                    family: guessFamily(m.id),
                    context: m.context,
                    maxOutput: m.maxOutput,
                    priceIn: 0,
                    priceOut: 0,
                    priceCachedIn: 0,
                    tools: m.tools ?? !p.local,
                    vision: m.vision ?? false,
                    extraBody: null,
                    discovered: true,
                    source: 'discovered',
                    shown: shown.has(ref)
                  }
            )
          }
          // a free model OpenRouter no longer lists goes too
          for (const [ref, m] of this.models) if (m.provider === p && m.source === 'discovered' && !found.has(ref)) this.models.delete(ref)
          out.push({ provider: p.id, found: found.size })
          continue
        }
        const info = await p.client.localModelInfo(signal)
        const byId = new Map(listed.map((m) => [m.id, m]))
        // LM Studio's own list has every downloaded model (`/v1/models` may list only the loaded ones) and marks the embedding and draft ones
        const ids = [...new Set([...byId.keys(), ...info.keys()])].filter((id) => (info.get(id)?.chat ?? !/embed/i.test(id)) && !skipsDiscovered(p, id))
        this.installed.set(p.id, new Set(ids))
        this.dropMissing(p)
        for (const id of ids) {
          const ref = `${p.id}/${id}`
          if (this.models.has(ref)) continue
          const known = this.configured.get(ref)
          if (known) {
            this.models.set(ref, { ...known, provider: p })
            continue
          }
          const li = info.get(id)
          const lm = byId.get(id)
          this.models.set(ref, {
            ref,
            provider: p,
            id,
            family: guessFamily(id),
            context: lm?.context,
            priceIn: 0,
            priceOut: 0,
            priceCachedIn: 0,
            tools: li?.tools ?? lm?.tools ?? !p.local,
            vision: li?.vision ?? lm?.vision ?? false,
            extraBody: null,
            discovered: true,
            source: 'discovered',
            shown: shown.has(ref)
          })
        }
        // the context the model is loaded with, unless providers.md says otherwise (a model already loaded counts as it is)
        for (const [id, li] of info) {
          const m = this.models.get(`${p.id}/${id}`)
          if (m && li.loadedContext && (m.context === undefined || p.loadModels)) m.context = li.loadedContext
        }
        out.push({ provider: p.id, found: ids.length })
      } catch (err) {
        out.push({ provider: p.id, found: 0, error: (err as Error).message })
      }
    }
    return out
  }

  /**
   * Every chat model an openai-compat provider lists (`GET /models`), whether it is in the dropdown or not, for Settings > Models.
   * Text-only, no embedding models, no `discover_skip` ones. The list is kept, so picking one later knows its price and context.
   */
  async catalog(providerId: string, signal?: AbortSignal): Promise<ListedModel[]> {
    const p = this.providers.get(providerId)
    if (!p) throw new Error(`no provider "${providerId}"`)
    if (!p.available) throw new Error(p.unavailableReason ?? 'not available')
    if (!(p.client instanceof OpenAiCompatClient)) throw new Error(`a ${p.kind} provider can't list its models: add them to providers.md`)
    const listed = (await p.client.listModelInfo(signal)).filter((m) => m.textOnly && !/embed/i.test(m.id) && !skipsDiscovered(p, m.id))
    this.catalogs.set(providerId, listed)
    return listed
  }

  /** What `catalog` listed for a provider last time. */
  listedModels(providerId: string): ListedModel[] {
    return this.catalogs.get(providerId) ?? []
  }

  /**
   * Asks every `concurrency: auto` provider how many requests it serves at once and sets its `concurrency`:
   * Strata reports it as `concurrency.serving` of `GET <base_url>/status`; for LM Studio it is the sum of `parallel`
   * over the loaded chat models (`GET /api/v1/models`). A server that can't be asked counts as 1.
   * Returns the providers whose concurrency changed.
   */
  async syncServerSlots(signal?: AbortSignal): Promise<{ provider: ProviderInfo; from: number; to: number }[]> {
    const changed: { provider: ProviderInfo; from: number; to: number }[] = []
    for (const p of this.providers.values()) {
      if (!p.concurrencyAuto || !p.available || !p.baseUrl) continue
      const base = p.baseUrl.replace(/\/+$/, '')
      const get = async (url: string) => {
        const res = await (this.opts.fetchImpl ?? fetch)(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000) })
        return res.ok ? ((await res.json()) as Record<string, unknown>) : null
      }
      let slots = 1
      let context: number | undefined
      try {
        const status = await get(`${base}/status`).catch(() => null)
        const n = Number((status?.concurrency as { serving?: unknown } | undefined)?.serving)
        if (Number.isInteger(n) && n >= 1) slots = Math.min(n, 16)
        const ctx = Number((status?.context as { native?: unknown } | undefined)?.native)
        if (Number.isInteger(ctx) && ctx > 0) context = ctx
        else {
          // LM Studio: its native API sits next to the OpenAI-compatible /v1
          const lm = await get(`${base.replace(/\/v1$/, '')}/api/v1/models`)
          const models = (lm?.models ?? []) as { type?: string; loaded_instances?: { config?: { parallel?: unknown } }[] }[]
          let sum = 0
          for (const m of models) {
            if (m.type !== 'llm') continue
            for (const i of m.loaded_instances ?? []) {
              const par = Number(i.config?.parallel)
              sum += Number.isInteger(par) && par >= 1 ? par : 1
            }
          }
          if (sum >= 1) slots = Math.min(sum, 16)
        }
      } catch {
        /* the server is down or restarting: one at a time until it answers */
      }
      this.serverSlots.set(p.id, slots)
      if (context) this.serverContexts.set(p.id, context)
      else this.serverContexts.delete(p.id)
      p.serverContext = context
      if (p.concurrency !== slots) {
        changed.push({ provider: p, from: p.concurrency, to: slots })
        p.concurrency = slots
      }
    }
    return changed
  }

  getModel(ref: string): ModelInfo | undefined {
    return this.models.get(this.resolve(ref))
  }

  /** The chat models (all models here: there are no embedding models), available ones first. */
  listModels(): ModelInfo[] {
    return [...this.models.values()].sort((a, b) => Number(b.provider.available) - Number(a.provider.available))
  }

  /** How a `load_models` provider loads `model`: the provider defaults, with the model's own `load_context` / `load_parallel` over them. */
  /** The context LM Studio loads models with: the app's setting, else (null) providers.md decides. */
  setContextSize(tokens: number | null): void {
    this.contextOverride = tokens
  }

  /** The context LM Studio loads models with when nothing overrides it per model. */
  get lmContext(): { effective: number; fromConfig: number } {
    return { effective: this.contextOverride ?? this.lmLoad.context, fromConfig: this.lmLoad.context }
  }

  loadConfigFor(provider: string, model: string): LmLoadSettings {
    const m = this.models.get(`${provider}/${model}`)
    return { parallel: m?.loadParallel ?? this.lmLoad.parallel, context: this.contextOverride ?? m?.loadContext ?? this.lmLoad.context, ttlMinutes: this.lmLoad.ttlMinutes }
  }

  /** A `provider/model`, or an alias from roles.md resolved to its model. */
  resolve(ref: string): string {
    return this.roles.aliases[ref] ?? ref
  }

  /** Model refs in the roles file for a role, in order, with aliases resolved. */
  roleModelRefs(role: string): string[] {
    return (this.roles.roles[role]?.models ?? []).map((r) => this.resolve(r))
  }
}

/** A model the server lists but `discover_skip` keeps out (a word of it is in the id, any case). */
function skipsDiscovered(p: ProviderInfo, id: string): boolean {
  const s = id.toLowerCase()
  return p.discoverSkip.some((w) => w && s.includes(w.toLowerCase()))
}

function isOpenRouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith('openrouter.ai')
  } catch {
    return false
  }
}

/** OpenRouter's app attribution. */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://github.com/Tihi321/midi-generator', 'X-Title': 'Chiptune Studio' }

export function guessFamily(id: string): string {
  const s = id.toLowerCase()
  for (const f of ['qwen', 'nemotron', 'deepseek', 'llama', 'mistral', 'gemma', 'glm', 'kimi', 'claude', 'gemini', 'gpt']) {
    if (s.includes(f)) return f
  }
  // OpenRouter ids start with the maker (`thinkingmachines/inkling:free`): the closest thing to a family
  return s.includes('/') ? s.slice(0, s.indexOf('/')) : 'unknown'
}

/** Cost of a usage on a model in USD, 0 for local models. For display. */
export function costOf(m: ModelInfo, usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number }): number {
  return isPaidModel(m) ? computeCost(m, usage) : 0
}
