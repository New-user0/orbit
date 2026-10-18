import { describe, expect } from "bun:test"
import { LLMEvent, type LLMRequest } from "@orbit/ai"
import { TestLLM } from "@orbit/ai/testing"
import { Money } from "@orbit/schema/money"
import { StepFailedError } from "@orbit/core/session/error"
import { SessionEvent } from "@orbit/core/session/event"
import type { SessionMessage } from "@orbit/core/session/message"
import { SessionOutput } from "@orbit/core/session/output"
import { SessionReminders } from "@orbit/core/session/reminders"
import { TurnReminder } from "@orbit/core/session/turn-reminder"
import { Effect, Layer, Logger } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { LayerNode } from "@orbit/util/effect/layer-node"
import type { Database } from "@orbit/core/database/database"
import type { SessionContext } from "@orbit/core/session/context"
import { testEffect } from "./lib/effect"
import { scenario, sessionID, type Scenario } from "./lib/runner"

// A price of $0.50 per token, so one token in and one out cost $1.
const price = {
  input: Money.USDPerMillionTokens.make(500_000),
  output: Money.USDPerMillionTokens.make(500_000),
  cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
}
const spend = { nonCachedInputTokens: 1, outputTokens: 1 }

let calls = 0
const toolStep = (usage?: typeof spend) =>
  TestLLM.complete(
    { reason: { normalized: "tool-calls" }, usage },
    LLMEvent.toolCall({ id: `budget-call-${calls++}`, name: "echo", input: { text: "x" } }),
  )
const answer = (usage?: typeof spend) =>
  TestLLM.complete(
    { reason: { normalized: "stop" }, usage },
    LLMEvent.textStart({ id: "answer" }),
    LLMEvent.textDelta({ id: "answer", text: "Done" }),
    LLMEvent.textEnd({ id: "answer" }),
  )

const budgetRows = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.filter(
    (message): message is Extract<SessionMessage.Info, { type: "synthetic" }> =>
      message.type === "synthetic" &&
      (message.metadata?.reminder as { kind?: unknown } | undefined)?.kind === "turn-budget",
  )
const textsOf = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )
const budgets = (request: LLMRequest | undefined) =>
  textsOf(request).filter((text) => text.includes("Budget of the current turn")).slice(-1)

const withProducer = (s: Scenario) => {
  s.reminders.durable = [TurnReminder.durable(s.db)]
}
const limited = (s: Scenario) =>
  s.resume.pipe(
    Effect.flip,
    Effect.flatMap((error) => (error instanceof StepFailedError ? Effect.succeed(error.error) : Effect.die(error))),
  )

describe("the budget reminder of a turn with limits", () => {
  scenario("rides every step of a step-limited turn and counts from the steps used", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 4 }, resume: false })
    yield* s.llm.push(toolStep(), toolStep(), toolStep(), answer())
    yield* s.resume

    expect(s.requests).toHaveLength(4)
    s.requests.forEach((request) => expect(budgets(request)).toHaveLength(1))
    expect(budgets(s.requests[0])[0]).toContain("- Steps: 0 of 4 used, 4 left.")
    expect(budgets(s.requests[1])[0]).toContain("- Steps: 1 of 4 used, 3 left.")
    expect(budgets(s.requests[2])[0]).toContain("- Steps: 2 of 4 used, 2 left.")
    expect(budgets(s.requests[3])[0]).toContain("- Steps: 3 of 4 used, 1 left.")
    // Only the last step is called the last one.
    s.requests.slice(0, 3).forEach((request) => expect(budgets(request)[0]).not.toContain("last one"))
    expect(budgets(s.requests[3])[0]).toContain("last one")
    expect(budgetRows(yield* s.context)).toHaveLength(4)
  })

  scenario("publishes nothing after the response that reaches the limit", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 4 }, resume: false })
    yield* s.llm.push(toolStep(), toolStep(), toolStep(), toolStep(), toolStep())

    expect(yield* limited(s)).toMatchObject({ type: "limit.steps" })
    expect(s.requests).toHaveLength(4)
    expect(budgetRows(yield* s.context)).toHaveLength(4)
  })

  for (const [name, turn] of [
    ["no options", undefined],
    ["a fallback model only", { fallbackModel: { providerID: "fake", id: "other" } }],
    ["a structured answer only", { output: { schema: { type: "object" } } }],
  ] as const)
    scenario(`adds nothing to a turn with ${name}`, function* (s) {
      withProducer(s)
      yield* s.session.prompt({ sessionID, text: "Work", ...(turn ? { turn: turn as never } : {}), resume: false })
      yield* s.llm.push(toolStep(), answer())
      yield* s.resume.pipe(Effect.ignore)

      expect(budgetRows(yield* s.context)).toEqual([])
    })

  scenario("counts compaction spend and the cost of each response, to four decimals, and clamps nothing below zero", function* (s) {
    withProducer(s)
    s.modelCost = [price]
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxCost: Money.USD.make(10) }, resume: false })
    yield* s.llm.push(toolStep(spend), answer(spend))
    const first = yield* s.resumePaused
    yield* s.bus.publish(SessionEvent.UsageRecorded, {
      sessionID,
      source: "compaction",
      cost: Money.USD.make(4),
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    yield* first.finish

    expect(budgets(s.requests[0])[0]).toContain("- Cost: $0.0000 of $10.0000 used, $10.0000 left.")
    // $1 for the response and $4 for the compaction record.
    expect(budgets(s.requests[1])[0]).toContain("- Cost: $5.0000 of $10.0000 used, $5.0000 left.")
    expect(budgets(s.requests[1])[0]).not.toMatch(/-$/)
  })

  scenario("reports tokens as input, cache write, output and reasoning", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxTokens: 100 }, resume: false })
    yield* s.llm.push(
      TestLLM.complete(
        {
          reason: { normalized: "tool-calls" },
          usage: { nonCachedInputTokens: 3, cacheReadInputTokens: 50, cacheWriteInputTokens: 2, outputTokens: 5 },
        },
        LLMEvent.toolCall({ id: "tokens-call", name: "echo", input: { text: "x" } }),
      ),
      answer(),
    )
    yield* s.resume

    expect(budgets(s.requests[1])[0]).toContain("- Tokens: 10 of 100 used, 90 left.")
  })

  scenario("asks for the final answer from 90 percent of a limit, and not before", function* (s) {
    withProducer(s)
    s.modelCost = [price]
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxCost: Money.USD.make(10) }, resume: false })
    yield* s.llm.push(toolStep({ nonCachedInputTokens: 10, outputTokens: 8 }), answer())
    yield* s.resume

    expect(budgets(s.requests[0])[0]).not.toContain("Do not start new work")
    expect(budgets(s.requests[1])[0]).toContain("Do not start new work")
    expect(budgets(s.requests[1])[0]).not.toContain("last one")
  })

  scenario("calls the only step of a one-step turn the last one", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 1 }, resume: false })
    yield* s.llm.push(answer())
    yield* s.resume

    expect(s.requests).toHaveLength(1)
    expect(budgets(s.requests[0])[0]).toContain("- Steps: 0 of 1 used, 1 left.")
    expect(budgets(s.requests[0])[0]).toContain("last one")
  })

  scenario("names the output tool on the last step until an answer was accepted", function* (s) {
    withProducer(s)
    yield* s.session.prompt({
      sessionID,
      text: "Work",
      turn: { maxSteps: 2, output: { schema: { type: "object" } } },
      resume: false,
    })
    yield* s.llm.push(toolStep(), answer())
    yield* s.resume.pipe(Effect.ignore)

    expect(budgets(s.requests[0])[0]).not.toContain("last one")
    expect(budgets(s.requests[0])[0]).toContain(SessionOutput.NAME)
    expect(budgets(s.requests[1])[0]).toContain("last one")
    expect(budgets(s.requests[1])[0]).toContain(SessionOutput.NAME)
  })

  scenario("leaves a queued prompt without options out and lets a steer join the turn", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 3 }, resume: false })
    yield* s.session.prompt({ sessionID, text: "Queued", delivery: "queue", resume: false })
    yield* s.llm.push(answer(), answer())
    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(budgets(s.requests[0])).toHaveLength(1)
    // The queued prompt began a turn that sets no limit.
    expect(budgetRows(yield* s.context)).toHaveLength(1)
  })

  scenario("keeps one row per logical step across a retried step", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 3 }, resume: false })
    yield* s.llm.push(toolStep(), answer())
    yield* s.resume

    expect(budgetRows(yield* s.context)).toHaveLength(2)
  })
})

