// context-memory-4: a checkpoint can keep the messages from one boundary on, by reference. The completed compaction
// stores only the first kept message's ID; history selection derives the span, stored order puts the checkpoint after
// the kept messages, and lowering sends the checkpoint first. Nothing in production names a boundary yet, so these tests
// call `SessionCompaction.Service.compact` with `retain` the way the later callers will.
import { expect } from "bun:test"
import { CompactionCheckpointResponse, CompactionPart, Message, type LLMRequest } from "@orbit/ai"
import { TestLLM } from "@orbit/ai/testing"
import { and, asc, eq, inArray } from "drizzle-orm"
import { DateTime, Effect, Logger, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { EventTable } from "@orbit/core/event/sql"
import { Agent } from "@orbit/core/agent"
import { Project } from "@orbit/core/project"
import { Session } from "@orbit/core/session"
import { SessionCompaction } from "@orbit/core/session/compaction"
import { SessionContext } from "@orbit/core/session/context"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionHistory } from "@orbit/core/session/history"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
import { SessionProviderContext } from "@orbit/core/session/provider-context"
import { CLEARED_RESULT, toLLMMessages } from "@orbit/core/session/runner/to-llm-message"
import { SessionTransfer } from "@orbit/core/session/transfer"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionStore } from "@orbit/core/session/store"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { Location } from "@orbit/core/location"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { AbsolutePath } from "@orbit/core/schema"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { nativeWindowModel, scenario, sessionID, type Scenario } from "./lib/runner"
import { fakeModel, seedStep } from "./lib/context-history"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { promptLocationNode } from "./fixture/prompt-location"

const STARTED = "session.compaction.started.1"
const ENDED = "session.compaction.ended.1"
const FAILED = "session.compaction.failed.1"
const WARNING = "retained checkpoint skipped"
const NOT_IN_HISTORY = {
  type: "compaction.unavailable",
  message: "The message to keep from is not in the active history",
}
const NOTHING = { type: "compaction.unavailable", message: "Nothing to compact yet" }

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

const answer = (label: number | string, tokens?: number) =>
  tokens === undefined
    ? TestLLM.text(`answer ${label}`, `answer-${label}`)
    : TestLLM.textWithUsage(`answer ${label}`, `answer-${label}`, tokens)
const summaryReply = (label: string) => TestLLM.text(`## Objective\n- ${label} summary`, `summary-${label}`)

const newSession = (s: Scenario, name: string) =>
  Effect.gen(function* () {
    const id = Session.ID.make(`ses_rc_${name}`)
    yield* s.db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })

/** Prompts `from` to `from + count - 1`, each answered with "answer N" (and `tokens` of reported usage when given). */
const grow = (s: Scenario, count: number, options: { id?: Session.ID; from?: number; tokens?: number } = {}) =>
  Effect.gen(function* () {
    const id = options.id ?? sessionID
    for (let n = options.from ?? 1; n < (options.from ?? 1) + count; n++) {
      yield* s.llm.push(answer(n, options.tokens))
      yield* s.session.prompt({ sessionID: id, text: `prompt ${n}`, resume: false })
      yield* s.session.resume(id)
    }
  })

const messagesOf = (s: Scenario, id: Session.ID = sessionID) => s.session.messages({ sessionID: id, order: "asc" })
const userID = (s: Scenario, text: string, id: Session.ID = sessionID) =>
  messagesOf(s, id).pipe(
    Effect.map((messages) => {
      const found = messages.find((message) => message.type === "user" && message.text === text)
      if (!found) throw new Error(`no user message ${text}`)
      return found.id
    }),
  )
const assistantID = (s: Scenario, n: number, id: Session.ID = sessionID) =>
  messagesOf(s, id).pipe(
    Effect.map((messages) => {
      const found = messages.filter((message) => message.type === "assistant")[n - 1]
      if (!found) throw new Error(`no assistant message ${n}`)
      return found.id
    }),
  )
const completedCheckpoints = (s: Scenario, id: Session.ID = sessionID) =>
  messagesOf(s, id).pipe(
    Effect.map((messages) =>
      messages.flatMap((message) => (message.type === "compaction" && message.status === "completed" ? [message] : [])),
    ),
  )

const eventsOf = (s: Scenario, type: string, id: Session.ID = sessionID) =>
  s.db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, id), eq(EventTable.type, type)))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.data as Record<string, unknown>)),
    )

/**
 * The compaction under test, called the way the runner calls it: a manual one opens its message first. A caller can
 * replace the window of the loaded model, which fixes the thresholds.
 */
const compactWith = (
  s: Scenario,
  input: {
    readonly retain?: SessionMessage.ID
    readonly reason?: "manual" | "auto" | "overflow"
    readonly id?: Session.ID
    readonly window?: { readonly context: number; readonly output: number }
  } = {},
) =>
  Effect.gen(function* () {
    const id = input.id ?? sessionID
    const contexts = yield* SessionContext.Service
    const compaction = yield* SessionCompaction.Service
    const reason = input.reason ?? "manual"
    const inputID = SessionMessage.ID.create()
    if (reason === "manual")
      yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: id, reason: "manual", recent: "", inputID })
    const fresh = yield* contexts.load(yield* contexts.select(id))
    const context = input.window ? { ...fresh, model: { ...fresh.model, limit: input.window } } : fresh
    const outcome = yield* compaction.compact(
      reason === "manual"
        ? { reason, context, inputID, retain: input.retain }
        : { reason, context, retain: input.retain },
    )
    return { outcome, context }
  })

const loadedContext = (id: Session.ID = sessionID) =>
  Effect.gen(function* () {
    const contexts = yield* SessionContext.Service
    return yield* contexts.load(yield* contexts.select(id))
  })

const textOf = (message: Message) => message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
const shape = (request: Pick<LLMRequest, "messages"> | undefined) =>
  (request?.messages ?? []).map((message) => `${message.role}: ${textOf(message)}`)
/** The summary or exchange lines of a request, with the checkpoint's wording cut down to its summary label. */
const labelled = (lines: readonly string[]) =>
  lines.map((line) => {
    const found = /## Objective\n- (\w+) summary/.exec(line)
    return found ? `[${found[1]} summary]` : line
  })
const REAL = ["user", "assistant", "compaction"]
const view = (messages: ReadonlyArray<SessionMessage.Info>) =>
  messages.filter((message) => REAL.includes(message.type)).map((message) => message.id)
