// Main-process LLM service: lazily creates the registry/router from ~/ChiptuneStudio/config, answers the
// Settings dialog (providers, models, keys) and picks the model for a chat run. No Electron import.

import { join } from 'node:path'
import {
  createLlm,
  deleteStoredKey,
  getStoredKey,
  resolveKey,
  setStoredKey,
  type AgentModelSource,
  type KeyResolver,
  type ModelInfo,
  type ModelRegistry,
  type ModelRouter
} from '../llm'
import type { KeyStatus, LlmModelInfo, LlmOverview, LlmProviderInfo } from '../shared/agent'
import { CONTEXT_SIZE_MAX, CONTEXT_SIZE_MIN, readAppSettings, writeAppSettings } from './appSettings'
import { defaultRoot } from './services'

/** The role the chat agent uses in roles.md. */
export const AGENT_ROLE = 'composer'

export interface KeyOps {
  /** Environment variable first, then the credential store (what the registry uses). */
  resolve: KeyResolver
  getStored(name: string): string | undefined
  set(name: string, value: string): void
  delete(name: string): boolean
  /** Environment lookup (default `process.env`). */
  env(name: string): string | undefined
}

export const defaultKeyOps: KeyOps = {
  resolve: resolveKey,
  getStored: (n) => getStoredKey(n),
  set: (n, v) => setStoredKey(n, v),
  delete: (n) => deleteStoredKey(n),
  env: (n) => process.env[n]
}

export interface LlmServiceOptions {
  /** Default `~/ChiptuneStudio/config`. */
  configDir?: string
  /** Folder with the seed providers.md and roles.md. */
  seedDir: string
  keys?: KeyOps
  /** Ask local providers for their models while loading. Default true. */
  discover?: boolean
  /** Default `~/ChiptuneStudio`, shown read-only in Settings. */
  dataDir?: string
}

export interface ResolvedModel {
  source: AgentModelSource
  /** The chosen model can look at images (auto-preview is on). */
  vision: boolean
  /** `provider/model` that will answer first, when known. */
  ref?: string
}

interface Loaded {
  registry: ModelRegistry
  router: ModelRouter
  configDir: string
}

function modelInfo(m: ModelInfo): LlmModelInfo {
  const priced = m.priceIn > 0 || m.priceOut > 0
  return {
    ref: m.ref,
    provider: m.provider.id,
    id: m.id,
    label: m.id,
    tools: m.tools,
    vision: m.vision,
    local: m.provider.local,
    available: m.provider.available,
    ...(m.provider.unavailableReason ? { unavailableReason: m.provider.unavailableReason } : {}),
    ...(priced && !m.provider.local ? { priceIn: m.priceIn, priceOut: m.priceOut } : {})
  }
}

export class LlmService {
  private loading: Promise<Loaded> | null = null
  private refreshing: Promise<void> | null = null
  private readonly keys: KeyOps
  readonly configDir: string
  readonly dataDir: string

  constructor(private readonly opts: LlmServiceOptions) {
    this.keys = opts.keys ?? defaultKeyOps
    this.dataDir = opts.dataDir ?? defaultRoot()
    this.configDir = opts.configDir ?? join(this.dataDir, 'config')
  }

  /** Creates the registry on first use. A failure (invalid config) is not remembered: the next call tries again. */
  get(): Promise<Loaded> {
    if (!this.loading) {
      this.loading = createLlm({
        configDir: this.configDir,
        seedDir: this.opts.seedDir,
        keys: this.keys.resolve,
        discover: this.opts.discover
      })
        .then(async (l) => {
          l.registry.setContextSize((await readAppSettings(this.configDir)).contextSize)
          return l
        })
        .catch((err) => {
          this.loading = null
          throw err
        })
    }
    return this.loading
  }

  private keyStatus(env: string | undefined): KeyStatus {
    if (!env) return 'none'
    if (this.keys.env(env)) return 'env'
    return this.keys.getStored(env) ? 'stored' : 'none'
  }

