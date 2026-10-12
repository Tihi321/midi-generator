// ToolRegistry: zod-schema'd tool definitions, one source for the chat agent, MCP and the stdio shim.
// No DOM, no Electron, no node:*.

import { z } from 'zod'
import type { ToolDef, ToolHost, ToolResult, TurnToolHost } from '../shared/tools'
import type { ToolServices } from './services'

export type { ToolDef, ToolHost, ToolResult, TurnToolHost }

// TODO(Phase 3): the music tool groups (song, channels, notes, ...) are final; check them against src/tools/defs.
export type ToolGroup = 'song' | 'channels' | 'notes' | 'reading' | 'instruments' | 'theory' | 'assets' | 'export' | 'playback' | 'history'

/**
 * What the registry needs from the thing the tools edit (Phase 3: the song session). Writing tools run inside
 * `transactionAsync` (one tool call = one undo step); `beginTurn` / `endTurn` merge an agent turn into one step.
 */
export interface ToolSession {
  transactionAsync<T>(label: string, fn: () => Promise<T>): Promise<T>
  beginTurn(label?: string): void
  endTurn(opts?: { rollback?: boolean }): void
}

export interface ToolContext {
  session: ToolSession
  services: ToolServices
  signal?: AbortSignal
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  /** snake_case, /^[a-z_]+$/ */
  name: string
  /** Written for an LLM: what it does, key rules, one example where helpful. */
  description: string
  group: ToolGroup
  input: S
  /** True when the tool never changes the song (no undo step is created). Default false. */
  readOnly?: boolean
  /** True for undo/redo: do not wrap the call in a transaction. Default false. */
  noTransaction?: boolean
  handler(args: z.output<S>, ctx: ToolContext): ToolResult | Promise<ToolResult>
}

/** A tool with its argument type erased (what the registry stores). */
export interface RegisteredTool {
  name: string
  description: string
  group: ToolGroup
  input: z.ZodType
  readOnly: boolean
  noTransaction: boolean
  handler(args: unknown, ctx: ToolContext): ToolResult | Promise<ToolResult>
}

export function defineTool<S extends z.ZodType>(def: ToolDefinition<S>): RegisteredTool {
  if (!/^[a-z_]+$/.test(def.name)) throw new Error(`Invalid tool name "${def.name}": use lowercase letters and underscores.`)
  return {
    name: def.name,
    description: def.description,
    group: def.group,
    input: def.input,
    readOnly: def.readOnly ?? false,
    noTransaction: def.noTransaction ?? false,
    handler: def.handler as RegisteredTool['handler']
  }
}

// ---------------------------------------------------------------- results

export function textResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

export function jsonResult(value: unknown, prefix?: string): ToolResult {
  const body = JSON.stringify(value)
  return textResult(prefix ? `${prefix}\n${body}` : body)
}

export function imageResult(base64Png: string, text?: string): ToolResult {
  const content: ToolResult['content'] = []
  if (text) content.push({ type: 'text', text })
  content.push({ type: 'image', mimeType: 'image/png', data: base64Png })
  return { content }
}

/** Plain text of a result (text parts joined), for logs and tests. */
export function resultText(result: ToolResult): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
}

// ---------------------------------------------------------------- validation errors

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = ''
  for (const p of path) {
    if (typeof p === 'number') out += `[${p}]`
    else out += out ? `.${String(p)}` : String(p)
  }
  return out
}

/** Readable, LLM-friendly description of a zod error (one line per issue, with the argument path). */
export function formatZodError(toolName: string, error: z.ZodError): string {
  const lines: string[] = []
  const walk = (issues: z.core.$ZodIssue[], prefix: Array<PropertyKey>): void => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path]
      if (issue.code === 'invalid_union' && issue.errors.length > 0 && issue.errors.every((e) => e.length > 0)) {
        // Show the closest branch's problems, which are usually the informative ones.
        const best = [...issue.errors].sort((a, b) => a.length - b.length)[0]!
        const isTypeMismatch = issue.errors.every((e) => e.some((i) => i.code === 'invalid_type'))
        if (!isTypeMismatch) {
          walk(best, path)
          continue
        }
      }
      let msg = issue.message
      if (issue.code === 'unrecognized_keys') {
        msg = `Unrecognized argument${issue.keys.length === 1 ? '' : 's'} ${issue.keys.map((k) => JSON.stringify(k)).join(', ')} (check the argument names in the tool schema)`
      } else if (issue.code === 'invalid_type' && /received undefined$/.test(msg)) {
        msg = `Required argument is missing (expected ${issue.expected})`
      }
      lines.push(`- ${path.length ? formatPath(path) : '(arguments)'}: ${msg}`)
    }
  }
  walk(error.issues, [])
  return `Invalid arguments for ${toolName}:\n${lines.join('\n')}\nFix the arguments and call ${toolName} again.`
}

