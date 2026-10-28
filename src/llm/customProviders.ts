import { promises as fs } from 'node:fs'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { YAMLMap, YAMLSeq } from 'yaml'
import { providersSchema } from './config'
import { splitFrontmatter } from './md'
import { withFileLock } from './fileLock'

/** Custom OpenAI-compatible providers in config/providers.md (MDI-07). Pure file logic, no Electron. Same shape as Scriptorium SCP-44. */

/** Ids a custom provider may never take: seed providers and the names the role lists use. */
export const RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  'acp', 'anthropic', 'gemini', 'openai', 'openrouter', 'deepseek', 'lmstudio', 'strata', 'ollama', 'mock', 'claude', 'local', 'paid', 'search', 'client'
])

export interface CustomProviderInput {
  /** Set to edit that entry; missing creates a new one. */
  id?: string
  name: string
  baseUrl: string
  /** Free / local: no key needed, no prices. */
  free: boolean
  jsonSchema: boolean
  concurrency: number | 'auto'
  discover: boolean
  enabled: boolean
  /** A key is given (stored by the caller): the entry gets `api_key_env: CUSTOM_<ID>_API_KEY` when it has none. */
  withKey?: boolean
  /** Model ids to list in the entry (the whole list is replaced). Undefined keeps the entry's models. */
  models?: string[]
}

export function customKeyName(id: string): string {
  return `CUSTOM_${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** The id a name gives, or '' when the name has no letters or digits. */
export function customProviderSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
}

/** Throws with a message for the form when the address is not an http(s) URL. */
export function checkBaseUrl(raw: string): string {
  const text = raw.trim()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error('the base URL is not a valid address')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('the base URL must start with http:// or https://')
  return text.replace(/\/+$/, '')
}

interface Parsed {
  doc: ReturnType<typeof parseDocument>
  body: string
  crlf: boolean
  list: YAMLSeq
}

async function readProviders(file: string): Promise<Parsed> {
  const text = await fs.readFile(file, 'utf8')
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) throw new Error('providers.md has no frontmatter')
  const doc = parseDocument(frontmatter)
  const list = doc.get('providers')
  if (!isSeq(list)) throw new Error('providers.md has no providers list')
  return { doc, body, crlf: text.includes('\r\n'), list }
}

function entryOf(list: YAMLSeq, id: string): YAMLMap | undefined {
  for (const item of list.items) if (isMap(item) && item.get('id') === id) return item
  return undefined
}

async function writeProviders(file: string, p: Parsed): Promise<void> {
  const check = providersSchema.safeParse(p.doc.toJS())
  if (!check.success) throw new Error(`providers.md would be invalid: ${check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
  let next = `---\n${p.doc.toString({ lineWidth: 0 })}---\n${p.body}`
  if (p.crlf) next = next.replace(/\r?\n/g, '\r\n')
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, next, 'utf8')
  await fs.rename(tmp, file)
}

/** The ids given, keeping the settings of models the entry already has. */
function mergeModels(entry: YAMLMap | undefined, ids: string[] | undefined): unknown[] {
  const old = new Map<string, unknown>()
  const cur = entry?.get('models')
  if (isSeq(cur)) for (const m of cur.items) if (isMap(m)) old.set(String(m.get('id')), m.toJSON())
  return [...new Set((ids ?? []).map((i) => i.trim()).filter(Boolean))].map((id) => old.get(id) ?? { id, family: 'unknown' })
}

/**
 * Adds a custom entry (`custom: true`) to providers.md, or edits the one named by `input.id`. Only that entry changes: comments and hand
 * edits of the rest of the file stay (a `yaml` document round trip). Returns the id and key name of the entry.
 */
export function saveCustomEntry(file: string, input: CustomProviderInput): Promise<{ id: string; apiKeyEnv: string; created: boolean }> {
  return withFileLock(file, () => saveCustomEntryImpl(file, input))
}

