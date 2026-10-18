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
import { Effect, Fiber, Layer, Logger, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AIError, TransportError } from "@orbit/ai"
import { SessionTurnEnd } from "@orbit/core/session/turn-end"
import { ReminderText } from "@orbit/core/session/reminder-text"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { LayerNode } from "@orbit/util/effect/layer-node"
import type { Database } from "@orbit/core/database/database"
import type { SessionContext } from "@orbit/core/session/context"
import { testEffect } from "./lib/effect"
import { makeLayer, scenario, scenarioOn, sessionID, type Scenario } from "./lib/runner"
import type { LspDiagnostics } from "@orbit/core/lsp/collector"

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
      ReminderText.isReminder(message) &&
      message.type === "synthetic" &&
      (message.metadata?.reminder as { kind: string }).kind === "turn-budget",
  )
const textsOf = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )
const budgets = (request: LLMRequest | undefined) =>
  textsOf(request)
    .filter((text) => text.includes("Budget of the current turn"))
    .slice(-1)

const inputOf = (messages: ReadonlyArray<SessionMessage.Info>) => ({
  session: { id: sessionID } as never,
  agent: {} as never,
  tools: [],
  model: {} as never,
  messages,
  step: 1,
  firstStep: true,
})

const unavailable = () =>
  new AIError({
    reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
  })

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
    // Step 4 of 4 is only 75 % used: the wrap-up line comes from being the last step.
    expect(budgets(s.requests[3])[0]).toContain("Do not start new work")
    expect(budgets(s.requests[2])[0]).not.toContain("Do not start new work")
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

  scenario("counts compaction spend and the cost of each response, to four decimals", function* (s) {
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
  })

  scenario("never reports a negative amount left", function* (s) {
    withProducer(s)
    s.modelCost = [price]
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxCost: Money.USD.make(2) }, resume: false })
    yield* s.llm.push(answer(spend))
    yield* s.resume
    // A subagent records spend after the limit check and before the reminder's own read.
    yield* s.bus.publish(SessionEvent.UsageRecorded, {
      sessionID,
      source: "compaction",
      cost: Money.USD.make(5),
      tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    const [entry] = yield* TurnReminder.durable(s.db).run(inputOf([]))

    expect(entry.text).toContain("- Cost: $6.0000 of $2.0000 used, $0.0000 left.")
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

  scenario("names the output tool until an answer was accepted, and not after", function* (s) {
    withProducer(s)
    s.turnEnd = SessionTurnEnd.structuredOutput(s.db).run
    yield* s.session.prompt({
      sessionID,
      text: "Work",
      turn: { maxSteps: 2, output: { schema: { type: "object" } } },
      resume: false,
    })
    yield* s.llm.push(
      TestLLM.toolCalls(
        LLMEvent.toolCall({ id: "budget-echo", name: "echo", input: { text: "side" } }),
        LLMEvent.toolCall({ id: "budget-out", name: SessionOutput.NAME, input: {} }),
      ),
      TestLLM.stop(),
    )
    yield* s.resume

    expect(s.requests).toHaveLength(2)
    expect(budgets(s.requests[0])[0]).toContain(SessionOutput.NAME)
    expect(budgets(s.requests[0])[0]).not.toContain("last one")
    expect(budgets(s.requests[1])[0]).toContain("last one")
    expect(budgets(s.requests[1])[0]).not.toContain(SessionOutput.NAME)
  })

  scenario("never names the output tool on a turn without a structured answer", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 1 }, resume: false })
    yield* s.llm.push(answer())
    yield* s.resume

    expect(budgets(s.requests[0])[0]).toContain("last one")
    expect(budgets(s.requests[0])[0]).not.toContain(SessionOutput.NAME)
  })

  scenario("leaves a queued prompt without options out", function* (s) {
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

  scenario("lets a steer without options join the turn, counting on from the same window", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 5 }, resume: false })
    yield* s.llm.push(toolStep(), toolStep(), answer())
    const tools = yield* s.blockTools()
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* s.session.prompt({ sessionID, text: "Steer", resume: false })
    yield* tools.release
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(3)
    ;[0, 1, 2].forEach((used) =>
      expect(budgets(s.requests[used])[0]).toContain(`- Steps: ${used} of 5 used, ${5 - used} left.`),
    )
    expect(budgetRows(yield* s.context)).toHaveLength(3)
  })

  scenario("stops reporting after a steer that sets empty options lifts the limits", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 5 }, resume: false })
    yield* s.llm.push(toolStep(), toolStep(), answer())
    const tools = yield* s.blockTools()
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* tools.started
    yield* s.session.prompt({ sessionID, text: "Steer", turn: {}, resume: false })
    yield* tools.release
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(3)
    expect(budgets(s.requests[0])).toHaveLength(1)
    expect(budgetRows(yield* s.context)).toHaveLength(1)
  })

  scenario("keeps one row per logical step across a retried step", function* (s) {
    withProducer(s)
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 3 }, resume: false })
    yield* s.llm.push(Stream.fail(unavailable()))
    yield* s.llm.push(answer())
    const scheduled = yield* Queue.unbounded<SessionMessage.ID>()
    yield* s.bus.subscribe(SessionEvent.RetryScheduled).pipe(
      Stream.filter((event) => event.data.sessionID === sessionID),
      Stream.runForEach((event) => Queue.offer(scheduled, event.data.assistantMessageID)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("1 minute")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(budgetRows(yield* s.context)).toHaveLength(1)
  })
})

describe("the production node", () => {
  const late = {
    file: "/project/src/late.ts",
    diagnostics: [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 1,
        message: "late problem",
      },
    ],
  }
  let pending = true
  const diagnostics: LspDiagnostics.Interface = {
    touch: () => Effect.void,
    size: () => Effect.succeed(0),
    drain: () =>
      Effect.sync(() => {
        const out = pending ? [late] : []
        pending = false
        return out
      }),
  }
  const production = scenarioOn(testEffect(makeLayer(true, diagnostics)))

  production("publishes the budget row after the diagnostics row", function* (s) {
    yield* s.session.prompt({ sessionID, text: "Work", turn: { maxSteps: 2 }, resume: false })
    yield* s.llm.push(answer())
    yield* s.resume

    const kinds = (yield* s.context).flatMap((message) =>
      ReminderText.isReminder(message) && message.type === "synthetic"
        ? [(message.metadata?.reminder as { kind: string }).kind]
        : [],
    )
    expect(kinds).toEqual(["lsp-diagnostics", "turn-budget"])
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
    // The history as it stood before the row was stored, and as a restarted drain loads it after.
    expect(yield* producer.run(inputOf(loaded.slice(0, stored)))).toHaveLength(1)
    expect(yield* producer.run(inputOf(loaded.slice(0, stored + 1)))).toEqual([])
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
