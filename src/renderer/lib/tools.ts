// Runs the tool registry from the UI, on the same live session the LLM/MCP bridge drives. The UI actions
// that overlap with tools (save/place assets, style references) go through here, so a button and the LLM do
// exactly the same thing and each action is one undo step. Refused while an agent turn is active.

import { type ToolResult, type ToolServices, ToolRegistry, createDefaultRegistry, resultText } from '../../tools'
import { session } from '../state/session'
import { createIpcServices } from '../toolBridgeClient'

let registry: ToolRegistry | null = null
let services: ToolServices | null = null

export function uiRegistry(): ToolRegistry {
  return (registry ??= createDefaultRegistry())
}

/** The IPC-backed services (asset library, files). */
export function uiServices(): ToolServices {
  return (services ??= createIpcServices())
}

export interface UiToolOutcome {
  ok: boolean
  /** The first line of the tool's text (or the error). */
  message: string
  result: ToolResult
}

export const AGENT_BUSY_MESSAGE = 'The agent is working on the song. Wait for it to finish, or stop it.'

/** Run a tool by name with the given arguments. Never throws. */
export async function runUiTool(name: string, args: unknown): Promise<UiToolOutcome> {
  if (session.turnActive) {
    const result: ToolResult = { content: [{ type: 'text', text: AGENT_BUSY_MESSAGE }], isError: true }
    return { ok: false, message: resultText(result), result }
  }
  const result = await uiRegistry().execute(name, args, { session, services: uiServices() })
  const text = resultText(result).trim()
  return { ok: !result.isError, message: text.split('\n')[0] ?? '', result }
}
