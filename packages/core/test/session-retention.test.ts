// foundations-19: `cleanup_period_days` removes idle session families. The reference judges every file by its age alone;
// Orbit removes a family (a session, its subagents and its forks) whole, only when no member has queued or pending
// work, holds the execution claim or is shared (V2 durable admission and restart recovery). A family that existed before
// the upgrade counts its idle time from the upgrade (owner, 2026-10-21). The stats of a removed family stay in
// `orb stats`, as the reference's stats cache keeps them. The pass also sweeps the folders of the sessions this database
// removed: the saved results under `<data>/tool-output` and the scratchpads under `<tmp>/sessions`, roots that other
// databases share. A folder is named by a session ID, so the name is shape-checked, a link is removed as a link, a root
// that is a link is left alone, and a folder that a live ID names in another letter case stays (classes 4 and 5). A row
// whose ID or clock does not decode, or whose stats cannot be folded, keeps its family (class 7).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { DateTime, Effect, Layer, Logger, LogLevel, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { eq, sql } from "drizzle-orm"
import { Agent } from "@orbit/schema/agent"
import { Model } from "@orbit/schema/model"
import { Money } from "@orbit/schema/money"
import { Provider } from "@orbit/schema/provider"
import { SessionEvent } from "@orbit/schema/session-event"
import { SessionMessage } from "@orbit/schema/session-message"
import { Bus } from "@orbit/core/bus"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Instance } from "@orbit/core/instance/service"
import { LocationServiceMap } from "@orbit/core/location-services"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionEnvironment } from "@orbit/core/session/environment"
import { SessionExecution } from "@orbit/core/session/execution"
import { SessionModelTransport } from "@orbit/core/session/model-transport"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRetention } from "@orbit/core/session/retention"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionMessageTable, SessionRemovedTable, SessionTable } from "@orbit/core/session/sql"
import { SessionStats } from "@orbit/core/session/stats"
import { SessionStore } from "@orbit/core/session/store"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const DAY = 86_400_000
const linkType = process.platform === "win32" ? "junction" : "dir"
const directory = AbsolutePath.make(path.resolve("/retention"))
const otherProject = Project.ID.make("retention-other")
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

// The module's surface as the spec gives it (S3 to S5); the casts stand in for its own types until the build adds it.
type Pass = { readonly removed: ReadonlyArray<string> }
const prune = (input: { readonly days: number; readonly now?: number }) =>
  SessionRetention.Service.use((service: { readonly prune: (value: typeof input) => Effect.Effect<Pass> }) =>
    service.prune(input),
  ) as Effect.Effect<Pass>
const schedule = (read: Effect.Effect<number | undefined>) =>
  SessionRetention.schedule(read) as Effect.Effect<never, never, Scope.Scope>

const transport = Layer.succeed(
  SessionModelTransport.Service,
  SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("unexpected model call") }),
    close: () => Effect.void,
    closeAll: Effect.void,
  }),
)

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const data = path.join(root, "data")
  const tmp = path.join(root, "tmp")
  return {
    root,
    data,
    tmp,
    outputs: path.join(data, "tool-output"),
    scratch: path.join(tmp, "sessions"),
    outside: path.join(root, "outside"),
  }
})
type Layout = Effect.Success<typeof layout>

type Services = Database.Service | Bus.Service | Session.Service

// Each build has its own in-memory database over the folders of `l`, so two builds over one layout stand for two
// channels' databases on one machine.
const graph = (l: Layout, execution: Layer.Layer<SessionExecution.Service> = SessionExecution.noopLayer) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      Session.node,
      Instance.node,
      LocationServiceMap.node,
      SessionRetention.node,
    ]),
    [
      Project.node.replace(globalProjectNode),
      SessionExecution.node.replace(execution),
      SessionModelTransport.node.replace(transport),
      offlineModels,
      Global.node.replace(Global.layerWith({ data: l.data, tmp: l.tmp, config: path.join(l.root, "config") })),
    ],
  )

const scenario = <A, E>(
  body: (l: Layout) => Effect.Effect<A, E, Services | Scope.Scope>,
  execution?: Layer.Layer<SessionExecution.Service>,
) =>
  Effect.gen(function* () {
    const l = yield* layout
    return yield* body(l).pipe(Effect.provide(graph(l, execution)))
  })

// A session row written straight into the store, so a test can name any ID and any clock.
const row = (input: {
  readonly id: string
  readonly updated: number
  readonly parent?: string
  readonly fork?: string
  readonly project?: Project.ID
  readonly created?: number
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values([
        { id: Project.ID.global, worktree: directory, sandboxes: [] },
        { id: otherProject, worktree: AbsolutePath.make(path.resolve("/retention-other")), sandboxes: [] },
      ])
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(input.id),
        project_id: input.project ?? Project.ID.global,
        slug: input.id,
        directory,
        version: "test",
        parent_id: input.parent === undefined ? undefined : SessionSchema.ID.make(input.parent),
        fork_session_id: input.fork === undefined ? undefined : SessionSchema.ID.make(input.fork),
        fork_boundary:
          input.fork === undefined ? undefined : { type: "through", messageID: SessionMessage.ID.make("msg_boundary") },
        time_created: input.created ?? input.updated,
        time_updated: input.updated,
      })
      .run()
      .pipe(Effect.orDie)
  })

const remaining = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
  return rows.map((item) => String(item.id)).toSorted()
})

// What `Session.remove` records for a session that went in an earlier version of the store, where no row of it is left.
const removedEarlier = (...ids: string[]) =>
  Database.Service.use((database) =>
    database.db
      .insert(SessionRemovedTable)
      .values(ids.map((id) => ({ id: SessionSchema.ID.make(id) })))
      .run()
      .pipe(Effect.orDie, Effect.asVoid),
  )

const records = Database.Service.use((database) =>
  database.db
    .select({ id: SessionRemovedTable.id })
    .from(SessionRemovedTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((item) => String(item.id)).toSorted()),
    ),
)

const exists = (file: string) =>
  Effect.promise(() =>
    fs.lstat(file).then(
      () => true,
      () => false,
    ),
  )

const folder = (target: string, file = "keep.txt") =>
  Effect.promise(async () => {
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(target, file), "kept")
  })

const link = (target: string, at: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(at), { recursive: true })
    await fs.symlink(target, at, linkType)
  })

// Keeps the messages of retention's own log lines.
const logging = (logged: string[]) =>
  Effect.provideService(
    Logger.CurrentLoggers,
    new Set([
      Logger.make((entry) => {
        const message = [entry.message].flat()[0]
        if (typeof message === "string" && message.startsWith("session retention")) logged.push(message)
      }),
    ]),
  )

// The pass time of most rows: every row written at the wall clock is 31 days idle by then, and the upgrade (the
// migration that the layer ran) is as well, so the grace has passed.
const later = () => Date.now() + 31 * DAY

