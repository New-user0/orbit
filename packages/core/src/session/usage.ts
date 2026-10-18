export * as SessionUsage from "./usage.js"

import type { Usage } from "@orbit/ai"
import { Money } from "@orbit/schema/money"
import type { TokenUsage } from "@orbit/schema/token-usage"
import type { Model } from "@orbit/schema/model"

const finite = (value: number) => (Number.isFinite(value) ? value : 0)
const safe = (value: number | undefined) => Math.max(0, finite(value ?? 0))

export const tokens = (usage: Usage | undefined): TokenUsage.Info => ({
  input: safe(usage?.nonCachedInputTokens),
  output: safe(usage?.visibleOutputTokens),
  reasoning: safe(usage?.reasoningTokens),
  cache: {
    read: safe(usage?.cacheReadInputTokens),
    write: safe(usage?.cacheWriteInputTokens),
  },
})

// TODO(#35765): Use the billed amount a provider reports, when it reports one, once billing has a dedicated typed
// runtime contract.
export function calculateCost(costs: Model.Info["cost"], usage: TokenUsage.Info) {
  const context = usage.input + usage.cache.read + usage.cache.write
  const tier = costs
    .filter((cost) => cost.tier?.type === "context" && context > cost.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  const cost = tier ?? costs.find((cost) => cost.tier === undefined)
  if (!cost) return Money.USD.zero
  return Money.USD.make(
    (usage.input * finite(cost.input) +
      (usage.output + usage.reasoning) * finite(cost.output) +
      usage.cache.read * finite(cost.cache.read) +
      usage.cache.write * finite(cost.cache.write)) /
      1_000_000,
  )
}

export type Recorded = { readonly tokens: TokenUsage.Info; readonly cost: Money.USD }

export const record = (usage: Usage | undefined, costs: Model.Info["cost"]): Recorded => {
  const normalized = tokens(usage)
  return { tokens: normalized, cost: calculateCost(costs, normalized) }
}

/**
 * Spend that a sent request incurred but the provider never reported, because the response was cut off, timed out or
 * was abandoned. The sizes are estimates, priced with the model's own rates, so the turn counts the call as computed
 * spend instead of free. A model with no price stays unpriced: its tokens carry a cost of zero, which a limit reads as
 * unknown.
 */
export const estimate = (
  costs: Model.Info["cost"],
  size: { readonly input: number; readonly output: number },
): Recorded => {
  const normalized: TokenUsage.Info = {
    input: safe(Math.round(size.input)),
    output: safe(Math.round(size.output)),
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
  return { tokens: normalized, cost: calculateCost(costs, normalized) }
}

/** Whether a record holds any tokens, so a call that never ran is not recorded as a zero. */
export const hasTokens = (recorded: Recorded) =>
  recorded.tokens.input +
    recorded.tokens.output +
    recorded.tokens.reasoning +
    recorded.tokens.cache.read +
    recorded.tokens.cache.write >
  0

export const add = (a: Recorded, b: Recorded): Recorded => ({
  cost: Money.USD.make(a.cost + b.cost),
  tokens: {
    input: a.tokens.input + b.tokens.input,
    output: a.tokens.output + b.tokens.output,
    reasoning: a.tokens.reasoning + b.tokens.reasoning,
    cache: {
      read: a.tokens.cache.read + b.tokens.cache.read,
      write: a.tokens.cache.write + b.tokens.cache.write,
    },
  },
})
