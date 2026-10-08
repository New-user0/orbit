import { describe, expect } from "bun:test"
import { asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { EventTable } from "@orbit/core/event/sql"
import { Model } from "@orbit/core/model"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionProjector } from "@orbit/core/session/projector"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { SessionTurn } from "@orbit/core/session/turn"
import { Money } from "@orbit/schema/money"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node]),
    [Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)
const sessionID = Session.ID.make("ses_turn_test")
const otherSessionID = Session.ID.make("ses_turn_other")
const primary = { id: Model.ID.make("primary"), providerID: Provider.ID.make("provider") }
const backup = { id: Model.ID.make("backup"), providerID: Provider.ID.make("provider") }
const spare = {
  id: Model.ID.make("spare"),
  providerID: Provider.ID.make("provider"),
  variant: Model.VariantID.make("fast"),
}

// Drives the durable events a busy period records, without a model: the same events the runner publishes.
const harness = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const inbox = yield* SessionInbox.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values(
      [sessionID, otherSessionID].map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: "test",
        version: "test",
      })),
    )
    .run()

  // The helpers a test drives one session with. A second session lets a test check that nothing leaks between them.
  const forSession = (id: Session.ID) => ({
    admit: (text: string, input: { turn?: SessionTurn.Options; delivery?: SessionInbox.Delivery } = {}) =>
      inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID: id,
        item: {
          type: "user",
          payload: SessionInbox.UserPayload.make({ text, turn: input.turn }),
          delivery: input.delivery ?? "steer",
        },
      }),
    admitSynthetic: (text: string, delivery: SessionInbox.Delivery) =>
      inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID: id,
        item: { type: "synthetic", payload: SessionInbox.SyntheticPayload.make({ text }), delivery },
      }),
    promote: (scope: SessionInbox.Promotable) => SessionInbox.promote(db, bus, id, scope),
    // A notice the runner records directly: it carries no delivery.
    notice: (kind: unknown, extra: Record<string, unknown> = {}) =>
      bus.publish(SessionEvent.Synthetic, {
        sessionID: id,
        text: `Notice ${String(kind)}`,
        metadata: { notice: kind, ...extra },
      }),
    idle: bus.publish(SessionEvent.Execution.Succeeded, { sessionID: id }),
    switchModel: (model: Model.Ref) => bus.publish(SessionEvent.ModelSelected, { sessionID: id, model }),
    current: SessionTurn.current(db, id),
  })
  const seq = (id: SessionMessage.ID) =>
    db
      .select({ seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.flatMap((row) => (row ? Effect.succeed(row.seq) : Effect.die(new Error(`Not projected: ${id}`)))),
      )
  const replay = Effect.gen(function* () {
    const recorded = yield* db
      .select()
      .from(EventTable)
      .where(eq(EventTable.aggregate_id, sessionID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    yield* bus.remove(sessionID)
    yield* db.delete(InstructionStateTable).where(eq(InstructionStateTable.session_id, sessionID)).run()
    yield* db.delete(SessionInboxTable).where(eq(SessionInboxTable.session_id, sessionID)).run()
    yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.session_id, sessionID)).run()
    yield* Effect.forEach(
      recorded.map((event) => ({
        id: event.id,
        created: event.created,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      })),
      (event) => bus.replay(event),
      { discard: true },
    )
  })
  return { db, ...forSession(sessionID), other: forSession(otherSessionID), seq, replay }
})

// DateTime values compare by their parts cache as well, so compare the instant instead.
const plain = (turn: SessionTurn.Current) => ({
  ...turn,
  options: turn.options && { ...turn.options, time: DateTime.toEpochMillis(turn.options.time) },
})