describe("SessionRetention.prune", () => {
  it.live("removes an idle family whole and keeps a recent session", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* row({ id: "ses_ret_root", updated: now })
        yield* row({ id: "ses_ret_child", parent: "ses_ret_root", updated: now })
        yield* row({ id: "ses_ret_fork", fork: "ses_ret_root", updated: now })
        yield* row({ id: "ses_ret_fork_child", parent: "ses_ret_fork", updated: now })
        yield* row({ id: "ses_ret_recent", updated: later() - DAY })

        const pass = yield* prune({ days: 30, now: later() })

        expect([...pass.removed].toSorted()).toEqual([
          "ses_ret_child",
          "ses_ret_fork",
          "ses_ret_fork_child",
          "ses_ret_root",
        ])
        expect(yield* remaining).toEqual(["ses_ret_recent"])
      }),
    ),
  )

  // V2 durable admission and restart recovery: admitted work, a claimed execution and a shared session are never lost,
  // and one recent member keeps the whole family. Each row has a control family that the same pass removes.
  const blockers: ReadonlyArray<readonly [string, (now: number) => Effect.Effect<void, never, Database.Service>]> = [
    [
      "child has a queued input",
      (now) =>
        Database.Service.use((database) =>
          database.db
            .run(
              sql`INSERT INTO session_inbox (id, session_id, type, payload, delivery, enqueued_seq, time_created)
                  VALUES ('msg_ret_queued', 'ses_ret_kept_child', 'user', '{"text":"later"}', 'queue', 1, ${now})`,
            )
            .pipe(Effect.orDie, Effect.asVoid),
        ),
    ],
    [
      "child has a pending delivery",
      (now) =>
        Database.Service.use((database) =>
          database.db
            .run(
              sql`INSERT INTO session_pending (id, session_id, type, data, delivery, admitted_seq, time_created)
                  VALUES ('msg_ret_pending', 'ses_ret_kept_child', 'user', '{"text":"later"}', 'queue', 1, ${now})`,
            )
            .pipe(Effect.orDie, Effect.asVoid),
        ),
    ],
    [
      "root holds the execution claim",
      (now) =>
        Database.Service.use((database) =>
          database.db
            .update(SessionTable)
            .set({ time_suspended: now })
            .where(eq(SessionTable.id, SessionSchema.ID.make("ses_ret_kept")))
            .run()
            .pipe(Effect.orDie, Effect.asVoid),
        ),
    ],
    [
      "child is shared",
      () =>
        Database.Service.use((database) =>
          database.db
            .update(SessionTable)
            .set({ share_url: "https://share.invalid/s/ret" })
            .where(eq(SessionTable.id, SessionSchema.ID.make("ses_ret_kept_child")))
            .run()
            .pipe(Effect.orDie, Effect.asVoid),
        ),
    ],
    [
      "fork changed inside the period",
      () => row({ id: "ses_ret_kept_fork", fork: "ses_ret_kept", updated: later() - DAY }),
    ],
  ]
  for (const [name, block] of blockers)
    it.live(`keeps a family whose ${name}`, () =>
      scenario(() =>
        Effect.gen(function* () {
          const now = Date.now()
          yield* row({ id: "ses_ret_kept", updated: now })
          yield* row({ id: "ses_ret_kept_child", parent: "ses_ret_kept", updated: now })
          yield* row({ id: "ses_ret_control", updated: now })
          yield* row({ id: "ses_ret_control_child", parent: "ses_ret_control", updated: now })
          yield* block(now)

          yield* prune({ days: 30, now: later() })

          const left = yield* remaining
          expect(left).toContain("ses_ret_kept")
          expect(left).toContain("ses_ret_kept_child")
          expect(left).not.toContain("ses_ret_control")
          expect(left).not.toContain("ses_ret_control_child")
        }),
      ),
    )

  // The reference writes nothing at 0 and deletes everything; Orbit must keep saving (V2), so 0 only moves the cutoff to
  // now: every family that may go, goes at the next pass.
  it.live("removes every eligible family when the period is 0", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* row({ id: "ses_ret_zero", updated: now - 1 })
        yield* row({ id: "ses_ret_zero_queued", updated: now - 1 })
        const database = yield* Database.Service
        yield* database.db
          .run(
            sql`INSERT INTO session_inbox (id, session_id, type, payload, delivery, enqueued_seq, time_created)
                VALUES ('msg_ret_zero', 'ses_ret_zero_queued', 'user', '{"text":"later"}', 'queue', 1, ${now})`,
          )
          .pipe(Effect.orDie)

        yield* prune({ days: 0, now: Date.now() + 1_000 })

        expect(yield* remaining).toEqual(["ses_ret_zero_queued"])
      }),
    ),
  )

  // Owner, 2026-10-21: a family that existed before the version that ships retention counts its idle time from that
  // version's first start, which in a test is the migration the layer ran.
  it.live("counts the idle time of an older family from the upgrade", () =>
    scenario(() =>
      Effect.gen(function* () {
        const start = Date.now()
        yield* row({ id: "ses_ret_old", updated: start - 40 * DAY })
        yield* row({ id: "ses_ret_old_child", parent: "ses_ret_old", updated: start - 45 * DAY })

        yield* prune({ days: 30, now: start })
        yield* prune({ days: 30, now: start + 29 * DAY })
        expect(yield* remaining).toEqual(["ses_ret_old", "ses_ret_old_child"])

        yield* prune({ days: 30, now: start + 31 * DAY })
        expect(yield* remaining).toEqual([])
      }),
    ),
  )

  it.live("keeps a family with a row whose ID or clock does not decode", () =>
    scenario(() =>
      Effect.gen(function* () {
        const logged: string[] = []
        const now = Date.now()
        yield* row({ id: "ses_ret_badid", updated: now })
        yield* row({ id: "ses_x/../y", parent: "ses_ret_badid", updated: now })
        yield* row({ id: "ses_ret_badclock", updated: now })
        yield* row({ id: "ses_ret_badclock_child", parent: "ses_ret_badclock", updated: now })
        yield* row({ id: "ses_ret_good", updated: now })
        const database = yield* Database.Service
        yield* database.db
          .run(sql`UPDATE session_v2 SET time_updated = 'soon' WHERE id = 'ses_ret_badclock_child'`)
          .pipe(Effect.orDie)

        yield* prune({ days: 30, now: later() }).pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([
              Logger.make((entry) => {
                const message = [entry.message].flat()[0]
                if (
                  LogLevel.isGreaterThanOrEqualTo(entry.logLevel, "Warn") &&
                  typeof message === "string" &&
                  message.startsWith("session retention")
                )
                  logged.push(message)
              }),
            ]),
          ),
        )

        expect(yield* remaining).toEqual(["ses_ret_badclock", "ses_ret_badclock_child", "ses_ret_badid", "ses_x/../y"])
        // One line for each row that does not decode, and none for the family that went. The lines name the reason, so a
        // family kept only because its removal failed later would not pass for one the check kept.
        expect(logged.toSorted()).toEqual([
          "session retention kept a family: a session's ID cannot name a folder",
          "session retention kept a family: a session's last change does not decode",
        ])
      }),
    ),
  )

  // Class 7: a stored message whose data is not JSON stops the fold of its own family's stats, so that family stays with
  // one line; the family after it and the folder sweep still run in the same pass.
  it.live("keeps a family whose stats cannot be folded", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const logged: string[] = []
        const now = Date.now()
        yield* row({ id: "ses_ret_badjson", updated: now })
        yield* row({ id: "ses_ret_badjson_child", parent: "ses_ret_badjson", updated: now })
        yield* row({ id: "ses_ret_goodjson", updated: now })
        const database = yield* Database.Service
        yield* database.db
          .run(
            sql`INSERT INTO session_message (id, session_id, seq, type, time_created, time_updated, data)
                VALUES ('msg_ret_badjson', 'ses_ret_badjson_child', 1, 'assistant', ${now}, ${now}, 'not json')`,
          )
          .pipe(Effect.orDie)
        yield* folder(path.join(l.outputs, "ses_ret_goodjson"))
        yield* folder(path.join(l.outputs, "ses_ret_badjson_child"))

        const pass = yield* prune({ days: 30, now: later() }).pipe(logging(logged))

        expect(pass.removed).toEqual(["ses_ret_goodjson"])
        expect(yield* remaining).toEqual(["ses_ret_badjson", "ses_ret_badjson_child"])
        expect(logged).toEqual(["session retention kept a family: its stats could not be folded"])
        expect(yield* exists(path.join(l.outputs, "ses_ret_goodjson"))).toBe(false)
        expect(yield* exists(path.join(l.outputs, "ses_ret_badjson_child", "keep.txt"))).toBe(true)
      }),
    ),
  )

  // Class 7: content that is valid JSON but holds no object where a part belongs (a string or number element, or a
  // scalar in place of the list) is not a tool part. Both the fold and the folder sweep skip it: the idle family that
  // holds it is folded and removed, and a live session that holds it does not stop the sweep of another family's folder.
  for (const [name, data] of [
    ["a string element", '{"content":["abc"]}'],
    ["a number element", '{"content":[1]}'],
    ["a scalar in place of the list", '{"content":"abc"}'],
  ])
    it.live(`skips message content with ${name}`, () =>
      scenario((l) =>
        Effect.gen(function* () {
          const now = Date.now()
          yield* row({ id: "ses_ret_oddidle", updated: now })
          yield* row({ id: "ses_ret_oddlive", updated: later() - DAY })
          yield* row({ id: "ses_ret_oddcontrol", updated: now })
          const database = yield* Database.Service
          yield* database.db
            .run(
              sql`INSERT INTO session_message (id, session_id, seq, type, time_created, time_updated, data)
                VALUES ('msg_ret_oddidle', 'ses_ret_oddidle', 1, 'assistant', ${now}, ${now}, ${data}),
                       ('msg_ret_oddlive', 'ses_ret_oddlive', 1, 'assistant', ${now}, ${now}, ${data})`,
            )
            .pipe(Effect.orDie)
          yield* folder(path.join(l.outputs, "ses_ret_oddidle"))
          yield* folder(path.join(l.outputs, "ses_ret_oddcontrol"))
          yield* folder(path.join(l.outputs, "ses_ret_oddlive"))

          const pass = yield* prune({ days: 30, now: later() })

          expect(pass.removed.toSorted()).toEqual(["ses_ret_oddcontrol", "ses_ret_oddidle"])
          expect(yield* remaining).toEqual(["ses_ret_oddlive"])
          expect(yield* exists(path.join(l.outputs, "ses_ret_oddidle"))).toBe(false)
          expect(yield* exists(path.join(l.outputs, "ses_ret_oddcontrol"))).toBe(false)
          expect(yield* exists(path.join(l.outputs, "ses_ret_oddlive", "keep.txt"))).toBe(true)
        }),
      ),
    )
})

