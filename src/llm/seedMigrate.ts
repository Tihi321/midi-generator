import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import type { Document, Node, YAMLMap, YAMLSeq } from 'yaml'
import { providersSchema } from './config'
import { splitFrontmatter } from './md'
import { withFileLock } from './fileLock'

/**
 * Seed providers added after the first release. An existing config folder gets each one once: `config/seed-state.json` lists the seed
 * providers already offered, so one the user deleted is not added back and user edits are never overwritten (MDI-07, like BTT-21).
 * The seed entry is copied as text (its comments too) and inserted before `mock`, like Pixel Studio's migration (MDI-08).
 */
export const SEED_STATE_FILE = 'seed-state.json'
export const MIGRATED_SEED_PROVIDERS = ['acp'] as const

interface SeedState {
  version: 1
  providers: string[]
  /** Ids of the one-off migrations that have run (`strata-loaded-v1`). */
  migrations?: string[]
}

interface Parsed {
  doc: Document
  providers: YAMLSeq
  front: string
  frontStart: number
  text: string
  nl: string
}

function parseProviders(text: string): Parsed | undefined {
  const { frontmatter } = splitFrontmatter(text)
  if (frontmatter === null) return undefined
  const doc = parseDocument(frontmatter)
  if (doc.errors.length) return undefined
  const providers = doc.get('providers')
  if (!isSeq(providers)) return undefined
  const bom = text.charCodeAt(0) === 0xfeff ? 1 : 0
  const frontStart = bom + text.slice(bom).indexOf('\n') + 1
  return { doc, providers, front: frontmatter, frontStart, text, nl: text.includes('\r\n') ? '\r\n' : '\n' }
}

const idOf = (item: unknown): string | undefined => {
  const id = isMap(item) ? item.get('id') : undefined
  return typeof id === 'string' ? id : undefined
}

/** Where entry `i` starts in the frontmatter: its line, or the first of the comment lines right above it. */
function entryStart(p: Parsed, i: number): number {
  const item = p.providers.items[i] as Node
  let at = p.front.lastIndexOf('\n', item.range![0]) + 1
  while (at > 0) {
    const prev = p.front.lastIndexOf('\n', at - 2) + 1
    if (!p.front.slice(prev, at).trim().startsWith('#')) break
    at = prev
  }
  return at
}

/** Where the providers list ends in the frontmatter: after its last line. */
function listEnd(p: Parsed): number {
  const end = p.providers.range![1]
  const nl = p.front.indexOf('\n', Math.max(0, end - 1))
  return nl === -1 ? p.front.length : nl + 1
}

async function readState(file: string): Promise<SeedState> {
  try {
    const j = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SeedState>
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    return { version: 1, providers: strings(j.providers), ...(Array.isArray(j.migrations) ? { migrations: strings(j.migrations) } : {}) }
  } catch {
    return { version: 1, providers: [] }
  }
}

/** Adds the missing migrated seed providers to providers.md. Returns the ids it added. Idempotent. */
export function migrateSeedProviders(configDir: string, seedDir: string | undefined): Promise<string[]> {
  return withFileLock(path.join(configDir, 'providers.md'), () => migrate(configDir, seedDir))
}

async function migrate(configDir: string, seedDir: string | undefined): Promise<string[]> {
  const provFile = path.join(configDir, 'providers.md')
  const stateFile = path.join(configDir, SEED_STATE_FILE)
  if (!seedDir || !existsSync(provFile) || !existsSync(path.join(seedDir, 'providers.md'))) return []
  const state = await readState(stateFile)
  const todo = MIGRATED_SEED_PROVIDERS.filter((id) => !state.providers.includes(id))
  if (!todo.length) return []

  const mine = parseProviders(await fs.readFile(provFile, 'utf8'))
  const seed = parseProviders(await fs.readFile(path.join(seedDir, 'providers.md'), 'utf8'))
  if (!mine || !seed) return []
  const have = new Set(mine.providers.items.map(idOf))
  const added: string[] = []
  let add = ''
  for (const id of todo) {
    if (!have.has(id)) {
      const k = seed.providers.items.findIndex((item) => idOf(item) === id)
      if (k === -1) continue
      const to = k + 1 < seed.providers.items.length ? entryStart(seed, k + 1) : listEnd(seed)
      add += seed.front.slice(entryStart(seed, k), to).replace(/\r\n/g, '\n')
      added.push(id)
    }
    state.providers.push(id)
  }
  if (added.length) {
    const mock = mine.providers.items.findIndex((item) => idOf(item) === 'mock')
    const insertAt = mock === -1 ? listEnd(mine) : entryStart(mine, mock)
    if (!add.endsWith('\n')) add += '\n'
    let front = mine.front.slice(0, insertAt) + add.replace(/\n/g, mine.nl) + mine.front.slice(insertAt)
    if (insertAt > 0 && front[insertAt - 1] !== '\n') front = front.slice(0, insertAt) + mine.nl + front.slice(insertAt)
    const doc = parseDocument(front)
    if (doc.errors.length || !providersSchema.safeParse(doc.toJS()).success) return [] // left alone, nothing recorded: the next start tries again
    const next = mine.text.slice(0, mine.frontStart) + front + mine.text.slice(mine.frontStart + mine.front.length)
    await fs.writeFile(`${provFile}.tmp`, next, 'utf8')
    await fs.rename(`${provFile}.tmp`, provFile)
  }
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
  return added
}

