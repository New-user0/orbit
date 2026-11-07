export * as SessionMessageBudget from "./message-budget.js"

import { Effect, Option, Schema } from "effect"
import type { Bus } from "../../bus.js"
import { ToolOutput } from "../../tool-output.js"
import type { SessionContext } from "../context.js"
import { SessionEvent } from "../event.js"
import type { SessionMessage } from "../message.js"
import { withoutReplaced } from "./to-llm-message.js"

/**
 * The results to save so that the step's new results fit `limit`. The new results are the client-run results of the
 * newest assistant message, which the step's request is the first to carry; every older group was carried by an earlier
 * request, so it is never decided again, and a pass over the same history decides nothing new (restart, fork and replay
 * agree without process state). The largest go first, equal sizes in call order, each taking its whole size off the sum
 * until the sum is at or under the limit.
 *
 * A result counts only when it could be replaced: completed, text only, not saved on its own (a `persisted` marker),
 * carrying no override, and from a tool that declares a finite result limit. Failures, hosted results and results with
 * a file part neither count nor go.
 */
export const select = (input: {
  readonly messages: ReadonlyArray<SessionMessage.Info>
  /** Whether the tool of this name declares no result limit, as Read does. */
  readonly exempt: (name: string) => boolean
  readonly limit: number
}) => {
  const message = withoutReplaced(input.messages).findLast((item) => item.type === "assistant")
  if (message?.type !== "assistant") return undefined
  const candidates = message.content.flatMap((part) => {
    if (part.type !== "tool" || part.executed === true || part.override !== undefined) return []
    if (part.state.status !== "completed" || input.exempt(part.name)) return []
    if (Option.isSome(decodePersisted(part.state.metadata?.persisted))) return []
    const texts = part.state.content.flatMap((item) => (item.type === "text" ? [item.text] : []))
    if (texts.length !== part.state.content.length) return []
    return [{ id: part.id, texts, size: texts.reduce((sum, text) => sum + text.length, 0) }]
  })
  const chosen = candidates
    .toSorted((a, b) => b.size - a.size)
    .reduce(
      (state, candidate) =>
        state.remaining > input.limit
          ? { remaining: state.remaining - candidate.size, chosen: [...state.chosen, candidate] }
          : state,
      { remaining: candidates.reduce((sum, candidate) => sum + candidate.size, 0), chosen: [] as typeof candidates },
    ).chosen
  return { messageID: message.id, chosen }
}

/**
 * Saves each result `select` chose to the running session's folder and records one `session.tool.overridden` event for
 * it. A result whose file cannot be saved is sent whole, and once that request carries it, it is never decided again.
 * Answers whether anything was recorded, so the caller reloads the context before reading it.
 */
export const apply = Effect.fnUntraced(function* (input: {
  readonly bus: Bus.Interface
  readonly toolOutput: ToolOutput.Interface
  readonly loaded: SessionContext.Loaded
  readonly limit: number
}) {
  const sessionID = input.loaded.session.id
  const selected = select({
    messages: input.loaded.messages,
    // By the tool of that name in the request's tool set; a name no longer offered is not exempt.
    exempt: (name) => input.loaded.tools.describe(name)?.maxResultChars === Infinity,
    limit: input.limit,
  })
  if (selected === undefined) return false
  const recorded = yield* Effect.forEach(selected.chosen, (candidate) =>
    input.toolOutput
      .persist({ sessionID, messageID: selected.messageID, callID: candidate.id, texts: candidate.texts })
      .pipe(
        Effect.flatMap((override) =>
          override === undefined
            ? Effect.succeed(false)
            : input.bus
                .publish(SessionEvent.Tool.Overridden, {
                  sessionID,
                  assistantMessageID: selected.messageID,
                  id: candidate.id,
                  override,
                })
                .pipe(Effect.as(true)),
        ),
      ),
  )
  return recorded.includes(true)
})

const decodePersisted = Schema.decodeUnknownOption(ToolOutput.Persisted)