describe("SessionRetention.prune: the order of removal", () => {
  // Rows that name each other as parent have no member to remove first; the family stays, with one line (class 7).
  it.live("keeps a family whose sessions name each other in a loop", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        const logged: string[] = []
        yield* row({ id: "ses_ret_loop_a", parent: "ses_ret_loop_b", updated: now })
        yield* row({ id: "ses_ret_loop_b", parent: "ses_ret_loop_a", updated: now })
        yield* row({ id: "ses_ret_loop_leaf", parent: "ses_ret_loop_a", updated: now })
        yield* row({ id: "ses_ret_loop_control", updated: now })

        const pass = yield* prune({ days: 30, now: later() }).pipe(
          Effect.provideService(
            Logger.CurrentLoggers,
            new Set([
              Logger.make((entry) => {
                const message = [entry.message].flat()[0]
                if (typeof message === "string" && message.startsWith("session retention")) logged.push(message)
              }),
            ]),
          ),
        )

        expect(pass.removed).toEqual(["ses_ret_loop_control"])
        // The member that hangs off the loop stays with it: a family goes whole or not at all.
        expect(yield* remaining).toEqual(["ses_ret_loop_a", "ses_ret_loop_b", "ses_ret_loop_leaf"])
        expect(logged).toEqual(["session retention kept a family: its sessions name each other in a loop"])
      }),
    ),
  )

  // A member that `Session.remove` cannot remove (here its creation time does not decode) stops its family where it is:
  // the members removed before it stay removed, the rest stay, one line is logged, and the next family still goes.
  it.live("keeps the rest of a family when removing one of its sessions fails", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        const logged: string[] = []
        yield* row({ id: "ses_ret_stuckroot", updated: now })
        yield* row({ id: "ses_ret_stuckchild", parent: "ses_ret_stuckroot", updated: now })
        yield* row({ id: "ses_ret_stuckcontrol", updated: now })
        const database = yield* Database.Service
        yield* database.db
          .run(sql`UPDATE session_v2 SET time_created = 'soon' WHERE id = 'ses_ret_stuckroot'`)
          .pipe(Effect.orDie)

        const pass = yield* prune({ days: 30, now: later() }).pipe(logging(logged))

        expect(pass.removed.toSorted()).toEqual(["ses_ret_stuckchild", "ses_ret_stuckcontrol"])
        expect(yield* remaining).toEqual(["ses_ret_stuckroot"])
        expect(logged).toEqual(["session retention could not remove a session"])
      }),
    ),
  )

  // When the first member to go fails, nothing after it is tried: the session it names stays with it, and the next
  // family still goes.
  it.live("keeps the session that a member it could not remove names", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        const logged: string[] = []
        yield* row({ id: "ses_ret_heldroot", updated: now })
        yield* row({ id: "ses_ret_heldchild", parent: "ses_ret_heldroot", updated: now })
        yield* row({ id: "ses_ret_heldcontrol", updated: now })
        const database = yield* Database.Service
        yield* database.db
          .run(sql`UPDATE session_v2 SET time_created = 'soon' WHERE id = 'ses_ret_heldchild'`)
          .pipe(Effect.orDie)

        const pass = yield* prune({ days: 30, now: later() }).pipe(logging(logged))

        expect(pass.removed).toEqual(["ses_ret_heldcontrol"])
        expect(yield* remaining).toEqual(["ses_ret_heldchild", "ses_ret_heldroot"])
        expect(logged).toEqual(["session retention could not remove a session"])
      }),
    ),
  )
})

