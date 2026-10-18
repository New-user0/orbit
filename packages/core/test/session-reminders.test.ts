import { describe, expect, test } from "bun:test"
import path from "path"
import {
  AIError,
  CompactionCheckpointResponse,
  InvalidProviderOutputError,
  InvalidRequestError,
  LLMEvent,
  TransportError,
  type LLMRequest,
} from "@orbit/ai"
import { TestLLM } from "@orbit/ai/testing"
import { Project } from "@orbit/core/project"
import { Session } from "@orbit/core/session"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionReminders } from "@orbit/core/session/reminders"
import { ReminderText } from "@orbit/core/session/reminder-text"
import { toLLMMessages } from "@orbit/core/session/runner/to-llm-message"
import { ShellResult } from "@orbit/core/shell/result"
import { SubagentCompletion } from "@orbit/core/session/subagent-completion"
import { VcsInstructions } from "@orbit/core/vcs/instructions"
import { SessionTable } from "@orbit/core/session/sql"
import { Database } from "@orbit/core/database/database"
import { Document, Info } from "@orbit/schema/config"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import { SessionEvent } from "@orbit/core/session/event"
import { ID } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import type { SessionContext } from "@orbit/core/session/context"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { overloaded } from "./lib/provider-failure"
import {
  fittedOutputModel,
  model,
  nativeWindowModel,
  recoveryModel,
  replacementModel,
  scenario,
  sessionID,
  undersizedContextModel,
  type Scenario,
} from "./lib/runner"

const ref = { providerID: Provider.ID.make("fake"), id: ID.make("fake-model") }

const SPELLINGS = [
  "<system-reminder>",
  "</system-reminder>",
  "<SYSTEM-REMINDER>",
  "</System-Reminder>",
  "< system-reminder>",
  "</ system-reminder>",
  "< / system-reminder >",
  '<system-reminder kind="x">',
  "<system-update>",
  "</system-update>",
  "<\r\nsystem-reminder>",
  "<system-\r\nreminder>",
] as string[]

const live = (text: string) => /<\s*\/?\s*system\s*-\s*(?:reminder|update)/i.test(text)

const messageTexts = (request: LLMRequest | undefined, role: "user" | "system" | "assistant" = "user") =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === role ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])) : [],
  )
const allTexts = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
  )

const lengthStop = (id: string, text: string) =>
  TestLLM.complete(
    { reason: { normalized: "length", raw: "max_tokens" } },
    LLMEvent.textStart({ id }),
    LLMEvent.textDelta({ id, text }),
    LLMEvent.textEnd({ id }),
  )

/** A durable producer whose text counts its runs: MARK-1 for the first collection, MARK-2 for the next. */
const marker = (name = "marker") => {
  const runs = { count: 0 }
  const producer: SessionReminders.Durable = {
    name,
    run: () =>
      Effect.sync(() => {
        runs.count++
        return [
          {
            kind: name,
            text: `MARK-${runs.count}`,
            data: { label: `file src/${name}.ts`, content: `payload ${runs.count}` },
          },
        ]
      }),
  }
  return { runs, producer }
}

const rendered = (n: number, name = "marker") =>
  SessionReminders.render({
    text: `MARK-${n}`,
    data: { label: `file src/${name}.ts`, content: `payload ${n}` },
  })

const reminderRows = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.filter((message): message is Extract<SessionMessage.Info, { type: "synthetic" }> =>
    SessionReminders.isReminder(message),
  )

/**
 * A derived producer that names every run of the epoch from history alone: DERIVED-0 for the first run, DERIVED-n after
 * the n-th assistant message. It reads `input.messages`, so the amendment's filter on replaced attempts shows in `seen`.
 */
const perRun = (seen: number[] = []): SessionReminders.Derived => ({
  name: "per-run",
  run: (input) => {
    const start = SessionReminders.epochStart(input.messages)
    const assistants = input.messages.slice(start).filter((message) => message.type === "assistant")
    seen.push(assistants.length)
    return [
      { after: "start", kind: "per-run", text: "DERIVED-0" },
      ...assistants.map((message, index) => ({
        after: index === assistants.length - 1 ? ("tail" as const) : message.id,
        kind: "per-run",
        text: `DERIVED-${index + 1}`,
      })),
    ]
  },
})

const subscribeRetries = (s: Scenario) =>
  Effect.gen(function* () {
    const scheduled = yield* Queue.unbounded<SessionMessage.ID>()
    yield* s.bus.subscribe(SessionEvent.RetryScheduled).pipe(
      Stream.filter((event) => event.data.sessionID === sessionID),
      Stream.runForEach((event) => Queue.offer(scheduled, event.data.assistantMessageID)),
      Effect.forkScoped({ startImmediately: true }),
    )
    return scheduled
  })

const unavailable = () =>
  new AIError({
    reason: new TransportError({ message: "Provider unavailable", transport: "http", operation: "request" }),
  })

