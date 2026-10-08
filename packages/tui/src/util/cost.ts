import type { ModelInfo, SessionInfo, SessionMessageInfo } from "@orbit/client"
import { TokenUsage } from "@orbit/schema/token-usage"

type Tokens = SessionInfo["tokens"]

/** A model the catalog has no price for is `undefined`, never zero: the server records $0 for it, which is not a free model. */
export type ModelCost = {
  providerID: string
  modelID: string
  name: string
  /** Responses (and completed compactions) that reported usage. */
  responses: number
  tokens: Tokens
  /** The sum of the recorded costs; undefined when every response of this model was unpriced. */
  cost: number | undefined
  /** Responses that used tokens but whose model has no price. */
  unpriced: number
}

/**
 * What a session has cost and used, for /cost. The session's totals are the server's own; the per-model rows and the
 * API time come from the messages in the client's store, which may be only the newest page (`windowed`). A response is
 * unpriced when the catalog lists its model without a price (the server records $0 for it) or the message carries no
 * cost; the catalog only decides when it is loaded. Free models and models.dev models without a price both have
 * zero-valued catalog entries, so those two cannot be told apart.
 */
export function costSummary(
  session: Pick<SessionInfo, "cost" | "tokens"> & { time: Pick<SessionInfo["time"], "created"> },
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  windowed = false,
) {
  const rows = new Map<string, ModelCost>()
  const used = messages.flatMap((message) => {
    if (message.type === "compaction" && message.status !== "completed") return []
    if (message.type !== "assistant" && message.type !== "compaction") return []
    if (!message.tokens || !message.model) return []
    return [{ ...message, tokens: message.tokens, model: message.model }]
  })
  used.forEach((message) => {
    const key = `${message.model.providerID}/${message.model.id}`
    const info = models?.find((model) => model.providerID === message.model.providerID && model.id === message.model.id)
    const row =
      rows.get(key) ??
      ({
        providerID: message.model.providerID,
        modelID: message.model.id,
        name: info?.name ?? message.model.id,
        responses: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: undefined,
        unpriced: 0,
      } satisfies ModelCost)
    row.responses += 1
    row.tokens.input += message.tokens.input
    row.tokens.output += message.tokens.output
    row.tokens.reasoning += message.tokens.reasoning
    row.tokens.cache.read += message.tokens.cache.read
    row.tokens.cache.write += message.tokens.cache.write
    if (message.cost === undefined || info?.cost.length === 0) {
      if (TokenUsage.total(message.tokens) > 0) row.unpriced += 1
    } else row.cost = (row.cost ?? 0) + message.cost
    rows.set(key, row)
  })

  const assistants = messages.flatMap((message) => (message.type === "assistant" ? [message] : []))
  const completed = assistants.flatMap((message) =>
    message.time.completed === undefined ? [] : [message.time.completed],
  )
  // `streamed` ends the provider response; `completed` also waits for tools and for the person's answers.
  const spans = assistants.flatMap((message) =>
    message.time.streamed === undefined ? [] : [Math.max(0, message.time.streamed - message.time.created)],
  )
  const all = [...rows.values()]
  const priced = all.some((row) => row.cost !== undefined)
  const remainder = session.cost - all.reduce((total, row) => total + (row.cost ?? 0), 0)

  return {
    // Everything loaded was unpriced and nothing older is missing: the cost is unknown, not zero.
    cost: !priced && all.length > 0 && !windowed ? undefined : session.cost,
    partial: all.some((row) => row.unpriced > 0) && (priced || windowed),
    tokens: session.tokens,
    wall: completed.length > 0 ? Math.max(0, Math.max(...completed) - session.time.created) : undefined,
    api: spans.length > 0 ? spans.reduce((total, span) => total + span, 0) : undefined,
    models: all.toSorted((left, right) => (right.cost ?? -1) - (left.cost ?? -1)),
    /** Spend the rows do not itemize (titles and other usage records); only known when every response is loaded. */
    other: !windowed && priced && remainder > 0.00005 ? remainder : undefined,
    /** Set when older responses are not loaded: the breakdown and API time cover only this many. */
    loaded: windowed ? used.length : undefined,
  }
}

export type CostSummary = ReturnType<typeof costSummary>
