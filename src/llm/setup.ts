import { defaultConfigDir, ensureConfigDir, ModelRegistry } from './registry'
import type { RegistryOptions } from './registry'
import { ModelRouter } from './router'
import { migrateSeedProviders } from './seedMigrate'
import type { RouterOptions } from './router'

export interface CreateLlmOptions extends RegistryOptions {
  /** Where providers.md and roles.md live. Default `~/ChiptuneStudio/config`. */
  configDir?: string
  /** The folder with the seed providers.md and roles.md, copied into `configDir` for the files that are missing. */
  seedDir?: string
  router?: RouterOptions
  /** Ask providers with `discover: true` for their models, and sync `concurrency: auto` slots. Default true. Errors are ignored. */
  discover?: boolean
  signal?: AbortSignal
}

/**
 * Builds the registry and router from the config folder: seeds missing files, loads them, discovers models.
 * Call `registry.load()` again after the files change, and `registry.discover()` / `registry.syncServerSlots()` to refresh.
 */
export async function createLlm(opts: CreateLlmOptions = {}): Promise<{ registry: ModelRegistry; router: ModelRouter; configDir: string }> {
  const configDir = opts.configDir ?? defaultConfigDir()
  await ensureConfigDir(configDir, opts.seedDir)
  await migrateSeedProviders(configDir, opts.seedDir).catch(() => []) // a failed migration never blocks the start
  const registry = new ModelRegistry(configDir, opts)
  await registry.load()
  if (opts.discover !== false) {
    await registry.discover(opts.signal).catch(() => undefined)
    await registry.syncServerSlots(opts.signal).catch(() => undefined)
  }
  return { registry, router: new ModelRouter(registry, opts.router), configDir }
}