// The prompts are admitted with the editor and agents their payload carries, as the server stores them: admission
// itself is tested in session-prompt-editor.test.ts.
const admitWithContext = (s: Scenario, text: string, name: string) =>
  s.sessionInbox.admit({
    id: SessionMessage.ID.create(),
    sessionID,
    item: {
      type: "user",
      delivery: "steer",
      payload: SessionInbox.UserPayload.make({
        text,
        agents: [{ name }],
        editor: { path: path.join(process.cwd(), `${name}.ts`) },
      }),
    },
  })

describe("a prompt's context notes on a minimal instance", () => {
  for (const minimal of [false, true])
    scenario(`${minimal ? "a minimal" : "the production"} instance lowers a prompt's notes`, function* (s) {
      s.reminders.minimal = minimal
      yield* admitWithContext(s, "Look and echo", "first")
      yield* s.llm.push(
        TestLLM.toolCalls(LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "keep" } })),
        TestLLM.text("Handled", "text-after-steer"),
      )
      const tools = yield* s.blockTools(1)
      const run = yield* s.resume.pipe(Effect.forkChild)
      yield* tools.started
      yield* admitWithContext(s, "STEER", "second")
      yield* tools.release
      yield* Fiber.join(run)

      // The first prompt keeps its hint and editor note on the production instance only. The steer keeps the mid-turn
      // note on both, and neither hint nor editor note.
      expect(messageTexts(s.requests[0]).length).toBe(minimal ? 1 : 3)
      expect(messageTexts(s.requests[0]).at(-1)).toBe("Look and echo")
      const steer = messageTexts(s.requests[1]).slice(-2)
      expect(steer[0]).toContain("must not be ignored")
      expect(steer[1]).toBe("STEER")
    })
})

