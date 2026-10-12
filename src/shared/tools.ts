// Tool types shared by main, preload, renderer and the tool registry. Structurally identical to the
// `ToolDef` / `ToolResult` / `ToolHost` types of src/llm (so a ToolHost here can be passed to the agent
// loop), but declared here so that src/tools and src/shared never import the node-only LLM layer.
// No DOM, no Electron, no node:* imports.

export interface ToolDef {
  name: string
  description: string
  /** JSON schema (type: "object") of the tool arguments. */
  parameters: Record<string, unknown>
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }

export interface ToolResult {
  content: ToolContent[]
  isError?: boolean
}

/** Something that can list and run tools: the in-renderer registry host, or the main-process ToolBridge. */
export interface ToolHost {
  tools(): ToolDef[]
  /** Runs a tool. It may throw: the agent turns that into an error result for the model. */
  execute(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>
}

/** A ToolHost that can also group several tool calls (one agent turn) into a single undo step. */
export interface TurnToolHost extends ToolHost {
  /** Start an agent turn: tool calls until `endTurn` become ONE undo step. Nested calls are counted. */
  beginTurn(label?: string): Promise<void> | void
  /** Finish the turn. `rollback: true` reverts everything the turn did. */
  endTurn(opts?: { rollback?: boolean }): Promise<void> | void
}
