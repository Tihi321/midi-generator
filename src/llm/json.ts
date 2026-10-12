import { z } from 'zod'
import type { ZodType } from 'zod'
import { stripThinking } from './types'
import type { ChatFn, ChatMessage, ChatResult } from './types'

export { stripThinking } from './types'

/** Pulls the first JSON object out of a reply, tolerating fences and chatter around it. */
export function extractJson(text: string): unknown {
  let t = stripThinking(text).trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t)
  if (fence) t = fence[1]!.trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start === -1 || end <= start) throw new Error('no JSON object in the reply')
  return JSON.parse(t.slice(start, end + 1))
}

export function jsonSchemaOf(schema: ZodType): Record<string, unknown> {
  const js = z.toJSONSchema(schema) as Record<string, unknown>
  delete js.$schema
  return js
}

export interface JsonResult<T> {
  value: T
  chat: ChatResult
  cost: number
}

/**
 * Asks for JSON. Passes the schema to providers that support it. If the reply doesn't parse or validate,
 * asks once more with the error (a repair retry). If the provider rejects the schema, tries again without it.
 * `chat` is any model call, for example `router.chatFn({ role })`.
 */
export async function chatJson<T>(
  chat: ChatFn,
  messages: ChatMessage[],
  schema: ZodType<T>,
  opts: { maxTokens?: number; temperature?: number; signal?: AbortSignal } = {}
): Promise<JsonResult<T>> {
  let cost = 0
  const jsonSchema = jsonSchemaOf(schema)
  const ask = async (msgs: ChatMessage[], withSchema: boolean): Promise<ChatResult> => {
    const r = await chat(msgs, { schema: withSchema ? jsonSchema : undefined, ...opts })
    cost += r.costUsd
    return r
  }
  let reply: ChatResult
  try {
    reply = await ask(messages, true)
  } catch (err) {
    if (opts.signal?.aborted || (err as Error).name === 'AbortError' || /token limit/i.test((err as Error).message)) throw err
    reply = await ask(messages, false)
  }
  const tryParse = (text: string): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      const parsed = schema.safeParse(extractJson(text))
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }
  let parsed = tryParse(reply.text)
  if (parsed.ok) return { value: parsed.value, chat: reply, cost }
  const repair: ChatMessage[] = [
    ...messages,
    { role: 'assistant', content: reply.text.slice(0, 6000) },
    {
      role: 'user',
      content: `Your reply could not be used: ${parsed.error}.\nReply again with only one valid JSON object that matches the requested format. No explanations, no code fences.`
    }
  ]
  const second = await ask(repair, false)
  parsed = tryParse(second.text)
  if (parsed.ok) return { value: parsed.value, chat: second, cost }
  throw new Error(`the model did not return valid JSON twice: ${parsed.error}`)
}