  async overview(extraError?: string): Promise<LlmOverview> {
    const settings = await readAppSettings(this.configDir)
    const base = {
      configDir: this.configDir,
      dataDir: this.dataDir,
      selectedModel: settings.selectedModel,
      defaultModel: null as string | null,
      contextSize: settings.contextSize ?? 0,
      contextSizeSet: settings.contextSize !== null
    }
    let loaded: Loaded
    try {
      loaded = await this.get()
    } catch (err) {
      return { ...base, providers: [], models: [], error: err instanceof Error ? err.message : String(err) }
    }
    const { registry, router } = loaded
    const providers: LlmProviderInfo[] = [...registry.providers.values()].map((p) => ({
      id: p.id,
      kind: p.kind,
      enabled: p.enabled,
      local: p.local,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
      available: p.available,
      ...(p.unavailableReason ? { unavailableReason: p.unavailableReason } : {}),
      keyStatus: this.keyStatus(p.apiKeyEnv),
      models: [...registry.models.values()].filter((m) => m.provider.id === p.id).map((m) => m.ref),
      ...(p.serverContext ? { serverContext: p.serverContext } : {}),
      loadsModels: p.loadModels
    }))
    return {
      ...base,
      contextSize: registry.lmContext.effective,
      defaultModel: router.candidates(AGENT_ROLE)[0]?.ref ?? null,
      providers,
      models: registry.listModels().map(modelInfo),
      ...(extraError ? { error: extraError } : {})
    }
  }

  async setSelectedModel(ref: string | null): Promise<void> {
    await writeAppSettings(this.configDir, { selectedModel: ref })
  }

  /** Sets the context LM Studio loads models with (null: back to providers.md). A model loaded with less is loaded again on its next request. */
  async setContextSize(tokens: number | null): Promise<LlmOverview> {
    if (tokens !== null && !(Number.isInteger(tokens) && tokens >= CONTEXT_SIZE_MIN && tokens <= CONTEXT_SIZE_MAX)) {
      throw new Error(`The context size must be a whole number from ${CONTEXT_SIZE_MIN} to ${CONTEXT_SIZE_MAX}.`)
    }
    await writeAppSettings(this.configDir, { contextSize: tokens })
    const loaded = await this.get().catch(() => null)
    loaded?.registry.setContextSize(tokens)
    return this.overview()
  }

  async selectedModel(): Promise<string | null> {
    return (await readAppSettings(this.configDir)).selectedModel
  }

  private async apiKeyEnvOf(providerId: string): Promise<string> {
    const { registry } = await this.get()
    const env = registry.providers.get(providerId)?.apiKeyEnv
    if (!env) throw new Error(`Provider "${providerId}" has no api_key_env in providers.md, so it takes no key.`)
    return env
  }

  async setKey(providerId: string, key: string): Promise<LlmOverview> {
    const trimmed = key.trim()
    if (!trimmed) throw new Error('The key is empty.')
    this.keys.set(await this.apiKeyEnvOf(providerId), trimmed)
    return this.reload(false)
  }

  async deleteKey(providerId: string): Promise<LlmOverview> {
    this.keys.delete(await this.apiKeyEnvOf(providerId))
    return this.reload(false)
  }

  /** Re-reads providers.md / roles.md (the previous state stays when a file is invalid), and re-discovers local models. */
  async reload(discover = true): Promise<LlmOverview> {
    let error: string | undefined
    try {
      const { registry } = await this.get()
      await registry.load()
      if (discover && this.opts.discover !== false) {
        await registry.discover().catch(() => undefined)
        await registry.syncServerSlots().catch(() => undefined)
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    return this.overview(error)
  }

  /** Asks the local providers again which models they have, without re-reading the config files. The chat's model list calls this when it opens. */
  async refreshModels(): Promise<LlmOverview> {
    if (this.opts.discover !== false) {
      this.refreshing ??= this.get()
        .then(async ({ registry }) => {
          await registry.discover().catch(() => undefined)
          await registry.syncServerSlots().catch(() => undefined)
        })
        .catch(() => undefined) // overview() reports a config error
        .finally(() => {
          this.refreshing = null
        })
      await this.refreshing
    }
    return this.overview()
  }

  /** The model source for a run: `modelRef`, else the saved selection, else the role's list. */
  async resolveModel(modelRef?: string | null): Promise<ResolvedModel> {
    const { router } = await this.get()
    const ref = modelRef ?? (await this.selectedModel())
    const primary = router.candidates(AGENT_ROLE, { agentModel: ref })[0]
    return { source: { router, role: AGENT_ROLE, modelRef: ref }, vision: !!primary?.vision, ref: primary?.ref }
  }
}