const rowData = (s: Scenario, ids: readonly SessionMessage.ID[]) =>
  s.db
    .select()
    .from(SessionMessageTable)
    .where(inArray(SessionMessageTable.id, [...ids]))
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie, Effect.map((rows) => JSON.stringify(rows.map((row) => [row.id, row.seq, row.type, row.data]))))
const countRows = (s: Scenario, id: Session.ID) =>
  s.db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.session_id, id))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

const withWarnings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const logged: string[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (Array.isArray(entry.message) && entry.message[0] === WARNING) logged.push(JSON.stringify(entry.message))
    })
    const value = yield* effect.pipe(Effect.provide(Logger.layer([logger])))
    return { value, logged }
  })

// A restart rebuilds a session's projection from its event log, as the runner reloads it before every step.
const replayProjection = (s: Scenario, id: Session.ID) =>
  Effect.gen(function* () {
    const recorded = yield* s.db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, id))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    yield* s.bus.remove(id)
    yield* s.db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, id)).run().pipe(Effect.orDie)
    yield* Effect.forEach(
      recorded.map((event) => ({
        id: event.id,
        created: event.created,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
      (event) => s.bus.replay(event),
      { discard: true },
    )
  })

/** Four exchanges and a manual compaction that keeps from "prompt 3"; then, unless said otherwise, "prompt 5". */
const retained = (s: Scenario, id: Session.ID, options: { next?: boolean } = {}) =>
  Effect.gen(function* () {
    yield* grow(s, 4, { id })
    const before = s.requests.at(-1)
    const start = yield* userID(s, "prompt 3", id)
    yield* s.llm.push(summaryReply("first"))
    const result = yield* compactWith(s, { id, retain: start })
    expect(result.outcome).toEqual({ status: "completed" })
    if (options.next !== false) yield* grow(s, 1, { id, from: 5 })
    return { start, before, request: s.requests.at(-1) }
  })

// ---------------------------------------------------------------------------------------------------------------------
// Storage and the summary request

scenario("a retained checkpoint stores only the first kept message's ID", function* (s) {
  yield* grow(s, 4)
  const messages = yield* messagesOf(s)
  const start = yield* userID(s, "prompt 3")
  const kept = messages.slice(messages.findIndex((message) => message.id === start)).map((message) => message.id)
  expect(kept).toHaveLength(4)
  const before = yield* rowData(s, kept)

  yield* s.llm.push(summaryReply("first"))
  expect((yield* compactWith(s, { retain: start })).outcome).toEqual({ status: "completed" })

  const ended = yield* eventsOf(s, ENDED)
  expect(ended).toHaveLength(1)
  expect(ended[0]).toMatchObject({ reason: "manual", text: "## Objective\n- first summary", recent: "", retain: start })
  // Nothing else is new: no last kept message, no count, no copy.
  expect(Object.keys(ended[0]!).sort()).toEqual(
    ["cost", "model", "reason", "recent", "retain", "sessionID", "text", "tokens"].sort(),
  )
  const [checkpoint] = yield* completedCheckpoints(s)
  expect(checkpoint).toMatchObject({ status: "completed", retain: start })
  // The kept rows are the rows they were.
  expect(yield* rowData(s, kept)).toBe(before)

  // Control: a compaction that names nothing records no `retain`.
  const plain = yield* newSession(s, "plain")
  yield* grow(s, 2, { id: plain })
  yield* s.llm.push(summaryReply("plain"))
  expect((yield* compactWith(s, { id: plain })).outcome).toEqual({ status: "completed" })
  expect((yield* eventsOf(s, ENDED, plain))[0]).not.toHaveProperty("retain")
})

scenario("the summary request covers only the messages before the kept one", function* (s) {
  yield* grow(s, 4)
  const start = yield* userID(s, "prompt 3")
  yield* s.llm.push(summaryReply("first"))
  const before = s.requests.length
  yield* compactWith(s, { retain: start })
  expect(s.requests).toHaveLength(before + 1)
  const lines = shape(s.requests.at(-1))
  expect(lines.slice(0, 4)).toEqual(["user: prompt 1", "assistant: answer 1", "user: prompt 2", "assistant: answer 2"])
  expect(lines).toHaveLength(5)
  expect(lines[4]).toBe(`user: ${SessionCompaction.buildPrompt()}`)
  for (const kept of ["prompt 3", "answer 3", "prompt 4", "answer 4"]) expect(lines.join("\n")).not.toContain(kept)

  // With a checkpoint already in the summarized part, its message comes first.
  const second = yield* newSession(s, "second")
  yield* grow(s, 2, { id: second })
  yield* s.llm.push(summaryReply("earlier"))
  yield* compactWith(s, { id: second })
  yield* grow(s, 3, { id: second, from: 3 })
  yield* s.llm.push(summaryReply("later"))
  yield* compactWith(s, { id: second, retain: yield* userID(s, "prompt 5", second) })
  const sent = labelled(shape(s.requests.at(-1)))
  expect(sent.slice(0, 5)).toEqual(["[earlier summary]", "user: prompt 3", "assistant: answer 3", "user: prompt 4", "assistant: answer 4"])
  expect(sent.join("\n")).not.toContain("prompt 5")
})

// ---------------------------------------------------------------------------------------------------------------------
// The view and the request

scenario("the next request sends the checkpoint, then the kept messages verbatim, then new ones", function* (s) {
  const run = yield* retained(s, sessionID)
  const lines = labelled(shape(run.request))
  expect(lines).toEqual([
    "[first summary]",
    "user: prompt 3",
    "assistant: answer 3",
    "user: prompt 4",
    "assistant: answer 4",
    "user: prompt 5",
  ])
  // Verbatim: the kept messages lower as the request before the compaction lowered them.
  expect(run.request!.messages.slice(1, 4)).toEqual(run.before!.messages.slice(4, 7))
})

scenario("history keeps the checkpoint's stored place and the lowering puts it first", function* (s) {
  const run = yield* retained(s, sessionID)
  const [checkpoint] = yield* completedCheckpoints(s)
  const p3 = run.start
  const all = yield* messagesOf(s)
  const tail = all.slice(all.findIndex((message) => message.id === p3)).filter((message) => REAL.includes(message.type))
  const ids = tail.map((message) => message.id)
  // Stored order: the kept rows, the checkpoint (placed by the start of its compaction), then what came after.
  expect(ids.map((id) => (id === checkpoint!.id ? "C" : "m"))).toEqual(["m", "m", "m", "m", "C", "m", "m"])
  const latest = view(yield* s.context)
  expect(latest).toEqual(ids)
  const contexts = yield* SessionContext.Service
  const selected = yield* contexts.select(sessionID)
  const provenance = SessionProviderContext.provenance((yield* loadedContext()).model) ?? "local"
  expect(view(yield* SessionHistory.load(s.db, sessionID, "local"))).toEqual(ids)
  expect(view(yield* SessionHistory.load(s.db, sessionID, provenance))).toEqual(ids)
  const previewed = yield* SessionHistory.preview(s.db, sessionID, selected.instructions, "latest")
  expect(view(previewed.messages)).toEqual(ids)
  const lowered = toLLMMessages(yield* s.context, fakeModel)
  expect(textOf(lowered[0]!)).toContain("first summary")
})

scenario("a restarted runner sends the same retained view", function* (s) {
  const control = yield* retained(s, sessionID)
  const restarted = yield* newSession(s, "restarted")
  yield* retained(s, restarted, { next: false })
  yield* replayProjection(s, restarted)
  yield* grow(s, 1, { id: restarted, from: 5 })
  expect(shape(s.requests.at(-1))).toEqual(shape(control.request))
  expect(labelled(shape(s.requests.at(-1)))[0]).toBe("[first summary]")
})

// ---------------------------------------------------------------------------------------------------------------------
// The estimate

scenario("the estimate after a retained checkpoint ignores the kept messages' old usage", function* (s) {
  yield* grow(s, 4, { tokens: 150_000 })
  const start = yield* userID(s, "prompt 3")
  yield* s.llm.push(summaryReply("first"))
  yield* compactWith(s, { retain: start })

  const compaction = yield* SessionCompaction.Service
  const loaded = yield* loadedContext()
  const threshold = compaction.thresholds(loaded).thresholds!.threshold
  const prompt = SessionCompaction.estimatePrompt(loaded)
  expect(prompt.measured).toBe(0)
  expect(prompt.estimated).toBeGreaterThan(0)
  expect(prompt.estimated).toBeLessThan(threshold)
  // The kept answers stay stored with their usage; only the estimate looks past it.
  expect(loaded.messages.some((message) => message.type === "assistant" && message.tokens?.input === 150_000)).toBe(true)

  // The next step makes one model request and no second compaction.
  const requests = s.requests.length
  const started = (yield* eventsOf(s, STARTED)).length
  yield* s.llm.push(answer(5, 21_000))
  yield* s.runPrompt("prompt 5")
  expect(s.requests).toHaveLength(requests + 1)
  expect(yield* eventsOf(s, STARTED)).toHaveLength(started)
  // After that response the anchor is the response.
  expect(SessionCompaction.estimatePrompt(yield* loadedContext()).measured).toBeGreaterThanOrEqual(21_000)
})

scenario("estimatePrompt anchors only on a response after the latest checkpoint", function* (s) {
  yield* grow(s, 1)
  const base = yield* loadedContext()
  const created = DateTime.makeUnsafe(0)
  const assistant = (id: string, input: number) =>
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id,
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "fake-model", providerID: "fake" },
      content: [{ type: "text", text: `Reply ${id}` }],
      tokens: { input, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    })
  const user = (id: string, text: string) => SessionMessage.User.make({ id: SessionMessage.ID.make(id), type: "user", text, time: { created } })
  const checkpoint = SessionMessage.Compaction.make({
    id: SessionMessage.ID.make("msg_anchor_checkpoint"),
    type: "compaction",
    status: "completed",
    reason: "manual",
    summary: "Earlier work",
    recent: "",
    time: { created },
  })
  const before = [user("msg_anchor_kept", "Kept"), assistant("msg_anchor_old", 150_000), checkpoint, user("msg_anchor_new", "New")]
  const unanchored = SessionCompaction.estimatePrompt({ ...base, messages: before })
  expect(unanchored.measured).toBe(0)
  expect(unanchored.estimated).toBeGreaterThan(0)
  // A response after the checkpoint is the anchor, and it alone.
  const anchored = SessionCompaction.estimatePrompt({ ...base, messages: [...before, assistant("msg_anchor_response", 30_000)] })
  expect(anchored.measured).toBe(30_010)
  // Control: with no checkpoint in the list, the measured response is the anchor.
  expect(SessionCompaction.estimatePrompt({ ...base, messages: before.filter((message) => message.type !== "compaction") }).measured).toBe(150_010)
})