async function saveCustomEntryImpl(file: string, input: CustomProviderInput): Promise<{ id: string; apiKeyEnv: string; created: boolean }> {
  const name = input.name.trim()
  if (!name) throw new Error('the provider needs a name')
  const baseUrl = checkBaseUrl(input.baseUrl)
  if (input.concurrency !== 'auto' && (!Number.isInteger(input.concurrency) || input.concurrency < 1)) throw new Error('parallel must be a whole number of at least 1, or auto')
  const p = await readProviders(file)
  if (input.id) {
    const entry = entryOf(p.list, input.id)
    if (!entry) throw new Error(`no provider "${input.id}"`)
    if (entry.get('custom') !== true) throw new Error(`"${input.id}" is not a custom provider: edit it in config/providers.md`)
    const apiKeyEnv = (entry.get('api_key_env') as string | undefined) ?? customKeyName(input.id)
    entry.set('name', name)
    entry.set('enabled', input.enabled)
    entry.set('base_url', baseUrl)
    entry.set('local', input.free)
    entry.set('json_schema', input.jsonSchema)
    entry.set('concurrency', input.concurrency)
    entry.set('discover', input.discover)
    if (input.models) entry.set('models', p.doc.createNode(mergeModels(entry, input.models)))
    if (input.withKey && !entry.get('api_key_env')) entry.set('api_key_env', apiKeyEnv)
    await writeProviders(file, p)
    return { id: input.id, apiKeyEnv, created: false }
  }
  const id = customProviderSlug(name)
  if (!id) throw new Error('the name needs letters or digits')
  const taken = new Set<string>()
  for (const item of p.list.items) if (isMap(item)) taken.add(String(item.get('id')))
  if (RESERVED_PROVIDER_IDS.has(id)) throw new Error(`"${id}" is a reserved provider id: choose another name`)
  if (taken.has(id)) throw new Error(`a provider "${id}" exists already: choose another name`)
  const apiKeyEnv = customKeyName(id)
  p.list.add(
    p.doc.createNode({
      id,
      name,
      custom: true,
      kind: 'openai-compat',
      enabled: input.enabled,
      base_url: baseUrl,
      ...(input.withKey ? { api_key_env: apiKeyEnv } : {}),
      local: input.free,
      json_schema: input.jsonSchema,
      concurrency: input.concurrency,
      discover: input.discover,
      models: mergeModels(undefined, input.models)
    })
  )
  await writeProviders(file, p)
  return { id, apiKeyEnv, created: true }
}

/** Removes a custom entry from providers.md. Returns its key name, or throws when it isn't a custom provider. */
export function removeCustomEntry(file: string, id: string): Promise<{ apiKeyEnv: string }> {
  return withFileLock(file, () => removeCustomEntryImpl(file, id))
}

async function removeCustomEntryImpl(file: string, id: string): Promise<{ apiKeyEnv: string }> {
  const p = await readProviders(file)
  const entry = entryOf(p.list, id)
  if (!entry) throw new Error(`no provider "${id}"`)
  if (entry.get('custom') !== true) throw new Error(`"${id}" is not a custom provider: remove it in config/providers.md`)
  const apiKeyEnv = (entry.get('api_key_env') as string | undefined) ?? customKeyName(id)
  p.list.items = p.list.items.filter((i) => i !== entry)
  await writeProviders(file, p)
  return { apiKeyEnv }
}

/** Switches any provider (seed ones such as `acp` too) on or off. Only `enabled` changes. */
export function setEntryEnabled(file: string, id: string, enabled: boolean): Promise<void> {
  return withFileLock(file, () => setEntryEnabledImpl(file, id, enabled))
}

async function setEntryEnabledImpl(file: string, id: string, enabled: boolean): Promise<void> {
  const p = await readProviders(file)
  const entry = entryOf(p.list, id)
  if (!entry) throw new Error(`no provider "${id}"`)
  entry.set('enabled', enabled)
  await writeProviders(file, p)
}
