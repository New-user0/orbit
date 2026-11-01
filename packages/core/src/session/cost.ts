export * as SessionCost from "./cost.js"

import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Money } from "@orbit/schema/money"
import type { SessionCost } from "@orbit/schema/session-cost"
import { Database } from "../database/database.js"
import { NotFoundError } from "./error.js"
import { SessionMessageTable, SessionTable, SessionUsageTable } from "./sql.js"
import type { SessionSchema } from "./schema.js"

/** Spend below this is rounding, not a record the rows failed to explain. */
const EPSILON = 0.00005

type Counts = {
  providerID: string
  modelID: string
  responses: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  unrecorded: number
  zero: number
}

/**
 * What a session and its subagents have cost, by model, from the durable rows alone: the whole history, however much of
 * it a client has loaded. It reads no folder and starts no work, so it needs no trust (class 12). Model IDs are only
 * grouped and returned, never parsed (class 5).
 *
 * A row is a model's assistant responses plus every usage record that names the model: side requests, titles, discarded
 * attempts and compaction calls, whether the compaction completed, failed or was cancelled. A completed compaction's
 * message stands in only where its session has no compaction record naming a model, so a session whose compactions all
 * predate them counts them from their messages; once such a session compacts again, the earlier compactions' spend
 * falls into `other`. Whatever no row explains (responses a rewind removed, records from before they named a model) is `other`,
 * so that the total stays the sessions' own totals.
 */