describe("SessionRetention.prune: the folders that sessions name", () => {
  // The family goes and with it the folders only it used. A live session's stored result still names the root's saved
  // results (a fork whose intermediate source is gone carries such a marker), so that folder stays. The scratchpad goes
  // although no instance of the family's location is loaded, and although a fork shared its source's folder.
  it.live("removes the folders of a removed family and keeps one a live result still names", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* row({ id: "ses_ret_froot", updated: now })
        yield* row({ id: "ses_ret_fchild", parent: "ses_ret_froot", updated: now })
        yield* row({ id: "ses_ret_ffork", fork: "ses_ret_froot", updated: now })
        yield* row({ id: "ses_ret_live", updated: later() - DAY })
        const database = yield* Database.Service
        yield* database.db
          .insert(SessionMessageTable)
          .values(
            messageRow(
              "ses_ret_live",
              1,
              assistant("msg_ret_live", later() - DAY, [
                SessionMessage.AssistantTool.make({
                  type: "tool",
                  id: "call_saved",
                  name: "Read",
                  state: SessionMessage.ToolStateCompleted.make({
                    status: "completed",
                    input: {},
                    content: [{ type: "text", text: "large" }],
                    metadata: {
                      persisted: {
                        session: "ses_ret_froot",
                        name: "msg_retsaved-call_saved-0123abcd.txt",
                        size: 5,
                        format: 1,
                      },
                    },
                  }),
                  time: { created: DateTime.makeUnsafe(later() - DAY) },
                }),
              ]),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* folder(path.join(l.outputs, "ses_ret_froot"))
        yield* folder(path.join(l.outputs, "ses_ret_fchild"))
        yield* folder(path.join(l.outputs, "ses_ret_ffork"))
        yield* folder(path.join(l.outputs, "ses_ret_live"))
        yield* folder(path.join(l.scratch, "ses_ret_froot"))
        yield* folder(path.join(l.scratch, "ses_ret_live"))

        yield* prune({ days: 30, now: later() })

        expect(yield* remaining).toEqual(["ses_ret_live"])
        expect(yield* exists(path.join(l.outputs, "ses_ret_froot", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses_ret_fchild"))).toBe(false)
        expect(yield* exists(path.join(l.outputs, "ses_ret_ffork"))).toBe(false)
        expect(yield* exists(path.join(l.outputs, "ses_ret_live", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_froot"))).toBe(false)
        expect(yield* exists(path.join(l.scratch, "ses_ret_live", "keep.txt"))).toBe(true)
        // The record of a removed session stays while one of its folders does, so the folder goes once nothing names it.
        expect(yield* records).toEqual(["ses_ret_froot"])

        const sessions = yield* Session.Service
        yield* sessions.remove(SessionSchema.ID.make("ses_ret_live"))
        yield* prune({ days: 30, now: later() })

        expect(yield* exists(path.join(l.outputs, "ses_ret_froot"))).toBe(false)
        expect(yield* exists(path.join(l.outputs, "ses_ret_live"))).toBe(false)
        expect(yield* exists(path.join(l.scratch, "ses_ret_live"))).toBe(false)
        expect(yield* records).toEqual([])
      }),
    ),
  )

  // The roots are shared by every database on the machine: each channel (a source build is `local`) and `ORBIT_DB` have
  // their own. A pass in one database removes only the folders of sessions it removed itself, at any period, so another
  // database's shared session, and its session still inside the upgrade grace, keep their folders however old they are.
  it.live("leaves the folders of sessions another database holds", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const old = new Date(Date.now() - 40 * DAY)
      const age = (target: string) => Effect.promise(() => fs.utimes(target, old, old))
      const kept = ["ses_ret_other_shared", "ses_ret_other_grace"]
      yield* Effect.gen(function* () {
        yield* row({ id: "ses_ret_other_shared", updated: Date.now() - 40 * DAY })
        yield* row({ id: "ses_ret_other_grace", updated: Date.now() - 40 * DAY })
        const database = yield* Database.Service
        yield* database.db
          .update(SessionTable)
          .set({ share_url: "https://share.invalid/s/other" })
          .where(eq(SessionTable.id, SessionSchema.ID.make("ses_ret_other_shared")))
          .run()
          .pipe(Effect.orDie)
        yield* Effect.forEach(
          kept.flatMap((id) => [path.join(l.outputs, id), path.join(l.scratch, id)]),
          (target) => folder(target).pipe(Effect.andThen(age(target))),
          { discard: true },
        )
        yield* prune({ days: 30 })
        expect(yield* remaining).toEqual(kept.toSorted())
      }).pipe(Effect.provide(graph(l)))

      yield* Effect.gen(function* () {
        // Controls in the same pass: one session this database removes and one it removed by hand earlier.
        yield* row({ id: "ses_ret_mine_idle", updated: Date.now() })
        yield* row({ id: "ses_ret_mine_hand", updated: Date.now() })
        yield* Effect.forEach(
          ["ses_ret_mine_idle", "ses_ret_mine_hand"].flatMap((id) => [
            path.join(l.outputs, id),
            path.join(l.scratch, id),
          ]),
          (target) => folder(target),
          { discard: true },
        )
        const sessions = yield* Session.Service
        yield* sessions.remove(SessionSchema.ID.make("ses_ret_mine_hand"))

        yield* prune({ days: 0, now: Date.now() + 1_000 })

        expect(yield* remaining).toEqual([])
        for (const id of kept) {
          expect(yield* exists(path.join(l.outputs, id, "keep.txt"))).toBe(true)
          expect(yield* exists(path.join(l.scratch, id, "keep.txt"))).toBe(true)
        }
        for (const id of ["ses_ret_mine_idle", "ses_ret_mine_hand"]) {
          expect(yield* exists(path.join(l.outputs, id))).toBe(false)
          expect(yield* exists(path.join(l.scratch, id))).toBe(false)
        }
      }).pipe(Effect.provide(graph(l)))
    }),
  )

  // Class 4: a link where a session's folder should be is removed as a link; what it leads to is never entered.
  it.live("removes a session folder that is a link as a link", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const target = path.join(l.outside, "target")
        const scratchTarget = path.join(l.outside, "scratch-target")
        const missing = path.join(l.outside, "missing")
        yield* folder(target)
        yield* folder(scratchTarget)
        yield* folder(missing)
        yield* link(target, path.join(l.outputs, "ses_ret_linked"))
        yield* link(scratchTarget, path.join(l.scratch, "ses_ret_linked"))
        yield* link(missing, path.join(l.outputs, "ses_ret_dangling"))
        yield* Effect.promise(() => fs.rm(missing, { recursive: true, force: true }))
        yield* row({ id: "ses_ret_linked", updated: Date.now() })
        yield* row({ id: "ses_ret_dangling", updated: Date.now() })

        yield* prune({ days: 30, now: later() })

        expect(yield* remaining).toEqual([])
        expect(yield* exists(path.join(l.outputs, "ses_ret_linked"))).toBe(false)
        expect(yield* exists(path.join(l.scratch, "ses_ret_linked"))).toBe(false)
        expect(yield* exists(path.join(l.outputs, "ses_ret_dangling"))).toBe(false)
        expect(yield* exists(path.join(target, "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(scratchTarget, "keep.txt"))).toBe(true)
      }),
    ),
  )

  // Class 4: when the tool-output folder itself is a link, nothing under it is touched; the scratchpad root beside it
  // is swept in the same pass, which shows the pass ran.
  it.live("removes nothing under a tool-output folder that is a link", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const elsewhere = path.join(l.outside, "elsewhere")
        yield* folder(path.join(elsewhere, "ses_ret_gone"))
        // A flat saved result of an earlier version, past the cutoff: the legacy sweep does not follow the link either.
        yield* folder(elsewhere, "tool_0123456789ab")
        yield* link(elsewhere, l.outputs)
        yield* folder(path.join(l.scratch, "ses_ret_gone"))
        yield* row({ id: "ses_ret_gone", updated: Date.now() })

        yield* prune({ days: 30, now: later() })

        expect(yield* exists(path.join(elsewhere, "ses_ret_gone", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(elsewhere, "tool_0123456789ab"))).toBe(true)
        expect((yield* Effect.promise(() => fs.lstat(l.outputs))).isSymbolicLink()).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_gone"))).toBe(false)
        // A root left alone may still hold the session's folder, so its record waits for a later pass.
        expect(yield* records).toEqual(["ses_ret_gone"])
      }),
    ),
  )

  // Class 7: a root that cannot be read costs only itself. With a file where the temporary folder was, the scratchpad
  // root cannot be looked at (POSIX says so, with one line; Windows reports it missing, which is no error), and the
  // saved-results root is still swept in the same pass.
  it.live("sweeps the other root when one cannot be read", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const logged: string[] = []
        yield* folder(path.join(l.outputs, "ses_ret_unread"))
        yield* row({ id: "ses_ret_unread", updated: Date.now() })
        yield* Effect.promise(async () => {
          await fs.rm(l.tmp, { recursive: true, force: true })
          await fs.writeFile(l.tmp, "not a folder")
        })

        yield* prune({ days: 30, now: later() }).pipe(logging(logged))

        expect(yield* exists(path.join(l.outputs, "ses_ret_unread"))).toBe(false)
        expect(logged).toEqual(process.platform === "win32" ? [] : ["session retention could not read a folder"])
      }),
    ),
  )

  // Class 4: on Windows and macOS two IDs that differ in letter case name one folder, so a folder that a live session's
  // ID names in any case stays; the stricter answer holds on every platform.
  it.live("keeps a folder whose name is a live session's ID in another case", () =>
    scenario((l) =>
      Effect.gen(function* () {
        yield* row({ id: "ses_ret_CaseKeep", updated: later() - DAY })
        yield* row({ id: "ses_ret_lowerkeep", updated: later() - DAY })
        yield* folder(path.join(l.outputs, "ses_ret_casekeep"))
        yield* folder(path.join(l.scratch, "ses_ret_casekeep"))
        // The other way round: the folder's name is the one in mixed case.
        yield* folder(path.join(l.outputs, "ses_ret_LowerKeep"))
        yield* folder(path.join(l.scratch, "ses_ret_LowerKeep"))
        yield* folder(path.join(l.outputs, "ses_ret_nolive"))
        // A removed session whose ID has capitals and that no live session names in any case: its folder goes.
        yield* folder(path.join(l.outputs, "ses_ret_MixedGone"))
        yield* folder(path.join(l.scratch, "ses_ret_MixedGone"))
        // Each folder's own spelling is a session this database removed, so only the live ID in the other case keeps it.
        yield* removedEarlier("ses_ret_casekeep", "ses_ret_LowerKeep", "ses_ret_MixedGone")
        yield* row({ id: "ses_ret_nolive", updated: Date.now() })

        yield* prune({ days: 30, now: later() })

        expect(yield* exists(path.join(l.outputs, "ses_ret_casekeep", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_casekeep", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses_ret_LowerKeep", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_LowerKeep", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses_ret_nolive"))).toBe(false)
        expect(yield* exists(path.join(l.outputs, "ses_ret_MixedGone"))).toBe(false)
        expect(yield* exists(path.join(l.scratch, "ses_ret_MixedGone"))).toBe(false)
      }),
    ),
  )

  // A subagent uses its parent's scratchpad and a fork its source's (`SessionScratchpad.key`). When that session was
  // removed earlier, the live one still works in the folder it names, so the folder stays; a folder nothing names goes.
  it.live("keeps the scratchpad a live session uses after the session that names it is gone", () =>
    scenario((l) =>
      Effect.gen(function* () {
        yield* row({ id: "ses_ret_keptchild", parent: "ses_ret_goneparent", updated: later() - DAY })
        yield* row({ id: "ses_ret_keptfork", fork: "ses_ret_gonesource", updated: later() - DAY })
        yield* folder(path.join(l.scratch, "ses_ret_goneparent"))
        yield* folder(path.join(l.scratch, "ses_ret_gonesource"))
        yield* folder(path.join(l.scratch, "ses_ret_noone"))
        yield* removedEarlier("ses_ret_goneparent", "ses_ret_gonesource", "ses_ret_noone")

        yield* prune({ days: 30, now: later() })

        expect(yield* remaining).toEqual(["ses_ret_keptchild", "ses_ret_keptfork"])
        expect(yield* exists(path.join(l.scratch, "ses_ret_goneparent", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_gonesource", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_noone"))).toBe(false)
      }),
    ),
  )

  // Class 5: only a name a session ID can take is a session's folder.
  it.live("leaves names that are not session folders alone", () =>
    scenario((l) =>
      Effect.gen(function* () {
        yield* folder(path.join(l.outputs, "notes"))
        yield* folder(path.join(l.outputs, "ses-dash"))
        yield* folder(path.join(l.scratch, "notes"))
        yield* Effect.promise(() => fs.writeFile(path.join(l.outputs, "readme.txt"), "kept"))
        yield* folder(path.join(l.outputs, "ses_ret_orphan"))
        // An ID can take the dash spelling (a row an import wrote), but no folder of that shape is a session's.
        yield* removedEarlier("ses-dash", "ses_ret_orphan")

        yield* prune({ days: 30, now: later() })

        expect(yield* exists(path.join(l.outputs, "notes", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses-dash", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "notes", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "readme.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses_ret_orphan"))).toBe(false)
      }),
    ),
  )

  // The flat files of earlier versions were saved results, which the reference prunes under this setting; the fixed
  // seven days go.
  it.live("removes flat saved results of earlier versions by the period", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const old = path.join(l.outputs, "tool_0123456789ab")
        const recent = path.join(l.outputs, "tool_0123456789ac")
        // Only plain files go: a link of that name past the period stays, and so does what it points at.
        const linked = path.join(l.outputs, "tool_0123456789ad")
        const target = path.join(l.root, "elsewhere")
        yield* folder(target)
        yield* link(target, linked)
        yield* Effect.promise(async () => {
          await fs.writeFile(old, "old")
          await fs.writeFile(recent, "recent")
          await fs.utimes(old, new Date(), new Date(Date.now() - 10 * DAY))
          await fs.lutimes(linked, new Date(), new Date(Date.now() - 10 * DAY))
        })

        yield* prune({ days: 30, now: Date.now() })
        expect(yield* exists(old)).toBe(true)

        yield* prune({ days: 5, now: Date.now() })
        expect(yield* exists(old)).toBe(false)
        expect(yield* exists(recent)).toBe(true)
        expect(yield* exists(linked)).toBe(true)
        expect(yield* exists(path.join(target, "keep.txt"))).toBe(true)
      }),
    ),
  )
})

