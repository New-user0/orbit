import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Session } from "@orbit/core/session"
import { ContextUsageReminder } from "@orbit/core/session/context-usage-reminder"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionReminders } from "@orbit/core/session/reminders"
import { testEffect } from "./lib/effect"

/**
 * prompts-context-7: the context-window usage reminder. As in the reference it is off unless the person switches it on
 * with an environment variable, and then tells the main conversation, on every step, how much of the window the last
 * response used. The step, cost and token budgets of a turn stay with TurnReminder.
 */

const it = testEffect(Layer.empty)
const at = Date.now()
const history = (messages: ReadonlyArray<unknown>) =>
  messages.map((message) => Schema.decodeUnknownSync(SessionMessage.Info)(message))
const assistant = (id: string, tokens?: { input: number; output: number; reasoning: number; read: number; write: number }) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "fake", id: "fake-model" },
  content: [],
  ...(tokens
    ? {
        tokens: {
          input: tokens.input,
          output: tokens.output,
          reasoning: tokens.reasoning,
          cache: { read: tokens.read, write: tokens.write },
        },
      }
    : {}),
  time: { created: at, completed: at },
})
const row = (id: string, kind: string) => ({
  id,
  type: "synthetic",
  text: "<system-reminder>\nposted\n</system-reminder>",
  metadata: { reminder: { kind } },
  time: { created: at },
})

const input = (messages: ReadonlyArray<unknown>, limit = { context: 200_000, output: 32_000 }) => ({
  session: { id: Session.ID.make("ses_usage_reminder") } as never,
  agent: {} as never,
  tools: [],
  model: { limit } as never,
  messages: history(messages),
  step: 1,
  firstStep: false,
})

// The switch is read when the producer runs, as the reference reads it on every collection.
const switched = <A, E, R>(value: string | undefined, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const before = process.env[ContextUsageReminder.ENV]
      if (value === undefined) delete process.env[ContextUsageReminder.ENV]
      else process.env[ContextUsageReminder.ENV] = value
      return before
    }),
    () => effect,
    (before) =>
      Effect.sync(() => {
        if (before === undefined) delete process.env[ContextUsageReminder.ENV]
        else process.env[ContextUsageReminder.ENV] = before
      }),
  )

const producer = ContextUsageReminder.producer
const tokens = { input: 1_000, output: 200, reasoning: 50, read: 300, write: 0 }

describe("the context-window usage reminder", () => {
  it.effect("is named ORBIT_ENABLE_CONTEXT_USAGE_REMINDER and is off unless it is switched on", () =>
    Effect.gen(function* () {
      expect(ContextUsageReminder.ENV).toBe("ORBIT_ENABLE_CONTEXT_USAGE_REMINDER")
      for (const value of [undefined, "", "0", "false", "no"])
        expect(yield* switched(value, producer.run(input([assistant("msg_0000000001", tokens)])))).toEqual([])
      for (const value of ["1", "true", "TRUE"])
        expect(yield* switched(value, producer.run(input([assistant("msg_0000000001", tokens)])))).toHaveLength(1)
    }),
  )

  it.effect("reports the last response's tokens against the window less the reserve for a summary", () =>
    Effect.gen(function* () {
      const used = tokens.input + tokens.output + tokens.reasoning + tokens.read + tokens.write
      // The usable window is the context less the smaller of the model's output limit and 20,000 tokens.
      const entries = yield* switched(
        "1",
        producer.run(input([assistant("msg_0000000001", { ...tokens, input: 9 }), assistant("msg_0000000002", tokens)])),
      )
      expect(entries).toEqual([
        {
          kind: ContextUsageReminder.KIND,
          text: `Context window: ${used} of 180000 tokens used, ${180_000 - used} left.`,
        },
      ])
      const small = yield* switched(
        "1",
        producer.run(input([assistant("msg_0000000001", tokens)], { context: 100_000, output: 8_000 })),
      )
      expect(small[0].text).toBe(`Context window: ${used} of 92000 tokens used, ${92_000 - used} left.`)
    }),
  )

  it.effect("counts from the newest response that has a count, and from zero before the first", () =>
    Effect.gen(function* () {
      const used = tokens.input + tokens.output + tokens.reasoning + tokens.read + tokens.write
      const after = yield* switched("1", producer.run(input([assistant("msg_0000000001", tokens), assistant("msg_0000000002")])))
      expect(after[0].text).toBe(`Context window: ${used} of 180000 tokens used, ${180_000 - used} left.`)
      const first = yield* switched("1", producer.run(input([])))
      expect(first[0].text).toBe("Context window: 0 of 180000 tokens used, 180000 left.")
    }),
  )

  it.effect("says nothing when the model's window is not known", () =>
    Effect.gen(function* () {
      expect(yield* switched("1", producer.run(input([], { context: 0, output: 32_000 })))).toEqual([])
      // The control: the same step with a known window gets the line.
      expect(yield* switched("1", producer.run(input([], { context: 64_000, output: 32_000 })))).toHaveLength(1)
    }),
  )

  it.effect("is posted once per run, for the main conversation only, and not in the minimal lists", () =>
    Effect.gen(function* () {
      const posted = [assistant("msg_0000000001", tokens), row("msg_0000000002", ContextUsageReminder.KIND)]
      expect(yield* switched("1", producer.run(input(posted)))).toEqual([])
      expect(yield* switched("1", producer.run(input(posted.slice(0, 1))))).toHaveLength(1)
      expect(producer.scope).toBe("primary")
      expect(SessionReminders.minimal({ durable: [producer], derived: [] }).durable).toEqual([])
    }),
  )
})