export const summary = Effect.fn("SessionCost.summary")(function* (sessionID: SessionSchema.ID) {
  const db = (yield* Database.Service).db
  const own = yield* db
    .select({
      cost: SessionTable.cost,
      created: SessionTable.time_created,
      added: SessionTable.lines_added,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!own) return yield* new NotFoundError({ sessionID })

  // The session and every descendant. UNION (not UNION ALL) keeps a parent cycle from looping.
  const family = sql`
    WITH RECURSIVE family(id) AS (
      SELECT ${sessionID}
      UNION
      SELECT child.id FROM ${SessionTable} AS child JOIN family ON child.parent_id = family.id
    )
  `
  const totals = yield* db
    .get<{ cost: number; added: number; removed: number }>(
      sql`
      ${family}
      SELECT
        coalesce(sum(session.cost), 0) AS cost,
        coalesce(sum(session.lines_added), 0) AS added,
        coalesce(sum(session.lines_removed), 0) AS removed
      FROM ${SessionTable} AS session
      WHERE session.id IN (SELECT id FROM family)
    `,
    )
    .pipe(Effect.orDie)

  // A fork copies its parent's settled messages with their original timestamps, but its own totals start at zero:
  // messages older than the fork belong to the parent.
  const messages = yield* db
    .all<Counts>(
      sql`
      ${family}
      SELECT
        json_extract(message.data, '$.model.providerID') AS providerID,
        json_extract(message.data, '$.model.id') AS modelID,
        count(*) AS responses,
        coalesce(sum(json_extract(message.data, '$.tokens.input')), 0) AS input,
        coalesce(sum(json_extract(message.data, '$.tokens.output')), 0) AS output,
        coalesce(sum(json_extract(message.data, '$.tokens.reasoning')), 0) AS reasoning,
        coalesce(sum(json_extract(message.data, '$.tokens.cache.read')), 0) AS cacheRead,
        coalesce(sum(json_extract(message.data, '$.tokens.cache.write')), 0) AS cacheWrite,
        coalesce(sum(json_extract(message.data, '$.cost')), 0) AS cost,
        coalesce(sum(CASE
          WHEN json_extract(message.data, '$.cost') IS NOT NULL THEN 0
          WHEN json_type(message.data, '$.tokens') IS NULL THEN 1
          WHEN ${tokenTotal("message.data")} > 0 THEN 1
          ELSE 0
        END), 0) AS unrecorded,
        coalesce(sum(CASE
          WHEN json_extract(message.data, '$.cost') = 0 AND ${tokenTotal("message.data")} > 0 THEN 1
          ELSE 0
        END), 0) AS zero
      FROM ${SessionMessageTable} AS message
      JOIN ${SessionTable} AS session ON session.id = message.session_id
      WHERE message.session_id IN (SELECT id FROM family)
        AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
        AND json_extract(message.data, '$.model.providerID') IS NOT NULL
        AND json_extract(message.data, '$.model.id') IS NOT NULL
        AND (
          (message.type = 'assistant'
            AND (json_type(message.data, '$.tokens') = 'object'
              -- A response that failed mid-stream carries neither tokens nor cost: its spend is unknown.
              OR (json_extract(message.data, '$.finish') = 'error' AND json_extract(message.data, '$.cost') IS NULL)))
          -- Once a session's compaction calls name their model, those records hold every call, including the ones of a
          -- compaction that failed or was cancelled. The message counts only while the session has none of them.
          OR (message.type = 'compaction'
            AND json_extract(message.data, '$.status') = 'completed'
            AND json_type(message.data, '$.tokens') = 'object'
            AND NOT EXISTS (
              SELECT 1 FROM ${SessionUsageTable} AS call
              WHERE call.session_id = message.session_id
                AND call.kind = 'usage' AND call.source = 'compaction' AND call.model_id IS NOT NULL
            ))
        )
      GROUP BY providerID, modelID
    `,
    )
    .pipe(Effect.orDie)

  const records = yield* db
    .all<Counts>(
      sql`
      ${family}
      SELECT
        usage.provider_id AS providerID,
        usage.model_id AS modelID,
        count(*) AS responses,
        sum(usage.tokens_input) AS input,
        sum(usage.tokens_output) AS output,
        sum(usage.tokens_reasoning) AS reasoning,
        sum(usage.tokens_cache_read) AS cacheRead,
        sum(usage.tokens_cache_write) AS cacheWrite,
        sum(usage.cost) AS cost,
        0 AS unrecorded,
        coalesce(sum(CASE
          WHEN usage.cost = 0 AND usage.tokens_input + usage.tokens_output + usage.tokens_reasoning
            + usage.tokens_cache_read + usage.tokens_cache_write > 0 THEN 1
          ELSE 0
        END), 0) AS zero
      FROM ${SessionUsageTable} AS usage
      WHERE usage.session_id IN (SELECT id FROM family)
        AND usage.provider_id IS NOT NULL
        AND usage.model_id IS NOT NULL
      GROUP BY usage.provider_id, usage.model_id
    `,
    )
    .pipe(Effect.orDie)

  // The key is a pair, never the two joined into a string, because either part may hold any separator.
  const merged = new Map<string, Counts>()
  ;[...messages, ...records].forEach((found) => {
    const key = JSON.stringify([found.providerID, found.modelID])
    const held = merged.get(key)
    if (!held) return merged.set(key, { ...found })
    Object.assign(held, {
      responses: held.responses + found.responses,
      input: held.input + found.input,
      output: held.output + found.output,
      reasoning: held.reasoning + found.reasoning,
      cacheRead: held.cacheRead + found.cacheRead,
      cacheWrite: held.cacheWrite + found.cacheWrite,
      cost: held.cost + found.cost,
      unrecorded: held.unrecorded + found.unrecorded,
      zero: held.zero + found.zero,
    })
  })
  const rows: SessionCost.Row[] = [...merged.values()]
    .toSorted(
      (left, right) =>
        right.cost - left.cost ||
        (left.providerID < right.providerID ? -1 : left.providerID > right.providerID ? 1 : 0) ||
        (left.modelID < right.modelID ? -1 : left.modelID > right.modelID ? 1 : 0),
    )
    .map((found) => ({
      providerID: found.providerID,
      modelID: found.modelID,
      responses: found.responses,
      tokens: {
        input: found.input,
        output: found.output,
        reasoning: found.reasoning,
        cache: { read: found.cacheRead, write: found.cacheWrite },
      },
      cost: Money.USD.make(found.cost),
      unrecorded: found.unrecorded,
      zero: found.zero,
    }))

  // `streamed` ends the provider response; `completed` also waits for tools and for the person's answers.
  const times = yield* db
    .get<{ api: number | null; completed: number | null }>(
      sql`
      ${family}
      SELECT
        sum(CASE
          WHEN json_extract(message.data, '$.time.streamed') IS NULL THEN NULL
          ELSE max(0, json_extract(message.data, '$.time.streamed') - json_extract(message.data, '$.time.created'))
        END) AS api,
        max(json_extract(message.data, '$.time.completed')) AS completed
      FROM ${SessionMessageTable} AS message
      JOIN ${SessionTable} AS session ON session.id = message.session_id
      WHERE message.session_id IN (SELECT id FROM family)
        AND message.type = 'assistant'
        AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
    `,
    )
    .pipe(Effect.orDie)

  const cost = totals?.cost ?? 0
  const explained = rows.reduce((sum, row) => sum + row.cost, 0)
  return {
    cost: Money.USD.make(cost),
    own: Money.USD.make(own.cost),
    subagents: Money.USD.make(Math.max(0, cost - own.cost)),
    other: cost - explained > EPSILON ? Money.USD.make(cost - explained) : undefined,
    api: times?.api ?? undefined,
    wall: times?.completed == null ? undefined : Math.max(0, times.completed - own.created),
    lines: own.added === null ? undefined : { added: totals?.added ?? 0, removed: totals?.removed ?? 0 },
    rows,
  } satisfies SessionCost.Info
})

/** The five token kinds of a stored message as one SQL sum; a missing field counts as 0. */
const tokenTotal = (column: string) =>
  sql.raw(
    ["input", "output", "reasoning", "cache.read", "cache.write"]
      .map((field) => `coalesce(json_extract(${column}, '$.tokens.${field}'), 0)`)
      .join(" + "),
  )