// ---------------------------------------------------------------------------------------------------------------------
// Choosing the kept span

scenario("the kept start moves past rows a kept span never holds", function* (s) {
  const system = (id: Session.ID) =>
    s.bus.publish(SessionEvent.InstructionsUpdated, { sessionID: id, delta: {}, text: "Updated instructions" })
  const rowsOf = (id: Session.ID, type: "system" | "compaction") =>
    messagesOf(s, id).pipe(Effect.map((messages) => messages.filter((message) => message.type === type)))
  type Row = {
    readonly name: string
    readonly build: (id: Session.ID) => Effect.Effect<SessionMessage.ID>
    /** The user message the stored `retain` should name, or undefined when nothing is kept. */
    readonly keeps: string | undefined
  }
  const rows: Row[] = [
    {
      name: "an instruction update",
      keeps: "prompt 3",
      build: (id) =>
        Effect.gen(function* () {
          yield* grow(s, 2, { id })
          yield* system(id)
          yield* grow(s, 1, { id, from: 3 })
          return (yield* rowsOf(id, "system"))[0]!.id
        }),
    },
    {
      name: "a failed compaction",
      keeps: "prompt 3",
      build: (id) =>
        Effect.gen(function* () {
          yield* grow(s, 2, { id })
          yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: id, reason: "auto", recent: "" })
          yield* s.bus.publish(SessionEvent.Compaction.Failed, {
            sessionID: id,
            reason: "auto",
            error: { type: "compaction.failed", message: "no" },
          })
          yield* grow(s, 1, { id, from: 3 })
          return (yield* rowsOf(id, "compaction"))[0]!.id
        }),
    },
    {
      name: "the previous summary checkpoint",
      keeps: "prompt 4",
      build: (id) =>
        Effect.gen(function* () {
          yield* grow(s, 3, { id })
          yield* s.llm.push(summaryReply("previous"))
          yield* compactWith(s, { id, retain: yield* userID(s, "prompt 3", id) })
          yield* grow(s, 2, { id, from: 4 })
          return (yield* completedCheckpoints(s, id))[0]!.id
        }),
    },
    {
      name: "a native checkpoint",
      keeps: "prompt 3",
      build: (id) =>
        Effect.gen(function* () {
          yield* grow(s, 3, { id })
          const target = SessionProviderContext.provenance({
            model: s.currentModel,
            ref: { id: fakeModel.id, providerID: fakeModel.providerID },
          })
          if (!target) throw new Error("Expected a concrete fixture endpoint")
          yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: id, reason: "auto", recent: "" })
          yield* s.bus.publish(SessionEvent.Compaction.Ended, {
            sessionID: id,
            reason: "auto",
            text: "",
            recent: "",
            retain: yield* userID(s, "prompt 2", id),
            providerContext: SessionProviderContext.encode(target, [
              Message.assistant(CompactionPart.make({ provider: s.currentModel.provider, encrypted: "window" })),
            ]),
          })
          yield* grow(s, 1, { id, from: 4 })
          return (yield* completedCheckpoints(s, id))[0]!.id
        }),
    },
    {
      name: "a trailing instruction update",
      keeps: undefined,
      build: (id) =>
        Effect.gen(function* () {
          yield* grow(s, 3, { id })
          yield* system(id)
          return (yield* rowsOf(id, "system"))[0]!.id
        }),
    },
  ]
  for (const row of rows) {
    const id = yield* newSession(s, `move_${row.name.replaceAll(" ", "_")}`)
    const start = yield* row.build(id)
    const requests = s.requests.length
    yield* s.llm.push(summaryReply("moved"))
    const outcome = (yield* compactWith(s, { id, retain: start })).outcome
    expect(outcome).toEqual({ status: "completed" })
    const ended = (yield* eventsOf(s, ENDED, id)).at(-1)!
    const sent = s.requests.at(-1)!
    if (row.keeps === undefined) {
      // Nothing is kept: a full summary, whose request holds every exchange.
      expect(ended).not.toHaveProperty("retain")
      for (const text of ["prompt 1", "prompt 2", "prompt 3"]) expect(JSON.stringify(sent.messages)).toContain(text)
    } else {
      expect(ended.retain).toBe(yield* userID(s, row.keeps, id))
      expect(JSON.stringify(sent.messages)).not.toContain(row.keeps)
    }
    expect(s.requests).toHaveLength(requests + 1)
    // The new checkpoint's view holds no instruction update and no older compaction row before it.
    const loaded = yield* SessionHistory.load(s.db, id, "latest")
    const latest = loaded.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
    expect(loaded.slice(0, latest).filter((message) => message.type === "system" || message.type === "compaction")).toEqual([])
  }
})