describe("SessionTurn.current", () => {
  it.effect("reports nothing for a session with no history", () =>
    Effect.gen(function* () {
      const s = yield* harness

      expect(yield* s.current).toEqual({ boundary: undefined, options: undefined, fallback: undefined, notices: {} })
    }),
  )

  it.effect("starts the first turn with the first input after the session began", () =>
    Effect.gen(function* () {
      const s = yield* harness
      const first = yield* s.admit("First", { turn: { maxSteps: 4 } })
      yield* s.promote("input")

      const turn = yield* s.current

      expect(turn.boundary).toBeUndefined()
      expect(turn.options).toMatchObject({ maxSteps: 4, seq: yield* s.seq(first.id) })
    }),
  )

  it.effect("keeps a queued prompt from inheriting the options or fallback of the turn before it", () =>
    Effect.gen(function* () {
      const s = yield* harness
      const first = yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      yield* s.notice("fallback", { model: backup })
      yield* s.notice("stop-hook")
      expect(yield* s.current).toMatchObject({
        options: { maxSteps: 1, seq: yield* s.seq(first.id) },
        fallback: backup,
        notices: { "stop-hook": 1, fallback: 1 },
      })

      const queued = yield* s.admit("B", { delivery: "queue" })
      expect(yield* s.promote("input")).toBe(1)

      expect(yield* s.current).toEqual({
        boundary: yield* s.seq(queued.id),
        options: undefined,
        fallback: undefined,
        notices: {},
      })
    }),
  )

  it.effect("applies the options a queued prompt brings to the turn it starts", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      const queued = yield* s.admit("B", { delivery: "queue", turn: { maxCost: Money.USD.make(2) } })
      yield* s.promote("input")

      expect(yield* s.current).toMatchObject({
        boundary: yield* s.seq(queued.id),
        options: { maxCost: 2, seq: yield* s.seq(queued.id) },
      })
      expect((yield* s.current).options).not.toHaveProperty("maxSteps")
    }),
  )

  it.effect("starts a turn at each queued prompt, one at a time, and lets steers join the turn in progress", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      const first = yield* s.admit("Queue first", { delivery: "queue", turn: { maxSteps: 2 } })
      const second = yield* s.admit("Queue second", { delivery: "queue", turn: { maxSteps: 9 } })

      yield* s.promote("input")
      expect((yield* s.current).boundary).toBeUndefined()

      yield* s.promote("input")
      expect(yield* s.current).toMatchObject({ boundary: yield* s.seq(first.id), options: { maxSteps: 2 } })

      const steer = yield* s.admit("Steer")
      yield* s.promote("steer")
      expect(yield* s.seq(steer.id)).toBeGreaterThan(yield* s.seq(first.id))
      expect(yield* s.current).toMatchObject({ boundary: yield* s.seq(first.id), options: { maxSteps: 2 } })

      yield* s.promote("input")
      expect(yield* s.current).toMatchObject({ boundary: yield* s.seq(second.id), options: { maxSteps: 9 } })
    }),
  )

  it.effect("moves the options window to a steer that carries options, and replaces the options whole", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A", { turn: { maxSteps: 1, maxTokens: 500 } })
      yield* s.promote("input")
      yield* TestClock.adjust("5 seconds")
      const steer = yield* s.admit("Steer", { turn: { maxCost: Money.USD.make(2) } })
      yield* s.promote("steer")

      const moved = yield* s.current
      expect(moved.options).toEqual({
        maxCost: Money.USD.make(2),
        seq: yield* s.seq(steer.id),
        time: expect.anything(),
      })
      expect(DateTime.toEpochMillis(moved.options!.time)).toBe(5_000)

      // A steer without options leaves the window where the last one put it.
      yield* TestClock.adjust("5 seconds")
      yield* s.admit("Plain steer")
      yield* s.promote("steer")
      expect(plain(yield* s.current).options).toMatchObject({
        maxCost: 2,
        seq: moved.options?.seq,
        time: 5_000,
      })

      // An empty set of options is still options: it lifts the limits set before it.
      const lifted = yield* s.admit("Lift the limits", { turn: {} })
      yield* s.promote("steer")
      expect(plain(yield* s.current).options).toEqual({ seq: yield* s.seq(lifted.id), time: 10_000 })
    }),
  )

  it.effect("starts a new turn at an idle marker, and the next prompt's options are the turn's own", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      yield* s.notice("fallback", { model: backup })
      yield* s.notice("stop-hook")
      yield* s.idle

      const afterIdle = yield* s.current
      expect(afterIdle).toMatchObject({ options: undefined, fallback: undefined, notices: {} })
      expect(afterIdle.boundary).toBeDefined()

      const next = yield* s.admit("C", { turn: { maxSteps: 7 } })
      yield* s.promote("input")
      expect(yield* s.current).toMatchObject({
        boundary: afterIdle.boundary,
        options: { maxSteps: 7, seq: yield* s.seq(next.id) },
      })
    }),
  )

  it.effect("starts a turn at a queue-delivered synthetic, and never at a steered or runner-recorded one", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A", { turn: { maxSteps: 3 } })
      yield* s.promote("input")
      yield* s.notice("stop-hook")
      yield* s.admitSynthetic("Background work finished", "steer")
      yield* s.promote("steer")
      expect(yield* s.current).toMatchObject({
        boundary: undefined,
        options: { maxSteps: 3 },
        notices: { "stop-hook": 1 },
      })

      const queued = yield* s.admitSynthetic("Later work finished", "queue")
      yield* s.promote("input")

      expect(yield* s.current).toEqual({
        boundary: yield* s.seq(queued.id),
        options: undefined,
        fallback: undefined,
        notices: {},
      })
    }),
  )

  it.effect("counts notices by kind from the boundary, and starts the counts again at each boundary", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      yield* s.notice("stop-hook")
      yield* s.notice("output-limit")
      yield* s.notice("stop-hook")
      yield* s.notice("output-escalation")
      yield* s.notice("stop-hook")
      expect((yield* s.current).notices).toEqual({ "stop-hook": 3, "output-limit": 1, "output-escalation": 1 })

      yield* s.admit("B", { delivery: "queue" })
      yield* s.promote("input")
      expect((yield* s.current).notices).toEqual({})
      yield* s.notice("stop-hook")
      expect((yield* s.current).notices).toEqual({ "stop-hook": 1 })

      yield* s.idle
      expect((yield* s.current).notices).toEqual({})
      yield* s.notice("output-limit")
      expect((yield* s.current).notices).toEqual({ "output-limit": 1 })
    }),
  )

  it.effect("counts only notices whose kind is text", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      yield* s.notice("stop-hook")
      yield* s.notice(7)
      yield* s.notice(null)
      yield* s.notice({ kind: "stop-hook" })
      yield* s.notice(["stop-hook"])
      yield* s.notice(undefined)
      yield* s.notice(true)

      expect((yield* s.current).notices).toEqual({ "stop-hook": 1 })
    }),
  )

  it.effect("keeps kinds named like prototype members as plain counts", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      yield* s.notice("__proto__")
      yield* s.notice("constructor")
      yield* s.notice("constructor")

      const notices = (yield* s.current).notices

      expect(Object.keys(notices).toSorted()).toEqual(["__proto__", "constructor"])
      expect(Object.getOwnPropertyDescriptor(notices, "__proto__")?.value).toBe(1)
      expect(Object.getOwnPropertyDescriptor(notices, "constructor")?.value).toBe(2)
    }),
  )

  it.effect("reads a kind the turn holds none of as absent, whatever its name, even in a turn without notices", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      const bare = (yield* s.current).notices
      yield* s.notice("stop-hook")
      const counted = (yield* s.current).notices

      for (const notices of [bare, counted]) {
        expect(Object.getPrototypeOf(notices)).toBeNull()
        for (const kind of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__", "output-limit"]) {
          expect(kind in notices).toBe(false)
          expect(notices[kind]).toBeUndefined()
        }
      }
      expect(counted["stop-hook"]).toBe(1)
    }),
  )

  it.effect("names the model of the latest fallback notice in the turn", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      yield* s.notice("fallback", { model: backup })
      expect((yield* s.current).fallback).toEqual(backup)

      yield* s.notice("fallback", { model: spare })
      expect((yield* s.current).fallback).toEqual(spare)
    }),
  )

  it.effect("clears the fallback when the session switches model afterwards, and not before", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      yield* s.switchModel(primary)
      yield* s.notice("fallback", { model: backup })
      expect((yield* s.current).fallback).toEqual(backup)

      yield* s.switchModel(spare)
      expect((yield* s.current).fallback).toBeUndefined()

      yield* s.notice("fallback", { model: backup })
      expect((yield* s.current).fallback).toEqual(backup)
    }),
  )

  it.effect("reads no fallback from a notice that does not name a model it can read", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A")
      yield* s.promote("input")
      yield* s.notice("fallback", { model: backup })
      const malformed: ReadonlyArray<Record<string, unknown>> = [
        {},
        { model: "provider/backup" },
        { model: { id: "backup" } },
        { model: { id: 1, providerID: "provider" } },
        { model: null },
      ]

      for (const extra of malformed) {
        yield* s.notice("fallback", extra)
        // The latest notice decides: an older, readable one is not brought back.
        expect((yield* s.current).fallback).toBeUndefined()
      }
      expect((yield* s.current).notices).toEqual({ fallback: 1 + malformed.length })
    }),
  )

  it.effect("treats messages projected before delivery was recorded as steers", () =>
    Effect.gen(function* () {
      const s = yield* harness
      const first = yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      const queued = yield* s.admit("B", { delivery: "queue" })
      yield* s.promote("input")
      expect((yield* s.current).boundary).toBe(yield* s.seq(queued.id))

      yield* s.db.run(sql`update session_message set data = json_remove(data, '$.delivery') where id = ${queued.id}`)

      expect(yield* s.current).toMatchObject({
        boundary: undefined,
        options: { maxSteps: 1, seq: yield* s.seq(first.id) },
      })
    }),
  )

  it.effect("fails when the prompt that carries the options cannot be read", () =>
    Effect.gen(function* () {
      const s = yield* harness
      const first = yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      yield* s.db.run(
        sql`update session_message set data = json_set(data, '$.turn', json('{"maxSteps":0}')) where id = ${first.id}`,
      )

      const error = yield* s.current.pipe(Effect.flip)

      expect(error._tag).toBe("Session.MessageDecodeError")
    }),
  )

  it.effect("reads only the session it is asked about, however much newer the other session's history is", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      yield* s.idle
      yield* s.admit("B", { turn: { maxSteps: 5 } })
      yield* s.promote("input")
      yield* s.notice("fallback", { model: backup })
      yield* s.notice("stop-hook")

      // Every kind of row the read looks for, in a session whose sequence numbers run well ahead of the first one's.
      for (const _ of Array.from({ length: 8 })) yield* s.other.notice("padding")
      yield* s.other.admit("Other", { turn: { maxTokens: 10 } })
      yield* s.other.promote("input")
      yield* s.other.notice("fallback", { model: spare })
      yield* s.other.switchModel(primary)
      yield* s.other.idle
      const queued = yield* s.other.admit("Other queued", { delivery: "queue", turn: { maxCost: Money.USD.make(9) } })
      yield* s.other.promote("input")
      yield* s.other.notice("stop-hook")
      yield* s.other.notice("stop-hook")
      yield* s.other.notice("fallback", { model: spare })
      yield* s.other.switchModel(backup)
      yield* s.other.notice("fallback", { model: spare })

      expect((yield* s.current).notices).toEqual({ fallback: 1, "stop-hook": 1 })
      expect(yield* s.current).toMatchObject({ options: { maxSteps: 5 }, fallback: backup })
      expect(yield* s.other.current).toMatchObject({
        boundary: yield* s.seq(queued.id),
        options: { maxCost: 9 },
        fallback: spare,
        notices: { "stop-hook": 2, fallback: 2 },
      })
    }),
  )

  it.effect("gives the same answer after the projection is rebuilt from the recorded events", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("A", { turn: { maxSteps: 1 } })
      yield* s.promote("input")
      yield* s.notice("stop-hook")
      yield* s.idle
      yield* TestClock.adjust("3 seconds")
      yield* s.admit("B", { delivery: "queue", turn: { maxSteps: 2, fallbackModel: backup } })
      yield* s.promote("input")
      yield* s.notice("fallback", { model: backup })
      yield* s.notice("output-limit")
      yield* s.notice("stop-hook")
      yield* s.notice("output-escalation")
      yield* TestClock.adjust("3 seconds")
      yield* s.admit("Steer", { turn: { maxCost: Money.USD.make(1.5) } })
      yield* s.promote("steer")
      yield* s.switchModel(primary)
      yield* s.notice("fallback", { model: spare })
      yield* s.admitSynthetic("Steered completion", "steer")
      yield* s.promote("steer")

      const before = yield* s.current
      expect(before.boundary).toBeDefined()
      expect(before.options).toMatchObject({ maxCost: Money.USD.make(1.5) })
      expect(before.options).not.toHaveProperty("maxSteps")
      expect(before.fallback).toEqual(spare)
      expect(before.notices).toEqual({ fallback: 2, "output-limit": 1, "stop-hook": 1, "output-escalation": 1 })

      yield* s.replay

      expect(plain(yield* s.current)).toEqual(plain(before))
    }),
  )
})

