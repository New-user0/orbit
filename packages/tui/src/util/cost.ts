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
  session: Pick<SessionInfo, "cost" | "tokens" | "fork"> & { time: Pick<SessionInfo["time"], "created"> },
  history: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
  windowed = false,
  /** The root session's whole loaded family (`data.session.cost`), which is what the footer and sidebar show. */
  family = session.cost,
) {
  // A fork copies its parent's settled messages with their original timestamps, but its own totals start at zero:
  // messages older than the fork belong to the parent and stay out of the rows and times.
  const messages = session.fork ? history.filter((message) => message.time.created >= session.time.created) : history
  const rows = new Map<string, ModelCost>()
  const used = messages.flatMap((message) => {
    if (message.type === "compaction" && message.status !== "completed") return []
    if (message.type !== "assistant" && message.type !== "compaction") return []
    if (!message.model) return []
    // A response that failed mid-stream carries neither tokens nor cost: its spend is unknown, as for the turn cost limit.
    const failed = message.type === "assistant" && message.finish === "error" && message.cost === undefined
    if (!message.tokens && !failed) return []
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
    rows.set(key, row)
    if (!message.tokens) {
      row.unpriced += 1
      return
    }
    row.tokens.input += message.tokens.input
    row.tokens.output += message.tokens.output
    row.tokens.reasoning += message.tokens.reasoning
    row.tokens.cache.read += message.tokens.cache.read
    row.tokens.cache.write += message.tokens.cache.write
    if (message.cost === undefined || (message.cost === 0 && info?.cost.length === 0)) {
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

  // A subagent's usage is never rolled into its parent's totals; the footer adds the family up, so the dialog does too.
  const subagents = family - session.cost > 0.00005 ? family - session.cost : undefined
  // Everything loaded was unpriced and nothing older is missing: the session's own cost is unknown, not zero.
  // A recorded amount above zero is known even when no row is priced (for example title generation on a priced model).
  const unknown = !priced && all.length > 0 && !windowed && session.cost === 0

  return {
    cost: unknown ? subagents : session.cost + (subagents ?? 0),
    subagents,
    partial:
      all.some((row) => row.unpriced > 0) && (priced || windowed || session.cost > 0 || subagents !== undefined),
    tokens: session.tokens,
    wall: completed.length > 0 ? Math.max(0, Math.max(...completed) - session.time.created) : undefined,
    api: spans.length > 0 ? spans.reduce((total, span) => total + span, 0) : undefined,
    models: all.toSorted((left, right) => (right.cost ?? -1) - (left.cost ?? -1)),
    /**
     * Spend the rows do not itemize (titles, undone responses and other usage records); only known when every response
     * is loaded. Undone responses leave the history but keep their cost, so it also shows when no row is left.
     */
    other: !windowed && (priced || all.length === 0) && remainder > 0.00005 ? remainder : undefined,
    /** Set when older responses are not loaded: the breakdown and API time cover only this many. */
    loaded: windowed ? used.length : undefined,
  }
}

export type CostSummary = ReturnType<typeof costSummary>