scenario("a retain that is not in the active history fails with a typed error and stores nothing", function* (s) {
  yield* grow(s, 4)
  const other = yield* newSession(s, "other")
  yield* grow(s, 1, { id: other })
  const replaced = yield* assistantID(s, 2)
  // An escalation notice and the attempt it replaces are left out of the active history.
  yield* s.bus.publish(SessionEvent.Synthetic, {
    sessionID,
    text: "The previous response reached the output cap, so the request is repeated with a larger one.",
    metadata: { notice: "output-escalation", replaces: replaced },
  })
  const noticeID = (yield* messagesOf(s)).findLast((message) => message.type === "synthetic")!.id
  const rows = [
    ["an unknown ID", SessionMessage.ID.make("msg_missing")],
    ["another session's message", yield* userID(s, "prompt 1", other)],
    ["a replaced attempt", replaced],
    ["the notice that replaces it", noticeID],
  ] as const
  for (const [name, retain] of rows) {
    const requests = s.requests.length
    const failures = (yield* eventsOf(s, FAILED)).length
    const result = yield* compactWith(s, { retain })
    expect({ name, outcome: result.outcome }).toEqual({ name, outcome: { status: "failed", error: NOT_IN_HISTORY } })
    const failed = yield* eventsOf(s, FAILED)
    expect(failed).toHaveLength(failures + 1)
    expect(failed.at(-1)).toMatchObject({ error: NOT_IN_HISTORY })
    expect(yield* eventsOf(s, ENDED)).toEqual([])
    expect(s.requests).toHaveLength(requests)
  }
  // Control: a message of the active history completes.
  yield* s.llm.push(summaryReply("control"))
  expect((yield* compactWith(s, { retain: yield* userID(s, "prompt 3") })).outcome).toEqual({ status: "completed" })

  // A message before the latest checkpoint's view is not in the active history either.
  const later = yield* newSession(s, "later")
  yield* grow(s, 2, { id: later })
  yield* s.llm.push(summaryReply("earlier"))
  yield* compactWith(s, { id: later })
  yield* grow(s, 2, { id: later, from: 3 })
  const requests = s.requests.length
  const stale = yield* compactWith(s, { id: later, retain: yield* userID(s, "prompt 1", later) })
  expect(stale.outcome).toEqual({ status: "failed", error: NOT_IN_HISTORY })
  expect(s.requests).toHaveLength(requests)
  yield* s.llm.push(summaryReply("control"))
  expect((yield* compactWith(s, { id: later, retain: yield* userID(s, "prompt 4", later) })).outcome).toEqual({
    status: "completed",
  })
})

scenario("nothing before the kept message fails as nothing to compact", function* (s) {
  yield* grow(s, 2)
  yield* s.llm.push(summaryReply("earlier"))
  yield* compactWith(s)
  yield* grow(s, 2, { from: 3 })
  const requests = s.requests.length
  const nothing = yield* compactWith(s, { retain: yield* userID(s, "prompt 3") })
  expect(nothing.outcome).toEqual({ status: "failed", error: NOTHING })
  expect(s.requests).toHaveLength(requests)
  // Control: one message later there is something before the kept one.
  yield* s.llm.push(summaryReply("control"))
  expect((yield* compactWith(s, { retain: yield* assistantID(s, 3) })).outcome).toEqual({ status: "completed" })
})

