export * as ContextUsageReminder from "./context-usage-reminder.js"

import { TokenUsage } from "@orbit/schema/token-usage"
import { Effect } from "effect"
import { postedInRun } from "./reminder-text.js"
import type { Durable } from "./reminders.js"

/**
 * Tells the main conversation how much of the model's context window the newest response used, on every logical step,
 * as the reference does behind an opt-in switch. It is off unless `ORBIT_ENABLE_CONTEXT_USAGE_REMINDER` is `1` or
 * `true`, read at each step. The usable window leaves room for a summary: the model's context less the smaller of its
 * output limit and `RESERVE`. A model whose context is not known adds nothing, rather than a figure that means nothing.
 *
 * Every figure is computed by the harness, and the entry carries no data and no description.
 */

const KIND = "context-usage"
export const SWITCH = "ORBIT_ENABLE_CONTEXT_USAGE_REMINDER"
/** The most that the room kept for a summary takes from the window. */
export const RESERVE = 20_000

export const durable: Durable = {
  name: KIND,
  scope: "primary",
  run: (input) =>
    Effect.sync(() => {
      if (!/^(1|true)$/i.test(process.env[SWITCH] ?? "")) return []
      if (input.model.limit.context <= 0) return []
      if (postedInRun(input.messages, KIND)) return []
      const window = input.model.limit.context - Math.min(input.model.limit.output, RESERVE)
      const newest = input.messages.findLast((message) => message.type === "assistant" && message.tokens !== undefined)
      const used = newest?.type === "assistant" && newest.tokens ? TokenUsage.total(newest.tokens) : 0
      return [{ kind: KIND, text: `Context window: ${used} of ${window} tokens used, ${window - used} left.` }]
    }),
}
