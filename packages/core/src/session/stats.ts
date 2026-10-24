export * as SessionStats from "./stats.js"

import { DateTime, Effect, Schema } from "effect"
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm"
import { Model } from "@orbit/schema/model"
import { Money } from "@orbit/schema/money"
import { Project } from "@orbit/schema/project"
import { Provider } from "@orbit/schema/provider"
import { ToolMode } from "@orbit/schema/session-stats"
import { TokenUsage } from "@orbit/schema/token-usage"
import { Database } from "../database/database.js"
import { SessionMessageTable, SessionStatsArchiveTable, SessionTable, SessionUsageTable } from "./sql.js"

type Input = {
  readonly from?: number
  readonly to?: number
  readonly projectID?: Project.ID
  readonly timezone?: string
  readonly tools?: ToolMode
}

type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

type MessageRow = {
  sessionID: string
  parentID: string | null
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
}

type ToolRow = {
  name: string | null
  status: string | null
  duration: number | null
}

type ToolSummaryRow = {
  calls: number
  succeeded: number
  failed: number
  unfinished: number
}

type ModelAggregate = {
  model: Model.Ref
  steps: number
  tokens: Tokens
  cost: number
}

type ToolAggregate = {
  name: string
  calls: number
  succeeded: number
  failed: number
  unfinished: number
  durations: number[]
}

const Window = 31 * 24 * 60 * 60 * 1_000
/** The width of an archive bucket (`SessionStatsArchiveTable`): every real time zone is a whole number of these from UTC. */
export const BUCKET = 15 * 60 * 1_000

export class InvalidRangeError extends Schema.TaggedError<InvalidRangeError>()("SessionStats.InvalidRangeError", {
  from: Schema.Finite,
  to: Schema.Finite,
}) {}

