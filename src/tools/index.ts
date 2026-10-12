// ToolRegistry: zod-schema'd tool definitions over core. No DOM, no Electron.
export const TOOLS_VERSION = 1

export { SongSession } from './session'
export type { SongCursor, SongSessionOptions, ReplaceSongOptions } from './session'
export { ToolRegistry, defineTool, createToolHost, textResult, errorResult, jsonResult, imageResult, resultText, formatZodError } from './registry'
export type { ToolContext, ToolDefinition, RegisteredTool, ToolGroup, ToolSession, ToolDef, ToolHost, ToolResult, TurnToolHost } from './registry'
export type { ToolServices, AssetService, AssetMeta, AssetData, AssetFilter, AssetKind, AssetSaveInput, AudioService, AudioRenderOptions, AudioRenderResult, PlaybackPosition } from './services'
export { createMemoryToolServices, createMemoryAudio, createMemoryAssets } from './memoryServices'
export type { MemoryToolServices, MemoryAudio, MemoryAssets } from './memoryServices'
export { allTools, createDefaultRegistry } from './defs'
export { GUIDE, GUIDE_SHORT } from './guideText'
