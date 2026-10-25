// context-memory-3: clearing old tool results. Before a model request the runner leaves the results of the oldest
// compactable calls out of what the model is sent, keeping the newest five: after an hour idle, or when automatic
// compaction is due and the clearing frees enough to spare it. The clearing is one durable `session.context.cleared`
// event of facts (message and call IDs, a trigger); lowering renders the placeholder, so the stored results, an export
// and every client's view keep the full output. Every client sends its requests through `runStep` (class 12).
import { describe, expect, test } from "bun:test"
import { LLMEvent, LanguageModel, type LLMRequest } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { TestLLM } from "@orbit/ai/testing"
import fs from "fs/promises"
import path from "path"
import { DateTime, Effect, Fiber, Layer, Queue, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { and, asc, eq, inArray } from "drizzle-orm"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { EventTable } from "@orbit/core/event/sql"
import { Project } from "@orbit/core/project"
import { Location } from "@orbit/core/location"
import { Session } from "@orbit/core/session"
import { SessionCompaction } from "@orbit/core/session/compaction"
import type { SessionContext } from "@orbit/core/session/context"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
import { CLEARED_RESULT, toLLMMessages } from "@orbit/core/session/runner/to-llm-message"
import { SessionMicrocompaction } from "@orbit/core/session/microcompaction"
import { Tool } from "@orbit/core/tool"
import { Token } from "@orbit/core/util/token"
import { AbsolutePath } from "@orbit/core/schema"
import { Money } from "@orbit/schema/money"
import { scenario, sessionID, transformTools, type Scenario } from "./lib/runner"
import { overloaded } from "./lib/provider-failure"
import { executeTool, registerToolPlugin, stubSnapshot } from "./lib/tool"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { globalProjectNode } from "./lib/project"
import { tempLocationLayer } from "./fixture/location"
import { promptLocationNode } from "./fixture/prompt-location"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Database } from "@orbit/core/database/database"
import { Config } from "@orbit/core/config"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { Image } from "@orbit/core/image"
import { Permission } from "@orbit/core/permission"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { ProjectTrust } from "@orbit/core/project-trust"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInstructions } from "@orbit/core/session/instructions"
import { InstructionTriggers } from "@orbit/core/instruction-triggers"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionStore } from "@orbit/core/session/store"
import { SessionTransfer } from "@orbit/core/session/transfer"
import { LocationServiceMap } from "@orbit/core/location-service-map"
import { ReadTool } from "@orbit/core/tool/plugin/read"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { fakeModel, seedStep, type SeededCall } from "./lib/context-history"

const CLEARED = "session.context.cleared.1"
const ENDED = "session.compaction.ended.1"
const MINUTE = 60_000

// Text of `chars` characters that names its call, so a result is told apart from the placeholder and from the others.
const body = (id: string, chars = 400) => `${id}:`.padEnd(chars, "x")
const reads = (prefix: string, count: number, chars = 400): SeededCall[] =>
  Array.from({ length: count }, (_, index) => {
    const id = `${prefix}${index + 1}`
    return { id, name: "Read", text: body(id, chars) }
  })

type Sent = { readonly messages: LLMRequest["messages"] } | undefined
const toolResults = (request: Sent) =>
  (request?.messages ?? []).flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) => (part.type === "tool-result" ? [{ id: part.id, result: part.result }] : []))
      : [],
  )
const isCleared = (result: { readonly type: string; readonly value?: unknown }) => result.value === CLEARED_RESULT
// The calls of a request whose result is the placeholder, in request order.
const clearedIn = (request: Sent) =>
  toolResults(request).flatMap((result) => (isCleared(result.result) ? [result.id] : []))
const wholeIn = (request: Sent) =>
  toolResults(request).flatMap((result) => (isCleared(result.result) ? [] : [result.id]))

type Cleared = {
  readonly trigger: string
  readonly tools: ReadonlyArray<{ readonly assistantMessageID: string; readonly id: string }>
}
const clearings = (s: Scenario, id: Session.ID = sessionID) =>
  s.db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, id), eq(EventTable.type, CLEARED)))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.data as Cleared)),
    )
const callsOf = (events: ReadonlyArray<Cleared>) => events.map((event) => event.tools.map((tool) => tool.id))

const completedCompactions = (s: Scenario, id: Session.ID = sessionID) =>
  s.db
    .select({ id: EventTable.id })
    .from(EventTable)
    .where(and(eq(EventTable.aggregate_id, id), eq(EventTable.type, ENDED)))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.length),
    )

const newSession = (s: Scenario, name: string, parentID?: Session.ID) =>
  Effect.gen(function* () {
    const id = Session.ID.make(`ses_mc_${name}`)
    yield* s.db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
        ...(parentID === undefined ? {} : { parent_id: parentID }),
      })
      .run()
      .pipe(Effect.orDie)
    return id
  })

// A prompt on `id` that the model answers with `reply`, and the request it made.
const ask = (s: Scenario, id: Session.ID, text = "Next", reply = "Done") =>
  Effect.gen(function* () {
    yield* s.llm.push(TestLLM.text(reply, `reply-${s.requests.length}`))
    const before = s.requests.length
    yield* s.session.prompt({ sessionID: id, text, resume: false })
    yield* s.session.resume(id)
    return s.requests.slice(before).at(-1)
  })

const storedContent = (s: Scenario, id: Session.ID) =>
  s.session.messages({ sessionID: id, order: "asc" }).pipe(
    Effect.map((messages) =>
      messages.flatMap((message) =>
        message.type === "assistant"
          ? message.content.flatMap((part) =>
              part.type === "tool" && part.state.status === "completed"
                ? [[part.id, part.state.content] as const]
                : [],
            )
          : [],
      ),
    ),
  )

// What a history lowers to, as a request would carry it.
const lowered = (history: ReadonlyArray<SessionMessage.Info>) => ({
  messages: toLLMMessages(history, fakeModel, "fake"),
})