export const get = Effect.fn("SessionStats.get")(function* (input: Input = {}) {
  const db = (yield* Database.Service).db
  const to = input.to ?? Date.now()
  if (input.from !== undefined && input.from >= to) return yield* new InvalidRangeError({ from: input.from, to })
  const project = input.projectID === undefined ? sql`` : sql`AND session.project_id = ${input.projectID}`
  // The stats of the sessions that retention removed; a session still here (a removal that failed after the fold) is
  // counted from its own rows only.
  const archived = sql`
    NOT EXISTS (SELECT 1 FROM ${SessionTable} AS live WHERE live.id = archive.session_id)
    ${input.projectID === undefined ? sql`` : sql`AND archive.project_id = ${input.projectID}`}
  `
  const from =
    input.from ??
    Math.min(
      to,
      ...(yield* Effect.all([
        db.get<{ time: number | null }>(
          sql`
          SELECT min(message.time_created) AS time
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id
          WHERE message.type IN ('user', 'assistant')
            AND message.time_created < ${to}
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            ${project}
        `,
        ),
        db.get<{ time: number | null }>(
          sql`
          SELECT min(archive.bucket) AS time
          FROM ${SessionStatsArchiveTable} AS archive
          WHERE archive.kind IN ('user', 'step') AND archive.bucket < ${to} AND ${archived}
        `,
        ),
      ]).pipe(Effect.orDie)).flatMap((row) => row?.time ?? []),
    )
  const ranges = windows(from, to)
  const toolMode = input.tools ?? "summary"
  const sessions = new Set<string>()
  const subagents = new Set<string>()
  const activity = new Map<string, number>()
  const models = new Map<string, ModelAggregate>()
  const tools = new Map<string, ToolAggregate>()
  const totals = {
    prompts: 0,
    steps: 0,
    tokens: emptyTokens(),
    cost: 0,
  }
  const toolTotals = { calls: 0, succeeded: 0, failed: 0, unfinished: 0 }
  const dateKey = makeDateKey(input.timezone)
  // A live message counts once; an archive bucket counts the messages it folded.
  const addMessages = (row: {
    sessionID: string
    subagent: boolean
    type: "user" | "assistant"
    time: number
    count: number
    providerID: string | null
    modelID: string | null
    variant: string | null
    tokens: Tokens
    cost: number
  }) => {
    if (row.subagent) subagents.add(row.sessionID)
    else sessions.add(row.sessionID)
    if (row.type === "user") {
      if (!row.subagent) totals.prompts += row.count
      return
    }
    totals.steps += row.count
    addTokens(totals.tokens, row.tokens)
    totals.cost += row.cost
    const day = dateKey(row.time)
    activity.set(day, (activity.get(day) ?? 0) + row.count)
    if (!row.providerID || !row.modelID) return
    const key = `${row.providerID}/${row.modelID}#${row.variant ?? ""}`
    const model = models.get(key) ?? {
      model: {
        providerID: Provider.ID.make(row.providerID),
        id: Model.ID.make(row.modelID),
        variant: row.variant ? Model.VariantID.make(row.variant) : undefined,
      },
      steps: 0,
      tokens: emptyTokens(),
      cost: 0,
    }
    models.set(key, model)
    model.steps += row.count
    model.cost += row.cost
    addTokens(model.tokens, row.tokens)
  }
  const addTools = (row: { name: string | null; status: string | null; count: number; duration: number | null }) => {
    addToolStatus(toolTotals, row.status, row.count)
    if (toolMode !== "detail" || !row.name) return
    const tool = tools.get(row.name) ?? {
      name: row.name,
      calls: 0,
      succeeded: 0,
      failed: 0,
      unfinished: 0,
      durations: [],
    }
    tools.set(row.name, tool)
    addToolStatus(tool, row.status, row.count)
    if (row.duration !== null) tool.durations.push(row.duration)
  }

  yield* Effect.forEach(
    ranges,
    (range) =>
      db
        .all<MessageRow>(
          sql`
          SELECT
            message.session_id AS sessionID,
            session.parent_id AS parentID,
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
          WHERE message.type IN ('user', 'assistant')
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            ${project}
        `,
        )
        .pipe(
          Effect.orDie,
          Effect.tap((rows) =>
            Effect.sync(() => {
              rows.forEach((row) =>
                addMessages({
                  ...row,
                  subagent: row.parentID !== null,
                  time: row.timeCreated,
                  count: 1,
                  tokens: rowTokens(row),
                  cost: row.cost ?? 0,
                }),
              )
            }),
          ),
        ),
    { concurrency: 1, discard: true },
  )

  if (toolMode !== "none")
    yield* Effect.forEach(
      ranges,
      (range) => {
        if (toolMode === "summary")
          return db
            .get<ToolSummaryRow>(
              sql`
            WITH calls AS MATERIALIZED (
              SELECT json_extract(content.value, '$.state.status') AS status
              FROM ${SessionMessageTable} AS message
              JOIN ${SessionTable} AS session ON session.id = message.session_id,
                json_each(message.data, '$.content') AS content
              WHERE message.type = 'assistant'
                AND message.time_created >= ${range.from}
                AND message.time_created < ${range.to}
                AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
                AND json_extract(content.value, '$.type') = 'tool'
                ${project}
            )
            SELECT
              count(*) AS calls,
              count(*) FILTER (WHERE status = 'completed') AS succeeded,
              count(*) FILTER (WHERE status = 'error') AS failed,
              count(*) FILTER (WHERE status IS NULL OR status NOT IN ('completed', 'error')) AS unfinished
            FROM calls
          `,
            )
            .pipe(
              Effect.orDie,
              Effect.tap((row) =>
                Effect.sync(() => {
                  if (!row) return
                  toolTotals.calls += row.calls
                  toolTotals.succeeded += row.succeeded
                  toolTotals.failed += row.failed
                  toolTotals.unfinished += row.unfinished
                }),
              ),
              Effect.asVoid,
            )
        return db
          .all<ToolRow>(
            sql`
          SELECT
            json_extract(content.value, '$.name') AS name,
            json_extract(content.value, '$.state.status') AS status,
            CASE
              WHEN json_extract(content.value, '$.time.completed') IS NULL THEN NULL
              ELSE json_extract(content.value, '$.time.completed')
                - coalesce(json_extract(content.value, '$.time.ran'), json_extract(content.value, '$.time.created'))
            END AS duration
          FROM ${SessionMessageTable} AS message
          JOIN ${SessionTable} AS session ON session.id = message.session_id,
            json_each(message.data, '$.content') AS content
          WHERE message.type = 'assistant'
            AND message.time_created >= ${range.from}
            AND message.time_created < ${range.to}
            AND (session.fork_session_id IS NULL OR message.time_created >= session.time_created)
            AND json_extract(content.value, '$.type') = 'tool'
            ${project}
        `,
          )
          .pipe(
            Effect.orDie,
            Effect.tap((rows) => Effect.sync(() => rows.forEach((row) => addTools({ ...row, count: 1 })))),
            Effect.asVoid,
          )
      },
      { concurrency: 1, discard: true },
    )

  const ids = yield* db
    .select({ id: SessionTable.id })
    .from(SessionTable)
    .where(input.projectID === undefined ? undefined : eq(SessionTable.project_id, input.projectID))
    .all()
    .pipe(Effect.orDie)
  // Read from the projected table: the event log is empty unless the Bus persists, which CLI servers do not.
  const recorded = (yield* Effect.forEach(
    batches(ids.map((row) => row.id)),
    (batch) =>
      db
        .select()
        .from(SessionUsageTable)
        .where(
          and(
            inArray(SessionUsageTable.session_id, batch),
            or(eq(SessionUsageTable.kind, "side_query"), eq(SessionUsageTable.source, "compaction")),
            gte(SessionUsageTable.time_created, from),
            lt(SessionUsageTable.time_created, to),
          ),
        )
        .all()
        .pipe(Effect.orDie),
    { concurrency: 4 },
  )).flat()
  recorded.forEach((row) => {
    addTokens(totals.tokens, {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cache: { read: row.tokens_cache_read, write: row.tokens_cache_write },
    })
    totals.cost += row.cost
  })

  // The archive keeps no tool durations, so a tool's median comes from live rows only.
  const archive = yield* db
    .all<{
      sessionID: string
      subagent: number
      bucket: number
      kind: "user" | "step" | "tool" | "usage"
      providerID: string | null
      modelID: string | null
      variant: string | null
      name: string | null
      status: string | null
      count: number
      cost: number
      input: number
      output: number
      reasoning: number
      cacheRead: number
      cacheWrite: number
    }>(
      sql`
      SELECT
        archive.session_id AS sessionID,
        archive.subagent AS subagent,
        archive.bucket AS bucket,
        archive.kind AS kind,
        archive.provider_id AS providerID,
        archive.model_id AS modelID,
        archive.variant AS variant,
        archive.name AS name,
        archive.status AS status,
        archive.count AS count,
        archive.cost AS cost,
        archive.tokens_input AS input,
        archive.tokens_output AS output,
        archive.tokens_reasoning AS reasoning,
        archive.tokens_cache_read AS cacheRead,
        archive.tokens_cache_write AS cacheWrite
      FROM ${SessionStatsArchiveTable} AS archive
      WHERE archive.bucket < ${to} AND archive.bucket + ${BUCKET} > ${from} AND ${archived}
      ORDER BY archive.bucket, archive.id
    `,
    )
    .pipe(Effect.orDie)
  archive.forEach((row) => {
    const tokens = {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cacheRead, write: row.cacheWrite },
    }
    if (row.kind === "usage") {
      addTokens(totals.tokens, tokens)
      totals.cost += row.cost
      return
    }
    if (row.kind === "tool") {
      if (toolMode !== "none") addTools({ ...row, duration: null })
      return
    }
    addMessages({
      ...row,
      type: row.kind === "user" ? "user" : "assistant",
      subagent: row.subagent !== 0,
      time: row.bucket,
      tokens,
    })
  })

  const days = [...activity.entries()].sort(([a], [b]) => a.localeCompare(b))
  return {
    range: { from: DateTime.makeUnsafe(from), to: DateTime.makeUnsafe(to) },
    sessions: sessions.size,
    subagents: subagents.size,
    prompts: totals.prompts,
    steps: totals.steps,
    tokens: totals.tokens,
    cost: Money.USD.make(totals.cost),
    tools:
      toolMode === "none"
        ? { mode: toolMode }
        : toolMode === "summary"
          ? { mode: toolMode, totals: toolTotals }
          : {
              mode: toolMode,
              totals: toolTotals,
              usage: [...tools.values()]
                .sort((a, b) => b.calls - a.calls)
                .map((tool) => ({
                  name: tool.name,
                  calls: tool.calls,
                  succeeded: tool.succeeded,
                  failed: tool.failed,
                  unfinished: tool.unfinished,
                  durationP50: median(tool.durations),
                })),
            },
    activeDays: days.length,
    streak: longestStreak(days.map(([date]) => date)),
    activity: days.map(([date, steps]) => ({ date, steps })),
    models: [...models.values()]
      .sort((a, b) => TokenUsage.total(b.tokens) - TokenUsage.total(a.tokens))
      .map((model) => ({ ...model, cost: Money.USD.make(model.cost) })),
  }
})

