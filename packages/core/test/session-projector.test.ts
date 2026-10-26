import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Logger, Option, Schema, Stream } from "effect"
import { and, asc, eq, sql } from "drizzle-orm"
import { Database } from "@orbit/core/database/database"
import { Agent } from "@orbit/core/agent"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Event } from "@orbit/schema/event"
import { EventTable } from "@orbit/core/event/sql"
import { Model } from "@orbit/core/model"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
import { Money } from "@orbit/schema/money"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionExecution } from "@orbit/core/session/execution"
import { fromRow } from "@orbit/core/session/info"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionStore } from "@orbit/core/session/store"
import { Shell } from "@orbit/schema/shell"
import {
  InstructionStateTable,
  SessionInboxTable,
  SessionMessageTable,
  SessionTable,
} from "@orbit/core/session/sql"
import { testEffect } from "./lib/effect"
import { seedStep } from "./lib/context-history"
import { Snapshot } from "@orbit/core/snapshot"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)
// A layer whose Session service forks through the projector of the same bus.
const forking = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node, Session.node]),
    [Bus.node.replace(Bus.configured({ persist: true })), SessionExecution.node.replace(SessionExecution.noopLayer)],
  ),
)
const sessionsLayer = AppNodeBuilder.build(Session.node, [SessionExecution.node.replace(SessionExecution.noopLayer)])
const sessionID = Session.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const previousModel = { ...model, variant: Model.VariantID.make("medium") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const build = Agent.defaultID

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
  usage?: Pick<SessionMessage.Assistant, "cost" | "tokens">,
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: build, model, content: [], time, ...usage }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

const seedSession = (overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        ...overrides,
      })
      .run()
    return db
  })

