import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { providersSchema, rolesSchema } from '../../src/llm/config'
import { MdValidationError, parseMdWith } from '../../src/llm/md'
import { MockProvider } from '../../src/llm/mock'
import { computeCost, ensureConfigDir, isPaidModel, ModelRegistry } from '../../src/llm/registry'
import { ModelRouter } from '../../src/llm/router'
import { createLlm } from '../../src/llm/setup'
import { collect } from '../../src/llm/types'
import { estimateCost } from '../../src/llm/pricing'

const seedDir = fileURLToPath(new URL('../../seed/config', import.meta.url))

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ps-llm-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const providersMd = (providers: string) => `---\nkind: providers\nproviders:\n${providers}\n---\n`
const rolesMd = (roles: string, aliases = '  {}') => `---\nkind: roles\naliases:\n${aliases}\nroles:\n${roles}\n---\n`

async function registryFor(providers: string, roles: string, aliases?: string, opts: ConstructorParameters<typeof ModelRegistry>[1] = {}) {
  await writeFile(path.join(dir, 'providers.md'), providersMd(providers))
  await writeFile(path.join(dir, 'roles.md'), rolesMd(roles, aliases))
  const registry = new ModelRegistry(dir, { keys: () => 'key', ...opts })
  await registry.load()
  return registry
}

describe('seed config', () => {
  it('is seeded into a missing config folder, never overwriting existing files', async () => {
    const cfg = path.join(dir, 'config')
    expect(await ensureConfigDir(cfg, seedDir)).toEqual(['providers.md', 'roles.md', 'models.md'])
    await writeFile(path.join(cfg, 'roles.md'), 'mine')
    expect(await ensureConfigDir(cfg, seedDir)).toEqual([])
    expect(await readFile(path.join(cfg, 'roles.md'), 'utf8')).toBe('mine')
    await expect(ensureConfigDir(path.join(dir, 'other'))).rejects.toThrow(/no seed/)
  })

  it('providers.md and roles.md load; roles resolve to existing models; capability flags are read', async () => {
    const { registry, router } = await createLlm({ configDir: path.join(dir, 'config'), seedDir, keys: () => undefined, discover: false })
    for (const id of ['lmstudio', 'strata', 'deepseek', 'openrouter', 'ollama', 'openai', 'anthropic', 'gemini']) expect(registry.providers.has(id), id).toBe(true)
    expect(registry.providers.get('lmstudio')).toMatchObject({ available: true, local: true, loadModels: true, concurrencyAuto: true })
    expect(registry.providers.get('strata')).toMatchObject({ available: true, local: true, jsonSchema: false })
    expect(registry.providers.get('deepseek')).toMatchObject({ available: false, unavailableReason: expect.stringMatching(/no key/) })
    expect(registry.providers.get('ollama')?.available).toBe(false)
    expect(registry.providers.get('deepseek')).toMatchObject({ jsonSchema: false })
    expect(registry.providers.get('openrouter')).toMatchObject({ discover: 'free', discoverSkip: ['content-safety'], jsonSchema: false, rpm: 20 })
    // the seed's models.md has no choices: nothing is shown until ticked
    expect(registry.listModels().every((m) => !m.shown && m.source === 'config')).toBe(true)

    const qwen = registry.getModel('lmstudio/nail-qwen3.6-35b-a3b-mtp')!
    expect(qwen).toMatchObject({ tools: true, vision: false, loadContext: undefined, context: 131072 })
    expect(registry.getModel('lmstudio/google/gemma-4-e4b')).toMatchObject({ tools: false, vision: true })
    expect(registry.getModel('anthropic/claude-sonnet-5-5')).toMatchObject({ tools: true, vision: true })
    expect(registry.getModel('claude')?.ref).toBe('anthropic/claude-sonnet-5-5')
    const flash = registry.getModel('deepseek/deepseek-flash')!
    expect(flash).toMatchObject({ priceIn: 0.3, priceCachedIn: 0.006, tools: true, extraBody: { thinking: { type: 'disabled' } } })
    expect(isPaidModel(flash)).toBe(true)
    expect(isPaidModel(qwen)).toBe(false)

    for (const role of Object.keys(registry.roles.roles)) for (const ref of registry.roleModelRefs(role)) expect(registry.getModel(ref), ref).toBeTruthy()
    expect(registry.roles.roles.composer).toBeTruthy()
    expect(registry.getModel('lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp')).toMatchObject({ tools: true, vision: true })
    // the local Qwen 3.8 27B is the only default
    expect(router.candidates('composer').map((m) => m.ref)).toEqual(['lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp'])
    expect(router.candidates('theory').map((m) => m.ref)).toEqual(['lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp'])
    // no key: a picked cloud model is dropped
    expect(router.candidates('composer', { agentModel: 'cloud' }).map((m) => m.ref)).toEqual(['lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp'])
    expect(router.candidates('composer', { agentModel: 'strata/qwen3.8-flash-next-low' })[0]!.ref).toBe('strata/qwen3.8-flash-next-low')
    expect(registry.loadConfigFor('lmstudio', 'nail-qwen3.6-35b-a3b-mtp')).toEqual({ parallel: 1, context: 131072, ttlMinutes: 60 })
    expect(registry.lmContext).toEqual({ effective: 131072, fromConfig: 131072 })
    // the context size from Settings replaces providers.md's for every LM Studio model, also over a model's own load_context
    registry.setContextSize(65536)
    expect(registry.loadConfigFor('lmstudio', 'google/gemma-4-e4b')).toEqual({ parallel: 1, context: 65536, ttlMinutes: 60 })
    expect(registry.lmContext.effective).toBe(65536)
    registry.setContextSize(null)
    expect(registry.loadConfigFor('lmstudio', 'google/gemma-4-e4b').context).toBe(131072)
  })

  it('with a key the paid providers are available', async () => {
    const { router } = await createLlm({ configDir: path.join(dir, 'config'), seedDir, keys: () => 'k', discover: false })
    expect(router.candidates('composer', { agentModel: 'cloud' }).map((m) => m.ref)).toEqual(['deepseek/deepseek-flash', 'lmstudio/ista-daslab-qwen3.8-27b-gsq-rco-unsloth-mtp'])
    expect(router.candidates('composer', { agentModel: 'claude', requireTools: true })).toHaveLength(2)
  })
})

