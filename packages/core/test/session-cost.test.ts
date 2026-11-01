// clients-ux-23 part 2: `SessionCost.summary` answers /cost for the whole session and its subagents from durable rows, so
// it does not depend on which page of messages a client loaded (FU-M2-026). It reads database rows only: no Location, no
// folder, no trust gate (PS2 pins that at the route).
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionCost } from "@orbit/core/session/cost"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionInbox } from "@orbit/core/session/inbox"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionMessageTable, SessionTable, SessionUsageTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { seedStep } from "./lib/context-history"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, SessionStore.node, Session.node]),
    [Bus.node.replace(Bus.configured({ persist: true })), SessionExecution.node.replace(SessionExecution.noopLayer)],
  ),
)

const root = Session.ID.make("ses_cost_root")
const child = Session.ID.make("ses_cost_child")
const tokens = (input: number) => ({ input, output: 1, reasoning: 0, cache: { read: 2, write: 3 } })

const seedProject = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  return db
})

/** A session row written directly: like one from before this version, its line counts are null. */
const sessionRow = (id: Session.ID, overrides: Partial<typeof SessionTable.$inferInsert> = {}) =>
  ({
    id,
    project_id: Project.ID.global,
    slug: id,
    directory: "/project",
    version: "test",
    ...overrides,
  }) satisfies typeof SessionTable.$inferInsert

/** A stored message, written as the projector writes it (the fields /cost reads, with the time in milliseconds). */
let serial = 0
const message = (
  sessionID: Session.ID,
  type: "assistant" | "compaction",
  fields: {
    readonly provider?: string
    readonly model?: string
    readonly input?: number
    readonly cost?: number
    readonly created?: number
    readonly streamed?: number
    readonly completed?: number
    readonly extra?: Record<string, unknown>
  },
) => {
  serial += 1
  const created = fields.created ?? 1_000 + serial
  return {
    id: `msg_cost_${serial}`,
    session_id: sessionID,
    type,
    seq: serial,
    time_created: created,
    data: {
      model: { providerID: fields.provider ?? "prov", id: fields.model ?? "alpha" },
      ...(fields.input === undefined ? {} : { tokens: tokens(fields.input) }),
      ...(fields.cost === undefined ? {} : { cost: fields.cost }),
      ...(type === "compaction" ? { status: "completed" } : {}),
      time: {
        created,
        ...(fields.streamed === undefined ? {} : { streamed: fields.streamed }),
        ...(fields.completed === undefined ? {} : { completed: fields.completed }),
      },
      ...fields.extra,
    },
  } as unknown as typeof SessionMessageTable.$inferInsert
}

let usageSeq = 0
const usage = (
  sessionID: Session.ID,
  kind: "usage" | "side_query",
  source: string,
  cost: number,
  model?: { readonly provider: string; readonly id: string },
) => {
  usageSeq += 1
  return {
    session_id: sessionID,
    seq: usageSeq,
    time_created: 2_000 + usageSeq,
    kind,
    source,
    cost,
    tokens_input: 10,
    tokens_output: 1,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    provider_id: model?.provider ?? null,
    model_id: model?.id ?? null,
  } satisfies typeof SessionUsageTable.$inferInsert
}

const totalOf = (rows: ReadonlyArray<{ readonly cost: number }>) => rows.reduce((sum, row) => sum + row.cost, 0)

