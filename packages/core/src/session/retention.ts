export * as SessionRetention from "./retention.js"

import fs from "fs/promises"
import path from "path"
import { inArray, sql } from "drizzle-orm"
import { Cause, Clock, Context, Effect, Layer } from "effect"
import { Project } from "@orbit/schema/project"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { Global } from "@orbit/util/global"
import { plain } from "@orbit/util/plain"
import { Agent } from "../agent.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import retentionMigration from "../database/migration/20261024013745_session_retention.js"
import { Session } from "../session.js"
import { ToolOutput } from "../tool-output.js"
import { SessionExecution } from "./execution.js"
import { SessionFolder } from "./folder.js"
import { SessionSchema } from "./schema.js"
import { SessionStats } from "./stats.js"
import {
  SessionInboxTable,
  SessionMessageTable,
  SessionPendingTable,
  SessionStatsArchiveTable,
  SessionTable,
  SessionUsageTable,
} from "./sql.js"

/** The days a session is kept after its last change when `cleanup_period_days` is not set. */
export const DEFAULT_DAYS = 30
const DAY = 86_400_000
const ACTIVE = 60_000

export interface Interface {
  /**
   * One pass: removes every family (a session with its subagents and forks) whose members all last changed before
   * `now` less `days`, counting no change from before retention started on this database, unless a member has queued or
   * pending input, holds the execution claim, is shared, or has an ID or clock that does not decode. A family's stats go
   * to the archive first. Then the session folders under the saved-results and scratchpad roots that no session names
   * any longer go, and the flat saved results of earlier versions past the cutoff.
   */
  readonly prune: (input: {
    readonly days: number
    readonly now?: number
  }) => Effect.Effect<{ readonly removed: ReadonlyArray<SessionSchema.ID> }>
  /** Whether a session is running in this process or changed in the last minute. */
  readonly busy: Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionRetention") {}

/**
 * The period from the config, or undefined when the pass must be skipped: a document did not parse, so the period it
 * may hold is unknown, or a document was rejected (whole or in part) while the period is named anywhere. A typo then
 * never falls back to the default (class 7).
 */
export const setting = Effect.gen(function* () {
  const config = yield* Config.Service
  const entries = yield* config.entries()
  const rejected = config.rejected === undefined ? [] : yield* config.rejected()
  const days = Config.latest(entries, "cleanup_period_days")
  if (rejected.some((item) => item.keys === undefined)) {
    yield* Effect.logWarning("session retention skipped: a config file does not parse", {
      sources: rejected.filter((item) => item.keys === undefined).map((item) => item.source),
    })
    return undefined
  }
  if (
    rejected.length > 0 &&
    (days !== undefined || rejected.some((item) => item.keys?.includes("cleanup_period_days")))
  ) {
    yield* Effect.logWarning("session retention skipped: the config has errors and sets cleanup_period_days", {
      sources: rejected.map((item) => item.source),
    })
    return undefined
  }
  return days ?? DEFAULT_DAYS
})

/**
 * Starts the passes on a fiber of the caller's scope, which they end with: the first 10 minutes from now and then one
 * every 24 hours, each put off by 10 minutes at a time while a session was active in the last minute. `read` gives the
 * period for each pass; undefined skips that pass. A pass that fails is logged, and the next one still runs.
 */
export const schedule = (read: Effect.Effect<number | undefined>) =>
  Effect.gen(function* () {
    const retention = yield* Service
    const pass = Effect.gen(function* () {
      while (yield* retention.busy) yield* Effect.sleep("10 minutes")
      const days = yield* read
      if (days === undefined) return
      yield* retention.prune({ days })
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.logError("session retention pass failed", { cause }),
      ),
    )
    return yield* Effect.sleep("10 minutes").pipe(
      Effect.andThen(pass.pipe(Effect.andThen(Effect.sleep("24 hours")), Effect.forever)),
      Effect.forkScoped,
    )
  })

type Row = {
  readonly id: string
  readonly projectID: string
  readonly parentID: string | null
  readonly forkID: string | null
  readonly updated: unknown
  readonly held: number
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sessions = yield* Session.Service
    const execution = yield* SessionExecution.Service
    const global = yield* Global.Service
    // Orbit's own folders, worked out once; every path the sweep removes is one of their entries.
    const outputs = path.join(global.data, ToolOutput.DIRECTORY)
    const scratch = Agent.scratchpadRoot(global.tmp)

    const prune: Interface["prune"] = Effect.fn("SessionRetention.prune")(function* (input) {
      const now = input.now ?? (yield* Clock.currentTimeMillis)
      const cutoff = now - input.days * DAY
      // When retention started on this database (the migration's journal row). Without it nothing counts as idle.
      const journal = yield* db
        .get<{ time: number }>(
          sql`SELECT time_completed AS time FROM ${sql.identifier("migration")} WHERE id = ${retentionMigration.id}`,
        )
        .pipe(Effect.orDie)
      const start = journal?.time ?? now
      const rows = yield* db
        .all<Row>(
          sql`
          SELECT
            session.id AS id,
            session.project_id AS projectID,
            session.parent_id AS parentID,
            session.fork_session_id AS forkID,
            session.time_updated AS updated,
            session.time_suspended IS NOT NULL
              OR session.share_url IS NOT NULL
              OR EXISTS (SELECT 1 FROM ${SessionInboxTable} AS inbox WHERE inbox.session_id = session.id)
              OR EXISTS (SELECT 1 FROM ${SessionPendingTable} AS pending WHERE pending.session_id = session.id) AS held
          FROM ${SessionTable} AS session
        `,
        )
        .pipe(Effect.orDie)
      const removed = yield* Effect.forEach(families(rows), (family) =>
        Effect.gen(function* () {
          // A client or an import chose the ID, and a folder is named by it; a clock that is not a whole number cannot be
          // compared. Either keeps the whole family, with one line for each row (classes 5 and 7).
          const bad = family.filter(
            (member) => !SessionFolder.KEY.test(member.id) || !Number.isSafeInteger(member.updated),
          )
          if (bad.length > 0)
            return yield* Effect.forEach(
              bad,
              (member) =>
                Effect.logWarning(
                  SessionFolder.KEY.test(member.id)
                    ? "session retention kept a family: a session's last change does not decode"
                    : "session retention kept a family: a session's ID cannot name a folder",
                  { id: plain(member.id).slice(0, 100) },
                ),
              { discard: true },
            ).pipe(Effect.as([]))
          if (family.some((member) => member.held)) return []
          if (family.some((member) => Math.max(Number(member.updated), start) >= cutoff)) return []
          const order = leavesFirst(family)
          if (order.length < family.length)
            return yield* Effect.logWarning("session retention kept a family: its sessions name each other in a loop", {
              ids: family.map((member) => plain(member.id).slice(0, 100)),
            }).pipe(Effect.as([]))
          yield* archive(family)
          return yield* removeInOrder(order)
        }),
      ).pipe(Effect.map((lists) => lists.flat()))
      yield* sweep(new Set(removed.map((id) => id.toLowerCase())), cutoff)
      return { removed }
    })

    // The family's stats, folded per session into 15-minute buckets. A pass that died between the fold and the removal
    // folds the same sessions again, so the old rows of each go first.
    const archive = Effect.fnUntraced(function* (family: readonly Row[]) {
      const ids = family.map((member) => SessionSchema.ID.make(member.id))
      const messages = yield* db
        .all<{
          sessionID: string
          type: "user" | "assistant"
          timeCreated: number
          providerID: string | null
          modelID: string | null
          variant: string | null
          input: number | null
          output: number | null
          reasoning: number | null
          cacheRead: number | null
          cacheWrite: number | null
          cost: number | null
        }>(
          sql`
          SELECT
            message.session_id AS sessionID,
            message.type AS type,
            message.time_created AS timeCreated,
            json_extract(message.data, '$.model.providerID') AS providerID,
            json_extract(message.data, '$.model.id') AS modelID,
            json_extract(message.data, '$.model.variant') AS variant,
            json_extract(message.data, '$.tokens.input') AS input,
            json_extract(message.data, '$.tokens.output') AS output,
            json_extract(message.data, '$.tokens.reasoning') AS reasoning,
            json_extract(message.data, '$.tokens.cache.read') AS cacheRead,
            json_extract(message.data, '$.tokens.cache.write') AS cacheWrite,
            json_extract(message.data, '$.cost') AS cost
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id
          WHERE message.session_id IN ${ids}
            AND message.type IN ('user', 'assistant')
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
          ORDER BY message.time_created, message.seq
        `,
        )
        .pipe(Effect.orDie)
      const tools = yield* db
        .all<{ sessionID: string; timeCreated: number; name: string | null; status: string | null }>(
          sql`
          SELECT
            message.session_id AS sessionID,
            message.time_created AS timeCreated,
            json_extract(content.value, '$.name') AS name,
            json_extract(content.value, '$.state.status') AS status
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id,
            json_each(message.data, '$.content') AS content
          WHERE message.session_id IN ${ids}
            AND message.type = 'assistant'
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            AND json_extract(content.value, '$.type') = 'tool'
          ORDER BY message.time_created, message.seq, content.key
        `,
        )
        .pipe(Effect.orDie)
      const usage = yield* db
        .all<{
          sessionID: string
          timeCreated: number
          input: number
          output: number
          reasoning: number
          cacheRead: number
          cacheWrite: number
          cost: number
        }>(
          sql`
          SELECT
            session_id AS sessionID,
            time_created AS timeCreated,
            tokens_input AS input,
            tokens_output AS output,
            tokens_reasoning AS reasoning,
            tokens_cache_read AS cacheRead,
            tokens_cache_write AS cacheWrite,
            cost
          FROM ${SessionUsageTable}
          WHERE session_id IN ${ids} AND (kind = 'side_query' OR source = 'compaction')
          ORDER BY time_created, seq
        `,
        )
        .pipe(Effect.orDie)

      const members = new Map(family.map((member) => [member.id, member]))
      const buckets = new Map<string, typeof SessionStatsArchiveTable.$inferInsert>()
      const add = (
        sessionID: string,
        time: number,
        kind: "user" | "step" | "tool" | "usage",
        key: {
          provider?: string | null
          model?: string | null
          variant?: string | null
          name?: string | null
          status?: string | null
        },
        amounts: {
          cost?: number | null
          input?: number | null
          output?: number | null
          reasoning?: number | null
          cacheRead?: number | null
          cacheWrite?: number | null
        },
      ) => {
        const bucket = Math.floor(time / SessionStats.BUCKET) * SessionStats.BUCKET
        const id = JSON.stringify([sessionID, bucket, kind, key.provider, key.model, key.variant, key.name, key.status])
        const member = members.get(sessionID)!
        const row = buckets.get(id) ?? {
          session_id: SessionSchema.ID.make(sessionID),
          project_id: Project.ID.make(member.projectID),
          subagent: member.parentID !== null,
          bucket,
          kind,
          provider_id: key.provider ?? null,
          model_id: key.model ?? null,
          variant: key.variant ?? null,
          name: key.name ?? null,
          status: key.status ?? null,
          count: 0,
          cost: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
        }
        buckets.set(id, {
          ...row,
          count: row.count + 1,
          cost: row.cost + (amounts.cost ?? 0),
          tokens_input: row.tokens_input + (amounts.input ?? 0),
          tokens_output: row.tokens_output + (amounts.output ?? 0),
          tokens_reasoning: row.tokens_reasoning + (amounts.reasoning ?? 0),
          tokens_cache_read: row.tokens_cache_read + (amounts.cacheRead ?? 0),
          tokens_cache_write: row.tokens_cache_write + (amounts.cacheWrite ?? 0),
        })
      }
      messages.forEach((message) =>
        message.type === "user"
          ? add(message.sessionID, message.timeCreated, "user", {}, {})
          : add(
              message.sessionID,
              message.timeCreated,
              "step",
              { provider: message.providerID, model: message.modelID, variant: message.variant },
              message,
            ),
      )
      tools.forEach((tool) =>
        add(tool.sessionID, tool.timeCreated, "tool", { name: tool.name, status: tool.status }, {}),
      )
      usage.forEach((item) => add(item.sessionID, item.timeCreated, "usage", {}, item))
      const values = [...buckets.values()]
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(SessionStatsArchiveTable).where(inArray(SessionStatsArchiveTable.session_id, ids)).run()
            yield* Effect.forEach(
              Array.from({ length: Math.ceil(values.length / 500) }, (_, index) =>
                values.slice(index * 500, (index + 1) * 500),
              ),
              (batch) => tx.insert(SessionStatsArchiveTable).values(batch).run(),
              { discard: true },
            )
          }),
        )
        .pipe(Effect.orDie)
    })

    // Through `Session.remove`, so every subscriber of the deletion runs. A session no other member names goes before
    // the one it names. A removal that fails keeps the rest of the family; the stats of a session that stays are not
    // counted twice, because the archive counts only sessions that are gone.
    const removeInOrder = Effect.fnUntraced(function* (order: readonly string[]) {
      const removed: SessionSchema.ID[] = []
      for (const member of order) {
        const id = SessionSchema.ID.make(member)
        const done = yield* sessions.remove(id).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logWarning("session retention could not remove a session", { id, cause }).pipe(Effect.as(false)),
          ),
        )
        if (!done) return removed
        removed.push(id)
      }
      return removed
    })

    // The folders that no session names any longer. The names of the live sessions, of their scratchpads and of the
    // saved results their messages still point to are compared in lower case, because Windows and macOS treat two
    // spellings as one folder (class 4). A folder of a session this pass removed goes; any other one only once its own
    // last change is past the cutoff, since another channel's database keeps its sessions under the same folders.
    const sweep = Effect.fnUntraced(function* (removed: ReadonlySet<string>, cutoff: number) {
      const live = yield* db
        .select({ id: SessionTable.id, parentID: SessionTable.parent_id, forkID: SessionTable.fork_session_id })
        .from(SessionTable)
        .all()
        .pipe(Effect.orDie)
      const ids = live.map((session) => session.id.toLowerCase())
      // The scratchpad a session uses (`SessionScratchpad.key`): its parent's, else its fork source's, else its own.
      const keys = live.map((session) => (session.parentID ?? session.forkID ?? session.id).toLowerCase())
      const markers = yield* db
        .all<{ session: unknown }>(
          sql`
          SELECT DISTINCT json_extract(content.value, '$.state.metadata.persisted.session') AS session
          FROM ${SessionMessageTable} AS message,
            json_each(CASE WHEN json_valid(message.data) THEN message.data ELSE '{}' END, '$.content') AS content
          WHERE message.type = 'assistant'
            AND json_extract(content.value, '$.type') = 'tool'
            AND json_extract(content.value, '$.state.metadata.persisted.session') IS NOT NULL
        `,
        )
        .pipe(Effect.orDie)
      const named = markers.flatMap((marker) =>
        typeof marker.session === "string" ? [marker.session.toLowerCase()] : [],
      )
      yield* sweepRoot(outputs, new Set([...ids, ...named]), removed, cutoff)
      yield* sweepRoot(scratch, new Set([...ids, ...keys]), removed, cutoff)
      yield* ToolOutput.cleanup(outputs, cutoff)
    })

    // The root is Orbit's own folder, checked with `lstat` and left alone when it is a link or not a folder. Each entry
    // is `lstat`ed and removed at the joined path that was checked: a link goes as a link, and nothing is followed or
    // resolved before the decision, so a link to a share is never opened (class 4). Only a name a session ID can take is
    // a session's folder (class 5).
    const sweepRoot = (root: string, keep: ReadonlySet<string>, removed: ReadonlySet<string>, cutoff: number) =>
      Effect.tryPromise(async () => {
        const info = await fs.lstat(root).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
        if (info === undefined) return { link: false, failed: 0 }
        if (!info.isDirectory()) return { link: true, failed: 0 }
        const outcomes = await Promise.all(
          (await fs.readdir(root))
            .map(async (name) => {
              if (!SessionFolder.KEY.test(name) || keep.has(name.toLowerCase())) return true
              const entry = path.join(root, name)
              const found = await fs.lstat(entry)
              if (!removed.has(name.toLowerCase()) && found.mtimeMs >= cutoff) return true
              if (found.isSymbolicLink()) return fs.unlink(entry).then(() => true)
              if (found.isDirectory()) return fs.rm(entry, { recursive: true, force: true }).then(() => true)
              return true
            })
            .map((outcome) => outcome.catch(() => false)),
        )
        return { link: false, failed: outcomes.filter((ok) => !ok).length }
      }).pipe(
        Effect.flatMap((result) =>
          result.link
            ? Effect.logWarning("session retention left a folder alone: it is a link or not a folder", { root })
            : result.failed > 0
              ? Effect.logWarning("session retention could not remove some entries", { root, failed: result.failed })
              : Effect.void,
        ),
        Effect.catch((error) => Effect.logWarning("session retention could not read a folder", { root, error })),
      )

    const busy = Effect.gen(function* () {
      if ((yield* execution.active).size > 0) return true
      const now = yield* Clock.currentTimeMillis
      const recent = yield* db
        .get<{ id: string }>(
          sql`
          SELECT id FROM ${SessionTable}
          WHERE typeof(time_updated) = 'integer' AND time_updated >= ${now - ACTIVE} AND time_updated <= ${now}
          LIMIT 1
        `,
        )
        .pipe(Effect.orDie)
      return recent !== undefined
    })

    return Service.of({ prune, busy })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, Session.node, SessionExecution.node, Global.node],
})