// ---------------------------------------------------------------- registry

/** Thrown inside a transaction to roll it back when a tool returned an error result. */
class RollbackSignal extends Error {
  constructor(readonly result: ToolResult) {
    super('rollback')
  }
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()
  private defsCache: ToolDef[] | null = null

  constructor(tools: RegisteredTool[] = []) {
    for (const t of tools) this.register(t)
  }

  register(tool: RegisteredTool): this {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`)
    this.tools.set(tool.name, tool)
    this.defsCache = null
    return this
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** LLM/MCP tool definitions with JSON-schema parameters generated from the zod inputs. */
  defs(): ToolDef[] {
    if (!this.defsCache) {
      this.defsCache = this.list().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: toJsonSchema(t.input)
      }))
    }
    return this.defsCache
  }

  /**
   * Validate `rawArgs` and run the tool. Never throws: bad arguments, unknown tools and handler
   * errors come back as `isError` results with a readable message. Tools that change the song run
   * inside one undo transaction (one tool call = one undo step); an error result or exception rolls the
   * partial changes back.
   */
  async execute(name: string, rawArgs: unknown, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      const close = this.list()
        .map((t) => t.name)
        .filter((n) => n.includes(name) || name.includes(n))
        .slice(0, 5)
      const hint = close.length ? ` Did you mean: ${close.join(', ')}?` : ` Available tools: ${this.list().map((t) => t.name).join(', ')}.`
      return errorResult(`Unknown tool "${name}".${hint}`)
    }
    let args: unknown = rawArgs
    if (typeof args === 'string') {
      const t = args.trim()
      try {
        args = t === '' ? {} : JSON.parse(t)
      } catch {
        return errorResult(`Invalid arguments for ${name}: expected a JSON object but got the string ${JSON.stringify(t.slice(0, 80))}.`)
      }
    }
    if (args === null || args === undefined) args = {}
    const parsed = tool.input.safeParse(args)
    if (!parsed.success) return errorResult(formatZodError(name, parsed.error))
    if (ctx.signal?.aborted) return errorResult(`${name} was cancelled before it ran.`)

    const run = async (): Promise<ToolResult> => tool.handler(parsed.data, ctx)
    try {
      if (tool.readOnly || tool.noTransaction) return await run()
      return await ctx.session.transactionAsync(`${name}`, async () => {
        const result = await run()
        if (result.isError) throw new RollbackSignal(result)
        return result
      })
    } catch (e) {
      if (e instanceof RollbackSignal) return e.result
      return errorResult(`${name} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
}

export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>
  delete js['$schema']
  return js
}

// ---------------------------------------------------------------- ToolHost

export interface ToolHostOptions {
  /** Label of the undo step for a turn when beginTurn() gets none. */
  turnLabel?: string
}

/**
 * Adapts a registry to the agent layer's ToolHost. Calls are serialized (one at a time, in order),
 * each tool call that changes the song is one undo step (the registry wraps it in a transaction),
 * and `beginTurn()` / `endTurn()` merge all steps of an agent turn into a single undo step.
 */
export function createToolHost(
  registry: ToolRegistry,
  ctxFactory: () => Omit<ToolContext, 'signal'>,
  opts: ToolHostOptions = {}
): TurnToolHost {
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const next = queue.then(fn, fn)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    tools: () => registry.defs(),
    execute(name, args, signal) {
      return enqueue(() => registry.execute(name, args, { ...ctxFactory(), signal }))
    },
    beginTurn(label) {
      ctxFactory().session.beginTurn(label ?? opts.turnLabel ?? 'Agent turn')
    },
    endTurn(o) {
      // Wait for queued tool calls so the turn is merged after the last one finished.
      return enqueue(() => {
        ctxFactory().session.endTurn(o)
      })
    }
  }
}