// Eight reads, an hour of quiet and a prompt: the prompt's request clears the three oldest, `name1` to `name3`.
const idleCleared = (s: Scenario, name: string) =>
  Effect.gen(function* () {
    const id = yield* newSession(s, name)
    yield* seedStep(s.bus, id, { id: `msg_${name}`, calls: reads(`${name}`, 8) })
    yield* TestClock.adjust(61 * MINUTE)
    const request = yield* ask(s, id)
    return { id, request, cleared: [1, 2, 3].map((n) => `${name}${n}`) }
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

// A history of eight big reads and then a step the provider measured at `measured` prompt tokens, so that automatic
// compaction is due when `measured` is past the threshold and the three oldest reads free about 30,000 tokens.
const pressured = (s: Scenario, id: Session.ID, measured: number) =>
  Effect.gen(function* () {
    yield* seedStep(s.bus, id, { id: `msg_${id}_reads`, calls: reads("p", 8, 40_000), inputTokens: 100 })
    yield* seedStep(s.bus, id, { id: `msg_${id}_anchor`, calls: [], inputTokens: measured, finish: "stop" })
  })

// The default test model has a 200,000-token window and a 32,000-token output limit: the summary keeps 20,000, so
// automatic compaction starts at 167,000 and, with it off, a request at 177,000 or more is refused.
const OVER = 170_000

describe("clearing old tool results", () => {
  scenario("clears the 3 oldest of 8 compactable results and keeps the newest 5", function* (s) {
    // Row 1: eight calls in one step.
    yield* seedStep(s.bus, sessionID, { id: "msg_one", calls: reads("one", 8) })
    yield* TestClock.adjust(61 * MINUTE)
    const request = yield* ask(s, sessionID)

    expect(clearedIn(request)).toEqual(["one1", "one2", "one3"])
    expect(wholeIn(request)).toEqual(["one4", "one5", "one6", "one7", "one8"])
    expect(toolResults(request)[3]?.result).toEqual({ type: "text", value: body("one4") })
    expect(yield* clearings(s)).toMatchObject([
      { trigger: "idle", tools: [1, 2, 3].map((n) => ({ assistantMessageID: "msg_one", id: `one${n}` })) },
    ])
    // The stored results keep their output.
    expect(yield* storedContent(s, sessionID)).toEqual(
      reads("one", 8).map((call) => [call.id, [{ type: "text", text: body(call.id) }]]),
    )

    // Row 2: eight calls spread over four steps. The oldest first, whichever message holds them.
    const spread = yield* newSession(s, "spread")
    for (const step of [1, 2, 3, 4])
      yield* seedStep(s.bus, spread, { id: `msg_spread${step}`, calls: reads(`s${step}_`, 2) })
    yield* TestClock.adjust(61 * MINUTE)
    const second = yield* ask(s, spread)
    expect(clearedIn(second)).toEqual(["s1_1", "s1_2", "s2_1"])
    expect(wholeIn(second)).toEqual(["s2_2", "s3_1", "s3_2", "s4_1", "s4_2"])
    expect(callsOf(yield* clearings(s, spread))).toEqual([["s1_1", "s1_2", "s2_1"]])
  })

  scenario("keeps everything with five or fewer compactable results", function* (s) {
    yield* seedStep(s.bus, sessionID, { id: "msg_five", calls: reads("f", 5) })
    yield* TestClock.adjust(61 * MINUTE)
    const request = yield* ask(s, sessionID)
    expect(clearedIn(request)).toEqual([])
    expect(wholeIn(request)).toHaveLength(5)
    expect(yield* clearings(s)).toEqual([])

    // Control: a sixth call puts one over.
    const six = yield* newSession(s, "six")
    yield* seedStep(s.bus, six, { id: "msg_six", calls: reads("g", 6) })
    yield* TestClock.adjust(61 * MINUTE)
    expect(clearedIn(yield* ask(s, six))).toEqual(["g1"])
  })

  // The names a call is recorded under: the current ones, the ones before the rename, and the shell under PowerShell.
  scenario("counts a call by its current or old name", function* (s) {
    const counted = [
      "Read", "Bash", "PowerShell", "Grep", "Glob", "WebSearch", "WebFetch", "Edit", "Write", "Patch",
      "read", "shell", "grep", "glob", "websearch", "webfetch", "edit", "write", "patch",
    ]
    const kept = [
      "NotebookEdit", "notebook_edit", "LSP", "lsp", "read_mcp_resource", "list_mcp_resources", "mcp__docs__search",
      "Agent", "subagent", "TaskOutput", "shell_output", "TodoWrite", "Skill",
    ]
    for (const [name, clears] of [...counted.map((name) => [name, true] as const), ...kept.map((name) => [name, false] as const)]) {
      const id = yield* newSession(s, `name_${name}`)
      // The oldest call is the one under test; the newest five are reads.
      yield* seedStep(s.bus, id, {
        id: `msg_name_${name}`,
        calls: [{ id: "target", name, text: body("target") }, ...reads("r", 5)],
      })
      yield* TestClock.adjust(61 * MINUTE)
      const request = yield* ask(s, id)
      expect([name, clearedIn(request)]).toEqual([name, clears ? ["target"] : []])
      expect([name, callsOf(yield* clearings(s, id))]).toEqual([name, clears ? [["target"]] : []])
    }
  })

  scenario("never clears a provider-hosted result", function* (s) {
    // The hosted search is the oldest call, six reads follow: the oldest read is the one to go.
    yield* seedStep(s.bus, sessionID, {
      id: "msg_hosted",
      calls: [{ id: "hosted", name: "WebSearch", hosted: true, text: "hosted results" }, ...reads("h", 6)],
    })
    yield* TestClock.adjust(61 * MINUTE)
    const request = yield* ask(s, sessionID)

    expect(callsOf(yield* clearings(s))).toEqual([["h1"]])
    // A hosted result sits in the assistant message that made the call, as the provider sent it.
    const hosted = (request?.messages ?? []).flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool-result" && part.providerExecuted ? [part] : []))
        : [],
    )
    expect(hosted.map((part) => [part.id, part.result])).toEqual([["hosted", { type: "text", value: "hosted results" }]])
    expect(clearedIn(request)).toEqual(["h1"])
  })

  scenario("clears an error result like a completed one", function* (s) {
    yield* seedStep(s.bus, sessionID, {
      id: "msg_error",
      calls: [{ id: "failed", name: "Bash", error: "boom: the command failed" }, ...reads("e", 5)],
    })
    yield* TestClock.adjust(61 * MINUTE)
    const request = yield* ask(s, sessionID)

    const failed = toolResults(request).find((result) => result.id === "failed")
    expect(failed?.result).toEqual({ type: "error", value: CLEARED_RESULT })
    expect(JSON.stringify(request?.messages)).not.toContain("boom")
    expect(callsOf(yield* clearings(s))).toEqual([["failed"]])
  })

  // What a clearing is worth is what the request carried for it: a saved result is its wrapper, an image 1,500 tokens.
  scenario("counts what the request carried", function* (s) {
    const root = "/data/tool-output"
    const huge = body("saved", 100_000)
    yield* seedStep(s.bus, sessionID, {
      id: "msg_carried",
      calls: [
        { id: "saved", name: "Read", text: huge },
        { id: "image", name: "Read", content: [{ type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" }] },
        ...reads("c", 5),
      ],
    })
    yield* s.bus.publish(SessionEvent.Tool.Overridden, {
      sessionID,
      assistantMessageID: SessionMessage.ID.make("msg_carried"),
      id: "saved",
      override: { session: sessionID, name: "msg_carried-saved-0a1b2c3d.txt", format: 1 },
    })
    const history = yield* s.session.context(sessionID)
    const lowered = toLLMMessages(history, fakeModel, "fake", [], { toolOutput: root })
    const carried = (id: string) => {
      const part = lowered
        .flatMap((message) => message.content)
        .find((item) => item.type === "tool-result" && item.id === id)
      return part?.type === "tool-result" ? part.result : undefined
    }
    const wrapper = carried("saved")
    // The wrapper is a small stand-in for the huge result, which is what the request carried.
    if (wrapper?.type !== "text") throw new Error("expected the saved result as a wrapper")
    expect(String(wrapper.value).startsWith("<saved-output>")).toBe(true)
    const placeholder = Token.estimate(CLEARED_RESULT)
    const freed = (id: string) =>
      SessionCompaction.estimateFreed(history, new Map([["msg_carried", new Set([id])]]), fakeModel, root)

    expect(freed("saved")).toBe(Token.estimate(String(wrapper.value)) - placeholder)
    expect(freed("saved")).toBeLessThan(Token.estimate(huge) / 10)
    expect(freed("image")).toBe(1_500 - placeholder)
    // Without the root a saved result is lowered as stored, and so counted as stored.
    expect(SessionCompaction.estimateFreed(history, new Map([["msg_carried", new Set(["saved"])]]), fakeModel)).toBe(
      Token.estimate(huge) - placeholder,
    )
  })

  scenario("records nothing when nothing new would be freed", function* (s) {
    // Row 1: every older result is empty, so clearing frees nothing.
    yield* seedStep(s.bus, sessionID, {
      id: "msg_empty",
      calls: [...reads("e", 3).map((call) => ({ ...call, text: "" })), ...reads("k", 5)],
    })
    yield* TestClock.adjust(61 * MINUTE)
    expect(clearedIn(yield* ask(s, sessionID))).toEqual([])
    expect(yield* clearings(s)).toEqual([])

    // Row 2: the older results are already named by a marker, so a second idle prompt records none.
    const named = yield* newSession(s, "named")
    yield* seedStep(s.bus, named, { id: "msg_named", calls: reads("n", 8) })
    yield* TestClock.adjust(61 * MINUTE)
    // Control: the first pass records one.
    expect(clearedIn(yield* ask(s, named))).toEqual(["n1", "n2", "n3"])
    yield* TestClock.adjust(61 * MINUTE)
    const again = yield* ask(s, named, "Once more")
    expect(clearedIn(again)).toEqual(["n1", "n2", "n3"])
    expect((yield* clearings(s, named)).length).toBe(1)
  })

  scenario("clears on the first step 60 minutes after the newest assistant message, not at 59:59", function* (s) {
    // 59:59 after the newest assistant message: nothing.
    const early = yield* newSession(s, "early")
    yield* seedStep(s.bus, early, { id: "msg_early", calls: reads("a", 8) })
    yield* TestClock.adjust(60 * MINUTE - 1_000)
    expect(clearedIn(yield* ask(s, early))).toEqual([])
    expect(yield* clearings(s, early)).toEqual([])

    // Exactly 60:00: the first step of the turn clears. The turn's second step records nothing, since its newest
    // assistant message is the one just made.
    const exact = yield* newSession(s, "exact")
    yield* seedStep(s.bus, exact, { id: "msg_exact", calls: reads("b", 8) })
    yield* TestClock.adjust(60 * MINUTE)
    const before = s.requests.length
    yield* s.llm.push(TestLLM.tool("call_echo", "echo", { text: "x" }), TestLLM.text("Done", "exact-done"))
    yield* s.session.prompt({ sessionID: exact, text: "Next", resume: false })
    yield* s.session.resume(exact)
    expect(s.requests.length - before).toBe(2)
    expect(clearedIn(s.requests[before])).toEqual(["b1", "b2", "b3"])
    expect(clearedIn(s.requests[before + 1])).toEqual(["b1", "b2", "b3"])
    expect((yield* clearings(s, exact)).map((event) => event.trigger)).toEqual(["idle"])
  })

  scenario("does not clear in a session that gives no reason to", function* (s) {
    // Each row is a history of eight reads and an hour of quiet, except where the row says what is missing.
    const compaction = yield* SessionCompaction.Service
    // Control: a main session clears.
    const control = yield* newSession(s, "control")
    yield* seedStep(s.bus, control, { id: "msg_control", calls: reads("c", 8) })
    yield* TestClock.adjust(61 * MINUTE)
    expect(clearedIn(yield* ask(s, control))).toEqual(["c1", "c2", "c3"])

    // No assistant message since the checkpoint: the reads are behind a completed compaction.
    const checkpoint = yield* newSession(s, "checkpoint")
    yield* seedStep(s.bus, checkpoint, { id: "msg_checkpoint", calls: reads("k", 8) })
    yield* s.bus.publish(SessionEvent.Compaction.Started, { sessionID: checkpoint, reason: "manual", recent: "" })
    yield* s.bus.publish(SessionEvent.Compaction.Ended, {
      sessionID: checkpoint,
      reason: "manual",
      text: "summary",
      recent: "",
    })
    yield* TestClock.adjust(61 * MINUTE)
    expect(clearedIn(yield* ask(s, checkpoint))).toEqual([])
    expect(yield* clearings(s, checkpoint)).toEqual([])

    // The newest assistant message is in the future: the gap is negative.
    const future = yield* newSession(s, "future")
    yield* TestClock.adjust(3 * 60 * MINUTE)
    yield* seedStep(s.bus, future, { id: "msg_future", calls: reads("f", 8) })
    yield* TestClock.setTime(61 * MINUTE)
    expect(clearedIn(yield* ask(s, future))).toEqual([])
    expect(yield* clearings(s, future)).toEqual([])

    // A subagent's session.
    yield* TestClock.setTime(10 * 60 * MINUTE)
    const child = yield* newSession(s, "child", sessionID)
    yield* seedStep(s.bus, child, { id: "msg_child", calls: reads("s", 8) })
    yield* TestClock.adjust(61 * MINUTE)
    expect(clearedIn(yield* ask(s, child))).toEqual([])
    expect(yield* clearings(s, child)).toEqual([])

    // The setting is off.
    yield* compaction.transform((editor) => editor.configure({ clear: false }))
    const off = yield* newSession(s, "off")
    yield* seedStep(s.bus, off, { id: "msg_off", calls: reads("o", 8) })
    yield* TestClock.adjust(61 * MINUTE)
    expect(clearedIn(yield* ask(s, off))).toEqual([])
    expect(yield* clearings(s, off)).toEqual([])
  })
  // The reference's manual and reactive compactions never take its time path; neither does Orbit's.
  scenario("a manual or overflow compaction never clears", function* (s) {
    // Control: a prompt after an hour clears.
    const control = yield* idleCleared(s, "control")
    expect(clearedIn(control.request)).toEqual(control.cleared)

    // `/compact` after an hour: the compaction replaces the reads, and nothing is cleared before it.
    const manual = yield* newSession(s, "manual")
    yield* seedStep(s.bus, manual, { id: "msg_manual", calls: reads("m", 8) })
    yield* TestClock.adjust(61 * MINUTE)
    yield* s.llm.push(TestLLM.text("## Objective\n- manual", "manual-summary"))
    yield* s.session.compact({ sessionID: manual })
    yield* s.session.resume(manual)
    expect(yield* completedCompactions(s, manual)).toBe(1)
    expect(yield* clearings(s, manual)).toEqual([])

    // A provider rejection as too long: the recovery compacts, and nothing is cleared on the way.
    const overflow = yield* newSession(s, "overflow")
    yield* seedStep(s.bus, overflow, { id: "msg_overflow", calls: reads("o", 8) })
    yield* s.llm.push(
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
      ],
      TestLLM.text("## Objective\n- recovered", "overflow-summary"),
      TestLLM.text("Recovered", "overflow-final"),
    )
    yield* s.session.prompt({ sessionID: overflow, text: "Next", resume: false })
    yield* s.session.resume(overflow)
    expect(yield* completedCompactions(s, overflow)).toBe(1)
    expect(yield* clearings(s, overflow)).toEqual([])
  })

  scenario("at the auto threshold it clears first and compacts only when still at or above it", function* (s) {
    const order = (id: Session.ID) =>
      s.db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(and(eq(EventTable.aggregate_id, id), inArray(EventTable.type, [CLEARED, ENDED])))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(
          Effect.orDie,
          Effect.map((rows) => rows.map((row) => row.type)),
        )

    // Row a: just past the threshold, and the three oldest reads free about 30,000 tokens: no compaction is needed.
    const spared = yield* newSession(s, "spared")
    yield* pressured(s, spared, OVER + 8_000)
    const request = yield* ask(s, spared)
    expect((yield* clearings(s, spared)).map((event) => event.trigger)).toEqual(["pressure"])
    expect(callsOf(yield* clearings(s, spared))).toEqual([["p1", "p2", "p3"]])
    expect(yield* completedCompactions(s, spared)).toBe(0)
    expect(clearedIn(request)).toEqual(["p1", "p2", "p3"])
    expect(wholeIn(request)).toEqual(["p4", "p5", "p6", "p7", "p8"])

    // Row b: so far past it that clearing cannot bring it under, so the compaction follows the clearing.
    const compacted = yield* newSession(s, "compacted")
    yield* pressured(s, compacted, 400_000)
    yield* s.llm.push(TestLLM.text("## Objective\n- summary", "pressure-summary"), TestLLM.text("Done", "pressure-done"))
    yield* s.session.prompt({ sessionID: compacted, text: "Next", resume: false })
    yield* s.session.resume(compacted)
    expect((yield* clearings(s, compacted)).map((event) => event.trigger)).toEqual(["pressure"])
    expect(yield* completedCompactions(s, compacted)).toBe(1)
    expect(yield* order(compacted)).toEqual([CLEARED, ENDED])

    // Control: not past the threshold, nothing is cleared (and no hour has passed).
    const quiet = yield* newSession(s, "quiet")
    yield* pressured(s, quiet, 50_000)
    expect(clearedIn(yield* ask(s, quiet))).toEqual([])
    expect(yield* clearings(s, quiet)).toEqual([])
  })

  scenario("pressure never clears with automatic compaction off or paused", function* (s) {
    const compaction = yield* SessionCompaction.Service
    const registry = yield* Tool.Service
    yield* transformTools(registry, {
      Grep: {
        name: "Grep",
        description: "Repeat text as a search result",
        input: Schema.Struct({ text: Schema.String, count: Schema.Number }),
        traits: { concurrencySafe: true },
        execute: ({ text, count }) => Effect.succeed({ content: text.repeat(count) }),
      },
    })

    // Off: the same history that clears under pressure is sent whole, and the idle trigger still clears.
    yield* compaction.transform((editor) => editor.configure({ auto: false }))
    const off = yield* newSession(s, "off")
    yield* pressured(s, off, OVER)
    expect(clearedIn(yield* ask(s, off))).toEqual([])
    expect(yield* clearings(s, off)).toEqual([])
    const idle = yield* idleCleared(s, "idle")
    expect(clearedIn(idle.request)).toEqual(idle.cleared)
    expect((yield* clearings(s, idle.id)).map((event) => event.trigger)).toEqual(["idle"])
    yield* compaction.transform((editor) => editor.configure({ auto: true }))

    // Paused: three steps whose automatic compaction fails, then a fifth that must neither compact nor clear. Every
    // response reports 185,000 tokens, so each step after the first is due; steps 3 and 4 have older calls to clear.
    const grepStep = (n: number) =>
      TestLLM.complete(
        { reason: { normalized: "tool-calls" }, usage: { inputTokens: 185_000, nonCachedInputTokens: 185_000 } },
        ...[1, 2, 3].map((i) =>
          LLMEvent.toolCall({ id: `g${n}_${i}`, name: "Grep", input: { text: "x", count: 40_000 } }),
        ),
      )
    const summaryFails = () => [
      [LLMEvent.providerError({ message: "summary unavailable" })],
      [LLMEvent.providerError({ message: "summary unavailable" })],
    ]
    const paused = yield* newSession(s, "paused")
    yield* s.llm.push(
      grepStep(1),
      ...summaryFails(),
      grepStep(2),
      ...summaryFails(),
      grepStep(3),
      ...summaryFails(),
      grepStep(4),
      TestLLM.text("Done", "paused-done"),
    )
    yield* s.session.prompt({ sessionID: paused, text: "Search", resume: false })
    yield* s.session.resume(paused)

    expect(callsOf(yield* clearings(s, paused))).toEqual([["g1_1"], ["g1_2", "g1_3", "g2_1"]])
    expect(yield* completedCompactions(s, paused)).toBe(0)
    // The last request holds older calls that a clearing could still take, and was sent with the four it had taken.
    const last = s.requests.at(-1)
    expect(clearedIn(last)).toEqual(["g1_1", "g1_2", "g1_3", "g2_1"])
    expect(wholeIn(last)).toHaveLength(8)
  })

  scenario("a retry of the step after a clearing neither clears again nor compacts", function* (s) {
    const id = yield* newSession(s, "retry")
    yield* pressured(s, id, OVER + 8_000)
    const scheduled = yield* Queue.unbounded<SessionMessage.ID>()
    yield* s.bus.subscribe(SessionEvent.RetryScheduled).pipe(
      Stream.filter((event) => event.data.sessionID === id),
      Stream.runForEach((event) => Queue.offer(scheduled, event.data.assistantMessageID)),
      Effect.forkScoped({ startImmediately: true }),
    )
    const before = s.requests.length
    yield* s.llm.push(Stream.fail(overloaded()), TestLLM.text("Done", "retry-done"))
    yield* s.session.prompt({ sessionID: id, text: "Next", resume: false })
    const run = yield* s.session.resume(id).pipe(Effect.forkChild)
    yield* Queue.take(scheduled)
    yield* TestClock.adjust(MINUTE)
    yield* Fiber.join(run)

    const attempts = s.requests.slice(before)
    expect(attempts).toHaveLength(2)
    // The retried request carries the same placeholders; the estimate (which counts the clearing) is under the threshold.
    expect(attempts.map(clearedIn)).toEqual([
      ["p1", "p2", "p3"],
      ["p1", "p2", "p3"],
    ])
    expect(yield* clearings(s, id)).toHaveLength(1)
    expect(yield* completedCompactions(s, id)).toBe(0)
  })

  // `session.context.updated` is ephemeral, so the scenario reads it from the live bus, never from the event log.
  scenario("reports the context as stale after a clearing until the next response", function* (s) {
    const updates = new Array<Record<string, unknown>>()
    yield* s.bus.subscribe().pipe(
      Stream.filter((event) => event.type === "session.context.updated"),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          updates.push({ ...(event.data as Record<string, unknown>) })
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    const id = yield* newSession(s, "stale")
    yield* pressured(s, id, OVER + 8_000)
    yield* s.llm.push(TestLLM.textWithUsage("Done", "stale-done", 120_000))
    yield* s.session.prompt({ sessionID: id, text: "Next", resume: false })
    yield* s.session.resume(id)
    // Ephemeral delivery runs on the subscriber's fiber, so give it a bounded number of turns to catch up.
    for (let turn = 0; turn < 200 && updates.length < 2; turn++) yield* Effect.yieldNow

    expect(updates.map((update) => update.stale)).toEqual([true, false])
    // The report right after the clearing holds the estimate that counts it: under the threshold it was over.
    expect(updates[0]?.used).toBeLessThan(updates[0]?.threshold as number)
    expect(updates[1]?.used).toBe(120_000)
  })

  scenario("a cleared result stays cleared on later prompts and after a restart", function* (s) {
    const first = yield* idleCleared(s, "later")
    for (const text of ["Again", "And again"]) expect(clearedIn(yield* ask(s, first.id, text))).toEqual(first.cleared)
    expect(yield* clearings(s, first.id)).toHaveLength(1)

    // A restarted process builds its runner from the stored events alone: rebuild the projection from the log.
    yield* replayProjection(s, first.id)
    expect(clearedIn(yield* ask(s, first.id, "After the restart"))).toEqual(first.cleared)
    expect(yield* clearings(s, first.id)).toHaveLength(1)
  })

  scenario("a fork after a clearing sends the same placeholders, and a fork before it sends the results whole", function* (s) {
    const source = yield* idleCleared(s, "forked")
    const marker = (yield* s.session.context(source.id)).find((message) => message.type === "context-cleared")
    if (marker?.type !== "context-cleared") return yield* Effect.die(new Error("Expected the marker"))

    // After: the copy names the fork's own copies of the messages, and the fork's request sends the same placeholders.
    const after = yield* s.session.fork({ sessionID: source.id })
    const copied = yield* s.session.context(after.id)
    const assistants = copied.flatMap((message) => (message.type === "assistant" ? [message.id] : []))
    const copiedMarker = copied.find((message) => message.type === "context-cleared")
    if (copiedMarker?.type !== "context-cleared") return yield* Effect.die(new Error("Expected the copied marker"))
    expect(copiedMarker.tools.map((tool) => tool.assistantMessageID)).toEqual(source.cleared.map(() => assistants[0]))
    expect(assistants[0]).not.toBe("msg_forked")
    expect(clearedIn(yield* ask(s, after.id, "In the fork"))).toEqual(source.cleared)
    expect(yield* clearings(s, after.id)).toEqual([])

    // Before: the fork stops short of the marker, so its history sends the results whole.
    const before = yield* s.session.fork({ sessionID: source.id, before: marker.id })
    const history = yield* s.session.context(before.id)
    expect(history.some((message) => message.type === "context-cleared")).toBe(false)
    expect(clearedIn(lowered(history))).toEqual([])
    expect(wholeIn(lowered(history))).toHaveLength(8)
  })

  // A committed revert deletes every row from its boundary on, the marker with them.
  scenario("a committed revert to before the clearing brings the results back", function* (s) {
    const revertTo = (id: Session.ID, messageID: SessionMessage.ID) =>
      Effect.gen(function* () {
        yield* s.bus.publish(SessionEvent.RevertEvent.Staged, { sessionID: id, revert: { messageID, files: [] } })
        yield* s.bus.publish(SessionEvent.RevertEvent.Committed, { sessionID: id, to: messageID })
        return yield* s.session.context(id)
      })

    // Back to the prompt that came after the reads: the marker, recorded during that prompt's step, goes with it.
    const before = yield* idleCleared(s, "revert_before")
    const prompt = (yield* s.session.context(before.id)).find((message) => message.type === "user")
    if (prompt === undefined) return yield* Effect.die(new Error("Expected the prompt"))
    const reverted = yield* revertTo(before.id, prompt.id)
    expect(reverted.some((message) => message.type === "context-cleared")).toBe(false)
    expect(clearedIn(lowered(reverted))).toEqual([])
    expect(wholeIn(lowered(reverted))).toHaveLength(8)

    // Control: back to the reply that came after the marker keeps it, and the placeholders with it.
    const after = yield* idleCleared(s, "revert_after")
    const reply = (yield* s.session.context(after.id)).findLast((message) => message.type === "assistant")
    if (reply === undefined) return yield* Effect.die(new Error("Expected the reply"))
    const kept = yield* revertTo(after.id, reply.id)
    expect(kept.filter((message) => message.type === "context-cleared")).toHaveLength(1)
    expect(clearedIn(lowered(kept))).toEqual(after.cleared)
  })
  // The marker's IDs come from a store a clone or an import ships: they are only ever compared as keys (class 5), and a
  // marker that names nothing real changes nothing (class 7).
  scenario("a marker that names calls the history does not hold changes nothing else", function* (s) {
    const id = yield* newSession(s, "hostile")
    yield* seedStep(s.bus, id, {
      id: "msg_hostile",
      calls: [{ id: "hosted", name: "WebSearch", hosted: true, text: "hosted results" }, ...reads("h", 6)],
    })
    const hostile = "\u001b]0;x\u0007"
    const named = (message: string, call: string) => ({ assistantMessageID: SessionMessage.ID.make(message), id: call })
    yield* s.bus.publish(SessionEvent.ContextCleared, {
      sessionID: id,
      trigger: "idle",
      tools: [
        named("msg_unknown", "h1"),
        named("msg_hostile", "nope"),
        named("msg_../x", "../x"),
        named(`msg_${hostile}`, hostile),
        named("msg_hostile", "hosted"),
        // Control: a call the history holds, in the same marker.
        named("msg_hostile", "h2"),
      ],
    })
    const request = yield* ask(s, id)

    expect(clearedIn(request)).toEqual(["h2"])
    expect(wholeIn(request)).toEqual(["h1", "h3", "h4", "h5", "h6"])
    const hosted = (request?.messages ?? []).flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool-result" && part.providerExecuted ? [part.result] : []))
        : [],
    )
    expect(hosted).toEqual([{ type: "text", value: "hosted results" }])
    // The names reach nothing: not the request, and no clearing of the runner's own was recorded beside the seeded one.
    expect(JSON.stringify(request)).not.toContain("../x")
    expect(JSON.stringify(request)).not.toContain("\u001b")
    expect(yield* clearings(s, id)).toHaveLength(1)

    // A call still running or streaming has no result to leave out: lowered as it would be without the marker.
    const decode = Schema.decodeUnknownSync(SessionMessage.Info)
    const unsettled = [
      decode({
        id: "msg_unsettled",
        type: "assistant",
        agent: "build",
        model: { id: "fake-model", providerID: "fake" },
        content: [
          { type: "tool", id: "running", name: "Read", state: { status: "running", input: {}, metadata: {} }, time: { created: 0 } },
          { type: "tool", id: "streaming", name: "Read", state: { status: "streaming", input: "{" }, time: { created: 0 } },
        ],
        time: { created: 0, completed: 0 },
      }),
      decode({
        id: "msg_marker",
        type: "context-cleared",
        trigger: "idle",
        tools: [
          { assistantMessageID: "msg_unsettled", id: "running" },
          { assistantMessageID: "msg_unsettled", id: "streaming" },
        ],
        time: { created: 0 },
      }),
    ]
    expect(toolResults(lowered(unsettled))).toEqual([])
    expect(toolResults(lowered(unsettled.slice(0, 1)))).toEqual([])
  })

  // The unit under the runner rows: what a marker does to the lowered history, part by part.
  test("lowers a cleared result as the placeholder and keeps the part's ID, name and provider metadata", () => {
    const decode = Schema.decodeUnknownSync(SessionMessage.Info)
    const completed = (text: string) => ({ status: "completed", input: {}, content: [{ type: "text", text }] })
    const part = (id: string, name: string, state: unknown, extra: object = {}) => ({
      type: "tool",
      id,
      name,
      state,
      time: { created: 0, completed: 0 },
      ...extra,
    })
    const history = [
      decode({ id: "msg_user", type: "user", text: "Look", time: { created: 0 } }),
      decode({
        id: "msg_assistant",
        type: "assistant",
        agent: "build",
        model: { id: "fake-model", providerID: "fake" },
        content: [
          // Recorded under the name from before the rename, with provider state beside its result.
          part("old", "read", completed("the full text"), { providerResultState: { signature: "kept" } }),
          part("failed", "Bash", { status: "error", input: {}, error: { type: "tool", message: "the full error" } }),
          part("hosted", "WebSearch", completed("hosted text"), { executed: true }),
          part("kept", "Grep", completed("a newer result")),
        ],
        time: { created: 0, completed: 0 },
      }),
      decode({
        id: "msg_marker",
        type: "context-cleared",
        trigger: "pressure",
        tools: ["old", "failed", "hosted"].map((call) => ({ assistantMessageID: "msg_assistant", id: call })),
        time: { created: 0 },
      }),
    ]
    const messages = toLLMMessages(history, fakeModel, "fake")

    // The marker is not a message of the request: a user message, the assistant message and its three client results.
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "tool"])
    const results = toolResults({ messages })
    expect(results).toEqual([
      { id: "old", result: { type: "text", value: CLEARED_RESULT } },
      { id: "failed", result: { type: "error", value: CLEARED_RESULT } },
      { id: "kept", result: { type: "text", value: "a newer result" } },
    ])
    // The part keeps its name as lowered today, and its provider metadata.
    const sent = messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.content)
      .filter((item) => item.type === "tool-result")
    expect(sent.map((item) => item.name)).toEqual(["Read", "Bash", "Grep"])
    expect(sent[0]?.providerMetadata).toEqual({ fake: { signature: "kept" } })
    // The hosted result is replayed as received.
    expect(JSON.stringify(messages)).toContain("hosted text")
    expect(JSON.stringify(messages)).not.toContain("the full text")
    expect(JSON.stringify(messages)).not.toContain("the full error")
    expect(CLEARED_RESULT).toBe("[Earlier tool output cleared to free context space]")
  })
})