describe('config schemas', () => {
  it('model flags default: vision false, tools unset (resolved per provider locality)', () => {
    const doc = parseMdWith(providersMd('  - id: p\n    kind: openai-compat\n    models:\n      - id: m'), providersSchema)
    const m = doc.data.providers[0]!.models[0]!
    expect(m.vision).toBe(false)
    expect(m.tools).toBeUndefined()
    expect(doc.data.lmstudio_context).toBe(32768)
  })

  it('invalid files are reported with the path of the problem', () => {
    expect(() => parseMdWith(providersMd('  - id: p\n    kind: nope'), providersSchema, 'providers.md')).toThrow(MdValidationError)
    expect(() => parseMdWith('---\nkind: roles\nroles: 5\n---\n', rolesSchema)).toThrow(/roles/)
  })

  it('tools default: true for remote providers, false for local ones; an explicit flag wins', async () => {
    const registry = await registryFor(
      [
        '  - id: remote\n    kind: openai-compat\n    base_url: http://r.test/v1\n    models:\n      - id: a\n      - id: b\n        tools: false',
        '  - id: loc\n    kind: openai-compat\n    local: true\n    base_url: http://l.test/v1\n    models:\n      - id: a\n      - id: b\n        tools: true\n        vision: true'
      ].join('\n'),
      '  r:\n    models: [remote/a]'
    )
    expect(['remote/a', 'remote/b', 'loc/a', 'loc/b'].map((r) => registry.getModel(r)!.tools)).toEqual([true, false, false, true])
    expect(registry.getModel('loc/b')!.vision).toBe(true)
  })

  it('aliases resolve in roles', async () => {
    const registry = await registryFor('  - id: p\n    kind: mock\n    models:\n      - id: m1\n      - id: m2', '  r:\n    models: [fast, p/m2]', '  fast: p/m1')
    expect(registry.roleModelRefs('r')).toEqual(['p/m1', 'p/m2'])
    expect(registry.getModel('fast')?.id).toBe('m1')
  })
})