scenario("a native-compaction model summarizes a retained compaction", function* (s) {
  s.currentModel = nativeWindowModel
  s.compaction = { type: "native" }
  yield* grow(s, 3)
  const start = yield* userID(s, "prompt 2")
  yield* s.llm.push(summaryReply("retained"))
  expect((yield* compactWith(s, { retain: start })).outcome).toEqual({ status: "completed" })
  const [checkpoint] = yield* completedCheckpoints(s)
  expect(checkpoint).toMatchObject({ retain: start, summary: "## Objective\n- retained summary" })
  expect(checkpoint!.providerContext).toBeUndefined()

  // Control: without `retain` the same model compacts natively.
  const plain = yield* newSession(s, "native")
  yield* grow(s, 2, { id: plain })
  yield* s.llm.push(
    CompactionCheckpointResponse.make({
      responseID: "resp_native",
      checkpoint: { type: "compaction", provider: s.currentModel.provider, encrypted: "native" },
    }),
  )
  expect((yield* compactWith(s, { id: plain })).outcome).toEqual({ status: "completed" })
  const [native] = yield* completedCheckpoints(s, plain)
  expect(native?.providerContext).toBeDefined()
  expect(native).not.toHaveProperty("retain")
})

// ---------------------------------------------------------------------------------------------------------------------
// The automatic check

scenario("on the automatic path a result at or above the threshold falls back to a full summary; manual keeps it", function* (s) {
  const compaction = yield* SessionCompaction.Service
  const big = (chars: number) => `${"x".repeat(chars)} end`
  /** Four exchanges with "prompt 3" (the kept start) big or small; `early` makes the summarized part the big one. */
  const history = (name: string, size: "kept" | "summarized") =>
    Effect.gen(function* () {
      const id = yield* newSession(s, name)
      const text = (n: number) => (size === "kept" ? (n === 3 ? big(40_000) : `prompt ${n}`) : n === 1 ? big(40_000) : `prompt ${n}`)
      for (let n = 1; n <= 4; n++) {
        yield* s.llm.push(answer(n))
        yield* s.session.prompt({ sessionID: id, text: text(n), resume: false })
        yield* s.session.resume(id)
      }
      const user = (yield* messagesOf(s, id)).filter((message) => message.type === "user")[2]!
      return { id, start: user.id }
    })
  const window = { context: 16_000, output: 4_000 }
  const row = (input: { name: string; size: "kept" | "summarized"; reason: "manual" | "auto" | "overflow"; window?: typeof window }) =>
    Effect.gen(function* () {
      const { id, start } = yield* history(input.name, input.size)
      const requests = s.requests.length
      yield* s.llm.push(summaryReply("first"), summaryReply("second"))
      const result = yield* compactWith(s, { id, retain: start, reason: input.reason, window: input.window ?? window })
      expect(result.outcome).toEqual({ status: "completed" })
      const ended = yield* eventsOf(s, ENDED, id)
      expect(ended).toHaveLength(1)
      return {
        id,
        start,
        calls: s.requests.length - requests,
        retain: ended[0]!.retain,
        started: (yield* eventsOf(s, STARTED, id)).length,
        last: JSON.stringify(s.requests.at(-1)!.messages),
        text: ended[0]!.text,
      }
    })

  yield* grow(s, 1)
  const base = yield* loadedContext()
  const threshold = compaction.thresholds({ ...base, model: { ...base.model, limit: window } }).thresholds!.threshold
  expect(threshold).toBeGreaterThan(0)

  for (const reason of ["auto", "overflow"] as const) {
    const fallback = yield* row({ name: `fallback_${reason}`, size: "kept", reason })
    expect(fallback.calls).toBe(2)
    expect(fallback.retain).toBeUndefined()
    expect(fallback.text).toContain("second summary")
    // The second request carries every exchange.
    for (const n of [1, 2, 3, 4]) expect(fallback.last).toContain(`answer ${n}`)
    // One compaction message: the fallback does not announce itself again.
    expect(fallback.started).toBe(reason === "auto" ? 1 : 0)
    const view = yield* SessionHistory.load(s.db, fallback.id, "latest")
    expect(view[0]?.type).toBe("compaction")
  }
  // The same span, asked for by a person, is kept.
  const manual = yield* row({ name: "manual", size: "kept", reason: "manual" })
  expect(manual.calls).toBe(1)
  expect(manual.retain).toBe(manual.start)
  // A small kept span stays under the threshold on the automatic path.
  const small = yield* row({ name: "small", size: "summarized", reason: "auto" })
  expect(small.calls).toBe(1)
  expect(small.retain).toBe(small.start)
  // An unknown window has no threshold to check.
  const unknown = yield* row({ name: "unknown", size: "kept", reason: "overflow", window: { context: 0, output: 4_000 } })
  expect(unknown.calls).toBe(1)
  expect(unknown.retain).toBe(unknown.start)

  // A result exactly at the threshold falls back; one token below keeps. The window is sized from the estimate.
  const exact = yield* history("exact", "kept")
  const probe = yield* loadedContext(exact.id)
  const checkpoint = SessionMessage.Compaction.make({
    id: SessionMessage.ID.make("msg_exact_checkpoint"),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "## Objective\n- first summary",
    recent: "",
    time: { created: DateTime.makeUnsafe(0) },
  })
  const keptRows = probe.messages.slice(probe.messages.findIndex((message) => message.id === exact.start))
  const estimate = SessionCompaction.estimateRequest({
    system: [],
    tools: [],
    messages: toLLMMessages([...keptRows, checkpoint], fakeModel),
  })
  for (const [name, context, kept] of [
    ["equal", 2 * estimate, false],
    ["one below", 2 * estimate + 2, true],
  ] as const) {
    const id = (yield* history(`exact_${name.replace(" ", "_")}`, "kept")).id
    const start = (yield* messagesOf(s, id)).filter((message) => message.type === "user")[2]!.id
    yield* s.llm.push(summaryReply("first"), summaryReply("second"))
    yield* compactWith(s, { id, retain: start, reason: "overflow", window: { context, output: 0 } })
    const ended = (yield* eventsOf(s, ENDED, id)).at(-1)!
    expect({ name, kept: ended.retain !== undefined }).toEqual({ name, kept })
  }
})

// ---------------------------------------------------------------------------------------------------------------------
// Later checkpoints, forks, reverts

