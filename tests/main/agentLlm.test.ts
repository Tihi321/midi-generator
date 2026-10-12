import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readAppSettings, writeAppSettings } from '../../src/main/appSettings'
import { LlmService, type KeyOps } from '../../src/main/llm'

const seedDir = fileURLToPath(new URL('../../seed/config', import.meta.url))

function fakeKeys(env: Record<string, string> = {}) {
  const store = new Map<string, string>()
  const ops: KeyOps = {
    env: (n) => env[n],
    getStored: (n) => store.get(n),
    set: (n, v) => void store.set(n, v),
    delete: (n) => store.delete(n),
    resolve: (n) => env[n] ?? store.get(n)
  }
  return { ops, store }
}

describe('LlmService', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ps-llm-'))
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))
  const make = (keys: KeyOps) => new LlmService({ seedDir, configDir: path.join(dir, 'config'), dataDir: dir, keys, discover: false })

  it('lists providers and models with capabilities, key status and no key values', async () => {
    const { ops, store } = fakeKeys({ OPENAI_API_KEY: 'sk-env-secret' })
    store.set('ANTHROPIC_API_KEY', 'sk-stored-secret')
    const o = await make(ops).overview()
    expect(o.error).toBeUndefined()
    expect(o.dataDir).toBe(dir)
    const byId = Object.fromEntries(o.providers.map((p) => [p.id, p]))
    expect(byId.anthropic).toMatchObject({ keyStatus: 'stored', available: true, apiKeyEnv: 'ANTHROPIC_API_KEY' })
    expect(byId.openai).toMatchObject({ keyStatus: 'env' })
    expect(byId.deepseek).toMatchObject({ keyStatus: 'none', available: false })
    expect(byId.lmstudio).toMatchObject({ keyStatus: 'none', available: true, local: true })
    expect(byId.anthropic!.models).toContain('anthropic/claude-sonnet-5-5')
    const sonnet = o.models.find((m) => m.ref === 'anthropic/claude-sonnet-5-5')!
    expect(sonnet).toMatchObject({ tools: true, vision: true, local: false, available: true })
    expect(o.models.find((m) => m.ref === 'lmstudio/google/gemma-4-e4b')).toMatchObject({ tools: false, vision: true, local: true })
    expect(o.defaultModel).toBe('lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp')
    expect(JSON.stringify(o)).not.toMatch(/secret/)
  })

  it('stores and deletes keys by the provider api_key_env and refreshes availability', async () => {
    const { ops, store } = fakeKeys()
    const svc = make(ops)
    expect((await svc.overview()).providers.find((p) => p.id === 'deepseek')).toMatchObject({ available: false })
    const after = await svc.setKey('deepseek', '  sk-new  ')
    expect(store.get('DEEPSEEK_API_KEY')).toBe('sk-new')
    expect(after.providers.find((p) => p.id === 'deepseek')).toMatchObject({ available: true, keyStatus: 'stored' })
    expect(JSON.stringify(after)).not.toContain('sk-new')
    const gone = await svc.deleteKey('deepseek')
    expect(store.has('DEEPSEEK_API_KEY')).toBe(false)
    expect(gone.providers.find((p) => p.id === 'deepseek')).toMatchObject({ available: false, keyStatus: 'none' })
    await expect(svc.setKey('lmstudio', 'x')).rejects.toThrow(/no api_key_env/)
    await expect(svc.setKey('deepseek', '  ')).rejects.toThrow(/empty/)
  })

  it('persists the selected model and resolves it with its capabilities', async () => {
    const { ops } = fakeKeys({ ANTHROPIC_API_KEY: 'k' })
    const svc = make(ops)
    expect(await svc.selectedModel()).toBeNull()
    await svc.setSelectedModel('anthropic/claude-sonnet-5-5')
    expect((await svc.overview()).selectedModel).toBe('anthropic/claude-sonnet-5-5')
    expect(JSON.parse(await readFile(path.join(dir, 'config', 'app.json'), 'utf8'))).toEqual({ selectedModel: 'anthropic/claude-sonnet-5-5' })
    expect(await svc.resolveModel()).toMatchObject({ vision: true, ref: 'anthropic/claude-sonnet-5-5', source: { role: 'composer', modelRef: 'anthropic/claude-sonnet-5-5' } })
    // an explicit ref wins over the saved one
    expect(await svc.resolveModel('lmstudio/google/gemma-4-e4b')).toMatchObject({ vision: true, ref: 'lmstudio/google/gemma-4-e4b' })
    await svc.setSelectedModel(null)
    expect(await svc.resolveModel()).toMatchObject({ vision: true, ref: 'lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp' })
  })

  it('the context size from Settings is saved, applied to LM Studio loads and survives a restart', async () => {
    const { ops } = fakeKeys()
    const svc = make(ops)
    expect(await svc.overview()).toMatchObject({ contextSize: 131072, contextSizeSet: false })
    expect((await svc.overview()).providers.find((p) => p.id === 'lmstudio')).toMatchObject({ loadsModels: true })
    expect(await svc.setContextSize(65536)).toMatchObject({ contextSize: 65536, contextSizeSet: true })
    expect((await svc.get()).registry.loadConfigFor('lmstudio', 'nail-qwen3.6-35b-a3b-mtp').context).toBe(65536)
    await expect(svc.setContextSize(100)).rejects.toThrow(/2048/)
    const again = make(ops)
    expect((await again.get()).registry.loadConfigFor('lmstudio', 'nail-qwen3.6-35b-a3b-mtp').context).toBe(65536)
    expect(await again.setContextSize(null)).toMatchObject({ contextSize: 131072, contextSizeSet: false })
  })

  it('reload keeps working and reports an invalid config instead of throwing', async () => {
    const { ops } = fakeKeys()
    const svc = make(ops)
    await svc.overview()
    await writeFile(path.join(dir, 'config', 'roles.md'), '---\nkind: nope\n---\n', 'utf8')
    const o = await svc.reload()
    expect(o.error).toBeTruthy()
    expect(o.providers.length).toBeGreaterThan(0)
  })
})

describe('appSettings', () => {
  it('reads defaults from a missing or broken file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ps-app-'))
    try {
      expect(await readAppSettings(dir)).toEqual({ selectedModel: null, contextSize: null })
      await writeAppSettings(dir, { selectedModel: 'a/b' })
      expect((await readAppSettings(dir)).selectedModel).toBe('a/b')
      await writeAppSettings(dir, { contextSize: 65536 })
      expect(await readAppSettings(dir)).toEqual({ selectedModel: 'a/b', contextSize: 65536 })
      await writeFile(path.join(dir, 'app.json'), JSON.stringify({ contextSize: 100 }), 'utf8')
      expect((await readAppSettings(dir)).contextSize).toBeNull()
      await writeFile(path.join(dir, 'app.json'), '{not json', 'utf8')
      expect(await readAppSettings(dir)).toEqual({ selectedModel: null, contextSize: null })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