describe('discovery', () => {
  it('adds the models a server lists, with tool and vision flags from LM Studio', async () => {
    const fetchImpl = (async (url: string) => {
      const u = String(url)
      if (u.includes('/api/v0/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'found-a', type: 'vlm', capabilities: ['tool_use'], loaded_context_length: 16384 }, { id: 'found-b', type: 'llm', capabilities: [] }] }))
      }
      if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: [{ id: 'found-a' }, { id: 'found-b' }, { id: 'listed' }] }))
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const registry = await registryFor(
      '  - id: lm\n    kind: openai-compat\n    local: true\n    base_url: http://lm.test/v1\n    discover: true\n    models:\n      - id: listed\n        tools: true',
      '  r:\n    models: [lm/listed]',
      undefined,
      { fetchImpl }
    )
    expect(await registry.discover()).toEqual([{ provider: 'lm', found: 3 }])
    expect(registry.getModel('lm/found-a')).toMatchObject({ discovered: true, tools: true, vision: true, context: 16384 })
    expect(registry.getModel('lm/found-b')).toMatchObject({ tools: false, vision: false })
    expect(registry.getModel('lm/listed')).toMatchObject({ discovered: false, tools: true })
    // a reload keeps what was found
    await registry.load()
    expect(registry.getModel('lm/found-a')).toBeTruthy()
  })

  it('lists only the installed models once the server answers: configured ones it lacks, embedding and draft models are left out', async () => {
    let installed = [{ id: 'kept', type: 'llm' }, { id: 'new-one', type: 'vlm' }, { id: 'text-embedding-x', type: 'embeddings' }, { id: 'qwen-dflash', type: 'llm', arch: 'dflash' }]
    let loaded = [{ id: 'kept' }]
    let up = false
    const fetchImpl = (async (url: string) => {
      if (!up) throw new TypeError('fetch failed')
      const u = String(url)
      if (u.includes('/api/v0/models')) return new Response(JSON.stringify({ data: installed }))
      // LM Studio without JIT loading lists only the loaded models here
      if (u.endsWith('/v1/models')) return new Response(JSON.stringify({ data: loaded }))
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const registry = await registryFor(
      '  - id: lm\n    kind: openai-compat\n    local: true\n    base_url: http://lm.test/v1\n    discover: true\n    models:\n      - id: kept\n        tools: true\n        load_context: 65536\n      - id: gone\n        tools: true',
      '  r:\n    models: [lm/gone, lm/kept]',
      undefined,
      { fetchImpl }
    )
    const lmRefs = () => registry.listModels().map((m) => m.ref).sort()
    // the server is down: the configured list stays
    expect((await registry.discover())[0]?.error).toBeTruthy()
    expect(lmRefs()).toEqual(['lm/gone', 'lm/kept'])

    up = true
    expect(await registry.discover()).toEqual([{ provider: 'lm', found: 2 }])
    expect(lmRefs()).toEqual(['lm/kept', 'lm/new-one'])
    expect(registry.getModel('lm/kept')).toMatchObject({ discovered: false, loadContext: 65536 })
    registry.setContextSize(100_000)
    expect(registry.loadConfigFor('lm', 'kept').context).toBe(100_000)
    expect(registry.getModel('lm/new-one')).toMatchObject({ discovered: true, vision: true })
    // a reload of the config files doesn't bring the missing one back
    await registry.load()
    expect(lmRefs()).toEqual(['lm/kept', 'lm/new-one'])

    // a configured model installed later gets its settings back; one uninstalled goes away
    installed = [{ id: 'gone', type: 'llm' }]
    loaded = []
    await registry.discover()
    expect(lmRefs()).toEqual(['lm/gone'])
    expect(registry.getModel('lm/gone')).toMatchObject({ discovered: false, tools: true })
  })
})

describe('model choices (models.md) and discover: free', () => {
  const openRouterList = {
    data: [
      { id: 'a/free-one:free', context_length: 131072, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }, supported_parameters: ['tools', 'temperature'] },
      { id: 'b/free-two:free', context_length: 8192, pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] }, supported_parameters: ['temperature'] },
      { id: 'c/paid', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002' }, architecture: { output_modalities: ['text'] } },
      { id: 'd/music:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['audio'] } },
      { id: 'nvidia/content-safety:free', pricing: { prompt: '0', completion: '0' }, architecture: { output_modalities: ['text'] } },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' }, architecture: { output_modalities: ['text'] } }
    ]
  }
  const orFetch = ((url: string) => (String(url).endsWith('/models') ? new Response(JSON.stringify(openRouterList)) : new Response('', { status: 404 }))) as unknown as typeof fetch
  const orProvider =
    '  - id: or\n    kind: openai-compat\n    base_url: https://openrouter.ai/api/v1\n    api_key_env: K\n    discover: free\n    discover_skip: [content-safety]\n    models:\n      - id: x/paid\n        price_in: 1\n        price_out: 2'
  const writeModels = (data: string) => writeFile(path.join(dir, 'models.md'), `---\nkind: models\n${data}\n---\n`)

  it('keeps only the free text models, never drops a configured paid one, and shows them only when ticked', async () => {
    const registry = await registryFor(orProvider, '  r:\n    models: [or/x/paid]', undefined, { fetchImpl: orFetch })
    // an old `hidden` key is tolerated and ignored
    await writeModels('shown: [or/b/free-two:free]\nhidden: [or/x/paid]')
    await registry.load()
    expect(await registry.discover()).toEqual([{ provider: 'or', found: 2 }])
    expect(registry.listModels().map((m) => m.ref).sort()).toEqual(['or/a/free-one:free', 'or/b/free-two:free', 'or/x/paid'])
    expect(registry.getModel('or/a/free-one:free')).toMatchObject({ source: 'discovered', discovered: true, shown: false, context: 131072, tools: true, vision: true, family: 'a', priceIn: 0 })
    expect(registry.getModel('or/b/free-two:free')).toMatchObject({ shown: true, tools: false, vision: false })
    expect(registry.getModel('or/x/paid')).toMatchObject({ source: 'config', shown: false, priceIn: 1 })
    // a reload keeps what was found and applies models.md again
    await writeModels('shown: [or/a/free-one:free]')
    await registry.load()
    expect(registry.getModel('or/a/free-one:free')).toMatchObject({ shown: true })
    expect(registry.getModel('or/b/free-two:free')).toMatchObject({ shown: false })
    expect(registry.getModel('or/x/paid')).toMatchObject({ shown: false })
    await writeModels('shown: [or/x/paid]')
    await registry.load()
    expect(registry.getModel('or/x/paid')).toMatchObject({ shown: true })
  })

  it('picked models are loaded and shown; providers.md wins over a picked duplicate; a picked ref of an unknown provider is ignored', async () => {
    const registry = await registryFor(orProvider, '  r:\n    models: [or/x/paid]', undefined, { fetchImpl: orFetch })
    await writeModels(
      'picked:\n  - { provider: or, id: y/picked, family: y, context: 5000, price_in: 3, price_out: 4, tools: false, vision: true }\n  - { provider: or, id: x/paid, price_in: 99, price_out: 99 }\n  - { provider: nope, id: z }'
    )
    await registry.load()
    expect(registry.getModel('or/y/picked')).toMatchObject({ source: 'picked', shown: true, context: 5000, priceIn: 3, priceOut: 4, priceCachedIn: 3, tools: false, vision: true })
    expect(registry.getModel('or/x/paid')).toMatchObject({ source: 'config', priceIn: 1 })
    expect(registry.getModel('nope/z')).toBeUndefined()
  })

  it('catalog lists the text models with prices (discover_skip applied) and remembers them; OpenRouter gets its attribution headers', async () => {
    const seen: Record<string, string>[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>)
      return orFetch(url as never, init as never)
    }) as unknown as typeof fetch
    const registry = await registryFor(orProvider, '  r:\n    models: [or/x/paid]', undefined, { fetchImpl })
    const listed = await registry.catalog('or')
    expect(listed.map((m) => m.id)).toEqual(['a/free-one:free', 'b/free-two:free', 'c/paid', 'openrouter/auto'])
    expect(listed.find((m) => m.id === 'c/paid')?.price).toMatchObject({ in: 1, out: 2 })
    expect(listed.find((m) => m.id === 'openrouter/auto')?.price).toBeUndefined()
    expect(registry.listedModels('or')).toHaveLength(4)
    expect(seen[0]).toMatchObject({ 'HTTP-Referer': expect.stringContaining('github.com'), 'X-Title': 'Chiptune Studio' })
    await expect(registry.catalog('missing')).rejects.toThrow(/no provider/)
  })

  it('discover_skip also applies to discover: true, and a model with only a maker prefix gets it as its family', async () => {
    const fetchImpl = (async (url: string) =>
      String(url).endsWith('/v1/models') ? new Response(JSON.stringify({ data: [{ id: 'keep-me' }, { id: 'qwen-DFlash' }, { id: 'acme/thing' }] })) : new Response('', { status: 404 })) as unknown as typeof fetch
    const registry = await registryFor('  - id: lm\n    kind: openai-compat\n    local: true\n    base_url: http://lm.test/v1\n    discover: true\n    discover_skip: [dflash]\n    models: []', '  r:\n    models: []', undefined, { fetchImpl })
    expect(await registry.discover()).toEqual([{ provider: 'lm', found: 2 }])
    expect(registry.getModel('lm/acme/thing')).toMatchObject({ family: 'acme', shown: false, source: 'discovered' })
    expect(registry.getModel('lm/qwen-DFlash')).toBeUndefined()
  })
})