// The connected groups of sessions over `parent_id` and `fork_session_id`, either way, among the rows that exist.
function families(rows: readonly Row[]) {
  const byID = new Map(rows.map((row) => [row.id, row]))
  const links = new Map(rows.map((row) => [row.id, [] as string[]]))
  rows.forEach((row) =>
    [row.parentID, row.forkID].forEach((other) => {
      if (other === null || other === row.id || !byID.has(other)) return
      links.get(row.id)!.push(other)
      links.get(other)!.push(row.id)
    }),
  )
  const seen = new Set<string>()
  return rows.flatMap((row) => {
    if (seen.has(row.id)) return []
    seen.add(row.id)
    const family: Row[] = []
    const queue = [row.id]
    while (queue.length > 0) {
      const id = queue.pop()!
      family.push(byID.get(id)!)
      links.get(id)!.forEach((other) => {
        if (seen.has(other)) return
        seen.add(other)
        queue.push(other)
      })
    }
    return [family]
  })
}

// Members in an order where none comes before a member that names it; shorter than the family when they name each
// other in a loop.
function leavesFirst(family: readonly Row[]) {
  const order: string[] = []
  const left = new Set(family.map((member) => member.id))
  while (left.size > 0) {
    const leaves = family.filter(
      (member) =>
        left.has(member.id) &&
        !family.some(
          (other) =>
            other.id !== member.id &&
            left.has(other.id) &&
            (other.parentID === member.id || other.forkID === member.id),
        ),
    )
    if (leaves.length === 0) return order
    leaves.forEach((member) => {
      left.delete(member.id)
      order.push(member.id)
    })
  }
  return order
}
