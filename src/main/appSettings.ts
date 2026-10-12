// App-level settings that are not provider config: `~/ChiptuneStudio/config/app.json`.
// Today: the model chosen for the chat and the context size. Unknown keys are kept, a broken file reads as defaults.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface AppSettings {
  /** `provider/model` the chat uses; null for the role's first available model. */
  selectedModel: string | null
  /** Context window (tokens) LM Studio loads models with; null: `lmstudio_context` / `load_context` in providers.md. */
  contextSize: number | null
}

export const APP_SETTINGS_FILE = 'app.json'

export const CONTEXT_SIZE_MIN = 2048
export const CONTEXT_SIZE_MAX = 1_048_576

const DEFAULTS: AppSettings = { selectedModel: null, contextSize: null }

export async function readAppSettings(configDir: string): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await readFile(join(configDir, APP_SETTINGS_FILE), 'utf8')) as Record<string, unknown>
    const ctx = raw.contextSize
    return {
      ...DEFAULTS,
      selectedModel: typeof raw.selectedModel === 'string' && raw.selectedModel ? raw.selectedModel : null,
      contextSize: typeof ctx === 'number' && Number.isInteger(ctx) && ctx >= CONTEXT_SIZE_MIN && ctx <= CONTEXT_SIZE_MAX ? ctx : null
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export async function writeAppSettings(configDir: string, patch: Partial<AppSettings>): Promise<AppSettings> {
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(await readFile(join(configDir, APP_SETTINGS_FILE), 'utf8')) as Record<string, unknown>
  } catch {
    /* new or unreadable file */
  }
  const next = { ...existing, ...patch }
  await mkdir(configDir, { recursive: true })
  await writeFile(join(configDir, APP_SETTINGS_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return readAppSettings(configDir)
}