/** The id `seed-state.json` records (`migrations`) once the Strata `loaded` migration has run. */
export const STRATA_LOADED_MIGRATION = 'strata-loaded-v1'

/** The refs of the Strata that had fixed model ids, and the neutral ones that replace them. The `-low` one first: the other is its prefix. */
const STRATA_RENAMES: [string, string][] = [
  ['strata/qwen3.8-flash-next-low', 'strata/default-low'],
  ['strata/qwen3.8-flash-next', 'strata/default']
]

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Exact-string rename of the old Strata refs (not inside a longer id). */
export function renameStrataRefs(text: string): string {
  let out = text
  for (const [from, to] of STRATA_RENAMES) {
    out = out.replace(new RegExp(`(?<![\\w/.-])${escapeRe(from)}(?![\\w.-])`, 'g'), to)
  }
  return out
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  try {
    const data: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    return data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function renameInFile(file: string): Promise<boolean> {
  if (!existsSync(file)) return false
  const text = await fs.readFile(file, 'utf8')
  const next = renameStrataRefs(text)
  if (next === text) return false
  await fs.writeFile(file, next, 'utf8')
  return true
}

/**
 * Moves an existing config folder onto the `loaded` Strata, once (`strata-loaded-v1` in seed-state.json):
 * - providers.md, provider `strata` (when the user still has it): without a `loaded` row it gets the seed's two `loaded` rows and `profiles`,
 *   `discover: true`, and loses the rows whose ids are now their aliases; every other row and key stays. Nothing is added back later.
 * - the old refs `strata/qwen3.8-flash-next(-low)` become `strata/default(-low)` in roles.md, models.md (`shown`) and app.json (`selectedModel`).
 * A providers.md that can't be read or would be invalid after the change is left alone with a warning and the migration is not recorded.
 */
export function migrateStrataLoaded(configDir: string, seedDir: string | undefined): Promise<{ changed: string[]; warnings: string[] }> {
  return withFileLock(path.join(configDir, 'providers.md'), () => migrateStrata(configDir, seedDir))
}

async function migrateStrata(configDir: string, seedDir: string | undefined): Promise<{ changed: string[]; warnings: string[] }> {
  const result = { changed: [] as string[], warnings: [] as string[] }
  if (!seedDir) return result
  const stateFile = path.join(configDir, SEED_STATE_FILE)
  const state = await readState(stateFile)
  const done = state.migrations ?? []
  if (done.includes(STRATA_LOADED_MIGRATION)) return result

  const file = path.join(configDir, 'providers.md')
  let recorded = true
  if (existsSync(file) && existsSync(path.join(seedDir, 'providers.md'))) {
    const mine = parseProviders(await fs.readFile(file, 'utf8'))
    const seed = parseProviders(await fs.readFile(path.join(seedDir, 'providers.md'), 'utf8'))
    if (!mine || !seed) {
      result.warnings.push(`${!mine ? 'providers.md' : 'the seed providers.md'} can't be read: the Strata loaded rows were not added`)
      recorded = false
    } else {
      const mineStrata = mine.providers.items.find((item) => idOf(item) === 'strata')
      const seedStrata = seed.providers.items.find((item) => idOf(item) === 'strata')
      const models = isMap(mineStrata) ? mineStrata.get('models', true) : undefined
      const hasLoaded = isSeq(models) && models.items.some((m) => isMap(m) && m.get('loaded') === true)
      if (isMap(mineStrata) && isMap(seedStrata) && !hasLoaded) {
        const seedModels = seedStrata.get('models', true)
        const rows = isSeq(seedModels) ? seedModels.items.filter((m): m is YAMLMap => isMap(m) && m.get('loaded') === true) : []
        const aliases = new Set(rows.flatMap((r) => (r.toJSON() as { aliases?: string[] }).aliases ?? []))
        const seedProfiles = seedStrata.get('profiles', true)
        if (rows.length) {
          const list: YAMLSeq = isSeq(models) ? models : mine.doc.createNode([])
          list.items = [...rows.map((r) => r.clone() as Node), ...list.items.filter((m) => !(isMap(m) && aliases.has(String(m.get('id')))))]
          if (!isSeq(models)) mineStrata.set('models', list)
          const discover = mineStrata.items.find((pair) => isScalar(pair.key) && pair.key.value === 'discover')
          if (discover && isScalar(discover.value)) discover.value.value = true
          else mineStrata.set('discover', true)
          if (!mineStrata.has('profiles') && isSeq(seedProfiles)) mineStrata.set('profiles', seedProfiles.clone())
          const front = mine.doc.toString({ lineWidth: 0 }).replace(/\n/g, mine.nl)
          const check = providersSchema.safeParse(parseDocument(front).toJS())
          if (!check.success) {
            result.warnings.push(`providers.md would be invalid with the Strata loaded rows (${check.error.issues[0]?.message ?? '?'}): left as it is`)
            recorded = false
          } else {
            await fs.writeFile(`${file}.tmp`, mine.text.slice(0, mine.frontStart) + front + mine.text.slice(mine.frontStart + mine.front.length), 'utf8')
            await fs.rename(`${file}.tmp`, file)
            result.changed.push('providers.md')
          }
        }
      }
    }
  }
  for (const name of ['roles.md', 'models.md']) if (await renameInFile(path.join(configDir, name))) result.changed.push(name)
  const appFile = path.join(configDir, 'app.json')
  const app = await readJsonObject(appFile)
  const selected = typeof app.selectedModel === 'string' ? renameStrataRefs(app.selectedModel) : undefined
  if (selected !== undefined && selected !== app.selectedModel) {
    await fs.writeFile(appFile, JSON.stringify({ ...app, selectedModel: selected }, null, 2) + '\n', 'utf8')
    result.changed.push('app.json')
  }
  if (recorded) {
    const latest = await readState(stateFile)
    await fs.writeFile(stateFile, JSON.stringify({ ...latest, migrations: [...(latest.migrations ?? []), STRATA_LOADED_MIGRATION] }, null, 2) + '\n', 'utf8')
  }
  return result
}

/** The id `seed-state.json` records (`migrations`) once the ACP port migration has run. */
export const ACP_PORT_MIGRATION = 'acp-port-8787-v1'
const ACP_OLD_URL = 'http://127.0.0.1:7461/v1'
const ACP_NEW_URL = 'http://127.0.0.1:8787/v1'

/**
 * Moves the `acp` provider of an existing config folder from the old proxy port to 8787, once (`acp-port-8787-v1` in seed-state.json):
 * only the exact value `http://127.0.0.1:7461/v1` of its `base_url` changes, any other value is kept. A providers.md that can't be read
 * or would be invalid after the change is left alone with a warning and the migration is not recorded (MDI-18).
 */
export function migrateAcpPort(configDir: string): Promise<{ changed: string[]; warnings: string[] }> {
  return withFileLock(path.join(configDir, 'providers.md'), () => migrateAcp(configDir))
}

async function migrateAcp(configDir: string): Promise<{ changed: string[]; warnings: string[] }> {
  const result = { changed: [] as string[], warnings: [] as string[] }
  const stateFile = path.join(configDir, SEED_STATE_FILE)
  const state = await readState(stateFile)
  if ((state.migrations ?? []).includes(ACP_PORT_MIGRATION)) return result
  const file = path.join(configDir, 'providers.md')
  if (existsSync(file)) {
    const mine = parseProviders(await fs.readFile(file, 'utf8'))
    if (!mine) {
      result.warnings.push("providers.md can't be read: the acp port was not moved")
      return result
    }
    const acp = mine.providers.items.find((item) => idOf(item) === 'acp')
    const url = isMap(acp) ? acp.get('base_url', true) : undefined
    if (isScalar(url) && url.value === ACP_OLD_URL) {
      url.value = ACP_NEW_URL
      const front = mine.doc.toString({ lineWidth: 0 }).replace(/\n/g, mine.nl)
      if (!providersSchema.safeParse(parseDocument(front).toJS()).success) {
        result.warnings.push('providers.md would be invalid with the new acp port: left as it is')
        return result
      }
      await fs.writeFile(`${file}.tmp`, mine.text.slice(0, mine.frontStart) + front + mine.text.slice(mine.frontStart + mine.front.length), 'utf8')
      await fs.rename(`${file}.tmp`, file)
      result.changed.push('providers.md')
    }
  }
  const latest = await readState(stateFile)
  await fs.writeFile(stateFile, JSON.stringify({ ...latest, migrations: [...(latest.migrations ?? []), ACP_PORT_MIGRATION] }, null, 2) + '\n', 'utf8')
  return result
}
