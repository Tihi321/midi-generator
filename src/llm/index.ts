// LLM layer: providers (OpenAI-compatible, Anthropic, Gemini, mock) with tool calling, registry, router, agent loop.
export const LLM_VERSION = 2

export * from './types'
export { AnthropicClient, toAnthropicMessages } from './anthropic'
export type { AnthropicOptions } from './anthropic'
export { GeminiClient, toGeminiContents, toGeminiSchema } from './gemini'
export type { GeminiOptions } from './gemini'
export { OpenAiCompatClient, toOpenAiMessages } from './openaiCompat'
export type { ListedModel, LocalModelInfo, OpenAiCompatOptions } from './openaiCompat'
export { MockProvider } from './mock'
export type { MockOptions, MockReply, MockResponder, MockToolCall } from './mock'
export { parseSse } from './sse'
export { KEYRING_SERVICE, deleteStoredKey, getStoredKey, resolveKey, setStoredKey } from './keys'
export type { KeyResolver } from './keys'
export { modelsSchema, providersSchema, rolesSchema, providerEntrySchema, providerModelSchema } from './config'
export type { ModelsConfig, ProviderEntry, ProviderModelEntry, ProvidersConfig, RolesConfig } from './config'
export { parseMd, parseMdWith, serializeMd, MdParseError, MdValidationError } from './md'
export { computeCost, estimateCost } from './pricing'
export type { Pricing } from './pricing'
export { CONFIG_FILES, ModelRegistry, defaultConfigDir, ensureConfigDir, guessFamily, isPaidModel } from './registry'
export type { LmLoadSettings, ModelInfo, ProviderInfo, RegistryOptions } from './registry'
export { addModel, editModelChoices, readModelChoices, showModels } from './modelChoices'
export type { AddModelCmd } from './modelChoices'
export { ProviderLimiter } from './limiter'
export { ModelRouter, isContextError } from './router'
export type { CandidateOptions, RoutedEvent, RoutedRequest, RouterOptions } from './router'
export { chatJson, extractJson, jsonSchemaOf } from './json'
export type { JsonResult } from './json'
export { actionSchema, jsonModeInstructions, runAgent, toolResultContent } from './agent'
export type {
  AgentEvent,
  AgentModelSource,
  AgentResult,
  AgentStopReason,
  ModelCapabilities,
  RunAgentOptions,
  ToolHost,
  ToolResult
} from './agent'
export { createLlm } from './setup'
export type { CreateLlmOptions } from './setup'
