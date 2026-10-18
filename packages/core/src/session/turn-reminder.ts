export * as TurnReminder from "./turn-reminder.js"

import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionMessage } from "./message.js"
import { SessionOutput } from "./output.js"
import { isReminder, runs } from "./reminder-text.js"
import type { Durable } from "./reminders.js"
import { SessionTurn } from "./turn.js"

/**
 * Tells the model how much of the turn's step, cost and token limits is used and left, on every logical step of a turn
 * that sets at least one. The figures are the ones `SessionTurn.exceeded` checks a moment earlier, so what the model
 * reads and what ends the turn agree. They include subagent and background spend, which the loaded history does not
 * hold, which is why this is a durable producer. Only the main conversation gets it: a subagent is limited through its
 * ancestor, and cannot answer for the turn.
 *
 * Everything in the text is computed by the harness. Nothing from a file, a tool or the person goes in it.
 */

const KIND = "turn-budget"
// From this share of any limit the text asks the model to wrap up.
const WRAP_UP = 0.9

export const durable = (db: Database.Interface["db"]): Durable => ({
  name: KIND,
  scope: "primary",
  run: (input) =>
    Effect.gen(function* () {
      const turn = yield* SessionTurn.current(db, input.session.id)
      const options = turn.options
      if (
        !options ||
        (options.maxSteps === undefined && options.maxCost === undefined && options.maxTokens === undefined)
      )
        return []
      // A drain that restarts between collection and the request runs this again for the same step.
      if (runs(input.messages).at(-1)?.messages.some(isBudget)) return []

      const spent = yield* SessionTurn.usage(db, input.session.id, options)
      const whole = (value: number) => `${value}`
      const dollars = (value: number) => `$${value.toFixed(4)}`
      const limits = [
        ...(options.maxSteps === undefined
          ? []
          : [{ name: "Steps", used: spent.steps, max: options.maxSteps, show: whole }]),
        ...(options.maxCost === undefined
          ? []
          : [{ name: "Cost", used: spent.cost, max: options.maxCost, show: dollars }]),
        ...(options.maxTokens === undefined
          ? []
          : [{ name: "Tokens", used: spent.tokens, max: options.maxTokens, show: whole }]),
      ]
      const lastStep = options.maxSteps !== undefined && options.maxSteps - spent.steps <= 1
      const wrapUp = lastStep || limits.some((limit) => limit.used >= limit.max * WRAP_UP)
      const answered = options.output
        ? (yield* SessionOutput.progress(db, input.session.id, options.seq)).latest === "accepted"
        : true
      const answer = "your final answer"
      const handIn = answered
        ? []
        : [`Hand in the final answer by calling ${SessionOutput.NAME}; a written reply does not count.`]

      return [
        {
          kind: KIND,
          text: [
            "Budget of the current turn:",
            ...limits.map(
              (limit) =>
                `- ${limit.name}: ${limit.show(limit.used)} of ${limit.show(limit.max)} used, ` +
                `${limit.show(Math.max(0, limit.max - limit.used))} left.`,
            ),
            "These figures count what was spent before this request, " +
              "subagents and background work such as compaction included.",
            "When any one of these limits is reached the turn stops at once and no reply is sent, " +
              `so ${answer} has to come before that.`,
            ...(wrapUp ? [`A limit is nearly used up. Do not start new work; give ${answer} now.`] : []),
            ...handIn,
            ...(lastStep
              ? [
                  "This response is the last one of the turn. Tool calls made in it get no follow-up request, " +
                    `so the response itself must carry ${answer}.`,
                ]
              : []),
          ].join("\n"),
        },
      ]
    }).pipe(
      // A failed read is a defect here: the guard around a producer logs it once and the step goes on without a report.
      Effect.orDie,
    ),
})

const isBudget = (message: SessionMessage.Info) =>
  isReminder(message) && (message.metadata?.reminder as { kind: string }).kind === KIND
