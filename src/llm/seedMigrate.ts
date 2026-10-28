import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { Document, Node, YAMLSeq } from 'yaml'
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
    return { version: 1, providers: Array.isArray(j.providers) ? j.providers.filter((x): x is string => typeof x === 'string') : [] }
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