describe("SessionProjector", () => {
  it.effect("does not settle a pending manual compaction on an auto failure", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const inbox = yield* SessionInbox.Service
      const inputID = SessionMessage.ID.make("msg_manual_compaction")
      yield* inbox.admitCompaction({ id: inputID, sessionID, delivery: "queue" })

      yield* bus.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        reason: "auto",
        error: { type: "compaction.failed", message: "Auto compaction failed" },
      })

      expect(yield* SessionInbox.find(db, inputID)).toMatchObject({ id: inputID })
    }),
  )

  it.effect("loads legacy revert storage into canonical state", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const legacy = JSON.stringify({
        messageID: "msg_boundary",
        snapshot: "tree",
        diff: "legacy patch",
        files: [{ path: "src/old.ts", status: "modified", additions: 1, deletions: 0, patch: "@@" }],
      })
      yield* db.run(sql`update session_v2 set revert = ${legacy} where id = ${sessionID}`)
      const stored = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()
      if (!stored) return yield* Effect.die("Session row missing")
      const storedRevert = fromRow(stored).revert
      expect(String(storedRevert?.messageID)).toBe("msg_boundary")
      expect(String(storedRevert?.snapshot)).toBe("tree")
      expect(storedRevert?.files).toEqual([
        { file: "src/old.ts", status: "modified", additions: 1, deletions: 0, patch: "@@" },
      ])
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = yield* seedSession({
        cost: 1.25,
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
      const boundary = SessionMessage.ID.make("msg_boundary")
      const earlier = SessionMessage.ID.make("msg_earlier")
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(earlier, 0),
          assistantRow(
            boundary,
            1,
            { created },
            {
              cost: Money.USD.make(0.5),
              tokens: { input: 4, output: 1, reasoning: 1, cache: { read: 1, write: 0 } },
            },
          ),
          assistantRow(
            SessionMessage.ID.make("msg_later"),
            2,
            { created },
            {
              cost: Money.USD.make(0.75),
              tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
            },
          ),
        ])
        .run()
      yield* db
        .insert(InstructionStateTable)
        .values({
          session_id: sessionID,
          epoch_start: 0,
          through_seq: 0,
          initial_values: {},
          current_values: {},
        })
        .run()
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        revert: { messageID: boundary, files: [] },
      })
      yield* bus.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        to: boundary,
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([earlier])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: Money.USD.make(1.25),
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
      // A committed revert resets the fold cache so the next boundary establishes a new epoch.
      expect(yield* db.select().from(InstructionStateTable).get().pipe(Effect.orDie)).toBeUndefined()
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const bus = yield* Bus.Service

      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: SessionMessage.ID.make("msg_first"),
        item: { type: "user", payload: { text: "first" }, delivery: "steer" },
      })
      yield* bus.publish(
        SessionEvent.InboxDelivered,
        {
          sessionID,
          inboxID: SessionMessage.ID.make("msg_first"),
        },
        { id: Event.ID.make("evt_z") },
      )
      yield* bus.publish(SessionEvent.InboxEnqueued, {
        sessionID,
        inboxID: SessionMessage.ID.make("msg_second"),
        item: { type: "user", payload: { text: "second" }, delivery: "steer" },
      })
      yield* bus.publish(
        SessionEvent.InboxDelivered,
        {
          sessionID,
          inboxID: SessionMessage.ID.make("msg_second"),
        },
        { id: Event.ID.make("evt_a") },
      )

      const sessions = yield* Session.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("maps malformed persisted rows consistently while single-message lookup defects", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const messageID = SessionMessage.ID.make("msg_malformed")
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          type: "user",
          seq: 0,
          data: { text: "valid before corruption", time: { created: 0 } },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db.run(sql`update session_message set data = '{"time":{"created":0}}' where id = ${messageID}`)

      const sessions = yield* Session.Service
      const store = yield* SessionStore.Service
      const expected = { _tag: "Session.MessageDecodeError", sessionID, messageID }
      expect(yield* store.messages({ sessionID }).pipe(Effect.flip)).toMatchObject(expected)
      expect(yield* sessions.messages({ sessionID }).pipe(Effect.flip)).toMatchObject(expected)
      expect(yield* sessions.context(sessionID).pipe(Effect.flip)).toMatchObject(expected)
      expect(yield* sessions.message({ sessionID, messageID }).pipe(Effect.catchDefect(Effect.succeed))).toMatchObject(
        expected,
      )
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("checks session existence before resolving a missing message cursor", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const missing = Session.ID.make("ses_missing")
      expect(
        yield* sessions
          .messages({
            sessionID: missing,
            cursor: { id: SessionMessage.ID.make("msg_missing"), direction: "next" },
          })
          .pipe(Effect.flip),
      ).toEqual(new Session.NotFoundError({ sessionID: missing }))
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("consumes the pending row and projects the message at promotion", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const inbox = yield* SessionInbox.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* inbox.admit({
        id,
        sessionID,
        item: { type: "user", payload: { text: "promote me" }, delivery: "steer" },
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID,
        inboxID: id,
      })

      expect(
        yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ session_id: sessionID, type: "user", seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const db = yield* seedSession({ agent: "plan", model: previousModel })
      const bus = yield* Bus.Service

      yield* bus.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: build,
      })
      yield* bus.publish(SessionEvent.ModelSelected, {
        sessionID,
        model,
      })
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: "synthetic context",
        metadata: { source: "projector-test" },
      })
      // Serialized events have no transient envelope metadata to supply the background marker.
      yield* bus.replay({
        id: Event.ID.create(),
        created: 0,
        aggregateID: sessionID,
        seq: 3,
        type: Bus.versionedType(SessionEvent.Shell.Started.type, 1),
        data: {
          sessionID,
          shell: Shell.Info.make({
            id: Shell.ID.make("sh_projector"),
            status: "running",
            command: "pwd",
            cwd: "/project",
            shell: "/bin/sh",
            file: "/tmp/sh_projector.out",
            metadata: { background: true },
            time: { started: 0 },
          }),
        },
      })
      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID,
        shell: Shell.Info.make({
          id: Shell.ID.make("sh_projector"),
          status: "exited",
          command: "pwd",
          cwd: "/project",
          shell: "/bin/sh",
          file: "/tmp/sh_projector.out",
          exit: 0,
          metadata: {},
          time: { started: 0, completed: 1 },
        }),
        output: { output: "/project", cursor: 8, size: 8, truncated: false },
      })
      yield* bus.publish(SessionEvent.Compaction.Started, {
        sessionID,
        reason: "manual",
        recent: "recent context",
      })
      yield* bus.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(sql`${EventTable.type} like 'session.compaction.delta.%'`)
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db
          .select({ data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ data: expect.objectContaining({ status: "running", summary: "", recent: "recent context" }) }])
      yield* bus.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "synthetic")).toMatchObject({
        text: "synthetic context",
        metadata: { source: "projector-test" },
      })
      expect(messages.find((message) => message.type === "agent-switched")).toMatchObject({
        agent: build,
        previous: "plan",
      })
      expect(messages.find((message) => message.type === "model-switched")).toMatchObject({ previous: previousModel })
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        command: "pwd",
        status: "exited",
        exit: 0,
        metadata: { background: true },
        output: { output: "/project", truncated: false },
        time: { completed: DateTime.makeUnsafe(0) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const id = SessionMessage.ID.make("msg_creator_collision")
      const { id: _, type, ...data } = encodeMessage({ id, type: "synthetic", text: "existing", time: { created } })
      yield* db
        .insert(SessionMessageTable)
        .values({ id, session_id: sessionID, type, seq: 0, time_created: 0, data })
        .run()

      const exit = yield* bus
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          agent: build,
          model,
          started: 0,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("projects retry state and clears it at the next step or execution terminal", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const first = SessionMessage.ID.make("msg_retry_first")
      const second = SessionMessage.ID.make("msg_retry_second")
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: first,
        agent: build,
        model,
        started: 0,
      })
      yield* bus.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID: first,
        attempt: 2,
        at: 2_000,
        error: { type: "provider.transport", message: "Disconnected" },
      })

      const decode = (row: typeof SessionMessageTable.$inferSelect) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type })
      const firstRow = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, first))
        .get()
        .pipe(Effect.orDie)
      const projected = firstRow ?? (yield* Effect.die(new Error("Missing retry projection")))
      expect(decode(projected)).toMatchObject({
        retry: { attempt: 2, at: DateTime.makeUnsafe(2_000), error: { type: "provider.transport" } },
      })

      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: second,
        agent: build,
        model,
        started: 0,
      })
      yield* bus.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID: second,
        attempt: 3,
        at: 6_000,
        error: { type: "provider.internal", message: "Unavailable" },
      })
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(decode(rows[0])).not.toHaveProperty("retry")
      expect(decode(rows[1])).not.toHaveProperty("retry")
    }),
  )

  it.effect("does not infer restart continuation from lifecycle history", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const suspended = () =>
        db
          .select({ timeSuspended: SessionTable.time_suspended })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
          .pipe(Effect.orDie)

      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })
      expect((yield* suspended())?.timeSuspended).toBeNull()

      yield* bus.publish(SessionEvent.Execution.Started, { sessionID })
      expect((yield* suspended())?.timeSuspended).toBeNull()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* Bus.Service
      const usageUpdated = yield* service
        .subscribe(SessionEvent.UsageUpdated)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        time: { completed: DateTime.makeUnsafe(0) },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 1.25,
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
      expect(Option.getOrThrow(yield* Fiber.join(usageUpdated)).data).toEqual({
        sessionID,
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      })
    }),
  )

  it.effect("projects ended and failed step terminal state", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const endedID = SessionMessage.ID.make("msg_ended")
      const failedID = SessionMessage.ID.make("msg_failed")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(endedID, 0), assistantRow(failedID, 1)])
        .run()
        .pipe(Effect.orDie)

      const service = yield* Bus.Service
      yield* service.publish(SessionEvent.Step.Streamed, {
        sessionID,
        assistantMessageID: endedID,
      })
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: endedID,
        finish: "stop",
        rawFinish: "stop_sequence",
        providerState: { response: "ended" },
        cost: Money.USD.make(1),
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
        snapshot: Snapshot.ID.make("snap_ended"),
        files: [RelativePath.make("src/ended.ts")],
      })
      yield* service.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID: failedID,
        finish: "content-filter",
        rawFinish: "blocked",
        providerState: { response: "failed" },
        error: { type: "provider.invalid-request", message: "Failed" },
        snapshot: Snapshot.ID.make("snap_failed"),
        files: [RelativePath.make("src/failed.ts")],
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).toMatchObject({
        type: "assistant",
        finish: "stop",
        rawFinish: "stop_sequence",
        providerState: { response: "ended" },
        cost: Money.USD.make(1),
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
        snapshot: { end: "snap_ended", files: ["src/ended.ts"] },
        time: { streamed: created, completed: created },
      })
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "content-filter",
        rawFinish: "blocked",
        providerState: { response: "failed" },
        error: { type: "provider.invalid-request", message: "Failed" },
        snapshot: { end: "snap_failed", files: ["src/failed.ts"] },
        time: { completed: created },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* Bus.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        ordinal: 0,
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: build,
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: build,
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})