// Class 4: the door follows no link wherever it deletes, in either root. Each row plants one spelling of a link (a
// junction on Windows, a folder link elsewhere) to a folder outside the roots that holds a marker, beside a removed
// session's plain folder as the control. After the pass both session folders are gone and the marker is still there.
describe("SessionRetention.prune: the links the door meets", () => {
  const roots = [
    ["saved-results", (l: Layout) => l.outputs],
    ["scratchpad", (l: Layout) => l.scratch],
  ] as const
  // Each plants its spelling where the folder of the removed session `ses_ret_door` is, under `root`.
  const spellings = [
    {
      name: "the session folder is a link",
      plant: (root: string, target: string) => link(target, path.join(root, "ses_ret_door")),
    },
    {
      name: "the session folder is a link whose target is gone",
      plant: (root: string, target: string) =>
        Effect.gen(function* () {
          const missing = path.join(path.dirname(target), "missing")
          yield* folder(missing)
          yield* link(missing, path.join(root, "ses_ret_door"))
          yield* Effect.promise(() => fs.rm(missing, { recursive: true, force: true }))
        }),
    },
    {
      name: "a link inside the session folder",
      plant: (root: string, target: string) =>
        Effect.gen(function* () {
          yield* folder(path.join(root, "ses_ret_door"))
          yield* link(target, path.join(root, "ses_ret_door", "link"))
        }),
    },
    {
      name: "a link nested in a folder of the session folder",
      plant: (root: string, target: string) =>
        Effect.gen(function* () {
          yield* folder(path.join(root, "ses_ret_door", "sub"))
          yield* link(target, path.join(root, "ses_ret_door", "sub", "link"))
        }),
    },
  ]
  for (const [rootName, pick] of roots)
    for (const spelling of spellings)
      it.live(`${rootName} root: ${spelling.name} goes and its target stays`, () =>
        scenario((l) =>
          Effect.gen(function* () {
            const root = pick(l)
            const target = path.join(l.outside, "target")
            yield* folder(target)
            yield* spelling.plant(root, target)
            yield* folder(path.join(root, "ses_ret_plain"))
            yield* row({ id: "ses_ret_door", updated: Date.now() })
            yield* row({ id: "ses_ret_plain", updated: Date.now() })

            yield* prune({ days: 30, now: later() })

            expect(yield* remaining).toEqual([])
            expect(yield* exists(path.join(root, "ses_ret_door"))).toBe(false)
            expect(yield* exists(path.join(root, "ses_ret_plain"))).toBe(false)
            expect(yield* exists(path.join(target, "keep.txt"))).toBe(true)
          }),
        ),
      )

  // The root itself is a link: nothing under it is touched, and its records wait for a later pass. The other root is
  // swept in the same pass as the control.
  for (const [rootName, pick] of roots)
    it.live(`${rootName} root: a root that is a link is left alone`, () =>
      scenario((l) =>
        Effect.gen(function* () {
          const root = pick(l)
          const other = root === l.outputs ? l.scratch : l.outputs
          const elsewhere = path.join(l.outside, "elsewhere")
          yield* folder(path.join(elsewhere, "ses_ret_door"))
          yield* link(elsewhere, root)
          yield* folder(path.join(other, "ses_ret_door"))
          yield* row({ id: "ses_ret_door", updated: Date.now() })

          yield* prune({ days: 30, now: later() })

          expect(yield* remaining).toEqual([])
          expect(yield* exists(path.join(elsewhere, "ses_ret_door", "keep.txt"))).toBe(true)
          expect((yield* Effect.promise(() => fs.lstat(root))).isSymbolicLink()).toBe(true)
          expect(yield* exists(path.join(other, "ses_ret_door"))).toBe(false)
          expect(yield* records).toEqual(["ses_ret_door"])
        }),
      ),
    )

  // A link named like a flat saved result of an earlier version, past the period: it stays, and so does its target. Only
  // the saved-results root holds such files; the plain file beside it is the control, and in the scratchpad root no
  // file of that name is swept at all.
  for (const [rootName, pick] of roots)
    it.live(`${rootName} root: a link named like a flat saved result stays`, () =>
      scenario((l) =>
        Effect.gen(function* () {
          const root = pick(l)
          const target = path.join(l.outside, "target")
          const linked = path.join(root, "tool_0123456789ad")
          const plain = path.join(root, "tool_0123456789ae")
          const old = new Date(Date.now() - 10 * DAY)
          yield* folder(target)
          yield* link(target, linked)
          yield* Effect.promise(async () => {
            await fs.writeFile(plain, "old")
            await fs.utimes(plain, old, old)
            await fs.lutimes(linked, old, old)
          })

          yield* prune({ days: 5, now: Date.now() })

          expect(yield* exists(linked)).toBe(true)
          expect(yield* exists(path.join(target, "keep.txt"))).toBe(true)
          expect(yield* exists(plain)).toBe(root === l.scratch)
        }),
      ),
    )
})

