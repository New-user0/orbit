// clients-ux-23 part 2: `SessionCost.summary` answers /cost for the whole session and its subagents from durable rows, so
// it does not depend on which page of messages a client loaded (FU-M2-026). It reads database rows only: no Location, no
// folder, no trust gate (PS2 pins that at the route).
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Model } from "@orbit/core/model"
import { Provider } from "@orbit/core/provider"
import { Money } from "@orbit/schema/money"
import { Session } from "@orbit/core/session"
import { SessionCost } from "@orbit/core/session/cost"
import { SessionEvent } from "@orbit/core/session/event"
import { SessionMessage } from "@orbit/core/session/message"
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
const tokens = (input: number) => ({ input, output: 1, reasoning: 5, cache: { read: 2, write: 3 } })

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
  counts: { readonly input: number; readonly output: number; readonly reasoning: number; readonly read: number; readonly write: number } = {
    input: 10,
    output: 1,
    reasoning: 0,
    read: 0,
    write: 0,
  },
) => {
  usageSeq += 1
  return {
    session_id: sessionID,
    seq: usageSeq,
    time_created: 2_000 + usageSeq,
    kind,
    source,
    cost,
    tokens_input: counts.input,
    tokens_output: counts.output,
    tokens_reasoning: counts.reasoning,
    tokens_cache_read: counts.read,
    tokens_cache_write: counts.write,
    provider_id: model?.provider ?? null,
    model_id: model?.id ?? null,
  } satisfies typeof SessionUsageTable.$inferInsert
}