describe("collection", () => {
  scenario(
    "publishes one hidden row per step, which lowers ahead of the prompt as an envelope and a data block",
    function* (s) {
      const { producer, runs } = marker()
      s.reminders.durable = [producer]
      yield* s.llm.push(TestLLM.text("Answer", "answer"))
      yield* s.runPrompt("Question")

      const rows = reminderRows(yield* s.context)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        type: "synthetic",
        text: rendered(1),
        metadata: { reminder: { kind: "marker", label: "file src/marker.ts" } },
      })
      expect(rows[0]).not.toHaveProperty("description")
      expect(runs.count).toBe(1)
      // Stored after the prompt, lowered before it.
      expect(messageTexts(s.requests[0])).toEqual([rendered(1), "Question"])
      expect(rendered(1)).toBe(
        "<system-reminder>\nMARK-1\n</system-reminder>\n\nfile src/marker.ts:\n```\npayload 1\n```",
      )
    },
  )

  scenario("keeps list order when a later producer finishes first", function* (s) {
    const later = yield* Deferred.make<void>()
    s.reminders.durable = [
      {
        name: "slow",
        run: () => Deferred.await(later).pipe(Effect.as([{ kind: "slow", text: "FIRST-IN-LIST" }])),
      },
      {
        name: "fast",
        run: () => Deferred.succeed(later, undefined).pipe(Effect.as([{ kind: "fast", text: "SECOND-IN-LIST" }])),
      },
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.runPrompt("Question")

    expect(reminderRows(yield* s.context).map((row) => row.metadata?.reminder)).toEqual([
      { kind: "slow" },
      { kind: "fast" },
    ])
  })

  scenario("drops an entry with no text and no data", function* (s) {
    s.reminders.durable = [
      { name: "empty", run: () => Effect.succeed([{ kind: "empty", text: "" }]) },
      { name: "none", run: () => Effect.succeed([]) },
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.runPrompt("Question")

    expect(reminderRows(yield* s.context)).toHaveLength(0)
    expect(messageTexts(s.requests[0])).toEqual(["Question"])
  })

  const esc = String.fromCharCode(27)

  scenario("stores a description as client text, escaped, and still hides the others", function* (s) {
    s.reminders.durable = [
      { name: "described", run: () => Effect.succeed([{ kind: "d", text: "T", description: "line one\nline two" }]) },
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.runPrompt("Question")

    expect(reminderRows(yield* s.context)[0]).toMatchObject({ description: expect.not.stringContaining(esc) })
  })

  scenario("does not collect again for a retried attempt", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.admit("Question")
    yield* s.llm.push(Stream.fail(unavailable()))
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("1 minute")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(runs.count).toBe(1)
    expect(reminderRows(yield* s.context)).toHaveLength(1)
    expect(messageTexts(s.requests[1])).toEqual(messageTexts(s.requests[0]))
  })

  const fallbackModel = { providerID: Provider.ID.make("fake"), id: ID.make("replacement") }

  scenario("collects once across a fallback switch and keeps the fallback after the reload", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.session.prompt({ sessionID, text: "Question", turn: { fallbackModel }, resume: false })
    yield* s.llm.push(Stream.fail(overloaded()), Stream.fail(overloaded()), Stream.fail(overloaded()))
    yield* s.llm.push(TestLLM.tool("call-1", "echo", { text: "x" }), TestLLM.text("Done", "done"))
    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    for (let index = 0; index < 2; index++) {
      yield* Queue.take(scheduled)
      yield* TestClock.adjust("1 minute")
    }
    yield* Fiber.join(run)

    // One collection for the first step, one for the second step after the tool round: the retries and the switch
    // reused the first. The second step's reload keeps the turn on the fallback model.
    expect(runs.count).toBe(2)
    expect(s.requests.map((request) => request.model)).toEqual([
      model,
      model,
      model,
      replacementModel,
      replacementModel,
    ])
  })

  scenario("collects again for a step that follows a tool round, and places it after the tool results", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.llm.push(TestLLM.tool("call-1", "echo", { text: "x" }), TestLLM.text("Done", "done"))
    yield* s.runPrompt("Question")

    expect(runs.count).toBe(2)
    expect(reminderRows(yield* s.context).map((row) => row.text)).toEqual([rendered(1), rendered(2)])
    const roles = s.requests[1]?.messages.map((message) => message.role)
    // MARK-1 and the prompt, the assistant call and its result, then the new reminder.
    expect(roles).toEqual(["user", "user", "assistant", "tool", "user"])
    expect(messageTexts(s.requests[1]).at(-1)).toBe(rendered(2))
  })

  scenario("does not collect again for the continuation of an incomplete stream", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.admit("Question")
    yield* s.llm.push(
      TestLLM.failAfter(
        new AIError({
          reason: new InvalidProviderOutputError({
            classification: "incomplete-stream",
            message: "The provider response ended unexpectedly.",
          }),
        }),
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.textStart({ id: "partial" }),
        LLMEvent.textDelta({ id: "partial", text: "Partial" }),
      ),
    )
    yield* s.llm.push(TestLLM.text(" rest", "rest"))
    const scheduled = yield* subscribeRetries(s)
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust("1 minute")
    yield* Fiber.join(run)

    expect(s.requests).toHaveLength(2)
    expect(runs.count).toBe(1)
    expect(reminderRows(yield* s.context)).toHaveLength(1)
  })

  scenario("re-collects exactly once when a later iteration of a collected step compacts", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    // The first reply is cut off at the output limit, and the window shrinks while it streams, so the text-only resume
    // that follows crosses the compaction threshold on a step that already collected.
    yield* s.llm.push(
      Stream.unwrap(
        Effect.sync(() => {
          s.currentModel = undersizedContextModel
          return Stream.fromIterable(lengthStop("cut", "Part"))
        }),
      ),
      TestLLM.text("## Objective\n- Carry on", "summary"),
      TestLLM.text(" rest", "rest"),
    )
    yield* s.runPrompt("Question")

    expect(s.requests).toHaveLength(3)
    expect(runs.count).toBe(2)
    expect(allTexts(s.requests[1]).join("\n")).not.toContain("MARK-")
    expect(allTexts(s.requests[2])).toContain(rendered(2))
    expect(allTexts(s.requests[2])).not.toContain(rendered(1))
  })

  scenario("does not collect for an output-limit resume of a text-only reply", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.llm.push(lengthStop("cut", "Part"), TestLLM.text(" rest", "rest"))
    yield* s.runPrompt("Question")

    expect(s.requests).toHaveLength(2)
    expect(runs.count).toBe(1)
    expect(reminderRows(yield* s.context)).toHaveLength(1)
  })

  scenario(
    "sends an escalated retry byte for byte as the original with a durable row and a derived insertion",
    function* (s) {
      const { producer, runs } = marker()
      const seen: number[] = []
      s.reminders.durable = [producer]
      s.reminders.derived = [perRun(seen)]
      yield* s.configControl!.setEntries([
        new Document({ type: "document", info: new Info({ output_token_cap: 8_000 }) }),
      ])
      s.currentModel = fittedOutputModel
      yield* s.llm.push(lengthStop("first", "FirstCut"), TestLLM.text("Whole", "whole"))
      yield* s.runPrompt("Question")

      expect(s.requests.map((request) => request.generation?.maxTokens)).toEqual([8_000, 64_000])
      expect(s.requests[1]?.messages).toEqual(s.requests[0]?.messages)
      expect(allTexts(s.requests[0])).toContain("<system-reminder>\nDERIVED-0\n</system-reminder>")
      expect(runs.count).toBe(1)
      // The cut-off attempt and its notice are invisible to the producers.
      expect(seen).toEqual([0, 0])
    },
  )

  scenario("publishes no second entry for the resumes after an escalation", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.configControl!.setEntries([
      new Document({ type: "document", info: new Info({ output_token_cap: 8_000 }) }),
    ])
    s.currentModel = fittedOutputModel
    yield* s.llm.push(lengthStop("a", "A"), lengthStop("b", "B"), TestLLM.text("C", "c"))
    yield* s.runPrompt("Question")

    expect(s.requests).toHaveLength(3)
    expect(runs.count).toBe(1)
    expect(reminderRows(yield* s.context)).toHaveLength(1)
  })
})