// Class 7: a folder that cannot be removed costs only itself. A folder inside it without write permission keeps its
// files, which POSIX enforces for a user who is not root (Windows removes it anyway, so the row runs there only).
describe.skipIf(process.platform === "win32")("SessionRetention.prune: a folder that cannot be removed", () => {
  it.live("keeps the record of a folder it could not remove and removes the others", () =>
    scenario((l) =>
      Effect.gen(function* () {
        const logged: string[] = []
        const locked = path.join(l.outputs, "ses_ret_stuck", "inner")
        yield* folder(locked)
        yield* folder(path.join(l.outputs, "ses_ret_freed"))
        yield* removedEarlier("ses_ret_stuck", "ses_ret_freed")
        yield* Effect.promise(() => fs.chmod(locked, 0o500))

        yield* prune({ days: 30, now: later() }).pipe(
          logging(logged),
          Effect.ensuring(Effect.promise(() => fs.chmod(locked, 0o700))),
        )

        expect(yield* exists(path.join(locked, "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses_ret_freed"))).toBe(false)
        expect(logged).toEqual(["session retention could not remove some entries"])
        // The folder is still there, so its record waits for a later pass; the other one's record goes.
        expect(yield* records).toEqual(["ses_ret_stuck"])
      }),
    ),
  )
})