// The estimate counts a clearing (R2): `measured` is the provider's count at the newest measured response, taken before
// a later clearing left results out, so the calls before that response come off it once. The response's own results are
// estimated from the lowered history, where they already carry the placeholder.
describe("estimatePrompt and a clearing", () => {
  const model = LanguageModel.make({ id: "test-model", provider: "test-provider", route: OpenAIChat.route })
  const resolved = SessionRunnerModel.resolved(model, {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 400_000, output: 1_000 },
  })
  const session = Session.Info.make({
    id: Session.ID.make("ses_mc_estimate"),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
  })
  const decode = Schema.decodeUnknownSync(SessionMessage.Info)
  const assistant = (id: string, calls: ReadonlyArray<readonly [string, string]>, tokens?: number) =>
    decode({
      id,
      type: "assistant",
      agent: "build",
      model: { id: "test-model", providerID: "test-provider" },
      content: calls.map(([call, text]) => ({
        type: "tool",
        id: call,
        name: "Read",
        state: { status: "completed", input: {}, content: [{ type: "text", text }] },
        time: { created: 0, completed: 0 },
      })),
      ...(tokens === undefined
        ? {}
        : { tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
      time: { created: 0, completed: 0 },
    })
  const user = (id: string) => decode({ id, type: "user", text: "Look", time: { created: 0 } })
  const marker = (id: string, ...tools: ReadonlyArray<readonly [string, string]>) =>
    decode({
      id,
      type: "context-cleared",
      trigger: "idle",
      tools: tools.map(([message, call]) => ({ assistantMessageID: message, id: call })),
      time: { created: 0 },
    })
  const older = body("older", 8_000)
  const own = body("own", 4_000)
  const freed = (text: string) => Token.estimate(text) - Token.estimate(CLEARED_RESULT)
  const prompt = (messages: ReadonlyArray<SessionMessage.Info>) =>
    SessionCompaction.estimatePrompt({
      session,
      model: resolved,
      messages,
      agent: { id: Agent.defaultID, info: Agent.Info.default(Agent.defaultID) },
      initial: "",
      tools: stubSnapshot({ definitions: [], execute: () => Effect.die("unused") }),
    } as unknown as SessionContext.Loaded)
  // A, the anchor B (measured at 100,000) with a result of its own, and a prompt after it.
  const before = [user("msg_u1"), assistant("msg_a", [["a1", older]]), user("msg_u2")]
  const anchor = assistant("msg_b", [["b1", own]], 100_000)
  const after = user("msg_u3")
  const base = prompt([...before, anchor, after])

  test("estimatePrompt subtracts what a newer clearing freed, once", () => {
    // A newer marker takes the older call off the measured count, and the anchor's own call off the local estimate.
    const newer = prompt([...before, anchor, marker("msg_m1", ["msg_a", "a1"], ["msg_b", "b1"]), after])
    expect(base.measured - newer.measured).toBe(freed(older))
    expect(base.estimated - newer.estimated).toBe(freed(own))

    // The anchor's own results alone take nothing off the measured count: they were never in it.
    const ownOnly = prompt([...before, anchor, marker("msg_m2", ["msg_b", "b1"]), after])
    expect(ownOnly.measured).toBe(base.measured)
    expect(base.estimated - ownOnly.estimated).toBe(freed(own))

    // Twice named, once subtracted.
    const twice = prompt([
      ...before,
      anchor,
      marker("msg_m3", ["msg_a", "a1"]),
      marker("msg_m4", ["msg_a", "a1"]),
      after,
    ])
    expect(base.measured - twice.measured).toBe(freed(older))

    // A marker older than the anchor: the response was measured with the results already left out.
    const earlier = prompt([...before.slice(0, 2), marker("msg_m5", ["msg_a", "a1"]), before[2]!, anchor, after])
    expect(earlier).toEqual(base)
    // A call another marker had already named before the anchor is not taken off again.
    const taken = prompt([
      ...before.slice(0, 2),
      marker("msg_m6", ["msg_a", "a1"]),
      before[2]!,
      anchor,
      marker("msg_m7", ["msg_a", "a1"]),
      after,
    ])
    expect(taken.measured).toBe(base.measured)
  })

  // The mutation cells of the pure selection that the runner rows cannot reach.
  test("select keeps at least one call and lets an idle trigger win over pressure", () => {
    const calls = ["x1", "x2", "x3"].map((call) => [call, body(call)] as const)
    const history = [assistant("msg_x", calls)]
    const select = (input: { readonly keep?: number; readonly pressure: boolean; readonly now: number }) =>
      SessionMicrocompaction.select({ messages: history, freed: () => 1, ...input })
    // A keep of 0 counts as 1: the newest call stays.
    expect(select({ keep: 0, pressure: true, now: 0 })?.tools.map((tool) => tool.id)).toEqual(["x1", "x2"])
    expect(select({ keep: 5, pressure: true, now: 0 })).toBeUndefined()
    // Neither idle nor pressure: no reason.
    expect(select({ keep: 1, pressure: false, now: 59 * MINUTE })).toBeUndefined()
    // Both: the time rule is the one reported.
    expect(select({ keep: 1, pressure: true, now: 60 * MINUTE })?.trigger).toBe("idle")
    expect(select({ keep: 1, pressure: true, now: 59 * MINUTE })?.trigger).toBe("pressure")
    // A pass that frees nothing is not recorded.
    expect(
      SessionMicrocompaction.select({ messages: history, freed: () => 0, keep: 1, pressure: true, now: 0 }),
    ).toBeUndefined()
  })
})
// An export carries the marker like any row, and an import decodes it strictly with the rest of the history.
describe("a transferred session", () => {
  const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
  const transferIt = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node, SessionTransfer.node]),
      [
        Bus.node.replace(Bus.configured({ persist: true })),
        Project.node.replace(globalProjectNode),
        LocationServiceMap.node.replace(promptLocationNode),
        SessionExecution.node.replace(SessionExecution.noopLayer),
      ],
    ),
  )

  transferIt.effect("an exported and imported session keeps its clearing", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const transfer = yield* SessionTransfer.Service
      const bus = yield* Bus.Service
      const source = yield* session.create({ location })
      yield* seedStep(bus, source.id, { id: "msg_transfer", calls: reads("t", 8) })
      yield* bus.publish(SessionEvent.ContextCleared, {
        sessionID: source.id,
        trigger: "idle",
        tools: [
          { assistantMessageID: SessionMessage.ID.make("msg_transfer"), id: "t1" },
          { assistantMessageID: SessionMessage.ID.make("msg_transfer"), id: "t2" },
          { assistantMessageID: SessionMessage.ID.make("msg_transfer"), id: "t3" },
        ],
      })

      const exported = yield* transfer.export({ sessionID: source.id })
      expect(exported.messages.filter((message) => message.type === "context-cleared")).toHaveLength(1)
      // The file moves to another database: the source is gone before the import.
      yield* session.remove(source.id)
      const imported = yield* transfer.import({
        data: { ...exported, info: { ...exported.info, id: Session.ID.create() } },
        location,
      })

      const history = yield* session.context(imported.id)
      expect(history.find((message) => message.type === "context-cleared")).toMatchObject({
        trigger: "idle",
        tools: [1, 2, 3].map((n) => ({ assistantMessageID: "msg_transfer", id: `t${n}` })),
      })
      // The next request is made from this history: the placeholders are in it, and the rest is whole.
      expect(clearedIn(lowered(history))).toEqual(["t1", "t2", "t3"])
      expect(wholeIn(lowered(history))).toEqual(["t4", "t5", "t6", "t7", "t8"])
    }),
  )
})