scenario("a second retained checkpoint summarizes the first and keeps from its own start", function* (s) {
  yield* retained(s, sessionID, { next: false })
  yield* grow(s, 2, { from: 5 })
  const inside = yield* userID(s, "prompt 4")
  yield* s.llm.push(summaryReply("second"))
  expect((yield* compactWith(s, { retain: inside })).outcome).toEqual({ status: "completed" })
  expect(labelled(shape(s.requests.at(-1))).slice(0, 3)).toEqual(["[first summary]", "user: prompt 3", "assistant: answer 3"])
  expect(shape(s.requests.at(-1))).toHaveLength(4 + 1)

  const [, second] = yield* completedCheckpoints(s)
  const view = yield* SessionHistory.load(s.db, sessionID, "latest")
  const ids = view.filter((message) => REAL.includes(message.type))
  expect(ids.map((message) => message.id)).toEqual([
    inside,
    yield* assistantID(s, 4),
    yield* userID(s, "prompt 5"),
    yield* assistantID(s, 5),
    yield* userID(s, "prompt 6"),
    yield* assistantID(s, 6),
    second!.id,
  ])
  yield* grow(s, 1, { from: 7 })
  expect(labelled(shape(s.requests.at(-1)))).toEqual([
    "[second summary]",
    "user: prompt 4",
    "assistant: answer 4",
    "user: prompt 5",
    "assistant: answer 5",
    "user: prompt 6",
    "assistant: answer 6",
    "user: prompt 7",
  ])
})

scenario("a fork keeps a retained checkpoint and a fork inside its kept span does not", function* (s) {
  const run = yield* retained(s, sessionID)
  const parentRequest = shape(run.request)
  const p5 = yield* userID(s, "prompt 5")

  // A fork past the checkpoint holds it, with `retain` on the copy of the kept start.
  const past = yield* s.session.fork({ sessionID, before: p5 })
  const copied = (yield* messagesOf(s, past.id)).find((message) => message.type === "user" && message.text === "prompt 3")!
  expect(copied.id).not.toBe(run.start)
  const [checkpoint] = yield* completedCheckpoints(s, past.id)
  expect(checkpoint).toMatchObject({ retain: copied.id })
  yield* grow(s, 1, { id: past.id, from: 5 })
  expect(shape(s.requests.at(-1))).toEqual(parentRequest)

  // A fork that stops at a kept message has no copy of the checkpoint, and sends the history as it was.
  const inside = yield* s.session.fork({ sessionID, before: yield* assistantID(s, 4) })
  expect(yield* completedCheckpoints(s, inside.id)).toEqual([])
  yield* grow(s, 1, { id: inside.id, from: 9 })
  expect(shape(s.requests.at(-1))).toEqual([
    "user: prompt 1",
    "assistant: answer 1",
    "user: prompt 2",
    "assistant: answer 2",
    "user: prompt 3",
    "assistant: answer 3",
    "user: prompt 4",
    "user: prompt 9",
  ])
})

scenario("a committed revert into the kept span returns to the earlier checkpoint", function* (s) {
  // Control: a revert to a message after the checkpoint keeps the checkpoint and its kept span.
  const control = yield* newSession(s, "revert_after")
  yield* retained(s, control)
  yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: control, to: yield* userID(s, "prompt 5", control) })
  yield* grow(s, 1, { id: control, from: 6 })
  expect(labelled(shape(s.requests.at(-1)))).toEqual([
    "[first summary]",
    "user: prompt 3",
    "assistant: answer 3",
    "user: prompt 4",
    "assistant: answer 4",
    "user: prompt 6",
  ])

  // A revert to a kept message removes the checkpoint with it, and the request is the history before.
  const into = yield* newSession(s, "revert_into")
  yield* retained(s, into)
  yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: into, to: yield* userID(s, "prompt 4", into) })
  expect(yield* completedCheckpoints(s, into)).toEqual([])
  yield* grow(s, 1, { id: into, from: 6 })
  expect(shape(s.requests.at(-1))).toEqual([
    "user: prompt 1",
    "assistant: answer 1",
    "user: prompt 2",
    "assistant: answer 2",
    "user: prompt 3",
    "assistant: answer 3",
    "user: prompt 6",
  ])

  // With an earlier checkpoint, the revert falls back to it.
  const earlier = yield* newSession(s, "revert_earlier")
  yield* grow(s, 2, { id: earlier })
  yield* s.llm.push(summaryReply("earlier"))
  yield* compactWith(s, { id: earlier })
  yield* grow(s, 2, { id: earlier, from: 3 })
  yield* s.llm.push(summaryReply("later"))
  yield* compactWith(s, { id: earlier, retain: yield* userID(s, "prompt 4", earlier) })
  yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: earlier, to: yield* userID(s, "prompt 4", earlier) })
  yield* grow(s, 1, { id: earlier, from: 6 })
  expect(labelled(shape(s.requests.at(-1)))).toEqual([
    "[earlier summary]",
    "user: prompt 3",
    "assistant: answer 3",
    "user: prompt 6",
  ])
})

// ---------------------------------------------------------------------------------------------------------------------
// A forged or imported store