describe("isolation", () => {
  scenario("lets a producer that dies or runs past its limit cost only itself", function* (s) {
    const started = yield* Deferred.make<void>()
    s.reminders.durable = [
      { name: "dies", run: () => Effect.die("boom") },
      { name: "hangs", run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)) },
      { name: "good", run: () => Effect.succeed([{ kind: "good", text: "GOOD" }]) },
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.admit("Question")
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust("2 seconds")
    yield* Fiber.join(run)

    expect(reminderRows(yield* s.context).map((row) => row.metadata?.reminder)).toEqual([{ kind: "good" }])
  })

  scenario("lets a producer ask for a longer limit than the default second", function* (s) {
    const started = yield* Deferred.make<void>()
    s.reminders.durable = [
      {
        name: "patient",
        timeout: "3 seconds",
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.sleep("2 seconds")),
            Effect.as([{ kind: "patient", text: "LATE" }]),
          ),
      },
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.admit("Question")
    const run = yield* s.resume.pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* TestClock.adjust("2 seconds")
    yield* Fiber.join(run)

    expect(reminderRows(yield* s.context).map((row) => row.metadata?.reminder)).toEqual([{ kind: "patient" }])
  })

  scenario("does not swallow an interruption", function* (s) {
    s.reminders.durable = [{ name: "interrupted", run: () => Effect.interrupt }]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.admit("Question")
    const exit = yield* s.resume.pipe(Effect.exit)

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    expect(s.requests).toHaveLength(0)
  })

  scenario("runs a primary producer for a top-level session only", function* (s) {
    const primary = marker("primary")
    const all = marker("all")
    s.reminders.durable = [{ ...primary.producer, scope: "primary" }, all.producer]
    const child = Session.ID.make("ses_reminder_child")
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: child,
        project_id: Project.ID.global,
        parent_id: sessionID,
        slug: child,
        directory: "/project",
        title: "child",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.session.prompt({ sessionID: child, text: "Child question", resume: false })
    yield* s.session.resume(child)

    expect(primary.runs.count).toBe(0)
    expect(all.runs.count).toBe(1)
  })

  test("keeps only the producers that mark themselves minimal on a bare or vanilla instance", () => {
    const keep = { name: "queued", minimal: true, run: () => Effect.succeed([]) }
    const drop = { name: "other", run: () => Effect.succeed([]) }
    const lists = SessionReminders.minimal({
      durable: [drop, keep],
      derived: [
        { name: "d-drop", run: () => [] },
        { name: "d-keep", minimal: true, run: () => [] },
      ],
    })

    expect(lists.durable.map((producer) => producer.name)).toEqual(["queued"])
    expect(lists.derived.map((producer) => producer.name)).toEqual(["d-keep"])
    expect(SessionReminders.minimal(SessionReminders.production)).toEqual({ durable: [], derived: [], minimal: true })
  })
})

describe("collect", () => {
  const unit = testEffect(Layer.empty)
  const loaded = (messages: ReadonlyArray<SessionMessage.Info> = []) =>
    ({
      session: { id: sessionID },
      agent: { info: {} },
      model: {},
      tools: { definitions: [] },
      messages,
    }) as unknown as SessionContext.Loaded

  unit.effect("logs one warning per producer that dies or runs past its limit, and still returns the others", () =>
    Effect.gen(function* () {
      const warnings: Array<unknown> = []
      const logger = Logger.map(Logger.formatStructured, (entry) => {
        if (entry.level === "WARN") warnings.push(entry.annotations.producer)
      })
      const lists = {
        durable: [
          { name: "dies", run: () => Effect.die("boom") },
          { name: "hangs", run: () => Effect.never },
          { name: "good", run: () => Effect.succeed([{ kind: "good", text: "GOOD" }]) },
        ],
        derived: [],
      }
      const published = yield* Effect.gen(function* () {
        const reminders = yield* SessionReminders.Service
        const run = yield* reminders.collect({ loaded: loaded(), step: 1 }).pipe(Effect.forkChild)
        yield* TestClock.adjust("2 seconds")
        return yield* Fiber.join(run)
      }).pipe(
        Effect.provide(AppNodeBuilder.build(LayerNode.group([Bus.node, SessionReminders.configured(lists)]))),
        Effect.provide(Logger.layer([logger])),
      )

      expect(published).toBe(true)
      expect(warnings.toSorted()).toEqual(["dies", "hangs"])
    }),
  )
})