// tool-runtime-9: `session.tool.overridden` sets the override beside a completed result and keeps the result's own
// content. An event that names a failed result or no result changes nothing (class 7).
describe("SessionProjector tool overrides", () => {
  it.effect("sets an override only on the completed result the event names", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const messageID = SessionMessage.ID.make("msg_overridden")
      const tool = (id: string, state: Record<string, unknown>) => ({
        type: "tool",
        id,
        name: "emit",
        state: { input: {}, ...state },
        time: { created: 0, completed: 0 },
      })
      const original = Schema.decodeUnknownSync(SessionMessage.Assistant)({
        id: messageID,
        type: "assistant",
        agent: build,
        model,
        content: [
          tool("call_done", { status: "completed", content: [{ type: "text", text: "done" }] }),
          tool("call_failed", { status: "error", error: { type: "tool.execution", message: "failed" } }),
        ],
        time: { created: 0, completed: 0 },
      })
      const { id: _, type, ...data } = encodeMessage(original)
      yield* db
        .insert(SessionMessageTable)
        .values({ id: messageID, session_id: sessionID, type, seq: 0, time_created: 0, data })
        .run()
        .pipe(Effect.orDie)
      const bus = yield* Bus.Service
      const override = (id: string) => ({
        session: sessionID,
        name: `msg_overridden-${id}-1a2b3c4d.txt`,
        format: 1 as const,
      })
      // Each event that names no completed result logs one line naming its call (class 7).
      const refused: unknown[] = []
      const logger = Logger.make((entry) => {
        const [message, fields] = Array.isArray(entry.message) ? entry.message : [entry.message]
        if (message === "a tool override names no completed result, so nothing changes")
          refused.push((fields as { readonly id?: unknown } | undefined)?.id)
      })
      for (const id of ["call_done", "call_failed", "call_missing"])
        yield* bus
          .publish(SessionEvent.Tool.Overridden, {
            sessionID,
            assistantMessageID: messageID,
            id,
            override: override(id),
          })
          .pipe(Effect.provide(Logger.layer([logger])))
      expect(refused).toEqual(["call_failed", "call_missing"])

      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (row === undefined) throw new Error("Expected the assistant row")
      const projected = Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type })
      if (projected.type !== "assistant") throw new Error("Expected the assistant message")
      expect<unknown>(projected.content).toEqual([
        { ...original.content[0], override: override("call_done") },
        original.content[1],
      ])
    }),
  )