scenario("a forged or imported retain fails open to the earlier history", function* (s) {
  const plain = (n: number) => [`user:prompt ${n}`, `assistant:answer ${n}`]
  const typeOf = (message: SessionMessage.Info) =>
    message.type === "user" ? `user:${message.text}` : message.type === "assistant" ? `assistant:${(message.content[0] as { text?: string } | undefined)?.text ?? ""}` : message.type
  const rows: Array<{
    readonly name: string
    readonly prepare?: (id: Session.ID) => Effect.Effect<void>
    /** The retain to forge, given the session, its checkpoint row ID, and the IDs of what the session holds. */
    readonly retain: (id: Session.ID) => Effect.Effect<SessionMessage.ID>
    readonly newer?: boolean
    readonly expected: string[]
    readonly warns: boolean
  }> = [
    {
      name: "a valid start (control)",
      retain: (id) => userID(s, "prompt 2", id),
      expected: [...plain(2), ...plain(3), "compaction"],
      warns: false,
    },
    {
      name: "an unknown ID",
      retain: () => Effect.succeed(SessionMessage.ID.make("msg_missing")),
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction"],
      warns: true,
    },
    {
      name: "a path-shaped ID",
      retain: () => Effect.succeed(SessionMessage.ID.make("msg_../../x")),
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction"],
      warns: true,
    },
    {
      name: "an ID with escape and bell characters",
      retain: () => Effect.succeed(SessionMessage.ID.make("msg_\u001b[31mred\u0007")),
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction"],
      warns: true,
    },
    {
      name: "another session's message",
      retain: () => userID(s, "prompt 1", Session.ID.make("ses_rc_foreign")),
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction"],
      warns: true,
    },
    {
      name: "the checkpoint's own ID",
      retain: () => Effect.succeed(SessionMessage.ID.make("msg_forged_checkpoint")),
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction"],
      warns: true,
    },
    {
      name: "a message after the checkpoint",
      retain: () => Effect.succeed(SessionMessage.ID.make("msg_forged_after")),
      newer: true,
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction", "assistant:"],
      warns: true,
    },
    {
      name: "an instruction update",
      prepare: (id) =>
        s.bus.publish(SessionEvent.InstructionsUpdated, { sessionID: id, delta: {}, text: "Updated" }).pipe(Effect.asVoid),
      retain: (id) =>
        messagesOf(s, id).pipe(Effect.map((messages) => messages.find((message) => message.type === "system")!.id)),
      expected: [...plain(1), ...plain(2), ...plain(3), "compaction"],
      warns: true,
    },
  ]
  const foreign = yield* newSession(s, "foreign")
  yield* grow(s, 1, { id: foreign })
  for (const row of rows) {
    const id = yield* newSession(s, `forged_${row.name.replace(/\W+/g, "_")}`)
    yield* grow(s, 3, { id })
    if (row.prepare) yield* row.prepare(id)
    const retain = yield* row.retain(id)
    const checkpointID = row.name === "the checkpoint's own ID" ? retain : undefined
    yield* s.bus.publish(SessionEvent.Compaction.Started, {
      sessionID: id,
      reason: "manual",
      recent: "",
      ...(checkpointID ? { inputID: checkpointID } : {}),
    })
    yield* s.bus.publish(SessionEvent.Compaction.Ended, { sessionID: id, reason: "manual", text: "Forged summary", recent: "", retain })
    if (row.newer) yield* seedStep(s.bus, id, { id: retain, calls: [], finish: "stop" })
    const rowsBefore = yield* countRows(s, id)
    const { value, logged } = yield* withWarnings(SessionHistory.load(s.db, id, "latest"))
    expect(yield* countRows(s, id)).toBe(rowsBefore)
    const shown = value.filter((message) => REAL.includes(message.type)).map(typeOf)
    expect({ name: row.name, shown }).toEqual({ name: row.name, shown: row.expected })
    expect({ name: row.name, warnings: logged.length }).toEqual({ name: row.name, warnings: row.warns ? 1 : 0 })
    // The log line never repeats the stored value.
    for (const line of logged) expect(line).not.toContain("\u001b")
    // The request starts with the checkpoint, then the earlier history.
    const lowered = toLLMMessages(value, fakeModel)
    expect(textOf(lowered[0]!)).toContain("Forged summary")
  }

  // A row before the previous checkpoint's start gives no wider view than that start.
  const chained = yield* newSession(s, "forged_chain")
  yield* grow(s, 3, { id: chained })
  yield* s.llm.push(summaryReply("previous"))
  yield* compactWith(s, { id: chained, retain: yield* userID(s, "prompt 3", chained) })
  yield* grow(s, 1, { id: chained, from: 4 })
  const first = yield* userID(s, "prompt 1", chained)
  yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: chained, reason: "manual", recent: "" })
  yield* s.bus.publish(SessionEvent.Compaction.Ended, { sessionID: chained, reason: "manual", text: "Forged summary", recent: "", retain: first })
  const before = yield* withWarnings(SessionHistory.load(s.db, chained, "latest"))
  expect(before.value.filter((message) => REAL.includes(message.type)).map(typeOf)).toEqual([
    ...plain(3),
    "compaction",
    ...plain(4),
    "compaction",
  ])
  expect(before.logged).toHaveLength(1)

  // A previous checkpoint's own row is not a start either.
  const onPrevious = yield* newSession(s, "forged_previous")
  yield* grow(s, 3, { id: onPrevious })
  yield* s.llm.push(summaryReply("previous"))
  yield* compactWith(s, { id: onPrevious })
  yield* grow(s, 2, { id: onPrevious, from: 4 })
  const previous = (yield* completedCheckpoints(s, onPrevious))[0]!.id
  yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: onPrevious, reason: "manual", recent: "" })
  yield* s.bus.publish(SessionEvent.Compaction.Ended, { sessionID: onPrevious, reason: "manual", text: "Forged summary", recent: "", retain: previous })
  const onRow = yield* withWarnings(SessionHistory.load(s.db, onPrevious, "latest"))
  expect(onRow.value.filter((message) => REAL.includes(message.type)).map(typeOf)).toEqual([
    "compaction",
    ...plain(4),
    ...plain(5),
    "compaction",
  ])
  expect(onRow.logged).toHaveLength(1)
})

// ---------------------------------------------------------------------------------------------------------------------
// Export and import

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const transferred = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Session.node,
      SessionTransfer.node,
      InstructionEntry.node,
    ]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Project.node.replace(globalProjectNode),
      LocationServiceMap.node.replace(promptLocationNode),
      SessionExecution.node.replace(SessionExecution.noopLayer),
    ],
  ),
)

/** A session whose messages are given, imported as a person would import a document. */
const imported = (suffix: string, retain?: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const transfer = yield* SessionTransfer.Service
    const template = yield* sessions.create({ location, title: "Retained" })
    const created = DateTime.makeUnsafe(1)
    const user = (name: string, text: string) =>
      SessionMessage.User.make({ id: SessionMessage.ID.make(`msg_${name}${suffix}`), type: "user", text, time: { created } })
    const assistant = (name: string, text: string) =>
      Schema.decodeUnknownSync(SessionMessage.Assistant)({
        id: `msg_${name}${suffix}`,
        type: "assistant",
        agent: Agent.defaultID,
        model: { id: "fake-model", providerID: "fake" },
        content: [{ type: "text", text }],
        time: { created: 1, completed: 1 },
      })
    const sessionID = Session.ID.create()
    const data = {
      info: { ...template, id: sessionID },
      messages: [
        user("rc_u1", "first"),
        assistant("rc_a1", "first answer"),
        user("rc_u2", "second"),
        assistant("rc_a2", "second answer"),
        SessionMessage.Compaction.make({
          id: SessionMessage.ID.make(`msg_rc_c${suffix}`),
          type: "compaction",
          status: "completed",
          reason: "manual",
          summary: "Imported summary",
          recent: "",
          retain: SessionMessage.ID.make(retain ?? `msg_rc_u2${suffix}`),
          time: { created },
        }),
        user("rc_u3", "third"),
      ],
    }
    yield* transfer.import({ data, location })
    return { sessionID, transfer, data }
  })