describe("the producer", () => {
  scenario("does not report twice into the same run (restart guard)", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 3 }, resume: false })
    yield* s.llm.push(answer())
    yield* s.resume
    const producer = TurnReminder.durable(s.db)
    const loaded = yield* s.context
    const stored = loaded.findIndex((message) => budgetRows([message]).length === 1)
    const input = (messages: ReadonlyArray<SessionMessage.Info>) => ({
      session: { id: sessionID } as never,
      agent: {} as never,
      tools: [],
      model: {} as never,
      messages,
      step: 1,
      firstStep: true,
    })
    // The history as it stood before the row was stored, and as a restarted drain loads it after.
    expect(yield* producer.run(input(loaded.slice(0, stored)))).toHaveLength(1)
    expect(yield* producer.run(input(loaded.slice(0, stored + 1)))).toEqual([])
  })

  scenario("is for the main conversation only and left out of the minimal lists", function* (s) {
    const producer = TurnReminder.durable(s.db)
    expect(producer.scope).toBe("primary")
    expect(SessionReminders.minimal({ durable: [producer], derived: [] }).durable).toEqual([])
  })

  scenario("is hidden, harness-only text with no data block", function* (s) {
    withProducer(s)
    s.modelCost = [price]
    yield* s.session.prompt({
      sessionID,
      text: "Work",
      turn: { maxSteps: 2, maxCost: Money.USD.make(10) },
      resume: false,
    })
    yield* s.llm.push(answer(spend))
    yield* s.resume

    const row = budgetRows(yield* s.context)[0]
    expect(row).not.toHaveProperty("description")
    expect(row.text).not.toContain("```")
    expect(row.text.startsWith("<system-reminder>\n")).toBe(true)
    expect(row.text.indexOf("- Steps:")).toBeLessThan(row.text.indexOf("- Cost:"))
    expect(row.text).not.toContain("Tokens")
  })

})

describe("a failing producer", () => {
  const unit = testEffect(Layer.empty)

  unit.effect("yields nothing and logs one warning when its read dies", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        if (entry.level === "WARN") warnings.push(entry.annotations.producer)
      })
      const failing = {
        select: () => {
          throw new Error("database gone")
        },
      } as unknown as Database.Interface["db"]
      const loaded = {
        session: { id: sessionID },
        agent: { info: {} },
        model: {},
        tools: { definitions: [] },
        messages: [],
      } as unknown as SessionContext.Loaded
      const published = yield* Effect.gen(function* () {
        const reminders = yield* SessionReminders.Service
        return yield* reminders.collect({ loaded, step: 1 })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(
            LayerNode.group([
              Bus.node,
              SessionReminders.configured({ durable: [TurnReminder.durable(failing)], derived: [] }),
            ]),
          ),
        ),
        Effect.provide(Logger.layer([logger])),
      )

      expect(published).toBe(false)
      expect(warnings).toEqual(["turn-budget"])
    }),
  )
})