describe("SessionTurn.usage", () => {
  const childID = Session.ID.make("ses_turn_child")
  const grandchildID = Session.ID.make("ses_turn_grandchild")
  const strangerID = Session.ID.make("ses_turn_stranger")
  const noTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

  // A response, written the way the runner writes one: started, then ended, at `at` milliseconds.
  const respond = (
    id: Session.ID,
    at: number,
    spend: { cost?: number; tokens?: typeof noTokens; finish?: "stop" | "tool-calls" | "error" | "length" | "content-filter" } = {},
  ) =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: id,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: primary,
        started: at,
      })
      yield* bus.publish(SessionEvent.Step.Ended, {
        sessionID: id,
        assistantMessageID,
        finish: spend.finish ?? "stop",
        cost: Money.USD.make(spend.cost ?? 1),
        tokens: spend.tokens ?? { input: 10, output: 4, reasoning: 2, cache: { read: 100, write: 8 } },
      })
    })
  // A response that failed mid-stream: started, then failed with no usage, so the row carries no cost.
  const respondFailed = (id: Session.ID, at: number) =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const assistantMessageID = SessionMessage.ID.create()
      yield* bus.publish(SessionEvent.Step.Started, {
        sessionID: id,
        assistantMessageID,
        agent: Agent.ID.make("build"),
        model: primary,
        started: at,
      })
      yield* bus.publish(SessionEvent.Step.Failed, {
        sessionID: id,
        assistantMessageID,
        error: { type: "provider.transport", message: "Disconnected" },
      })
    })
  const record = (id: Session.ID, source: "title" | "compaction", cost: number) =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID: id,
        source,
        cost: Money.USD.make(cost),
        tokens: { input: 5, output: 3, reasoning: 1, cache: { read: 50, write: 2 } },
      })
    })
  const children = Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values(
        [
          [childID, sessionID],
          [grandchildID, childID],
          [strangerID, otherSessionID],
        ].map(([id, parent_id]) => ({
          id: id!,
          parent_id,
          project_id: Project.ID.global,
          slug: id!,
          directory: "/project",
          title: "child",
          version: "test",
        })),
      )
      .run()
  })
  const since = (turn: SessionTurn.Current) => ({ seq: turn.options!.seq, time: turn.options!.time })

  it.effect("sums responses and usage records after the window and leaves earlier turns out", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("Earlier", { turn: { maxSteps: 9 } })
      yield* s.promote("input")
      yield* respond(sessionID, 1_000, { cost: 100 })
      yield* record(sessionID, "compaction", 100)
      yield* s.idle
      yield* s.admit("Now", { delivery: "queue", turn: { maxSteps: 9 } })
      yield* s.promote("input")
      yield* respond(sessionID, 2_000, { cost: 1, finish: "tool-calls" })
      yield* respond(sessionID, 2_100, { cost: 2, finish: "length" })
      yield* respond(sessionID, 2_200, { cost: 4, finish: "content-filter" })
      yield* respond(sessionID, 2_300, { cost: 8 })
      // A mid-stream failure is no step, but what it spent still counts.
      yield* respond(sessionID, 2_400, { cost: 16, finish: "error" })
      yield* record(sessionID, "compaction", 32)
      yield* record(sessionID, "title", 64)
      yield* respond(otherSessionID, 2_500, { cost: 1_000 })

      const turn = yield* s.current

      // Per response: input 10 + cache write 8 + output 4 + reasoning 2, and 5 + 2 + 3 + 1 per record. Cache reads never count.
      expect(yield* SessionTurn.usage(s.db, sessionID, since(turn))).toEqual({
        steps: 4,
        cost: 1 + 2 + 4 + 8 + 16 + 32 + 64,
        tokens: 5 * 24 + 2 * 11,
        unknown: 0,
      })
    }),
  )

  it.effect("includes a subagent and its own subagents created inside the window, and nothing before it", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* children
      yield* TestClock.adjust("1 second")
      yield* s.admit("Now", { turn: { maxSteps: 9 } })
      yield* s.promote("input")
      // A subagent that was already running spends before this turn began.
      yield* respond(childID, 500, { cost: 1_000 })
      const turn = yield* s.current
      yield* respond(sessionID, 1_000, { cost: 1 })
      yield* respond(childID, 1_500, { cost: 2 })
      yield* respond(grandchildID, 1_600, { cost: 4 })
      yield* record(grandchildID, "title", 8)
      yield* respond(strangerID, 1_700, { cost: 1_000 })

      // A subagent's responses are no steps of this Session.
      expect(yield* SessionTurn.usage(s.db, sessionID, since(turn))).toEqual({
        steps: 1,
        cost: 1 + 2 + 4 + 8,
        tokens: 24 * 3 + 11,
        unknown: 0,
      })
    }),
  )

  it.effect("counts what cannot be priced as unknown instead of free", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* children
      yield* s.admit("Now", { turn: { maxCost: Money.USD.make(5) } })
      yield* s.promote("input")
      const turn = yield* s.current
      yield* respond(sessionID, 1_000)
      expect((yield* SessionTurn.usage(s.db, sessionID, since(turn))).unknown).toBe(0)

      // A subagent whose response carried no usage at all.
      yield* respond(childID, 1_100, { cost: 0, tokens: noTokens })
      expect((yield* SessionTurn.usage(s.db, sessionID, since(turn))).unknown).toBe(1)

      // A usage record that no longer decodes.
      yield* record(childID, "compaction", 1)
      yield* s.db
        .update(EventTable)
        .set({ data: { sessionID: childID, source: "compaction" } })
        .where(sql`${EventTable.type} like 'session.usage.recorded%'`)
        .run()
      expect((yield* SessionTurn.usage(s.db, sessionID, since(turn))).unknown).toBe(2)
    }),
  )

  const unknownSpend: ReadonlyArray<
    [string, (id: Session.ID) => Effect.Effect<void, unknown, Bus.Service>]
  > = [
    ["a response with tokens and a cost of zero", (id) => respond(id, 1_100, { cost: 0 })],
    ["a failed response with no recorded cost", (id) => respondFailed(id, 1_100)],
    ["a usage record with tokens and a cost of zero", (id) => record(id, "title", 0)],
  ]
  for (const [name, spend] of unknownSpend)
    for (const where of ["the session", "a subagent"] as const)
      it.effect(`counts ${name} in ${where} as unknown`, () =>
        Effect.gen(function* () {
          const s = yield* harness
          yield* children
          yield* s.admit("Now", { turn: { maxCost: Money.USD.make(5) } })
          yield* s.promote("input")
          const turn = yield* s.current
          yield* respond(sessionID, 1_000)
          expect((yield* SessionTurn.usage(s.db, sessionID, since(turn))).unknown).toBe(0)

          yield* spend(where === "the session" ? sessionID : childID)
          expect((yield* SessionTurn.usage(s.db, sessionID, since(turn))).unknown).toBe(1)
        }),
      )

  it.effect("is the same after the session's events are replayed", () =>
    Effect.gen(function* () {
      const s = yield* harness
      yield* s.admit("Now", { turn: { maxSteps: 9 } })
      yield* s.promote("input")
      yield* respond(sessionID, 1_000, { cost: 3 })
      yield* record(sessionID, "compaction", 5)
      yield* respond(sessionID, 2_000, { cost: 7, finish: "error" })
      yield* respond(sessionID, 3_000, { cost: 11, finish: "tool-calls" })
      const turn = yield* s.current
      const before = yield* SessionTurn.usage(s.db, sessionID, since(turn))
      expect(before.steps).toBe(2)

      yield* s.replay

      const replayed = yield* s.current
      expect(replayed.options?.seq).toBe(turn.options?.seq)
      expect(yield* SessionTurn.usage(s.db, sessionID, since(replayed))).toEqual(before)
    }),
  )
})

