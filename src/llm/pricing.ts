import { contentText, estimateTokens } from './types'
import type { ChatMessage, Usage } from './types'

/** USD per 1M tokens, for display. There is no budget or spending cap. */
export interface Pricing {
  priceIn: number
  priceOut: number
  priceCachedIn: number
}

/** Cost in USD for a usage on a model. Cached input is billed at its own price. */
export function computeCost(m: Pricing, u: Usage): number {
  const uncached = Math.max(0, u.inputTokens - u.cachedInputTokens)
  return (uncached * m.priceIn + u.cachedInputTokens * m.priceCachedIn + u.outputTokens * m.priceOut) / 1_000_000
}

/** Rough cost of a request before it runs: input at the normal price, output at the request's maximum. */
export function estimateCost(model: Pick<Pricing, 'priceIn' | 'priceOut'> & { maxOutput?: number }, messages: ChatMessage[], maxTokens?: number): number {
  const inTok = estimateTokens(messages.map((m) => contentText(m.content)).join('\n'))
  const outTok = maxTokens ?? model.maxOutput ?? 4096
  return (inTok * model.priceIn + outTok * model.priceOut) / 1_000_000
}