function windows(from: number, to: number) {
  return Array.from({ length: Math.ceil((to - from) / Window) }, (_, index) => ({
    from: from + index * Window,
    to: Math.min(to, from + (index + 1) * Window),
  }))
}

function batches<T>(ids: T[]) {
  return Array.from({ length: Math.ceil(ids.length / 500) }, (_, index) => ids.slice(index * 500, (index + 1) * 500))
}

function rowTokens(row: MessageRow): Tokens {
  return {
    input: row.input ?? 0,
    output: row.output ?? 0,
    reasoning: row.reasoning ?? 0,
    cache: { read: row.cacheRead ?? 0, write: row.cacheWrite ?? 0 },
  }
}

function emptyTokens(): Tokens {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

function addTokens(target: Tokens, source: Tokens) {
  target.input += source.input
  target.output += source.output
  target.reasoning += source.reasoning
  target.cache.read += source.cache.read
  target.cache.write += source.cache.write
}

function addToolStatus(
  target: { calls: number; succeeded: number; failed: number; unfinished: number },
  status: string | null,
  count: number,
) {
  target.calls += count
  if (status === "completed") {
    target.succeeded += count
    return
  }
  if (status === "error") {
    target.failed += count
    return
  }
  target.unfinished += count
}

function makeDateKey(timezone = "UTC") {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
  return (time: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map((part) => [part.type, part.value]))
    return `${parts.year}-${parts.month}-${parts.day}`
  }
}

function longestStreak(days: string[]) {
  return days.reduce(
    (result, day, index) => {
      const previous = days[index - 1]
      const current = previous && dayOrdinal(day) - dayOrdinal(previous) === 1 ? result.current + 1 : 1
      return { current, longest: Math.max(result.longest, current) }
    },
    { current: 0, longest: 0 },
  ).longest
}

function dayOrdinal(value: string) {
  const [year, month, day] = value.split("-").map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

function median(values: number[]) {
  if (values.length === 0) return undefined
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}
