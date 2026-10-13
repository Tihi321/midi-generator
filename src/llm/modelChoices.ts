import { promises as fs } from 'node:fs'
import path from 'node:path'
import { parseMd, serializeMd } from './md'
import { guessFamily } from './registry'
import type { ModelRegistry } from './registry'

/** Which models the chat's dropdown offers: config/models.md, written by Settings > Models. No Electron. */

const MODELS_MD_BODY = `# Models in the dropdown

Which models the chat's model dropdown offers: only the ticked ones. The app writes this file from Settings > Models: pick a provider, press **Detect models** to list everything it has, and tick the models you want, or add one by its id (with its price for a paid provider). You can also edit it by hand; the app picks the change up on reload.

- \`shown\`: \`provider/model\` refs ticked in the dropdown: models of \`providers.md\`, and models found by \`discover\` (OpenRouter's free models, LM Studio models that are not in \`providers.md\`). A model that is not here (or in \`picked\`) is not in the dropdown.
- \`picked\`: models that are in neither: ticked from a provider's list or added by id, each with its \`provider\`, \`id\`, \`context\` and the price the provider listed (or the one you typed; \`price_in\`, \`price_out\`, \`price_cached_in\`, USD per 1M tokens, display only). They are always in the dropdown.

A role list in \`roles.md\` can still name a model that is not ticked. An old \`hidden\` list is ignored.
`

export interface ModelChoicesDoc {
  /** The frontmatter, unknown fields kept. */
  data: Record<string, unknown>
  body: string
}

/** What a change may edit: the lists of models.md. */
export interface ModelChoicesDraft {
  shown: Set<string>
  picked: Record<string, unknown>[]
}

function file(configDir: string): string {
  return path.join(configDir, 'models.md')
}

/** Reads config/models.md; a missing file is an empty one. */
export async function readModelChoices(configDir: string): Promise<ModelChoicesDoc> {
  try {
    const doc = parseMd(await fs.readFile(file(configDir), 'utf8'), file(configDir))
    return { data: doc.data, body: doc.body }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { data: { kind: 'models' }, body: MODELS_MD_BODY }
    throw err
  }
}

/** Reads models.md, lets `change` edit the lists and writes the file back (the body text stays). */
export async function editModelChoices(configDir: string, change: (c: ModelChoicesDraft) => void): Promise<void> {
  const doc = await readModelChoices(configDir)
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const draft: ModelChoicesDraft = {
    shown: new Set(strings(doc.data.shown)),
    picked: Array.isArray(doc.data.picked) ? (doc.data.picked as Record<string, unknown>[]) : []
  }
  change(draft)
  await fs.mkdir(configDir, { recursive: true })
  // `hidden` of an old file is dropped: nothing is shown by default any more
  const { hidden: _old, ...rest } = doc.data
  await fs.writeFile(file(configDir), serializeMd({ ...rest, kind: 'models', shown: [...draft.shown].sort(), picked: draft.picked }, doc.body || MODELS_MD_BODY), 'utf8')
}

const pickedIndex = (picked: Record<string, unknown>[], ref: string) => picked.findIndex((m) => `${String(m.provider)}/${String(m.id)}` === ref)

/**
 * Ticks (`shown` true) or unticks models of the dropdown. Unticking drops a picked model and a ticked one.
 * Ticking adds a providers.md or discovered model to `shown`, and picks a model only a provider's list (`registry.catalog`) knows,
 * with the context, price, tools and vision it listed. A paid model with no listed price is refused: add it by id with its price.
 * Does not reload the registry. Returns a message for each ref it could not tick.
 */
export async function showModels(registry: ModelRegistry, refs: string[], shown: boolean): Promise<string[]> {
  const problems: string[] = []
  await editModelChoices(registry.configDir, (c) => {
    for (const ref of new Set(refs)) {
      const slash = ref.indexOf('/')
      const p = slash < 1 ? undefined : registry.providers.get(ref.slice(0, slash))
      if (!p) {
        problems.push(`unknown model ${ref}`)
        continue
      }
      const known = registry.models.get(ref)
      if (!shown) {
        const i = pickedIndex(c.picked, ref)
        if (i >= 0) c.picked.splice(i, 1)
        c.shown.delete(ref)
        continue
      }
      if (known) {
        if (known.source !== 'picked') c.shown.add(ref)
        continue
      }
      if (pickedIndex(c.picked, ref) >= 0) continue
      const id = ref.slice(slash + 1)
      const listed = registry.listedModels(p.id).find((m) => m.id === id)
      if (!listed) {
        problems.push(`${p.id} has not listed ${id}: detect its models first`)
        continue
      }
      if (!p.local && !listed.price) {
        problems.push(`${ref} has no listed price: add it by id with its price`)
        continue
      }
      c.picked.push({
        provider: p.id,
        id,
        family: guessFamily(id),
        ...(listed.context ? { context: listed.context } : {}),
        ...(listed.maxOutput ? { max_output: listed.maxOutput } : {}),
        price_in: p.local ? 0 : listed.price!.in,
        price_out: p.local ? 0 : listed.price!.out,
        ...(!p.local && listed.price!.cachedIn !== undefined ? { price_cached_in: listed.price!.cachedIn } : {}),
        ...(listed.tools !== undefined ? { tools: listed.tools } : {}),
        ...(listed.vision !== undefined ? { vision: listed.vision } : {})
      })
    }
  })
  return problems
}

export interface AddModelCmd {
  provider: string
  id: string
  /** USD per 1M tokens. Required for a non-local provider (0 for a free model). */
  priceIn?: number
  priceOut?: number
  context?: number
  tools?: boolean
  vision?: boolean
}

/**
 * Adds a model the provider doesn't list (or can't list: DeepSeek, Anthropic, Gemini) to `picked`. A non-local provider's model needs both
 * prices. A model the registry already knows is only ticked. Throws on a bad command. Does not reload the registry.
 */
export async function addModel(registry: ModelRegistry, cmd: AddModelCmd): Promise<void> {
  const id = cmd.id.trim()
  const p = registry.providers.get(cmd.provider)
  if (!p) throw new Error(`No provider "${cmd.provider}".`)
  if (!id) throw new Error('The model id is empty.')
  const price = (v?: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const priceIn = p.local ? 0 : price(cmd.priceIn)
  const priceOut = p.local ? 0 : price(cmd.priceOut)
  if (priceIn === undefined || priceOut === undefined) throw new Error(`${cmd.provider}/${id} needs its price in and out (USD per 1M tokens, 0 for a free model).`)
  const ref = `${cmd.provider}/${id}`
  const known = registry.models.get(ref)
  await editModelChoices(registry.configDir, (c) => {
    if (known) {
      if (known.source !== 'picked') c.shown.add(ref)
      return
    }
    if (pickedIndex(c.picked, ref) >= 0) return
    const context = typeof cmd.context === 'number' && cmd.context > 0 ? Math.round(cmd.context) : undefined
    c.picked.push({
      provider: cmd.provider,
      id,
      family: guessFamily(id),
      ...(context ? { context } : {}),
      price_in: priceIn,
      price_out: priceOut,
      ...(cmd.tools !== undefined ? { tools: cmd.tools } : {}),
      ...(cmd.vision !== undefined ? { vision: cmd.vision } : {})
    })
  })
}
