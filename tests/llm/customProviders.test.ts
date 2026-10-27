import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkBaseUrl, customKeyName, customProviderSlug, removeCustomEntry, saveCustomEntry, setEntryEnabled } from '../../src/llm/customProviders'
import { parseMd } from '../../src/llm/md'
import { ModelRegistry } from '../../src/llm/registry'
import { migrateSeedProviders, SEED_STATE_FILE } from '../../src/llm/seedMigrate'
import { LlmService, type KeyOps } from '../../src/main/llm'

const seedDir = fileURLToPath(new URL('../../seed/config', import.meta.url))

let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ps-custom-'))
  file = path.join(dir, 'providers.md')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const OLD = '---\nkind: providers\nproviders:\n  # my own comment\n  - id: lmstudio\n    kind: openai-compat\n    local: true\n    base_url: http://localhost:1234/v1 # edited by hand\n    models: []\n---\n# Providers body\n'
const input = { name: 'My Server', baseUrl: 'http://127.0.0.1:9000/v1/', free: true, jsonSchema: false, concurrency: 2 as number | 'auto', discover: true, enabled: true, models: [] as string[] }

describe('custom providers file', () => {
  it('slug, key name and URL checks', () => {
    expect(customProviderSlug('ACP proxy (home)')).toBe('acp-proxy-home')
    expect(customProviderSlug('???')).toBe('')
    expect(customKeyName('my-server')).toBe('CUSTOM_MY_SERVER_API_KEY')
    expect(checkBaseUrl(' http://a.test/v1/ ')).toBe('http://a.test/v1')
    expect(() => checkBaseUrl('ftp://a')).toThrow(/http/)
    expect(() => checkBaseUrl('nope')).toThrow(/valid/)
  })

  it('adds, edits and removes a custom entry, keeping comments, the body and other entries', async () => {
    await writeFile(file, OLD)
    const r = await saveCustomEntry(file, { ...input, withKey: true, models: ['a', 'b'] })
    expect(r).toEqual({ id: 'my-server', apiKeyEnv: 'CUSTOM_MY_SERVER_API_KEY', created: true })
    let text = await readFile(file, 'utf8')
    expect(text).toContain('# my own comment')
    expect(text).toContain('# edited by hand')
    expect(text).toContain('# Providers body')
    let data = parseMd(text).data as { providers: Record<string, unknown>[] }
    expect(data.providers[1]).toMatchObject({
      id: 'my-server', name: 'My Server', custom: true, kind: 'openai-compat', base_url: 'http://127.0.0.1:9000/v1', api_key_env: 'CUSTOM_MY_SERVER_API_KEY',
      local: true, json_schema: false, concurrency: 2, discover: true, models: [{ id: 'a' }, { id: 'b' }]
    })

    const e = await saveCustomEntry(file, { ...input, id: 'my-server', name: 'Renamed', concurrency: 'auto', jsonSchema: true, models: ['b', 'c'] })
    expect(e.created).toBe(false)
    data = parseMd(await readFile(file, 'utf8')).data as typeof data
    expect(data.providers[1]).toMatchObject({ id: 'my-server', name: 'Renamed', concurrency: 'auto', json_schema: true, models: [{ id: 'b' }, { id: 'c' }] })

    expect(await removeCustomEntry(file, 'my-server')).toEqual({ apiKeyEnv: 'CUSTOM_MY_SERVER_API_KEY' })
    text = await readFile(file, 'utf8')
    expect(text).not.toContain('my-server')
    expect(text).toContain('# my own comment')
  })

  it('refuses reserved and duplicate ids, bad input, and editing or removing seed providers', async () => {
    await writeFile(file, OLD)
    await expect(saveCustomEntry(file, { ...input, name: 'ACP' })).rejects.toThrow(/reserved/)
    await expect(saveCustomEntry(file, { ...input, name: 'LMStudio' })).rejects.toThrow(/reserved/)
    await saveCustomEntry(file, input)
    await expect(saveCustomEntry(file, input)).rejects.toThrow(/exists already/)
    await expect(saveCustomEntry(file, { ...input, name: '  ' })).rejects.toThrow(/name/)
    await expect(saveCustomEntry(file, { ...input, name: 'X1', baseUrl: 'x' })).rejects.toThrow(/valid/)
    await expect(saveCustomEntry(file, { ...input, name: 'X2', concurrency: 0 })).rejects.toThrow(/parallel/)
    await expect(saveCustomEntry(file, { ...input, id: 'lmstudio' })).rejects.toThrow(/not a custom/)
    await expect(removeCustomEntry(file, 'lmstudio')).rejects.toThrow(/not a custom/)
    await expect(removeCustomEntry(file, 'nope')).rejects.toThrow(/no provider/)
  })

  it('setEntryEnabled changes only enabled', async () => {
    await writeFile(file, OLD)
    await setEntryEnabled(file, 'lmstudio', false)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('enabled: false')
    expect(text).toContain('# edited by hand')
  })
})