describe("SessionCost", () => {
  // PC1, FU-M2-026: the summary reads every response, however many a client has loaded. Mutation: drop the family.
  it.effect("the summary covers every page of a long session and its subagents", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 3 })).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values(sessionRow(child, { parent_id: root, cost: 0.5 })).run().pipe(Effect.orDie)
      const long = Array.from({ length: 300 }, (_, index) =>
        message(root, "assistant", {
          model: index % 2 === 0 ? "alpha" : "beta",
          input: 10,
          cost: 0.01,
          created: 10_000 + index * 10,
          streamed: 10_005 + index * 10,
          completed: 10_008 + index * 10,
        }),
      )
      yield* db.insert(SessionMessageTable).values(long).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values(Array.from({ length: 50 }, () => message(child, "assistant", { model: "alpha", input: 10, cost: 0.01 })))
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(summary.rows.map((row) => [row.modelID, row.responses])).toEqual([
        ["alpha", 200],
        ["beta", 150],
      ])
      expect(summary.rows.reduce((sum, row) => sum + row.tokens.input, 0)).toBe(3_500)
      expect(summary.cost).toBeCloseTo(3.5)
      expect(summary.own).toBeCloseTo(3)
      expect(summary.subagents).toBeCloseTo(0.5)
      expect(totalOf(summary.rows)).toBeCloseTo(3.5)
      expect(summary.other).toBeUndefined()
      expect(summary.api).toBe(300 * 5)

      // Asked for the child, the family is the child alone.
      const only = yield* SessionCost.summary(child)
      expect(only.rows[0]?.responses).toBe(50)
      expect(only.subagents).toBeCloseTo(0)
    }),
  )

  // PC2: what no row explains is one `other`, and the total stays the sum of the sessions' own totals.
  it.effect("a rewind's removed responses and records without a model fall into other, and the total stays exact", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      // The session spent 1.00: 0.60 is still in a response, 0.30 was in responses a rewind removed, 0.10 is a usage
      // record written before records named a model.
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 1 })).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values(message(root, "assistant", { input: 10, cost: 0.6 })).run().pipe(Effect.orDie)
      yield* db.insert(SessionUsageTable).values(usage(root, "usage", "title", 0.1)).run().pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(summary.cost).toBe(1)
      expect(totalOf(summary.rows)).toBeCloseTo(0.6)
      expect(summary.other).toBeCloseTo(0.4)
      expect(totalOf(summary.rows) + (summary.other ?? 0)).toBeCloseTo(summary.cost)
    }),
  )

  // PC3: a record with a model is itemized under it; a compaction is in its message and in a usage record, and counts once.
  // Mutation: also count the `session_usage` compaction rows.
  it.effect("side queries, titles and discarded attempts with a model are itemized under that model, and a compaction is counted once", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      const alpha = { provider: "prov", id: "alpha" }
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.9 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(root, "assistant", { input: 10, cost: 0.4 }),
          message(root, "compaction", { input: 10, cost: 0.2 }),
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionUsageTable)
        .values([
          usage(root, "usage", "title", 0.1, alpha),
          usage(root, "side_query", "step.retry", 0.15, alpha),
          // The compaction message above already holds this call's spend.
          usage(root, "usage", "compaction", 0.2, alpha),
          // A side query on another model.
          usage(root, "side_query", "webfetch.summarize", 0.05, { provider: "prov", id: "beta" }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      const alphaRow = summary.rows.find((row) => row.modelID === "alpha")
      expect(alphaRow?.responses).toBe(4)
      expect(alphaRow?.cost).toBeCloseTo(0.85)
      expect(summary.rows.find((row) => row.modelID === "beta")).toMatchObject({ responses: 1 })
      expect(totalOf(summary.rows)).toBeCloseTo(0.9)
      expect(summary.other).toBeUndefined()
    }),
  )

  // PC4: a fork's totals start at zero, so the messages it copied from its parent stay out. Model IDs may hold the
  // separators of a key (class 5): they are labels, never parsed.
  it.effect("a fork leaves out the messages it copied", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root)).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values(sessionRow(child, { fork_session_id: root, time_created: 10_000, cost: 0.5 }))
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(child, "assistant", { input: 10, cost: 1.5, created: 1_000, streamed: 2_000, completed: 3_000 }),
          message(child, "assistant", {
            provider: "a/b",
            model: "c#d",
            input: 10,
            cost: 0.25,
            created: 11_000,
            streamed: 12_000,
            completed: 13_000,
          }),
          message(child, "assistant", { provider: "a", model: "b/c#d", input: 10, cost: 0.25, created: 14_000 }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(child)
      expect(summary.rows.map((row) => [row.providerID, row.modelID, row.responses, row.cost])).toEqual([
        ["a", "b/c#d", 1, 0.25],
        ["a/b", "c#d", 1, 0.25],
      ])
      expect(summary.api).toBe(1_000)
      expect(summary.wall).toBe(3_000)
    }),
  )

  // PC5, D17: lines are counted when a tool result is projected. Mutation: count NotebookEdit; drop the null check.
  it.effect("Edit, Write and Patch lines are summed per edit, NotebookEdit is not, and a malformed entry costs only itself", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.Created, {
        sessionID: root,
        projectID: Project.ID.global,
        location: { directory: AbsolutePath.make("/project") },
        slug: "root",
        version: "test",
      })
      yield* bus.publish(SessionEvent.Created, {
        sessionID: child,
        projectID: Project.ID.global,
        parentID: root,
        location: { directory: AbsolutePath.make("/project") },
        slug: "child",
        version: "test",
      })
      const files = (...entries: unknown[]) => ({ files: entries as never })
      const calls = [
        { id: "c1", name: "Edit", metadata: files({ additions: 3, deletions: 1 }, { additions: 2, deletions: 0 }) },
        { id: "c2", name: "Write", metadata: files({ additions: 5, deletions: 0 }) },
        { id: "c3", name: "Patch", metadata: files({ additions: 1, deletions: 1 }) },
        // The old spelling of a tool is the same tool.
        { id: "c4", name: "edit", metadata: files({ additions: 10, deletions: 10 }) },
        { id: "c5", name: "NotebookEdit", metadata: files({ additions: 100, deletions: 100 }) },
        { id: "c6", name: "Read", metadata: files({ additions: 100, deletions: 100 }) },
        // A malformed entry costs only itself: not a number, a negative, a fraction, a missing field, not an object.
        {
          id: "c7",
          name: "Edit",
          metadata: files(
            { additions: 4, deletions: 2 },
            { additions: "x", deletions: 1 },
            { additions: 4, deletions: -1 },
            { additions: 1.5, deletions: 1 },
            { additions: 7 },
            null,
            "text",
          ),
        },
        { id: "c8", name: "Edit", metadata: { files: "not a list" } },
        { id: "c9", name: "Edit" },
      ]
      yield* seedStep(bus, root, { id: "msg_cost_edit", calls })
      yield* seedStep(bus, child, {
        id: "msg_cost_child",
        calls: [{ id: "c1", name: "Write", metadata: files({ additions: 7, deletions: 2 }) }],
      })

      const own = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(own.find((row) => row.id === root)).toMatchObject({ lines_added: 3 + 2 + 5 + 1 + 10 + 4, lines_removed: 1 + 0 + 0 + 1 + 10 + 2 })
      const summary = yield* SessionCost.summary(root)
      expect(summary.lines).toEqual({ added: 25 + 7, removed: 14 + 2 })
    }),
  )

  // PC6: a session that predates the counter has none, so a client shows no line; a new session and a fork start at zero.
  // Mutation: read a null column as zero.
  it.effect("a session from before the version has no line counts; a new session and a fork start at zero", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      const bus = yield* Bus.Service
      const sessions = yield* Session.Service
      yield* db.insert(SessionTable).values(sessionRow(child)).run().pipe(Effect.orDie)
      expect((yield* SessionCost.summary(child)).lines).toBeUndefined()

      yield* bus.publish(SessionEvent.Created, {
        sessionID: root,
        projectID: Project.ID.global,
        location: { directory: AbsolutePath.make("/project") },
        slug: "root",
        version: "test",
      })
      expect((yield* SessionCost.summary(root)).lines).toEqual({ added: 0, removed: 0 })

      yield* seedStep(bus, root, {
        id: "msg_cost_fork_source",
        calls: [{ id: "c1", name: "Edit", metadata: { files: [{ additions: 4, deletions: 4 }] } }],
      })
      expect((yield* SessionCost.summary(root)).lines).toEqual({ added: 4, removed: 4 })
      const fork = yield* sessions.fork({ sessionID: root })
      expect((yield* SessionCost.summary(fork.id)).lines).toEqual({ added: 0, removed: 0 })

      // An unknown session is a typed failure.
      const missing = yield* Effect.flip(SessionCost.summary(Session.ID.make("ses_cost_missing")))
      expect(missing._tag).toBe("Session.NotFoundError")
    }),
  )
})