describe("compaction", () => {
  scenario("collects after the checkpoint and keeps reminder rows out of the summary request", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    s.reminders.derived = [perRun()]
    yield* s.llm.push(TestLLM.text("Earlier answer", "earlier"))
    yield* s.runPrompt("Earlier question ".repeat(700))
    s.currentModel = undersizedContextModel
    s.requests.length = 0
    yield* s.llm.push(TestLLM.text("## Objective\n- Carry on", "summary"), TestLLM.text("Recovered", "final"))
    yield* s.runPrompt("Continue")

    expect(runs.count).toBe(2)
    // The summary request neither holds the first reminder nor a derived one.
    const summary = allTexts(s.requests[0]).join("\n")
    expect(summary).not.toContain("MARK-1")
    expect(summary).not.toContain("DERIVED-")
    // The first request after the checkpoint carries the second collection and the derived reminders again.
    const final = allTexts(s.requests[1])
    expect(final.some((text) => text.includes("<summary>"))).toBe(true)
    expect(final.join("\n")).not.toContain("MARK-1")
    expect(final).toContain(rendered(2))
    expect(final).toContain("<system-reminder>\nDERIVED-0\n</system-reminder>")
    const context = yield* s.context
    expect(context.map((message) => message.type)).toEqual(["compaction", "synthetic", "assistant"])
    expect(context.find((message) => message.type === "compaction")).not.toMatchObject({
      recent: expect.stringContaining("MARK"),
    })
  })

  scenario("keeps reminder rows out of a native compaction's input", function* (s) {
    const { producer } = marker()
    s.reminders.durable = [producer]
    s.currentModel = nativeWindowModel
    s.compaction = { type: "native" }
    const checkpoint = CompactionCheckpointResponse.make({
      responseID: "resp_native",
      checkpoint: { type: "compaction", provider: nativeWindowModel.provider, encrypted: "window" },
    })
    yield* s.llm.push(TestLLM.textWithUsage("Earlier answer", "earlier", 10_000))
    yield* s.runPrompt("First request")
    expect(reminderRows(yield* s.context)).toHaveLength(1)
    yield* s.llm.push(checkpoint, TestLLM.text("After native", "after"))
    yield* s.runPrompt("Second request")

    // The compaction request is the second one; the reminder row stays out of it and is collected again afterwards.
    expect(s.requests).toHaveLength(3)
    expect(JSON.stringify(s.requests[1]?.messages)).not.toContain("MARK-")
    expect(allTexts(s.requests[2])).toContain(rendered(2))
  })

  scenario("re-collects exactly once after an overflow compaction", function* (s) {
    const { producer, runs } = marker()
    s.reminders.durable = [producer]
    yield* s.llm.push(TestLLM.text("Earlier answer", "earlier"))
    yield* s.runPrompt("Earlier question ".repeat(700))
    s.currentModel = recoveryModel
    s.requests.length = 0
    yield* s.llm.push(
      Stream.fail(
        new AIError({
          reason: new InvalidRequestError({ message: "prompt too long", classification: "context-overflow" }),
        }),
      ),
    )
    yield* s.llm.push(TestLLM.text("## Objective\n- Recover", "summary"), TestLLM.text("Recovered", "final"))
    yield* s.runPrompt("Continue")

    expect(s.requests).toHaveLength(3)
    // The earlier prompt, the rejected request, and once more after the compaction.
    expect(runs.count).toBe(3)
    const final = allTexts(s.requests[2])
    expect(final).toContain(rendered(3))
    expect(final).not.toContain(rendered(2))
    expect(allTexts(s.requests[1]).join("\n")).not.toContain("MARK-")
  })
})

