import type { ModelInfo, SessionInfo, SessionMessageInfo } from "@orbit/client"

type Tokens = SessionInfo["tokens"]

/** A price the server did not report is `undefined`, never zero: a model without a price is not a free one. */
export type ModelCost = {
  providerID: string
  modelID: string
  name: string
  /** Responses that reported usage. */
  responses: number
  tokens: Tokens
  /** The sum of the reported prices; undefined when no response of this model reported one. */
  cost: number | undefined
  /** Responses that used tokens but reported no price. */
  unpriced: number
}

/**
 * What a session has cost and used, for /cost. The session's totals are the server's own; the per-model rows and the
 * times come from the assistant messages in the client's store. A time a message does not carry (older messages lack
 * some stamps) is left out of the sum and reported as unknown when nothing carried it.
 */
export function costSummary(
  session: Pick<SessionInfo, "cost" | "tokens">,
  messages: ReadonlyArray<SessionMessageInfo>,
  models: ReadonlyArray<ModelInfo> | undefined,
) {
  const rows = new Map<string, ModelCost>()
  const assistants = messages.flatMap((message) => (message.type === "assistant" ? [message] : []))
  assistants.forEach((message) => {
    if (!message.tokens) return
    const key = `${message.model.providerID}/${message.model.id}`
    const row =
      rows.get(key) ??
      ({
        providerID: message.model.providerID,
        modelID: message.model.id,
        name:
          models?.find((model) => model.providerID === message.model.providerID && model.id === message.model.id)
            ?.name ?? message.model.id,
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
    if (message.cost === undefined) row.unpriced += 1
    else row.cost = (row.cost ?? 0) + message.cost
    rows.set(key, row)
  })

  const created = assistants.flatMap((message) => (message.time?.created === undefined ? [] : [message.time.created]))
  const completed = assistants.flatMap((message) =>
    message.time?.completed === undefined ? [] : [message.time.completed],
  )
  const spans = assistants.flatMap((message) =>
    message.time?.completed === undefined || message.time.created === undefined
      ? []
      : [Math.max(0, message.time.completed - message.time.created)],
  )
  const all = [...rows.values()]
  const priced = all.some((row) => row.cost !== undefined)

  return {
    // Tokens were used and no response carried a price: the cost is unknown, not zero.
    cost: !priced && all.length > 0 ? undefined : session.cost,
    partial: priced && all.some((row) => row.unpriced > 0),
    tokens: session.tokens,
    wall:
      created.length > 0 && completed.length > 0
        ? Math.max(0, Math.max(...completed) - Math.min(...created))
        : undefined,
    api: spans.length > 0 ? spans.reduce((total, span) => total + span, 0) : undefined,
    models: all.toSorted((left, right) => (right.cost ?? -1) - (left.cost ?? -1)),
  }
}

export type CostSummary = ReturnType<typeof costSummary>