transferred.effect("an exported and imported session keeps its retained checkpoint", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const first = yield* imported("")
    const texts = (messages: ReadonlyArray<SessionMessage.Info>) =>
      toLLMMessages(messages, fakeModel).map((message) => textOf(message).slice(0, 18))
    const expected = ["Earlier messages ", "second", "second answer", "third"]
    expect(texts(yield* SessionHistory.load(db, first.sessionID, "latest"))).toEqual(expected)

    // Exported, renamed (message IDs are global) and imported again: the reference travels with the document.
    const document = yield* first.transfer.export({ sessionID: first.sessionID })
    const encoded = JSON.stringify(Schema.encodeSync(SessionTransfer.Data)(document)).replaceAll(/"msg_(rc_\w+?)"/g, '"msg_$1_copy"')
    const renamed = Schema.decodeUnknownSync(SessionTransfer.Data)({
      ...JSON.parse(encoded),
      info: { ...JSON.parse(encoded).info, id: Session.ID.create() },
    })
    const checkpoint = renamed.messages.find((message) => message.type === "compaction")
    expect(checkpoint).toMatchObject({ retain: "msg_rc_u2_copy" })
    yield* first.transfer.import({ data: renamed, location })
    expect(texts(yield* SessionHistory.load(db, renamed.info.id, "latest"))).toEqual(expected)
  }),
)

transferred.effect("an import refuses a checkpoint whose retain is not a message ID", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const first = yield* imported("_doc")
    const document = Schema.encodeSync(SessionTransfer.Data)(yield* first.transfer.export({ sessionID: first.sessionID }))
    const sessionsBefore = (yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)).length
    const edited = {
      ...document,
      info: { ...document.info, id: Session.ID.create() },
      messages: document.messages.map((message) => (message.type === "compaction" ? { ...message, retain: "../x" } : message)),
    }
    expect(() => Schema.decodeUnknownSync(SessionTransfer.Data)(edited)).toThrow()
    expect((yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)).length).toBe(sessionsBefore)
    // Control: the unedited document decodes.
    expect(() => Schema.decodeUnknownSync(SessionTransfer.Data)(document)).not.toThrow()
  }),
)

// ---------------------------------------------------------------------------------------------------------------------
// Clearing old results (context-memory-3) on a retained history

const BODY = (id: string) => `${id}:`.padEnd(400, "x")
const reads = (prefix: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index + 1}`, name: "Read", text: BODY(`${prefix}${index + 1}`) }))
const toolResults = (request: LLMRequest | undefined) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [{ id: part.id, result: part.result }] : []))
      : [],
  )
const isCleared = (result: { readonly type: string; readonly value?: unknown }) => result.value === CLEARED_RESULT
const ask = (s: Scenario, id: Session.ID) =>
  Effect.gen(function* () {
    yield* s.llm.push(TestLLM.text("Done", `reply-${s.requests.length}`))
    const before = s.requests.length
    yield* s.session.prompt({ sessionID: id, text: "Next", resume: false })
    yield* s.session.resume(id)
    return s.requests.slice(before).at(-1)
  })

scenario("clearing markers inside the kept span still apply", function* (s) {
  const history = (name: string, markKept: boolean) =>
    Effect.gen(function* () {
      const id = yield* newSession(s, name)
      // The runner starts a session's instruction state with its first step.
      yield* grow(s, 1, { id })
      const summarized = yield* seedStep(s.bus, id, { id: `msg_${name}_old`, calls: reads("a", 3) })
      yield* s.bus.publish(SessionEvent.ContextCleared, { sessionID: id, trigger: "pressure", tools: [{ assistantMessageID: summarized, id: "a1" }] })
      const kept = yield* seedStep(s.bus, id, { id: `msg_${name}_kept`, calls: reads("b", 3) })
      if (markKept)
        yield* s.bus.publish(SessionEvent.ContextCleared, { sessionID: id, trigger: "pressure", tools: [{ assistantMessageID: kept, id: "b1" }] })
      yield* s.llm.push(summaryReply("first"))
      expect((yield* compactWith(s, { id, retain: kept })).outcome).toEqual({ status: "completed" })
      return yield* ask(s, id)
    })
  const marked = yield* history("marked", true)
  const results = toolResults(marked)
  expect(results.map((result) => result.id)).toEqual(["b1", "b2", "b3"])
  expect(results.filter((result) => isCleared(result.result)).map((result) => result.id)).toEqual(["b1"])
  // The summarized calls leave no trace in the request.
  expect(JSON.stringify(marked!.messages)).not.toContain("a1:")
  expect(JSON.stringify(marked!.messages)).not.toContain("a2:")
  // Control: without the marker in the span, the kept results are sent whole.
  const unmarked = yield* history("unmarked", false)
  expect(toolResults(unmarked).filter((result) => isCleared(result.result))).toEqual([])
  expect(toolResults(unmarked)).toHaveLength(3)
})

scenario("idle clearing measures from a kept assistant message", function* (s) {
  const MINUTE = 60_000
  const history = (name: string) =>
    Effect.gen(function* () {
      const id = yield* newSession(s, name)
      yield* grow(s, 1, { id })
      yield* seedStep(s.bus, id, { id: `msg_${name}_old`, calls: reads("o", 2) })
      const kept = yield* seedStep(s.bus, id, { id: `msg_${name}_kept`, calls: reads("k", 8) })
      yield* s.llm.push(summaryReply("first"))
      expect((yield* compactWith(s, { id, retain: kept })).outcome).toEqual({ status: "completed" })
      return id
    })
  const control = yield* history("idle_control")
  const idle = yield* history("idle_due")
  yield* TestClock.adjust(60 * MINUTE - 1_000)
  expect(toolResults(yield* ask(s, control)).filter((result) => isCleared(result.result))).toEqual([])
  expect(yield* eventsOf(s, "session.context.cleared.1", control)).toEqual([])
  yield* TestClock.adjust(1_000)
  const request = yield* ask(s, idle)
  const recorded = yield* eventsOf(s, "session.context.cleared.1", idle)
  expect(recorded).toHaveLength(1)
  expect(recorded[0]).toMatchObject({ trigger: "idle" })
  expect(toolResults(request).filter((result) => isCleared(result.result)).map((result) => result.id)).toEqual(["k1", "k2", "k3"])
})