describe("SessionRetention.prune: stats", () => {
  // The reference keeps its usage history in a stats cache when transcripts age out; Orbit folds a family into an archive
  // before removing it, so `orb stats` reads the same before and after. A tool's median duration comes from live rows
  // only, and the default range start may move to the archive's bucket, so neither is compared. 18:40 UTC is 00:10 the
  // next day in a timezone half an hour off the hour.
  it.live("keeps the stats of a removed family", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* row({ id: "ses_ret_stats", updated: now })
        yield* row({ id: "ses_ret_stats_child", parent: "ses_ret_stats", updated: now })
        yield* row({ id: "ses_ret_stats_fork", fork: "ses_ret_stats", updated: now, created: Date.UTC(2026, 0, 4) })
        yield* row({ id: "ses_ret_stats_other", updated: now, project: otherProject })
        const database = yield* Database.Service
        yield* database.db
          .insert(SessionMessageTable)
          .values([
            messageRow(
              "ses_ret_stats",
              1,
              SessionMessage.User.make({
                id: SessionMessage.ID.make("msg_ret_user"),
                type: "user",
                text: "hello",
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
              }),
            ),
            messageRow(
              "ses_ret_stats",
              2,
              assistant("msg_ret_assistant", Date.UTC(2026, 0, 2, 18, 40), [
                tool("call_read", "Read", "completed", Date.UTC(2026, 0, 2, 18, 40)),
                tool("call_edit", "Edit", "error", Date.UTC(2026, 0, 2, 18, 40)),
                tool("call_wait", "Wait", "running", Date.UTC(2026, 0, 2, 18, 40)),
              ]),
            ),
            messageRow("ses_ret_stats_child", 1, assistant("msg_ret_child", Date.UTC(2026, 0, 3, 10), [], "large", 2)),
            messageRow(
              "ses_ret_stats_fork",
              1,
              SessionMessage.User.make({
                id: SessionMessage.ID.make("msg_ret_copied"),
                type: "user",
                text: "copied",
                time: { created: DateTime.makeUnsafe(Date.UTC(2026, 0, 2, 9)) },
              }),
            ),
            messageRow(
              "ses_ret_stats_fork",
              2,
              assistant("msg_ret_copied_assistant", Date.UTC(2026, 0, 2, 18, 40), [
                tool("call_copied", "Read", "completed", Date.UTC(2026, 0, 2, 18, 40)),
              ]),
            ),
            messageRow(
              "ses_ret_stats_fork",
              3,
              assistant("msg_ret_fork_new", Date.UTC(2026, 0, 5, 10), [], "fork-new"),
            ),
            messageRow("ses_ret_stats_other", 1, assistant("msg_ret_other", Date.UTC(2026, 0, 6, 10), [])),
          ])
          .run()
          .pipe(Effect.orDie)
        const bus = yield* Bus.Service
        yield* bus.publish(SessionEvent.UsageRecorded, {
          sessionID: SessionSchema.ID.make("ses_ret_stats"),
          source: "compaction",
          cost: Money.USD.make(0.25),
          tokens: { input: 2, output: 2, reasoning: 2, cache: { read: 2, write: 2 } },
        })
        // Naming a session is not counted live, so the archive must not count it either.
        yield* bus.publish(SessionEvent.UsageRecorded, {
          sessionID: SessionSchema.ID.make("ses_ret_stats_child"),
          source: "title",
          cost: Money.USD.make(0.5),
          tokens: { input: 3, output: 3, reasoning: 3, cache: { read: 3, write: 3 } },
        })
        const range = { from: Date.UTC(2025, 11, 1), to: Date.UTC(2026, 2, 1) }
        const queries = [
          { ...range, timezone: "UTC", tools: "detail" },
          { ...range, timezone: "Asia/Kolkata", tools: "summary" },
          { ...range, timezone: "UTC", tools: "detail", projectID: Project.ID.global },
          { timezone: "UTC", tools: "none" },
        ] as const
        const read = Effect.forEach(queries, (query) =>
          SessionStats.get(query).pipe(
            Effect.orDie,
            Effect.map((stats) => ({
              ...stats,
              range: undefined,
              tools:
                stats.tools.mode === "detail"
                  ? { ...stats.tools, usage: stats.tools.usage.map((item) => ({ ...item, durationP50: undefined })) }
                  : stats.tools,
            })),
          ),
        )
        const before = yield* read
        expect(before[0]?.steps).toBe(4)

        yield* prune({ days: 30, now: later() })

        expect(yield* remaining).toEqual([])
        expect(yield* read).toEqual(before)
      }),
    ),
  )

  // The family is folded before its members go. When a removal fails, the member that stays is counted from its own
  // rows only, not again from the archive, while the member that went is counted from the archive.
  it.live("counts a session whose removal failed once", () =>
    scenario(() =>
      Effect.gen(function* () {
        const now = Date.now()
        yield* row({ id: "ses_ret_once", updated: now })
        yield* row({ id: "ses_ret_once_child", parent: "ses_ret_once", updated: now })
        const database = yield* Database.Service
        yield* database.db
          .insert(SessionMessageTable)
          .values([
            messageRow("ses_ret_once", 1, assistant("msg_ret_once", Date.UTC(2026, 0, 2, 10), [])),
            messageRow("ses_ret_once_child", 1, assistant("msg_ret_once_child", Date.UTC(2026, 0, 3, 10), [], "large")),
          ])
          .run()
          .pipe(Effect.orDie)
        // `Session.remove` fails on the root, whose creation time does not decode; the child goes first.
        yield* database.db
          .run(sql`UPDATE session_v2 SET time_created = 'soon' WHERE id = 'ses_ret_once'`)
          .pipe(Effect.orDie)
        const read = SessionStats.get({ from: Date.UTC(2025, 11, 1), to: Date.UTC(2026, 2, 1), timezone: "UTC" }).pipe(
          Effect.orDie,
          Effect.map((stats) => ({ ...stats, range: undefined })),
        )
        const before = yield* read
        expect(before.steps).toBe(2)

        yield* prune({ days: 30, now: later() }).pipe(logging([]))

        expect(yield* remaining).toEqual(["ses_ret_once"])
        expect(yield* read).toEqual(before)
      }),
    ),
  )
})