describe('seed migration', () => {
  it('adds acp once to an old providers.md, keeps edits, records it, and does not add it back after a delete', async () => {
    await writeFile(file, OLD)
    expect(await migrateSeedProviders(dir, seedDir)).toEqual(['acp'])
    const text = await readFile(file, 'utf8')
    expect(text).toContain('# edited by hand')
    const acp = (parseMd(text).data as { providers: Record<string, unknown>[] }).providers.find((p) => p.id === 'acp')
    expect(acp).toMatchObject({ kind: 'openai-compat', name: 'ACP proxy', enabled: false, local: true, base_url: 'http://127.0.0.1:7461/v1', concurrency: 2, json_schema: false, discover: true, models: [] })
    expect(JSON.parse(await readFile(path.join(dir, SEED_STATE_FILE), 'utf8')).providers).toEqual(['acp'])
    // idempotent
    expect(await migrateSeedProviders(dir, seedDir)).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(text)
    // the user deletes it: it stays deleted
    await writeFile(file, OLD)
    expect(await migrateSeedProviders(dir, seedDir)).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(OLD)
  })

  it('a fresh copy of the seed only records acp, and a user entry with the same id is not overwritten', async () => {
    await writeFile(file, await readFile(path.join(seedDir, 'providers.md'), 'utf8'))
    expect(await migrateSeedProviders(dir, seedDir)).toEqual([])
    expect(existsSync(path.join(dir, SEED_STATE_FILE))).toBe(true)
    const own = OLD.replace('  - id: lmstudio', '  - id: acp\n    kind: openai-compat\n    base_url: http://mine/v1\n    models: []\n  - id: lmstudio')
    await rm(path.join(dir, SEED_STATE_FILE))
    await writeFile(file, own)
    expect(await migrateSeedProviders(dir, seedDir)).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(own)
  })

  it('does nothing without a seed folder', async () => {
    await writeFile(file, OLD)
    expect(await migrateSeedProviders(dir, undefined)).toEqual([])
  })
})

const listing = { data: [{ id: 'codex/gpt-5.6-luna' }, { id: 'antigravity/gemini-3.8-flash' }] }

describe('acp discovery and the LlmService form commands', () => {
  const fetchImpl = (async (url: string) => (String(url).startsWith('http://127.0.0.1:7461/v1/models') ? new Response(JSON.stringify(listing)) : new Response('', { status: 404 }))) as unknown as typeof fetch

  function keys() {
    const store = new Map<string, string>()
    const ops: KeyOps = { env: () => undefined, getStored: (n) => store.get(n), set: (n, v) => void store.set(n, v), delete: (n) => store.delete(n), resolve: (n) => store.get(n) }
    return { ops, store }
  }

  it('the seeded acp provider discovers ids with slashes once enabled', async () => {
    await writeFile(path.join(dir, 'roles.md'), '---\nkind: roles\nroles: {}\n---\n')
    await writeFile(file, await readFile(path.join(seedDir, 'providers.md'), 'utf8'))
    await setEntryEnabled(file, 'acp', true)
    const registry = new ModelRegistry(dir, { keys: () => undefined, fetchImpl })
    await registry.load()
    const p = registry.providers.get('acp')!
    expect(p).toMatchObject({ name: 'ACP proxy', custom: false, available: true, local: true, jsonSchema: false, concurrency: 2, discover: true })
    expect(await registry.discover()).toContainEqual({ provider: 'acp', found: 2 })
    expect(registry.getModel('acp/codex/gpt-5.6-luna')).toMatchObject({ id: 'codex/gpt-5.6-luna', source: 'discovered' })
    expect(registry.getModel('acp/antigravity/gemini-3.8-flash')).toBeDefined()
  })

  it('save, edit, test and remove a provider through the service without a restart; the key is stored and deleted', async () => {
    const { ops, store } = keys()
    const svc = new LlmService({ seedDir, configDir: path.join(dir, 'config'), dataDir: dir, keys: ops, discover: false, fetchImpl })
    const first = await svc.overview()
    expect(first.providers.find((p) => p.id === 'acp')).toMatchObject({ enabled: false, custom: false, name: 'ACP proxy', baseUrl: 'http://127.0.0.1:7461/v1' })
    expect(await svc.testProvider({ baseUrl: 'http://127.0.0.1:7461/v1' })).toEqual({ ok: true, count: 2 })
    expect((await svc.testProvider({ baseUrl: 'http://127.0.0.1:1/v1' })).ok).toBe(false)
    expect((await svc.testProvider({ baseUrl: 'nope' })).error).toMatch(/valid/)

    const o = await svc.saveProvider({ ...input, baseUrl: 'http://127.0.0.1:7461/v1', apiKey: 'sekret', models: ['x'] })
    const mine = o.providers.find((p) => p.id === 'my-server')!
    expect(mine).toMatchObject({ custom: true, name: 'My Server', apiKeyEnv: 'CUSTOM_MY_SERVER_API_KEY', keyStatus: 'stored', available: true, models: ['my-server/x'] })
    expect(store.get('CUSTOM_MY_SERVER_API_KEY')).toBe('sekret')
    expect(JSON.stringify(o)).not.toContain('sekret')
    await svc.showModels(['my-server/x'], true)

    const edited = await svc.saveProvider({ ...input, id: 'my-server', name: 'Mine', baseUrl: 'http://127.0.0.1:7461/v1', models: ['x'] })
    expect(edited.providers.find((p) => p.id === 'my-server')).toMatchObject({ name: 'Mine', keyStatus: 'stored' })
    await expect(svc.saveProvider({ ...input, name: 'ollama' })).rejects.toThrow(/reserved/)
    await expect(svc.removeProvider('acp')).rejects.toThrow(/not a custom/)

    const off = await svc.setProviderEnabled('acp', true)
    expect(off.providers.find((p) => p.id === 'acp')?.enabled).toBe(true)

    const gone = await svc.removeProvider('my-server')
    expect(gone.providers.find((p) => p.id === 'my-server')).toBeUndefined()
    expect(store.has('CUSTOM_MY_SERVER_API_KEY')).toBe(false)
    expect(gone.models.some((m) => m.provider === 'my-server')).toBe(false)
  })
})