// FU-M3-084: the reference answers a repeat read of an unchanged file with a stub that points at the earlier result. A
// clearing leaves that result out of the request for good, so the marks of the session are forgotten and the repeat
// shows the text. Freshness stays: an edit after a clearing needs no new read.
describe("a re-read after a clearing", () => {
  const readToolNode = makeLocationNode({
    name: "test/microcompaction-read-tool",
    layer: Layer.effectDiscard(registerToolPlugin(ReadTool.Plugin)),
    deps: [
      Config.node,
      Environment.node,
      FileLedger.node,
      Tool.node,
      ReadToolFileSystem.node,
      FileAccess.node,
      Image.node,
      Permission.node,
      SessionInstructions.node,
      InstructionTriggers.node,
      InstructionDiscovery.node,
      FSUtil.node,
      Location.node,
    ],
  })
  const config = Config.testLayer()
  const readIt = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionProjector.node,
        SessionStore.node,
        Session.node,
        Location.node,
        FSUtil.node,
        FileAccess.node,
        ReadToolFileSystem.node,
        readToolNode,
        FileLedger.node,
        Tool.node,
        PluginHooks.node,
        ProjectTrust.node,
        SessionInstructions.node,
        InstructionTriggers.node,
        InstructionDiscovery.node,
        Global.node,
        Image.node,
      ]),
      [
        Project.node.replace(globalProjectNode),
        SessionExecution.node.replace(SessionExecution.noopLayer),
        Location.node.replace(tempLocationLayer),
        Permission.node.replace(permissionLayer({ assert: () => Effect.void })),
        Config.node.replace(config),
        Image.node.replace(AppNodeBuilder.build(Image.node, [Config.node.replace(config)])),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: true })),
      ],
    ),
  )
  const readCall = (id: string, sessionID: Session.ID): Parameters<Tool.Snapshot["execute"]>[0] => ({
    sessionID,
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_reread"),
    call: { type: "tool-call", id, name: "Read", input: { file_path: "notes.txt" } },
  })
  const text = (result: unknown) => JSON.stringify(result)
  const stub = ReadTool.unchangedStub("notes.txt")

  readIt.effect("a re-read of a file whose earlier read was cleared returns the full content", () =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const file = path.join(location.directory, "notes.txt")
      // Long enough that the placeholder is smaller than the result it replaces.
      const content = Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n")
      yield* Effect.promise(() => fs.writeFile(file, content))
      const sessions = yield* Session.Service
      const sessionID = (yield* sessions.create({ location: Location.Ref.make({ directory: location.directory }) })).id
      const registry = yield* Tool.Service
      const bus = yield* Bus.Service
      const ledger = yield* FileLedger.Service

      // The first read shows the file and, repeated, only the stub: the control, with no clearing.
      expect(text(yield* executeTool(registry, readCall("first", sessionID)))).toContain("line 199")
      expect(text(yield* executeTool(registry, readCall("again", sessionID)))).toContain(stub)

      // That read, and five more calls after it, sit in the history an hour on: the runner's pass clears it.
      yield* seedStep(bus, sessionID, {
        id: "msg_reread",
        calls: [{ id: "first", name: "Read", text: content }, ...reads("later", 5)],
      })
      yield* TestClock.adjust(61 * MINUTE)
      const recorded = yield* SessionMicrocompaction.apply({
        bus,
        sessionID,
        messages: yield* sessions.context(sessionID),
        model: fakeModel,
        pressure: false,
        toolOutput: "/data/tool-output",
      })
      expect(recorded).toBe(true)

      // The model reads the same range again: the text, since the result that the stub pointed at is gone.
      const reread = yield* executeTool(registry, readCall("reread", sessionID))
      expect(text(reread)).toContain("line 199")
      expect(text(reread)).not.toContain(stub)
      // An edit after the clearing needs no new read, and a second repeat is the stub again.
      yield* ledger.assertFresh(sessionID, file, "notes.txt")
      expect(text(yield* executeTool(registry, readCall("twice", sessionID)))).toContain(stub)
    }),
  )
})