/** A usage record's five token kinds, each a distinct multiple of `n`, so a row that mixes them up or drops one differs. */
const scaled = (n: number) => ({ input: n, output: 2 * n, reasoning: 3 * n, read: 4 * n, write: 5 * n })

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
      expect(summary.rows.map((row) => row.tokens)).toEqual([
        { input: 2_000, output: 200, reasoning: 1_000, cache: { read: 400, write: 600 } },
        { input: 1_500, output: 150, reasoning: 750, cache: { read: 300, write: 450 } },
      ])
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

  // Mutations: let the subagent share go negative; give a session with no response a wall time.
  it.effect("a session with no response has no wall time, and the subagent share is never negative", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 1 })).run().pipe(Effect.orDie)
      const idle = yield* SessionCost.summary(root)
      expect(idle.wall).toBeUndefined()
      expect(idle.api).toBeUndefined()
      // A child whose stored total is below zero cannot make the family cost less than the session itself.
      yield* db.insert(SessionTable).values(sessionRow(child, { parent_id: root, cost: -0.4 })).run().pipe(Effect.orDie)
      expect(Number((yield* SessionCost.summary(root)).subagents)).toBe(0)
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
      expect(summary.cost).toBeCloseTo(1)
      expect(totalOf(summary.rows)).toBeCloseTo(0.6)
      expect(summary.other).toBeCloseTo(0.4)
      expect(totalOf(summary.rows) + (summary.other ?? 0)).toBeCloseTo(summary.cost)
    }),
  )

  // PC2 (continued): which responses are unknown spend. A response that used tokens and recorded no cost, and one that
  // failed with neither, are `unrecorded`; one that recorded exactly 0 is `zero`; one that used no tokens is neither.
  // Mutation: UNION ALL in the family query. A parent cycle then recurses without end, so the mutant is killed by a deadline.
  it.effect("a parent cycle counts each session once and ends", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.5 })).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values(sessionRow(child, { parent_id: root, cost: 0.5 })).run().pipe(Effect.orDie)
      yield* db.update(SessionTable).set({ parent_id: child }).where(eq(SessionTable.id, root)).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values(message(child, "assistant", { input: 10, cost: 1 })).run().pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(summary.cost).toBeCloseTo(1)
      expect(summary.rows.map((row) => row.responses)).toEqual([1])
    }),
  )

  // Mutation: invert either tie-break comparison of the row sort.
  it.effect("rows of equal cost are ordered by provider, then by model", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.4 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(root, "assistant", { provider: "zeta", model: "a", input: 10, cost: 0.1 }),
          message(root, "assistant", { provider: "alpha", model: "b", input: 10, cost: 0.1 }),
        ])
        .run()
        .pipe(Effect.orDie)
      // Records are merged after messages, so these arrive after zeta and the sort has to move them in front of it.
      yield* db
        .insert(SessionUsageTable)
        .values([
          usage(root, "usage", "step", 0.1, { provider: "alpha", id: "a" }),
          usage(root, "usage", "step", 0.1, { provider: "beta", id: "a" }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(summary.rows.map((row) => `${row.providerID}/${row.modelID}`)).toEqual(["alpha/a", "alpha/b", "beta/a", "zeta/a"])
    }),
  )

  it.effect("responses with no recorded cost or a recorded zero are counted apart, so a client can call them unknown", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.5 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(root, "assistant", { input: 10, cost: 0.5 }),
          message(root, "assistant", { input: 10 }),
          message(root, "assistant", { input: 10, cost: 0 }),
          message(root, "assistant", { input: 10, cost: 0 }),
          message(root, "assistant", { model: "gamma", extra: { finish: "error" } }),
          message(root, "assistant", { model: "delta", extra: { finish: "stop" } }),
          // No tokens used: neither unknown nor free.
          message(root, "assistant", { extra: { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } }),
          message(root, "assistant", { extra: { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0 } }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      // The failed response with no tokens counts; the stopped one with no tokens is not a response that used any.
      expect(summary.rows.map((row) => row.modelID)).toEqual(["alpha", "gamma"])
      expect(summary.rows[0]).toMatchObject({ responses: 6, unrecorded: 1, zero: 2 })
      expect(summary.rows[0]?.cost).toBeCloseTo(0.5)
      expect(summary.rows[1]).toMatchObject({ responses: 1, unrecorded: 1, zero: 0 })
    }),
  )

  // PC3: a record with a model is itemized under it. A compaction's calls are recorded when they happen, so a failed or
  // cancelled one is itemized too; its completed message is left out when the session has such records, so it counts once.
  // Mutation: count the compaction messages as well.
  it.effect("side queries, titles and discarded attempts with a model are itemized under that model, and a compaction is counted once", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      const alpha = { provider: "prov", id: "alpha" }
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 1.3 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(root, "assistant", { input: 10, cost: 0.4 }),
          message(root, "assistant", { model: "mixed", input: 10, cost: 0.1 }),
          // The records below hold this compaction's spend.
          message(root, "compaction", { input: 10, cost: 0.2 }),
          message(root, "compaction", { input: 10, cost: 0.3, extra: { status: "failed" } }),
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionUsageTable)
        .values([
          usage(root, "usage", "title", 0.1, alpha, scaled(100)),
          usage(root, "side_query", "step.retry", 0.15, alpha, scaled(1_000)),
          usage(root, "usage", "compaction", 0.2, alpha, scaled(10_000)),
          // A compaction that failed or was cancelled still spent this.
          usage(root, "usage", "compaction", 0.3, alpha, scaled(100_000)),
          // A call on a model that also has a priced response: its zero is still counted in the merged row.
          usage(root, "side_query", "webfetch.summarize", 0, { provider: "prov", id: "mixed" }),
          // A side query on another model.
          usage(root, "side_query", "webfetch.summarize", 0.05, { provider: "prov", id: "beta" }),
          // A call that spent tokens and recorded exactly 0 is counted as free or unpriced.
          usage(root, "side_query", "webfetch.summarize", 0, { provider: "prov", id: "free" }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      const alphaRow = summary.rows.find((row) => row.modelID === "alpha")
      expect(alphaRow?.responses).toBe(5)
      expect(alphaRow?.cost).toBeCloseTo(1.15)
      // The response (10, 1, 5, 2, 3) plus the four records.
      expect(alphaRow?.tokens).toEqual({ input: 111_110, output: 222_201, reasoning: 333_305, cache: { read: 444_402, write: 555_503 } })
      expect(summary.rows.find((row) => row.modelID === "mixed")).toMatchObject({
        responses: 2,
        unrecorded: 0,
        zero: 1,
        tokens: { input: 20, output: 2, reasoning: 5, cache: { read: 2, write: 3 } },
      })
      expect(summary.rows.find((row) => row.modelID === "beta")).toMatchObject({ responses: 1, zero: 0 })
      expect(summary.rows.find((row) => row.modelID === "free")).toMatchObject({ responses: 1, zero: 1 })
      expect(totalOf(summary.rows)).toBeCloseTo(1.3)
      expect(summary.other).toBeUndefined()
    }),
  )

  // A session from before usage records named a model: its compaction is counted from the message, once, and the
  // record without a model stays out of the rows.
  it.effect("a compaction from before records named a model is counted from its message", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.2 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([message(root, "compaction", { input: 10, cost: 0.2 })])
        .run()
        .pipe(Effect.orDie)
      yield* db.insert(SessionUsageTable).values([usage(root, "usage", "compaction", 0.2)]).run().pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(summary.rows).toHaveLength(1)
      expect(summary.rows[0]?.cost).toBeCloseTo(0.2)
      expect(summary.other).toBeUndefined()
    }),
  )

  // The session-wide rule: once a session compacts again after the upgrade, the earlier compaction's spend (a record with
  // no model) shows as other, and the total stays exact.
  it.effect("a session that compacts again after the upgrade shows its earlier compaction as other", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.5 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(root, "compaction", { input: 10, cost: 0.2 }),
          message(root, "compaction", { input: 10, cost: 0.3 }),
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionUsageTable)
        .values([
          usage(root, "usage", "compaction", 0.2),
          usage(root, "usage", "compaction", 0.3, { provider: "prov", id: "alpha" }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(totalOf(summary.rows)).toBeCloseTo(0.3)
      expect(summary.other).toBeCloseTo(0.2)
    }),
  )

  // Which records suppress a compaction message: only this session's compaction calls that name a model. Mutations: let a
  // title record suppress it (drop the source test), let another session's record suppress it (drop the session test),
  // count a compaction that did not complete.
  it.effect("only the session's own compaction records that name a model stand in for its compaction message", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      const alpha = { provider: "prov", id: "alpha" }
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.3 })).run().pipe(Effect.orDie)
      yield* db.insert(SessionTable).values(sessionRow(child, { parent_id: root, cost: 0.3 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          message(root, "compaction", { input: 10, cost: 0.2 }),
          message(root, "compaction", { input: 10, cost: 0.7, extra: { status: "failed" } }),
          message(child, "compaction", { input: 10, cost: 0.3 }),
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionUsageTable)
        .values([usage(root, "usage", "title", 0.1, alpha), usage(child, "usage", "compaction", 0.3, alpha)])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      // 0.2 from the root's message, 0.1 from its title, 0.3 from the child's record (its message is left out).
      expect(summary.rows[0]?.cost).toBeCloseTo(0.6)
      expect(summary.rows[0]?.responses).toBe(3)
    }),
  )

  // Float noise in the sessions' totals is not spend the rows failed to explain. Mutation: show any difference.
  it.effect("a rounding difference below the threshold is not other", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { cost: 0.1 + 0.2 })).run().pipe(Effect.orDie)
      yield* db.insert(SessionMessageTable).values(message(root, "assistant", { input: 10, cost: 0.3 })).run().pipe(Effect.orDie)

      expect((yield* SessionCost.summary(root)).other).toBeUndefined()
    }),
  )

  // A clock that stepped back must not give a negative duration.
  it.effect("a response stamped before its start or before its session adds no negative time", () =>
    Effect.gen(function* () {
      const db = yield* seedProject
      yield* db.insert(SessionTable).values(sessionRow(root, { time_created: 50_000 })).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([message(root, "assistant", { input: 10, cost: 0.1, created: 1_000, streamed: 900, completed: 2_000 })])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(root)
      expect(summary.api).toBe(0)
      expect(summary.wall).toBe(0)
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
          // Written in the very millisecond the fork was created: its own, not copied.
          message(child, "assistant", { provider: "e", model: "f", input: 10, cost: 0.1, created: 10_000, streamed: 10_500 }),
        ])
        .run()
        .pipe(Effect.orDie)

      const summary = yield* SessionCost.summary(child)
      expect(summary.rows.map((row) => [row.providerID, row.modelID, row.responses, row.cost])).toEqual([
        ["a", "b/c#d", 1, 0.25],
        ["a/b", "c#d", 1, 0.25],
        ["e", "f", 1, 0.1],
      ])
      expect(summary.api).toBe(1_500)
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
        // Two calls still running: the result belongs to the one it names, not to the last call in the message.
        { id: "r1", name: "Edit", running: true },
        { id: "r2", name: "Bash", running: true },
      ]
      yield* seedStep(bus, root, { id: "msg_cost_edit", calls })
      yield* seedStep(bus, child, {
        id: "msg_cost_child",
        calls: [{ id: "c1", name: "Write", metadata: files({ additions: 7, deletions: 2 }) }],
      })

      // A result for a call that already finished changes nothing, so a repeat does not count twice.
      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID: root,
        assistantMessageID: SessionMessage.ID.make("msg_cost_edit"),
        id: "c2",
        content: [{ type: "text", text: "again" }],
        metadata: { files: [{ additions: 50, deletions: 50 }] },
        executed: false,
      })

      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID: root,
        assistantMessageID: SessionMessage.ID.make("msg_cost_edit"),
        id: "r1",
        content: [{ type: "text", text: "done" }],
        metadata: { files: [{ additions: 6, deletions: 3 }] },
        executed: false,
      })

      const own = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(own.find((row) => row.id === root)).toMatchObject({ lines_added: 3 + 2 + 5 + 1 + 10 + 4 + 6, lines_removed: 1 + 0 + 0 + 1 + 10 + 2 + 3 })
      const summary = yield* SessionCost.summary(root)
      expect(summary.lines).toEqual({ added: 31 + 7, removed: 17 + 2 })
    }),
  )

  it.effect("a result for a message that is not stored counts no lines", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* seedProject
      yield* bus.publish(SessionEvent.Created, {
        sessionID: root,
        projectID: Project.ID.global,
        location: { directory: AbsolutePath.make("/project") },
        slug: "root",
        version: "test",
      })
      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID: root,
        assistantMessageID: SessionMessage.ID.make("msg_cost_absent"),
        id: "c1",
        content: [{ type: "text", text: "done" }],
        metadata: { files: [{ additions: 5, deletions: 5 }] },
        executed: false,
      })
      expect((yield* SessionCost.summary(root)).lines).toEqual({ added: 0, removed: 0 })
    }),
  )

  // Mutations: drop the session check of the message lookup; read the parts front to back.
  it.effect("a result is counted for the message of its own session, and for the latest call of a repeated ID", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* seedProject
      yield* Effect.forEach([root, child], (sessionID) =>
        bus.publish(SessionEvent.Created, {
          sessionID,
          projectID: Project.ID.global,
          location: { directory: AbsolutePath.make("/project") },
          slug: String(sessionID),
          version: "test",
        }),
      )
      yield* seedStep(bus, root, {
        id: "msg_cost_repeat",
        calls: [
          { id: "d1", name: "Edit", metadata: { files: [{ additions: 3, deletions: 1 }] as never } },
          { id: "d1", name: "Edit", running: true },
        ],
      })
      expect((yield* SessionCost.summary(root)).lines).toEqual({ added: 3, removed: 1 })

      // The other session names root's message: nothing is counted for either.
      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID: child,
        assistantMessageID: SessionMessage.ID.make("msg_cost_repeat"),
        id: "d1",
        content: [{ type: "text", text: "done" }],
        metadata: { files: [{ additions: 20, deletions: 20 }] },
        executed: false,
      })
      expect((yield* SessionCost.summary(child)).lines).toEqual({ added: 0, removed: 0 })

      // The same ID again on the root's own message belongs to the call that is still running, the later part.
      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID: root,
        assistantMessageID: SessionMessage.ID.make("msg_cost_repeat"),
        id: "d1",
        content: [{ type: "text", text: "done" }],
        metadata: { files: [{ additions: 5, deletions: 2 }] },
        executed: false,
      })
      expect((yield* SessionCost.summary(root)).lines).toEqual({ added: 8, removed: 3 })
    }),
  )

  // The projector stores the model a usage record names, so the summary itemizes it. Mutation: leave the columns null.
  it.effect("usage and side query events that name a model are itemized under it", () =>
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      yield* seedProject
      yield* bus.publish(SessionEvent.Created, {
        sessionID: root,
        projectID: Project.ID.global,
        location: { directory: AbsolutePath.make("/project") },
        slug: "root",
        version: "test",
      })
      const spent = { cost: Money.USD.make(0.25), tokens: tokens(10) }
      yield* bus.publish(SessionEvent.UsageRecorded, {
        sessionID: root,
        source: "title",
        model: { providerID: Provider.ID.make("prov"), id: Model.ID.make("alpha") },
        ...spent,
      })
      yield* bus.publish(SessionEvent.SideQueryRecorded, {
        sessionID: root,
        purpose: "webfetch.summarize",
        model: { providerID: Provider.ID.make("prov"), id: Model.ID.make("beta") },
        ...spent,
      })
      const summary = yield* SessionCost.summary(root)
      expect(summary.rows.map((row) => [row.providerID, row.modelID, row.responses]).toSorted()).toEqual([
        ["prov", "alpha", 1],
        ["prov", "beta", 1],
      ])
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
      // An edit in such a session does not start a partial count.
      yield* seedStep(bus, child, {
        id: "msg_cost_old_edit",
        calls: [{ id: "c1", name: "Edit", metadata: { files: [{ additions: 9, deletions: 9 }] } }],
      })
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