describe("SessionTurn.exceeded", () => {
  const spent = { steps: 2, cost: 3, tokens: 100, unknown: 0 }
  const table: ReadonlyArray<readonly [string, SessionTurn.Options, SessionTurn.Usage, boolean, string | undefined]> = [
    ["no limit", {}, spent, true, undefined],
    ["under every limit", { maxSteps: 3, maxCost: Money.USD.make(4), maxTokens: 101 }, spent, true, undefined],
    ["steps reached", { maxSteps: 2 }, spent, true, "limit.steps"],
    ["cost reached", { maxCost: Money.USD.make(3) }, spent, true, "limit.cost"],
    ["tokens reached", { maxTokens: 100 }, spent, true, "limit.tokens"],
    ["cost limit, model without a price", { maxCost: Money.USD.make(50) }, spent, false, "limit.cost-unknown"],
    ["cost limit, unknown spend", { maxCost: Money.USD.make(50) }, { ...spent, unknown: 1 }, true, "limit.cost-unknown"],
    ["unknown spend, no cost limit", { maxTokens: 500 }, { ...spent, unknown: 1 }, false, undefined],
  ]
  for (const [name, options, usage, priced, type] of table)
    it.effect(name, () =>
      Effect.sync(() => {
        expect(SessionTurn.exceeded(options, usage, priced)?.type).toBe(type)
      }),
    )
})