describe("derived insertions", () => {
  scenario("keeps the bytes of every earlier run when the conversation grows", function* (s) {
    s.reminders.derived = [perRun()]
    yield* s.llm.push(TestLLM.tool("call-1", "echo", { text: "x" }), TestLLM.text("Done", "done"))
    yield* s.runPrompt("Question")

    const first = s.requests[0]!.messages
    const second = s.requests[1]!.messages
    expect(messageTexts(s.requests[0])).toEqual(["<system-reminder>\nDERIVED-0\n</system-reminder>", "Question"])
    expect(second.slice(0, first.length)).toEqual([...first])
    expect(second.map((message) => message.role)).toEqual(["user", "user", "assistant", "tool", "user"])
    expect(messageTexts(s.requests[1]).at(-1)).toBe("<system-reminder>\nDERIVED-1\n</system-reminder>")
  })

  scenario("puts a derived insertion after the durable rows of its run and before the prompt", function* (s) {
    s.reminders.durable = [marker().producer]
    s.reminders.derived = [perRun()]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.runPrompt("Question")

    expect(messageTexts(s.requests[0])).toEqual([
      rendered(1),
      "<system-reminder>\nDERIVED-0\n</system-reminder>",
      "Question",
    ])
  })

  scenario("sends no derived insertion in a compaction request", function* (s) {
    s.reminders.derived = [perRun()]
    yield* s.llm.push(TestLLM.text("Earlier answer", "earlier"))
    yield* s.runPrompt("Earlier question ".repeat(700))
    s.currentModel = undersizedContextModel
    s.requests.length = 0
    yield* s.llm.push(TestLLM.text("## Objective\n- x", "summary"), TestLLM.text("Recovered", "final"))
    yield* s.runPrompt("Continue")

    expect(allTexts(s.requests[0]).join("\n")).not.toContain("DERIVED-")
    expect(allTexts(s.requests[1]).join("\n")).toContain("DERIVED-0")
  })

  scenario("drops a derived insertion with no text and no data", function* (s) {
    s.reminders.derived = [
      { name: "empty", run: () => [{ after: "tail", kind: "empty", text: "" }] },
      { name: "none", run: () => [] },
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.runPrompt("Question")

    expect(messageTexts(s.requests[0])).toEqual(["Question"])
  })

  scenario("lets a failing derived producer cost only itself", function* (s) {
    s.reminders.derived = [
      {
        name: "throws",
        run: () => {
          throw new Error("boom")
        },
      },
      perRun(),
    ]
    yield* s.llm.push(TestLLM.text("Answer", "answer"))
    yield* s.runPrompt("Question")

    expect(messageTexts(s.requests[0])).toEqual(["<system-reminder>\nDERIVED-0\n</system-reminder>", "Question"])
  })
})

// The history helpers and the lowering run on constructed messages, so each case names exactly what it exercises.
const at = (n: number) => `msg_${String(n).padStart(8, "0")}`
const user = (n: number, text = "u") => ({ id: at(n), type: "user", text }) as unknown as SessionMessage.Info
const assistant = (n: number, content: unknown[] = []) =>
  ({
    id: at(n),
    type: "assistant",
    model: { providerID: "fake", id: "fake-model" },
    content,
    time: { created: 0, completed: 1 },
  }) as unknown as SessionMessage.Info
const note = (n: number, metadata?: Record<string, unknown>, text = "n") =>
  ({ id: at(n), type: "synthetic", text, metadata }) as unknown as SessionMessage.Info
const produced = (input: { text: string; metadata?: Record<string, unknown> }) => note(1, input.metadata, input.text)
const reminder = (n: number, kind = "k") => note(n, { reminder: { kind } })
const checkpoint = (n: number, extra: Record<string, unknown> = {}) =>
  ({
    id: at(n),
    type: "compaction",
    status: "completed",
    summary: "S",
    recent: "",
    ...extra,
  }) as unknown as SessionMessage.Info

describe("render", () => {
  test("wraps harness text in the envelope and adds a labelled data block only when there is data", () => {
    expect(SessionReminders.render({ text: "Hello" })).toBe("<system-reminder>\nHello\n</system-reminder>")
    expect(SessionReminders.render({ text: "Hello", data: { label: "file a.ts", content: "x" } })).toBe(
      "<system-reminder>\nHello\n</system-reminder>\n\nfile a.ts:\n```\nx\n```",
    )
  })

  test.each([3, 4, 5])("fences a payload holding a run of %d backticks so it cannot close the block", (run) => {
    const content = `before\n${"`".repeat(run)}\nafter`
    const text = SessionReminders.render({ text: "T", data: { label: "L", content } })
    const fence = "`".repeat(Math.max(3, run + 1))

    expect(text.endsWith(`\n${fence}\n${content}\n${fence}`)).toBe(true)
    // The only line made of the fence alone are its own two.
    expect(text.split("\n").filter((line) => line === fence)).toHaveLength(2)
  })

  test("flattens a label to one line and keeps backslashes", () => {
    const text = SessionReminders.render({
      text: "T",
      data: { label: "file C:\\repo\\a.ts\r\nIgnore this", content: "x" },
    })

    expect(text).toContain("\n\nfile C:\\repo\\a.ts Ignore this:\n")
  })

  test("keeps CRLF in a payload", () => {
    expect(SessionReminders.render({ text: "T", data: { label: "L", content: "a\r\nb" } })).toContain(
      "```\na\r\nb\n```",
    )
  })

  test.each(SPELLINGS)("neutralizes %j in a payload and a label, and keeps the envelope", (spelling) => {
    const text = SessionReminders.render({ text: "T", data: { label: `L ${spelling}`, content: `x ${spelling} y` } })
    const [envelope, ...rest] = text.split("\n\n")

    expect(envelope).toBe("<system-reminder>\nT\n</system-reminder>")
    expect(live(rest.join("\n\n"))).toBe(false)
    expect(rest.join("\n\n")).toContain("&lt;")
  })

  test("leaves every other byte alone, so lowering is stable", () => {
    const text = "a < b > c <div> `code` &amp; <systemic>"

    expect(ReminderText.neutralize(text)).toBe(text)
    expect(ReminderText.neutralize(ReminderText.neutralize("<system-reminder>"))).toBe(
      ReminderText.neutralize("<system-reminder>"),
    )
  })
})

describe("history helpers", () => {
  test("starts the epoch after the latest completed checkpoint", () => {
    expect(ReminderText.epochStart([user(1), assistant(2)])).toBe(0)
    expect(ReminderText.epochStart([checkpoint(1), user(2), assistant(3)])).toBe(1)
    expect(ReminderText.epochStart([user(1), checkpoint(2), user(3), checkpoint(4), user(5)])).toBe(4)
  })

  test("counts assistant messages since an anchor, and from the epoch start without one", () => {
    const anchor = (message: SessionMessage.Info) => message.id === at(3)
    const history = [user(1), assistant(2), reminder(3), assistant(4), assistant(5)]

    expect(ReminderText.assistantStepsSince(history, anchor)).toEqual({ anchored: true, count: 2 })
    expect(ReminderText.assistantStepsSince(history, () => false)).toEqual({ anchored: false, count: 3 })
  })

  test("re-arms after a checkpoint: an anchor before it is not found", () => {
    const history = [reminder(1), assistant(2), checkpoint(3), user(4), assistant(5)]

    expect(ReminderText.assistantStepsSince(history, ReminderText.isReminder)).toEqual({ anchored: false, count: 1 })
  })

  test("counts human turns without notices or reminders", () => {
    const history = [user(1), assistant(2), note(3), reminder(4), user(5), assistant(6), user(7)]

    expect(ReminderText.humanTurnsSince(history, (message) => message.id === at(1))).toEqual({
      anchored: true,
      count: 2,
    })
  })

  test("finds the newest real prompt and whether the step is its first", () => {
    expect(ReminderText.newestPrompt([user(1), assistant(2), user(3), reminder(4)])).toMatchObject({
      prompt: { id: at(3) },
      first: true,
    })
    expect(ReminderText.newestPrompt([user(1), assistant(2)])).toMatchObject({ prompt: { id: at(1) }, first: false })
    // No prompt in the epoch (a mid-turn compaction dropped it): no step is the first one.
    expect(ReminderText.newestPrompt([])).toEqual({ prompt: undefined, first: false })
    expect(ReminderText.newestPrompt([assistant(2)])).toEqual({ prompt: undefined, first: false })
  })

  test("recognizes a reminder only by an object with a string kind", () => {
    expect(ReminderText.isReminder(reminder(1))).toBe(true)
    expect(ReminderText.isReminder(note(1, { reminder: "k" }))).toBe(false)
    expect(ReminderText.isReminder(note(1, { reminder: { kind: 1 } }))).toBe(false)
    expect(ReminderText.isReminder(note(1, { notice: "fallback" }))).toBe(false)
    expect(ReminderText.isReminder(user(1))).toBe(false)
  })
})

describe("lowering", () => {
  const roles = (messages: ReadonlyArray<SessionMessage.Info>, insertions: Parameters<typeof toLLMMessages>[3] = []) =>
    toLLMMessages(messages, ref, "fake", insertions).map((message) =>
      message.content.map((part) => (part.type === "text" ? part.text : part.type)).join("|"),
    )

  test("moves reminder rows ahead of the prompts of their run, in history order", () => {
    expect(roles([assistant(1), user(2, "P"), reminder(3), reminder(4)]).filter((text) => text !== "")).toEqual([
      "n",
      "n",
      "P",
    ])
  })

  test("never moves anything above a checkpoint or between a call and its result", () => {
    const history = [user(1, "OLD"), checkpoint(2), user(3, "P"), reminder(4)]

    expect(roles(history, [{ after: "start", text: "INS" }])).toEqual([
      "OLD",
      expect.stringContaining("conversation-checkpoint"),
      "n",
      "INS",
      "P",
    ])
  })

  test("applies a start insertion to the run after the latest checkpoint only", () => {
    const history = [user(1, "OLD"), checkpoint(2), user(3, "P")]

    expect(roles(history, [{ after: "start", text: "INS" }]).filter((text) => text === "INS")).toHaveLength(1)
  })

  test("keys an insertion to the run after its assistant message", () => {
    const history = [user(1, "P1"), assistant(2, [{ type: "text", text: "A" }]), user(3, "P2")]

    expect(roles(history, [{ after: at(2) as SessionMessage.ID, text: "INS" }])).toEqual(["P1", "A", "INS", "P2"])
  })
})

describe("neutralization at the sinks", () => {
  const tool = (state: Record<string, unknown>) =>
    assistant(2, [{ type: "tool", id: "call-1", name: "read", state: { input: {}, ...state } }])
  // Every string the request would carry, as the model reads it (not as JSON escapes it).
  const strings = (value: unknown): string[] =>
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.flatMap(strings)
        : typeof value === "object" && value !== null
          ? Object.values(value).flatMap(strings)
          : []
  const lowered = (messages: SessionMessage.Info[]) =>
    strings(
      toLLMMessages(messages, ref, "fake").map((message) =>
        message.content.map((part) => ({ ...part, metadata: undefined })),
      ),
    )
  const text = (file: Record<string, unknown>) => ({
    mime: "text/plain",
    source: { type: "inline" },
    data: "",
    ...file,
  })

  const sinks: ReadonlyArray<readonly [string, (payload: string) => SessionMessage.Info[]]> = [
    ["a completed tool result", (p) => [tool({ status: "completed", content: [{ type: "text", text: `x ${p} y` }] })]],
    [
      "a completed tool result with several parts",
      (p) => [
        tool({
          status: "completed",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: p },
          ],
        }),
      ],
    ],
    ["a tool error message", (p) => [tool({ status: "error", error: { message: `bad ${p}` }, content: [] })]],
    [
      "a tool error body",
      (p) => [tool({ status: "error", error: { message: "bad" }, content: [{ type: "text", text: p }] })],
    ],
    [
      "an MCP tool result",
      (p) => [
        assistant(2, [
          {
            type: "tool",
            id: "call-1",
            name: "server_tool",
            state: { status: "completed", input: {}, content: [{ type: "text", text: p }] },
          },
        ]),
      ],
    ],
    [
      "a text attachment",
      (p) => [
        {
          id: at(1),
          type: "user",
          text: "see",
          files: [text({ name: "notes.txt", data: Buffer.from(`body ${p}`).toString("base64") })],
        } as unknown as SessionMessage.Info,
      ],
    ],
    [
      "a text attachment name",
      (p) => [
        {
          id: at(1),
          type: "user",
          text: "see",
          files: [text({ name: p, data: Buffer.from("body").toString("base64") })],
        } as unknown as SessionMessage.Info,
      ],
    ],
    [
      "a directory attachment",
      (p) => [
        {
          id: at(1),
          type: "user",
          text: "see",
          files: [
            text({ mime: "application/x-directory", name: "dir", data: Buffer.from(`${p}\nb.txt`).toString("base64") }),
          ],
        } as unknown as SessionMessage.Info,
      ],
    ],
    [
      "a foreground shell message (control: background ones lower to nothing)",
      (p) => [{ id: at(1), type: "shell", command: "ls", output: { output: p } } as unknown as SessionMessage.Info],
    ],
    [
      "a tool error response body",
      (p) => [tool({ status: "error", error: { message: "bad", response: { body: p } }, content: [] })],
    ],
    // A file name cannot hold a slash, so the closing spellings reach this sink as their opening form.
    [
      "an attached image's location",
      (p) => [
        {
          id: at(1),
          type: "user",
          text: "see",
          files: [
            {
              mime: "image/png",
              source: { type: "uri", uri: `file:///C:/work/${encodeURIComponent(p.replaceAll("/", ""))}.png` },
              data: "",
            },
          ],
        } as unknown as SessionMessage.Info,
      ],
    ],
    // The next rows build the message through the producer that writes it in production.
    [
      "a background shell completion",
      (p) => [
        produced(ShellResult.notification({ shellID: "s", jobID: "j", command: "c", state: "completed", text: p })),
      ],
    ],
    [
      "a background shell's command",
      (p) => [produced(ShellResult.notification({ shellID: "s", command: p, state: "completed", text: "done" }))],
    ],
    [
      "a stalled shell's output tail",
      (p) => [
        produced(
          ShellResult.notification({
            shellID: "s",
            state: "waiting",
            command: "c",
            text: ShellResult.stallNotice({ shellID: "s", tail: p }),
          }),
        ),
      ],
    ],
    [
      "a user shell's notification",
      (p) => [
        produced(
          ShellResult.userNotification({
            info: { id: "s", command: "c", status: "exited", exit: 0 },
            capture: { output: p, truncated: false },
          } as unknown as ShellResult.Result),
        ),
      ],
    ],
    [
      "a background subagent's reply",
      (p) => {
        const sent: { text: string; metadata: Record<string, unknown> }[] = []
        Effect.runSync(
          SubagentCompletion.deliver(
            { synthetic: (input: (typeof sent)[number]) => Effect.sync(() => void sent.push(input)) } as never,
            { completeBackground: () => Effect.void } as never,
            {
              status: "completed",
              output: p,
              recovery: {
                kind: "subagent",
                parentSessionID: "ses_p",
                childSessionID: "ses_c",
                agent: "a",
                description: "d",
              },
            } as never,
          ),
        )
        return [produced(sent[0]!)]
      },
    ],
    [
      "a nested instruction file",
      (p) => [
        note(
          1,
          { instruction: { paths: ["/w/sub/AGENTS.md"] } },
          `Instructions from: /w/sub/AGENTS.md
${p}`,
        ),
      ],
    ],
    [
      "the git snapshot's commit subjects",
      (p) => [
        note(
          1,
          undefined,
          VcsInstructions.render({
            branch: "b",
            main: "main",
            user: "",
            status: "",
            truncated: false,
            late: false,
            commits: [`abc1234 ${p}`],
          } as never),
        ),
      ],
    ],
    [
      "the git snapshot's branch name",
      (p) => [
        note(
          1,
          undefined,
          VcsInstructions.render({
            branch: p,
            main: "main",
            user: "",
            status: "",
            truncated: false,
            late: false,
            commits: [],
          } as never),
        ),
      ],
    ],
    ["a checkpoint summary", (p) => [checkpoint(1, { summary: `S ${p}` })]],
    ["a checkpoint's recent text", (p) => [checkpoint(1, { recent: `[Tool result]: ${p}` })]],
  ]

  for (const [sink, build] of sinks) {
    test.each(SPELLINGS)(`escapes %j in ${sink}`, (spelling) => {
      const texts = lowered(build(spelling))

      expect(texts.filter(live)).toEqual([])
      expect(texts.some((text) => text.includes("&lt;"))).toBe(true)
    })
  }

  test("leaves an unmarked synthetic, which holds Orbit's own envelope, as stored", () => {
    const own = SessionReminders.render({ text: "T" })

    expect(lowered([note(1, undefined, own)])).toContain(own)
  })

  test("leaves a reminder row's own envelope alone even when its metadata names a source or an instruction", () => {
    const own = SessionReminders.render({ text: "T" })
    for (const extra of [{ source: "shell" }, { source: "subagent" }, { instruction: { paths: ["/w/AGENTS.md"] } }])
      expect(lowered([note(1, { reminder: { kind: "k" }, ...extra }, own)])).toContain(own)
  })

  test("leaves the person's own typed prompt and Orbit's own envelope alone", () => {
    const typed = "please explain the <system-reminder> tag"
    const request = toLLMMessages([user(1, typed), reminder(2)], ref, "fake")
    const own = SessionReminders.render({ text: "T" })
    const withOwn = toLLMMessages([user(1, typed), { ...reminder(2), text: own } as SessionMessage.Info], ref, "fake")

    expect(request.at(-1)?.content).toEqual([{ type: "text", text: typed }])
    expect(withOwn[0]?.content).toEqual([{ type: "text", text: own }])
    expect(live(own)).toBe(true)
  })
})