describe('pricing', () => {
  it('computes cost with cached input at its own price, for display', () => {
    const m = { priceIn: 3, priceOut: 15, priceCachedIn: 0.3 }
    expect(computeCost(m, { inputTokens: 1_000_000, cachedInputTokens: 500_000, outputTokens: 100_000 })).toBeCloseTo(1.5 + 0.15 + 1.5)
    expect(estimateCost({ ...m, maxOutput: 1000 }, [{ role: 'user', content: 'x'.repeat(4000) }])).toBeCloseTo((1000 * 3 + 1000 * 15) / 1_000_000)
  })
})

describe('router', () => {
  const twoProviders = (extra = '') =>
    [
      '  - id: a\n    kind: openai-compat\n    base_url: http://a.test/v1\n    concurrency: 2\n    models:\n      - id: ma',
      '  - id: b\n    kind: openai-compat\n    base_url: http://b.test/v1\n    models:\n      - id: mb',
      extra
    ].join('\n')

  const ok = (text: string) => new Response(`data: {"choices":[{"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })

  it('retries a retryable error with backoff, then falls back to the next model', async () => {
    const hits: string[] = []
    const fetchImpl = (async (url: string) => {
      const host = new URL(String(url)).host
      hits.push(host)
      return host === 'a.test' ? new Response('down', { status: 503 }) : ok('from b')
    }) as unknown as typeof fetch
    const registry = await registryFor(twoProviders(), '  r:\n    models: [a/ma, b/mb]', undefined, { fetchImpl })
    const sleeps: number[] = []
    const router = new ModelRouter(registry, { retries: 2, backoffMs: 10, sleep: async (ms) => void sleeps.push(ms) })
    const events = []
    for await (const ev of router.chat(router.candidates('r'), { messages: [{ role: 'user', content: 'hi' }] })) events.push(ev)
    expect(hits).toEqual(['a.test', 'a.test', 'a.test', 'b.test'])
    expect(sleeps).toEqual([10, 20])
    expect(events.filter((e) => e.type === 'attempt')).toHaveLength(4)
    const done = events.at(-1)!
    expect(done).toMatchObject({ type: 'done', finishReason: 'stop', costUsd: 0 })
    expect(done.type === 'done' && done.model.ref).toBe('b/mb')
    expect(router.limiter.inFlight('a')).toBe(0)
  })

  it('a non-retryable error skips the retries; when all fail the reasons are listed', async () => {
    const hits: string[] = []
    const fetchImpl = (async (url: string) => {
      hits.push(new URL(String(url)).host)
      return new Response('bad request', { status: 400 })
    }) as unknown as typeof fetch
    const registry = await registryFor(twoProviders(), '  r:\n    models: [a/ma, b/mb]', undefined, { fetchImpl })
    const router = new ModelRouter(registry, { sleep: async () => undefined })
    await expect(router.complete(router.candidates('r'), { messages: [] })).rejects.toThrow(/all models failed.*a\/ma: HTTP 400.*b\/mb: HTTP 400/)
    expect(hits).toEqual(['a.test', 'b.test'])
  })

  it('complete() collects text, tool calls and cost; chatFn is a ChatFn over a role', async () => {
    const fetchImpl = (async () =>
      new Response(
        [
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"x","arguments":"{}"}}]}}]}\n\n',
          'data: {"choices":[],"usage":{"prompt_tokens":1000000,"completion_tokens":1000000}}\n\n',
          'data: [DONE]\n\n'
        ].join(''),
        { headers: { 'content-type': 'text/event-stream' } }
      )) as unknown as typeof fetch
    const registry = await registryFor('  - id: a\n    kind: openai-compat\n    base_url: http://a.test/v1\n    models:\n      - id: ma\n        price_in: 1\n        price_out: 2', '  r:\n    models: [a/ma]', undefined, { fetchImpl })
    const router = new ModelRouter(registry)
    const r = await router.chatFn({ role: 'r' })([{ role: 'user', content: 'hi' }], { tools: [] })
    expect(r.toolCalls).toEqual([{ id: 't1', name: 'x', args: {} }])
    expect(r.finishReason).toBe('tool_calls')
    expect(r.costUsd).toBeCloseTo(3)
    expect(r.model).toBe('a/ma')
  })

  it('the mock provider works through the registry, and abort stops the router', async () => {
    const mock = new MockProvider('mock')
    const registry = await registryFor('  - id: mock\n    kind: mock\n    models:\n      - id: mm', '  r:\n    models: [mock/mm]', undefined, { mock })
    const router = new ModelRouter(registry)
    mock.onAny('hello there')
    const r = await collect(
      (async function* () {
        for await (const ev of router.chat(router.candidates('r'), { messages: [{ role: 'user', content: 'x' }], meta: { role: 'r' } })) if (ev.type === 'delta') yield ev
      })()
    )
    expect(r.text).toBe('hello there')
    const ac = new AbortController()
    ac.abort()
    await expect(router.complete(router.candidates('r'), { messages: [], signal: ac.signal })).rejects.toMatchObject({ name: 'AbortError' })
    await expect(router.chat([], { messages: [] }).next()).rejects.toThrow(/no available model/)
  })

  it('the limiter holds back requests over the provider concurrency', async () => {
    let active = 0
    let peak = 0
    const fetchImpl = (async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 20))
      active--
      return ok('x')
    }) as unknown as typeof fetch
    const registry = await registryFor('  - id: a\n    kind: openai-compat\n    base_url: http://a.test/v1\n    concurrency: 2\n    models:\n      - id: ma', '  r:\n    models: [a/ma]', undefined, { fetchImpl })
    const router = new ModelRouter(registry)
    const models = router.candidates('r')
    await Promise.all([1, 2, 3, 4, 5].map(() => router.complete(models, { messages: [] })))
    expect(peak).toBe(2)
  })
})

describe('credential store', () => {
  it('stores, reads and deletes a key under the chiptune-studio service (throwaway account)', async () => {
    const { deleteStoredKey, getStoredKey, KEYRING_SERVICE, setStoredKey } = await import('../../src/llm/keys')
    expect(KEYRING_SERVICE).toBe('chiptune-studio')
    const account = `CHIPTUNE_STUDIO_TEST_${process.pid}_${Date.now()}`
    const service = 'chiptune-studio-test'
    try {
      expect(getStoredKey(account, service)).toBeUndefined()
      setStoredKey(account, 'secret-value-123', service)
      expect(getStoredKey(account, service)).toBe('secret-value-123')
      expect(deleteStoredKey(account, service)).toBe(true)
      // Windows can show a deleted credential for a moment: wait up to two seconds for it to disappear
      for (let i = 0; i < 40 && getStoredKey(account, service) !== undefined; i++) await new Promise((r) => setTimeout(r, 50))
      expect(getStoredKey(account, service)).toBeUndefined()
    } finally {
      deleteStoredKey(account, service)
    }
  })
})