describe("SessionRetention.schedule", () => {
  // Waits in real time for what a fiber on the test clock does with the disk and the store.
  const eventually = (check: Effect.Effect<boolean, never, Services>) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200; attempt++) {
        if (yield* check) return true
        yield* Effect.promise(() => Bun.sleep(20))
      }
      return false
    })
  const still = (id: string) =>
    Effect.gen(function* () {
      yield* Effect.promise(() => Bun.sleep(300))
      return (yield* remaining).includes(id)
    })
  const gone = (id: string) => eventually(remaining.pipe(Effect.map((ids) => !ids.includes(id))))

  // The reference's first pass runs ten minutes after start. The `orb` server lives for days, so it repeats daily. The
  // removed session's folder goes last in a pass (S4.6), so once it is gone the schedule is about to sleep for a day;
  // the test clock does not move on its own, so the short real wait after it only lets the fiber reach that sleep.
  it.effect("runs the first pass 10 minutes after start and the next 24 hours later", () =>
    scenario((l) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now() + 40 * DAY)
        yield* row({ id: "ses_ret_first", updated: Date.now() })
        yield* folder(path.join(l.outputs, "ses_ret_first"))
        yield* Effect.forkScoped(schedule(Effect.succeed(30)))

        yield* TestClock.adjust("9 minutes")
        expect(yield* still("ses_ret_first")).toBe(true)
        yield* TestClock.adjust("1 minute")
        expect(yield* gone("ses_ret_first")).toBe(true)
        expect(
          yield* eventually(exists(path.join(l.outputs, "ses_ret_first")).pipe(Effect.map((there) => !there))),
        ).toBe(true)
        yield* Effect.promise(() => Bun.sleep(200))

        yield* row({ id: "ses_ret_second", updated: Date.now() })
        yield* TestClock.adjust("23 hours")
        expect(yield* still("ses_ret_second")).toBe(true)
        yield* TestClock.adjust("1 hour")
        expect(yield* gone("ses_ret_second")).toBe(true)
      }),
    ),
  )

  // The reference waits ten more minutes when the person did something in the last minute.
  it.effect("defers the pass while a session was active in the last minute", () =>
    scenario(() =>
      Effect.gen(function* () {
        const clock = Date.now() + 40 * DAY
        yield* TestClock.setTime(clock)
        yield* row({ id: "ses_ret_idle", updated: Date.now() })
        yield* row({ id: "ses_ret_busy", updated: clock + 10 * 60_000 - 30_000 })
        yield* Effect.forkScoped(schedule(Effect.succeed(30)))

        yield* TestClock.adjust("10 minutes")
        expect(yield* still("ses_ret_idle")).toBe(true)
        yield* TestClock.adjust("10 minutes")
        expect(yield* gone("ses_ret_idle")).toBe(true)
        expect(yield* remaining).toEqual(["ses_ret_busy"])
      }),
    ),
  )

  // Only a change in the last minute up to now counts: a clock ahead of now (a clock set back, or an imported row) or one
  // stored as text would otherwise put the pass off for as long as it stays so. The row above is the control.
  it.effect("does not defer the pass for a session whose clock is ahead or stored as text", () =>
    scenario(() =>
      Effect.gen(function* () {
        const clock = Date.now() + 40 * DAY
        yield* TestClock.setTime(clock)
        yield* row({ id: "ses_ret_idle", updated: Date.now() })
        yield* row({ id: "ses_ret_ahead", updated: clock + 10 * 60_000 + 60 * 60_000 })
        yield* row({ id: "ses_ret_text", updated: Date.now() })
        const database = yield* Database.Service
        yield* database.db
          .run(sql`UPDATE session_v2 SET time_updated = 'later' WHERE id = 'ses_ret_text'`)
          .pipe(Effect.orDie)
        yield* Effect.forkScoped(schedule(Effect.succeed(30))).pipe(logging([]))

        yield* TestClock.adjust("10 minutes")
        expect(yield* gone("ses_ret_idle")).toBe(true)
        expect(yield* remaining).toEqual(["ses_ret_ahead", "ses_ret_text"])
      }),
    ),
  )

  // A session this process is running counts as active however long ago its row last changed (a long model call writes
  // nothing until it ends), so the pass waits for it as well.
  it.effect("defers the pass while this process runs a session", () => {
    const running = { now: true }
    return scenario(
      () =>
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.now() + 40 * DAY)
          yield* row({ id: "ses_ret_waiting", updated: Date.now() })
          yield* Effect.forkScoped(schedule(Effect.succeed(30)))

          yield* TestClock.adjust("10 minutes")
          expect(yield* still("ses_ret_waiting")).toBe(true)
          running.now = false
          yield* TestClock.adjust("10 minutes")
          expect(yield* gone("ses_ret_waiting")).toBe(true)
        }),
      Layer.succeed(
        SessionExecution.Service,
        SessionExecution.Service.of({
          active: Effect.sync(() => new Set(running.now ? [SessionSchema.ID.make("ses_ret_running")] : [])),
          isActive: () => Effect.succeed(false),
          resume: () => Effect.void,
          wake: () => Effect.void,
          interrupt: () => Effect.succeed(false),
          awaitIdle: () => Effect.void,
        }),
      ),
    )
  })

  // A pass that fails (the server's config could not be loaded) is logged, and the next pass a day later still runs.
  it.effect("logs a pass that fails and runs the next one", () =>
    scenario(() =>
      Effect.gen(function* () {
        const logged: string[] = []
        let reads = 0
        yield* TestClock.setTime(Date.now() + 40 * DAY)
        yield* row({ id: "ses_ret_retry", updated: Date.now() })
        yield* Effect.forkScoped(
          schedule(
            Effect.suspend(() => (reads++ === 0 ? Effect.die("config could not be loaded") : Effect.succeed(30))),
          ),
        ).pipe(logging(logged))

        yield* TestClock.adjust("10 minutes")
        expect(yield* eventually(Effect.sync(() => logged.length > 0))).toBe(true)
        expect(logged).toEqual(["session retention pass failed"])
        expect(yield* still("ses_ret_retry")).toBe(true)
        yield* TestClock.adjust("24 hours")
        expect(yield* gone("ses_ret_retry")).toBe(true)
      }),
    ),
  )

  // Settings that fail to decode while they name the period skip the pass (S3); the schedule then removes nothing.
  it.effect("runs no pass when the setting cannot be read", () =>
    scenario(() =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now() + 40 * DAY)
        yield* row({ id: "ses_ret_unread", updated: Date.now() })
        yield* Effect.forkScoped(schedule(Effect.succeed(undefined)))

        yield* TestClock.adjust("10 minutes")
        yield* TestClock.adjust("24 hours")
        expect(yield* still("ses_ret_unread")).toBe(true)
      }),
    ),
  )
})

function tool(id: string, name: string, status: "completed" | "error" | "running", created: number) {
  const time = { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created + 1_000) }
  if (status === "completed")
    return SessionMessage.AssistantTool.make({
      type: "tool",
      id,
      name,
      state: SessionMessage.ToolStateCompleted.make({ status, input: {}, content: [{ type: "text", text: "ok" }] }),
      time,
    })
  if (status === "error")
    return SessionMessage.AssistantTool.make({
      type: "tool",
      id,
      name,
      state: SessionMessage.ToolStateError.make({ status, input: {}, error: { type: "tool", message: "failed" } }),
      time,
    })
  return SessionMessage.AssistantTool.make({
    type: "tool",
    id,
    name,
    state: SessionMessage.ToolStateRunning.make({ status, input: {}, metadata: {} }),
    time: { created: DateTime.makeUnsafe(created) },
  })
}

function assistant(
  id: string,
  created: number,
  content: SessionMessage.AssistantContent[],
  model = "small",
  scale = 1,
) {
  return SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(id),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make(model), providerID: Provider.ID.make("retention-provider") },
    content,
    cost: Money.USD.make(1.5 * scale),
    tokens: { input: 10 * scale, output: 5 * scale, reasoning: 2 * scale, cache: { read: 4 * scale, write: scale } },
    time: { created: DateTime.makeUnsafe(created), completed: DateTime.makeUnsafe(created + 2_000) },
  })
}

function messageRow(
  sessionID: string,
  seq: number,
  message: SessionMessage.Info,
): typeof SessionMessageTable.$inferInsert {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return {
    id: SessionMessage.ID.make(id),
    session_id: SessionSchema.ID.make(sessionID),
    type,
    seq,
    time_created: encoded.time.created,
    data,
  }
}
