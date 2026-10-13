import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseMd } from '../../src/llm/md'
import { addModel, readModelChoices, showModels } from '../../src/llm/modelChoices'
import { ModelRegistry } from '../../src/llm/registry'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'ps-choices-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

const list = {
  data: [
    { id: 'm/free:free', context_length: 4096, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] },
    { id: 'm/paid', context_length: 8000, pricing: { prompt: '0.000002', completion: '0.00001' }, architecture: { output_modalities: ['text'] } },
    { id: 'm/noprice', architecture: { output_modalities: ['text'] } }
  ]
}
const fetchImpl = (async (url: string) => (String(url).endsWith('/models') ? new Response(JSON.stringify(list)) : new Response('', { status: 404 }))) as unknown as typeof fetch

async function setup() {
  await writeFile(
    path.join(dir, 'providers.md'),
    '---\nkind: providers\nproviders:\n  - id: or\n    kind: openai-compat\n    base_url: https://openrouter.ai/api/v1\n    api_key_env: K\n    discover: free\n    models:\n      - id: cfg/model\n        price_in: 1\n        price_out: 2\n  - id: ds\n    kind: openai-compat\n    base_url: http://ds.test\n    api_key_env: K\n    models: []\n---\n'
  )
  await writeFile(path.join(dir, 'roles.md'), '---\nkind: roles\nroles: {}\n---\n')
  const registry = new ModelRegistry(dir, { keys: () => 'k', fetchImpl })
  await registry.load()
  await registry.discover()
  await registry.catalog('or')
  return registry
}

const state = async () => (await readModelChoices(dir)).data

describe('model choices', () => {
  it('a missing models.md reads as no choices', async () => {
    expect((await readModelChoices(dir)).data).toEqual({ kind: 'models' })
  })

  it('tick and untick: providers.md and discovered models go in shown, listed ones are picked with their price', async () => {
    const registry = await setup()
    expect(await showModels(registry, ['or/cfg/model'], true)).toEqual([]) // providers.md: shown
    expect(await showModels(registry, ['or/m/free:free'], true)).toEqual([]) // discovered: shown
    expect(await showModels(registry, ['or/m/paid'], true)).toEqual([]) // only listed: picked
    expect(await state()).toMatchObject({
      shown: ['or/cfg/model', 'or/m/free:free'],
      picked: [{ provider: 'or', id: 'm/paid', family: 'm', context: 8000, price_in: 2, price_out: 10 }]
    })
    await registry.load()
    expect(registry.getModel('or/cfg/model')).toMatchObject({ shown: true })
    expect((await state()).hidden).toBeUndefined()
    expect(registry.getModel('or/m/paid')).toMatchObject({ source: 'picked', shown: true, priceOut: 10 })
    expect(registry.getModel('or/m/free:free')).toMatchObject({ shown: true })

    await showModels(registry, ['or/cfg/model', 'or/m/free:free', 'or/m/paid'], false)
    expect(await state()).toMatchObject({ shown: [], picked: [] })
    await registry.load()
    expect(registry.getModel('or/cfg/model')).toMatchObject({ shown: false })
    // the file keeps its body text
    expect(parseMd(await readFile(path.join(dir, 'models.md'), 'utf8')).body).toMatch(/^# Models in the dropdown/)
  })

  it('refuses a paid model without a listed price, a model not listed yet and an unknown provider', async () => {
    const registry = await setup()
    const problems = await showModels(registry, ['or/m/noprice', 'or/m/unlisted', 'nope/x', 'ds/anything'], true)
    expect(problems).toHaveLength(4)
    expect(problems.join('\n')).toMatch(/no listed price/)
    expect((await state()).picked).toEqual([])
  })

  it('addModel: a non-local provider needs both prices; the model is picked once; a known one is only ticked', async () => {
    const registry = await setup()
    await expect(addModel(registry, { provider: 'ds', id: 'deepseek-x', priceIn: 1 })).rejects.toThrow(/needs its price/)
    await expect(addModel(registry, { provider: 'nope', id: 'a' })).rejects.toThrow(/No provider/)
    await expect(addModel(registry, { provider: 'ds', id: '  ' })).rejects.toThrow(/empty/)
    await addModel(registry, { provider: 'ds', id: ' deepseek-x ', priceIn: 0.5, priceOut: 1.5, context: 64000.4, tools: true, vision: false })
    await addModel(registry, { provider: 'ds', id: 'deepseek-x', priceIn: 9, priceOut: 9 })
    expect((await state()).picked).toEqual([{ provider: 'ds', id: 'deepseek-x', family: 'deepseek', context: 64000, price_in: 0.5, price_out: 1.5, tools: true, vision: false }])
    await addModel(registry, { provider: 'or', id: 'cfg/model', priceIn: 0, priceOut: 0 })
    expect((await state()).shown).toEqual(['or/cfg/model'])
    await registry.load()
    expect(registry.getModel('or/cfg/model')).toMatchObject({ source: 'config', shown: true })
    expect(registry.getModel('ds/deepseek-x')).toMatchObject({ source: 'picked', shown: true, tools: true, priceIn: 0.5 })
  })
})
