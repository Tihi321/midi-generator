import { z } from 'zod'

/**
 * Frontmatter schemas of config/providers.md and config/roles.md.
 * Config files carry a `kind` field, so a file says what it is. Unknown fields are kept (loose).
 */

const configBase = <K extends string>(kind: K) => z.looseObject({ kind: z.literal(kind) })

export const providerModelSchema = z.looseObject({
  id: z.string().min(1),
  family: z.string().default('unknown'),
  context: z.number().int().positive().optional(),
  max_output: z.number().int().positive().optional(),
  /** USD per 1M tokens. Display only: Chiptune Studio has no budget. */
  price_in: z.number().nonnegative().default(0),
  price_out: z.number().nonnegative().default(0),
  /** USD per 1M cached input tokens. Falls back to price_in when missing. */
  price_cached_in: z.number().nonnegative().optional(),
  /** The model supports native tool calling. Default: true for remote providers, false for local ones (the agent then uses JSON-action mode). */
  tools: z.boolean().optional(),
  /** The model can look at images (tool results such as render_preview are sent as images). Default false. */
  vision: z.boolean().default(false),
  /** Extra JSON fields merged into the request body for this model (for example to switch thinking off). */
  extra_body: z.record(z.string(), z.unknown()).nullable().optional(),
  /** `load_models` providers (LM Studio): load this model with this context window and parallel count instead of the defaults. */
  load_context: z.number().int().min(2048).optional(),
  load_parallel: z.number().int().min(1).max(16).optional()
})

export const providerEntrySchema = z.looseObject({
  id: z.string().min(1),
  kind: z.enum(['openai-compat', 'anthropic', 'gemini', 'mock']),
  enabled: z.boolean().default(true),
  local: z.boolean().default(false),
  base_url: z.string().optional(),
  api_key_env: z.string().optional(),
  /**
   * How many requests may run at once. `auto`: as many as the server says it serves (`concurrency.serving` of
   * `GET <base_url>/status`, the Strata status, or the loaded LM Studio slots); 1 while the server can't be asked.
   */
  concurrency: z.union([z.number().int().positive(), z.literal('auto')]).default(4),
  rpm: z.number().int().positive().optional(),
  /**
   * Ask the provider which models it has (GET /models) and add the unknown ones. `free`: only the models listed at price 0 are added
   * (OpenRouter), and the configured ones are kept. They show in the model dropdown once ticked (config/models.md).
   */
  discover: z.union([z.boolean(), z.literal('free')]).default(false),
  /** `discover` leaves out models whose id contains one of these words (any case). */
  discover_skip: z.array(z.string()).default([]),
  /** Send the JSON schema as `response_format`. Set false for servers that reject a bad JSON answer instead of constraining it. */
  json_schema: z.boolean().default(true),
  /** LM Studio: load a model that isn't loaded yet, with `lmstudio_parallel`, `lmstudio_context` and `lmstudio_ttl_minutes`. */
  load_models: z.boolean().default(false),
  models: z.array(providerModelSchema).default([])
})

export const providersSchema = configBase('providers').extend({
  /** LM Studio loading: requests at once, context window, idle minutes before LM Studio unloads the model. */
  lmstudio_parallel: z.number().int().min(1).max(16).default(1),
  lmstudio_context: z.number().int().min(2048).default(32768),
  lmstudio_ttl_minutes: z.number().int().min(1).default(60),
  providers: z.array(providerEntrySchema).default([])
})

export const rolesSchema = configBase('roles').extend({
  /** Names that stand for a `provider/model`, usable in the role lists (`local`, `cloud` ...). */
  aliases: z.record(z.string(), z.string()).default({}),
  /** Per role: ordered model list, `provider/model` or an alias. The first one is the default, the rest are fallbacks. */
  roles: z.record(z.string(), z.looseObject({ models: z.array(z.string()).default([]) })).default({})
})

/** config/models.md: which models the chat's dropdown offers. The app writes it from Settings > Models. */
export const modelsSchema = configBase('models').extend({
  /** `provider/model` refs ticked into the dropdown (providers.md and discovered models). Nothing is shown unless ticked or picked. */
  shown: z.array(z.string()).default([]),
  /** Not used any more (every model is opt-in); old files may still have it. */
  hidden: z.array(z.string()).default([]),
  /** Models added from a provider's list or by id (same fields as a providers.md model, plus `provider`). */
  picked: z.array(providerModelSchema.extend({ provider: z.string().min(1) })).default([])
})

export type ProviderModelEntry = z.output<typeof providerModelSchema>
export type ProviderEntry = z.output<typeof providerEntrySchema>
export type ProvidersConfig = z.output<typeof providersSchema>
export type RolesConfig = z.output<typeof rolesSchema>
export type ModelsConfig = z.output<typeof modelsSchema>
