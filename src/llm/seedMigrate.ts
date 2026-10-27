import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import { splitFrontmatter } from './md'

/**
 * Seed providers added after the first release. An existing config folder gets each one once: `config/seed-state.json` lists the seed
 * providers already offered, so one the user deleted is not added back and user edits are never overwritten (MDI-07, like BTT-21).
 */
export const SEED_STATE_FILE = 'seed-state.json'
export const MIGRATED_SEED_PROVIDERS = ['acp'] as const

interface SeedState {
  version: 1
  providers: string[]
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
export async function migrateSeedProviders(configDir: string, seedDir: string | undefined): Promise<string[]> {
  const provFile = path.join(configDir, 'providers.md')
  const stateFile = path.join(configDir, SEED_STATE_FILE)
  if (!seedDir || !existsSync(provFile) || !existsSync(path.join(seedDir, 'providers.md'))) return []
  const state = await readState(stateFile)
  const todo = MIGRATED_SEED_PROVIDERS.filter((id) => !state.providers.includes(id))
  if (!todo.length) return []

  const text = await fs.readFile(provFile, 'utf8')
  const { frontmatter, body } = splitFrontmatter(text)
  if (frontmatter === null) return []
  const doc = parseDocument(frontmatter)
  const list = doc.get('providers')
  if (!isSeq(list)) return []
  const seedText = splitFrontmatter(await fs.readFile(path.join(seedDir, 'providers.md'), 'utf8')).frontmatter
  const seedList = seedText ? parseDocument(seedText).get('providers') : undefined
  const added: string[] = []
  for (const id of todo) {
    const has = list.items.some((i) => isMap(i) && i.get('id') === id)
    if (!has) {
      const entry = isSeq(seedList) ? seedList.items.find((i) => isMap(i) && i.get('id') === id) : undefined
      if (!isMap(entry)) continue
      list.add(doc.createNode(entry.toJSON()))
      added.push(id)
    }
    state.providers.push(id)
  }
  if (added.length) {
    let next = `---\n${doc.toString({ lineWidth: 0 })}---\n${body}`
    if (text.includes('\r\n')) next = next.replace(/\r?\n/g, '\r\n')
    await fs.writeFile(`${provFile}.tmp`, next, 'utf8')
    await fs.rename(`${provFile}.tmp`, provFile)
  }
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8')
  return added
}