// context-memory-3: the clearing marker is one row at its place in the history, and a fork names its copies.
  forking.effect("projects session.context.cleared as one context-cleared row and remaps its IDs on a fork", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      const first = yield* seedStep(bus, sessionID, { id: "msg_cleared_first", calls: [{ id: "call_1", name: "Read" }] })
      const second = yield* seedStep(bus, sessionID, { id: "msg_cleared_second", calls: [{ id: "call_2", name: "Read" }] })

      yield* bus.publish(SessionEvent.ContextCleared, {
        sessionID,
        trigger: "idle",
        tools: [
          { assistantMessageID: first, id: "call_1" },
          { assistantMessageID: second, id: "call_2" },
        ],
      })
      // A marker from an import or an edited store can name messages the fork does not hold: one that names none it
      // copied is not copied, and one that names some keeps only those.
      const elsewhere = SessionMessage.ID.make("msg_elsewhere")
      yield* bus.publish(SessionEvent.ContextCleared, {
        sessionID,
        trigger: "pressure",
        tools: [{ assistantMessageID: elsewhere, id: "call_x" }],
      })
      yield* bus.publish(SessionEvent.ContextCleared, {
        sessionID,
        trigger: "pressure",
        tools: [
          { assistantMessageID: elsewhere, id: "call_y" },
          { assistantMessageID: second, id: "call_2" },
        ],
      })
      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "context-cleared")))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(3)
      const marker = Schema.decodeUnknownSync(SessionMessage.Info)({ ...rows[0]!.data, id: rows[0]!.id, type: rows[0]!.type })
      expect(marker).toMatchObject({
        type: "context-cleared",
        trigger: "idle",
        tools: [
          { assistantMessageID: first, id: "call_1" },
          { assistantMessageID: second, id: "call_2" },
        ],
      })

      // A fork past the marker copies it under the IDs its calls' messages were copied to.
      const past = yield* sessions.fork({ sessionID })
      const copied = yield* sessions.context(past.id)
      const assistants = copied.filter((message) => message.type === "assistant").map((message) => message.id)
      expect(assistants).toHaveLength(2)
      expect(assistants).not.toContain(first)
      const copiedMarkers = copied.filter((message) => message.type === "context-cleared")
      expect(copiedMarkers).toHaveLength(2)
      expect(copiedMarkers[0]).toMatchObject({
        trigger: "idle",
        tools: [
          { assistantMessageID: assistants[0], id: "call_1" },
          { assistantMessageID: assistants[1], id: "call_2" },
        ],
      })
      expect(copiedMarkers[0]!.id).not.toBe(marker.id)
      expect(copiedMarkers[1]).toMatchObject({ trigger: "pressure", tools: [{ assistantMessageID: assistants[1], id: "call_2" }] })

      // A fork that stops before the marker has no row.
      const before = yield* sessions.fork({ sessionID, before: marker.id })
      expect((yield* sessions.context(before.id)).map((message) => message.type)).toEqual(["assistant", "assistant"])

    }),
  )
})
