// foundations-19: `cleanup_period_days` removes idle session families. The reference judges every file by its age alone;
// Orbit removes a family (a session, its subagents and its forks) whole, only when no member has queued or pending
// work, holds the execution claim or is shared (V2 durable admission and restart recovery). A family that existed before
// the upgrade counts its idle time from the upgrade (owner, 2026-10-21). The stats of a removed family stay in
// `orb stats`, as the reference's stats cache keeps them. The pass also sweeps the folders that sessions name: the saved
// results under `<data>/tool-output` and the scratchpads under `<tmp>/sessions`. A folder is named by a session ID, so the
// name is shape-checked, a link is removed as a link, a root that is a link is left alone, and a folder that a live ID
// names in another letter case stays (classes 4 and 5). A row whose ID or clock does not decode keeps its family (class 7).
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
// @ts-expect-error foundations-19 adds this module; remove the directive with the build.
import { SessionRetention } from "@orbit/core/session/retention"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionMessageTable, SessionTable } from "@orbit/core/session/sql"
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

const scenario = <A, E>(body: (l: Layout) => Effect.Effect<A, E, Services | Scope.Scope>) =>
  Effect.gen(function* () {
    const l = yield* layout
    return yield* body(l).pipe(
      Effect.provide(
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
            SessionExecution.node.replace(SessionExecution.noopLayer),
            SessionModelTransport.node.replace(transport),
            offlineModels,
            Global.node.replace(Global.layerWith({ data: l.data, tmp: l.tmp, config: path.join(l.root, "config") })),
          ],
        ),
      ),
    )
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
        // One line for each row that does not decode, and none for the family that went.
        expect(logged).toHaveLength(2)
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
      }),
    ),
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

        yield* prune({ days: 30, now: later() })

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
        yield* link(elsewhere, l.outputs)
        yield* folder(path.join(l.scratch, "ses_ret_gone"))

        yield* prune({ days: 30, now: later() })

        expect(yield* exists(path.join(elsewhere, "ses_ret_gone", "keep.txt"))).toBe(true)
        expect((yield* Effect.promise(() => fs.lstat(l.outputs))).isSymbolicLink()).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_gone"))).toBe(false)
      }),
    ),
  )

  // Class 4: on Windows and macOS two IDs that differ in letter case name one folder, so a folder that a live session's
  // ID names in any case stays; the stricter answer holds on every platform.
  it.live("keeps a folder whose name is a live session's ID in another case", () =>
    scenario((l) =>
      Effect.gen(function* () {
        yield* row({ id: "ses_ret_CaseKeep", updated: later() - DAY })
        yield* folder(path.join(l.outputs, "ses_ret_casekeep"))
        yield* folder(path.join(l.scratch, "ses_ret_casekeep"))
        yield* folder(path.join(l.outputs, "ses_ret_nolive"))

        yield* prune({ days: 30, now: later() })

        expect(yield* exists(path.join(l.outputs, "ses_ret_casekeep", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.scratch, "ses_ret_casekeep", "keep.txt"))).toBe(true)
        expect(yield* exists(path.join(l.outputs, "ses_ret_nolive"))).toBe(false)
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
        yield* Effect.promise(async () => {
          await fs.mkdir(l.outputs, { recursive: true })
          await fs.writeFile(old, "old")
          await fs.writeFile(recent, "recent")
          await fs.utimes(old, new Date(), new Date(Date.now() - 10 * DAY))
        })

        yield* prune({ days: 30, now: Date.now() })
        expect(yield* exists(old)).toBe(true)

        yield* prune({ days: 5, now: Date.now() })
        expect(yield* exists(old)).toBe(false)
        expect(yield* exists(recent)).toBe(true)
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
  // orphan folder goes last in a pass (S4.6), so once it is gone the schedule is about to sleep for a day; the test
  // clock does not move on its own, so the short real wait after it only lets the fiber reach that sleep.
  it.effect("runs the first pass 10 minutes after start and the next 24 hours later", () =>
    scenario((l) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.now() + 40 * DAY)
        yield* row({ id: "ses_ret_first", updated: Date.now() })
        yield* folder(path.join(l.outputs, "ses_ret_orphan"))
        yield* Effect.forkScoped(schedule(Effect.succeed(30)))

        yield* TestClock.adjust("9 minutes")
        expect(yield* still("ses_ret_first")).toBe(true)
        yield* TestClock.adjust("1 minute")
        expect(yield* gone("ses_ret_first")).toBe(true)
        expect(
          yield* eventually(exists(path.join(l.outputs, "ses_ret_orphan")).pipe(Effect.map((there) => !there))),
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
