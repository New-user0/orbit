export * as SessionTurn from "./turn.js"

import { and, desc, eq, gt, gte, inArray, lt, lte, sql } from "drizzle-orm"
import type { SQL } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { Model } from "@orbit/schema/model"
import { Options } from "@orbit/schema/session-turn"
import { Database } from "../database/database.js"
import { MessageDecodeError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable, SessionTable } from "./sql.js"
import { SessionUsage } from "./usage.js"

export { Options }

type DatabaseService = Database.Interface["db"]

export interface Current {
  /** Sequence of the row that began the turn, or undefined when the turn began with the Session. */
  readonly boundary: number | undefined
  /**
   * The latest options the turn's prompts carried, with the sequence and time of the prompt that set them: a limit
   * counts what happened after that point.
   */
  readonly options: (Options & { readonly seq: number; readonly time: DateTime.Utc }) | undefined
  /** The model a fallback notice named in this turn, until the Session switches model again. */
  readonly fallback: Model.Ref | undefined
  /**
   * How many notices of each kind (`metadata.notice` of a synthetic message) the turn holds. A kind the turn holds none
   * of is absent, whatever its name: the record has no prototype, so `constructor` or `toString` are not inherited.
   */
  readonly notices: Readonly<Partial<Record<string, number>>>
}

/** Reads the turn as the transcript stood before a sequence number, or at a time (inclusive). */
export interface Until {
  readonly seq?: number
  readonly time?: number
}

const decodeModel = Schema.decodeUnknownOption(Model.Ref)

/**
 * Derives the state of the turn the Session is in from its transcript alone, so a restart or a replay gives the same
 * answer. A turn starts at the first input promoted after an idle marker, or at any input promoted with `queue`
 * delivery, which waits until the previous work ended. Steers join the current turn, and the notices that the runner
 * records directly carry no delivery, so they never start one. Messages projected before delivery was recorded count
 * as steers.
 *
 * Only an idle marker or a queued input closes a turn, and nothing records where a history was cut or that a busy
 * period outlived its turn. So a steer joins the last turn in front of it, and inherits its options, fallback model and
 * notice counts, whenever the history in front of it does not end in an idle marker. That holds for:
 * - a steer that arrives after the runner's last check for input but before the idle marker, which the same busy
 *   period promotes (the doorbell in `SessionRunCoordinator`);
 * - the first steer after a fork that stops before an idle marker, such as a fork before a queued prompt;
 * - the first steer after a committed revert, which deletes the idle marker that followed the history it keeps;
 * - the first steer after an import of a session that was exported in the middle of a turn;
 * - the first steer after a crash cut off a subagent's Session, or after a shutdown interrupted it without a reason:
 *   neither records an idle marker, and the next start resumes only top-level Sessions and background subagents, so it
 *   clears the claim of any other child (`SessionStore.releaseChildClaims`) without publishing a terminal event.
 * - the first steer after a control item or a move that the runner delivers at the end of a turn, and after a location
 *   reload: a steered compaction admitted while the last response streams, a queued one admitted at any point in the
 *   turn, a move, or a reload, runs after the turn's last response, in the same drain. The busy period does not
 *   settle, so no idle marker is written, and a steer that arrives while it runs is promoted next and joins the finished turn.
 * A queued input starts a new turn in all six. Closing them for steers takes a durable record of where the history was
 * cut or where the turn started, and nothing records either yet. For the fifth, the start could publish the terminal
 * event that it does not publish when it clears the claim.
 */
export const current: (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  until?: Until,
) => Effect.Effect<Current, MessageDecodeError> = Effect.fn("SessionTurn.current")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  until?: Until,
) {
  // Rows after `until` do not exist yet, as far as this read is concerned.
  const visible = and(
    until?.seq === undefined ? undefined : lt(SessionMessageTable.seq, until.seq),
    until?.time === undefined ? undefined : lte(SessionMessageTable.time_created, until.time),
  )
  const notice = sql<string>`json_extract(${SessionMessageTable.data}, '$.metadata.notice')`
  const read = yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const idle = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "idle"), visible))
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
        // Only the busy period since the last idle marker can hold a queued input that began the turn.
        const queued = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              inArray(SessionMessageTable.type, ["user", "synthetic"]),
              visible,
              gt(SessionMessageTable.seq, idle?.seq ?? -1),
              sql`json_extract(${SessionMessageTable.data}, '$.delivery') = 'queue'`,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
        const boundary = queued?.seq ?? idle?.seq
        const floor = boundary ?? -1
        // A queued prompt that began the turn is the boundary row itself, so its own options count.
        const options = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, "user"),
              visible,
              gte(SessionMessageTable.seq, floor),
              sql`json_extract(${SessionMessageTable.data}, '$.turn') is not null`,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
        const fallback = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, "synthetic"),
              gt(SessionMessageTable.seq, floor),
              sql`${notice} = 'fallback'`,
            ),
          )
          .orderBy(desc(SessionMessageTable.seq))
          .limit(1)
          .get()
        const switched = fallback
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(
                  eq(SessionMessageTable.session_id, sessionID),
                  eq(SessionMessageTable.type, "model-switched"),
                  gt(SessionMessageTable.seq, fallback.seq),
                ),
              )
              .limit(1)
              .get()
          : undefined
        const counts = yield* db
          .select({ notice, count: sql<number>`count(*)` })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, sessionID),
              eq(SessionMessageTable.type, "synthetic"),
              gt(SessionMessageTable.seq, floor),
              sql`json_type(${SessionMessageTable.data}, '$.metadata.notice') = 'text'`,
            ),
          )
          .groupBy(notice)
          .all()
        return { boundary, options, fallback: switched ? undefined : fallback, counts }
      }),
    )
    .pipe(Effect.orDie)

  const prompt = read.options ? yield* SessionHistory.decodeMessageRow(read.options) : undefined
  const named = read.fallback ? yield* SessionHistory.decodeMessageRow(read.fallback) : undefined
  const model = named?.type === "synthetic" ? decodeModel(named.metadata?.model) : undefined
  if (named && model?._tag !== "Some")
    yield* Effect.logWarning("Ignoring a fallback notice whose model cannot be read").pipe(
      Effect.annotateLogs({ sessionID, messageID: named.id }),
    )
  const own =
    read.options && prompt?.type === "user" && prompt.turn
      ? { ...prompt.turn, seq: read.options.seq, time: prompt.time.created }
      : undefined
  return {
    boundary: read.boundary,
    options: own ?? (yield* wakeUpOptions(db, sessionID, read.boundary, visible)),
    fallback: model?._tag === "Some" ? model.value : undefined,
    // fromEntries defines own properties, so a kind named `__proto__` is still a plain count, and assigning them onto an
    // object without a prototype keeps every other name from reading as an inherited member.
    notices: Object.assign(
      Object.create(null) as Record<string, number>,
      Object.fromEntries(read.counts.map((row) => [row.notice, row.count])),
    ),
  } satisfies Current
})

/**
 * Input that no user prompt began wakes the Session into a turn: a background subagent's or shell job's completion
 * notice, a plan reminder, any synthetic message. That turn carries no options of its own, so it continues the limits of
 * the turn that ended before it, counted from that turn's own prompt: the wake-up cannot spend what the original turn
 * had left and then some. A user prompt first starts a turn of its own.
 */
const wakeUpOptions = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: number | undefined,
  visible: SQL | undefined,
) {
  if (boundary === undefined) return undefined
  // A user prompt anywhere in the turn is the person's own input, so its options (or none) apply, whatever parked
  // synthetic input (a plan reminder, editor context) precedes it. Only a turn that holds nothing but synthetic input
  // is a wake-up.
  const kinds = yield* db
    .select({ type: SessionMessageTable.type })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        inArray(SessionMessageTable.type, ["user", "synthetic"]),
        visible,
        gte(SessionMessageTable.seq, boundary),
      ),
    )
    .groupBy(SessionMessageTable.type)
    .all()
    .pipe(Effect.orDie)
  if (kinds.some((row) => row.type === "user") || !kinds.some((row) => row.type === "synthetic")) return undefined
  // The nearest user prompt before the boundary began the turn this wake-up continues: every turn between them holds
  // synthetic input only, so one lookup replaces a walk through them. That turn is read as it stood right after the
  // prompt. A steered wake-up and a queued one find the same prompt, whatever idle markers lie between.
  const prompt = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "user"),
        visible,
        lt(SessionMessageTable.seq, boundary),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  if (!prompt) return undefined
  return (yield* current(db, sessionID, { seq: prompt.seq + 1 })).options
})

export interface Usage {
  /**
   * Responses in the Session that ended with finish `stop`, `length`, `tool-calls` or `content-filter`. A text-only
   * reply that was cut off at the output limit and then escalated or resumed is one logical step with what continues
   * it, so the cut-off attempt is not counted again.
   */
  readonly steps: number
  readonly cost: number
  /** Input, cache write, output and reasoning tokens. */
  readonly tokens: number
  /**
   * Responses and usage records, the Session's own or a subagent's, whose price is unknown: a finished response or
   * record with no recorded cost or no tokens at all, any response or record with tokens and a cost of zero, a
   * response that failed with no recorded cost. They add nothing (or nothing real) to `cost`, so a cost limit must not
   * read them as free.
   */
  readonly unknown: number
  /**
   * Finished responses and usage records that reported no tokens at all (a provider that omits usage), and responses
   * that failed with no token record. They add nothing to `tokens`, so a token limit must not read them as free. A
   * priced response with tokens and a zero cost is unknown for cost only.
   */
  readonly unknownTokens: number
}

/**
 * The usage a response has reported but `Step.Ended` has not yet recorded, by Session and assistant message. The event
 * waits for every tool of the response to finish, and a foreground subagent runs inside that window, so a limit check
 * made by the subagent would miss the step that started it. A Session and its subagents run in one process, and after
 * a crash the step reruns and is read from its rows again.
 */
const open = new Map<
  string,
  { readonly sessionID: SessionSchema.ID; readonly messageID: string; readonly spent: SessionUsage.Recorded }
>()

/** Holds the usage the provider reported for a response until the event that records it is published. */
export const reportStep = (sessionID: SessionSchema.ID, messageID: string, spent: SessionUsage.Recorded) => {
  open.set(`${sessionID}/${messageID}`, { sessionID, messageID, spent })
}

/** Drops what `reportStep` held, once the row carries the usage or the response is abandoned. */
export const settleStep = (sessionID: SessionSchema.ID, messageID: string) => {
  open.delete(`${sessionID}/${messageID}`)
}

/**
 * What the turn spent since `since`: the Session's own responses and usage records after `since.seq`, plus those of
 * every descendant Session (a subagent, however deep) written at or after `since.time`. Pre-output retries leave no
 * response (what they billed is a usage record), and a response that failed mid-stream (finish `error`) is not a step,
 * though its spend still counts. Usage records carry the compaction, title, side-query and generation spend, which a
 * crash can leave without a row on the message. A response that reported its usage but is not yet recorded counts
 * through `reportStep`, until its row carries a cost.
 */
export const usage = Effect.fn("SessionTurn.usage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  since: { readonly seq: number; readonly time: DateTime.Utc },
  /** A response the runner is about to continue in the same logical step, which is not a step yet. */
  continuing?: string,
) {
  const time = DateTime.toEpochMillis(since.time)
  const descendants = sql`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM session_v2 WHERE parent_id = ${sessionID}
    UNION
    SELECT child.id FROM session_v2 AS child JOIN descendants ON child.parent_id = descendants.id
  )`
  const ended = sql`json_extract(m.data, '$.finish') IN ('stop', 'length', 'tool-calls', 'content-filter')`
  const tokens = sql`coalesce(json_extract(m.data, '$.tokens.input'), 0) + coalesce(json_extract(m.data, '$.tokens.cache.write'), 0) + coalesce(json_extract(m.data, '$.tokens.output'), 0) + coalesce(json_extract(m.data, '$.tokens.reasoning'), 0)`
  const read = sql`${tokens} + coalesce(json_extract(m.data, '$.tokens.cache.read'), 0)`
  // Spend whose price is unknown: a finished response with no cost or no tokens, any response with tokens and a zero
  // cost (a model with no price, or a free one), and a failed one that recorded no cost.
  const unpriced = sql`(${ended} AND (json_extract(m.data, '$.cost') IS NULL OR ${read} = 0))
    OR (${read} > 0 AND coalesce(json_extract(m.data, '$.cost'), 0) = 0)
    OR (json_extract(m.data, '$.finish') = 'error' AND json_extract(m.data, '$.cost') IS NULL)`
  // Spend whose size is unknown: a finished response that reported no tokens, and a failed one with no token record.
  const untokened = sql`(${ended} AND ${read} = 0)
    OR (json_extract(m.data, '$.finish') = 'error' AND json_extract(m.data, '$.tokens') IS NULL)`
  // A text-only reply that was cut off is continued, in the same logical step, by the escalation or resume notice
  // recorded after it and before the Session's next response. A cut-off that called a tool is a step of its own.
  const textOnly = sql`NOT EXISTS (SELECT 1 FROM json_each(m.data, '$.content') WHERE json_extract(value, '$.type') = 'tool')`
  const continued = sql`json_extract(m.data, '$.finish') = 'length'
    AND ${textOnly}
    AND EXISTS (
      SELECT 1 FROM session_message AS n
      WHERE n.session_id = m.session_id AND n.type = 'synthetic'
        AND json_extract(n.data, '$.metadata.notice') IN ('output-limit', 'output-escalation')
        AND n.seq > m.seq
        AND n.seq < coalesce(
          (SELECT min(a.seq) FROM session_message AS a WHERE a.session_id = m.session_id AND a.type = 'assistant' AND a.seq > m.seq),
          9223372036854775807))`
  const messages = yield* db
    .get<{
      steps: number | null
      cost: number | null
      tokens: number | null
      unknown: number | null
      unknown_tokens: number | null
    }>(
      sql`${descendants}
        SELECT
          sum(CASE WHEN m.session_id = ${sessionID} AND ${ended} AND NOT (${continued}) AND NOT (m.id IS ${continuing ?? null} AND ${textOnly}) THEN 1 ELSE 0 END) AS steps,
          sum(coalesce(json_extract(m.data, '$.cost'), 0)) AS cost,
          sum(${tokens}) AS tokens,
          sum(CASE WHEN ${unpriced} THEN 1 ELSE 0 END) AS unknown,
          sum(CASE WHEN ${untokened} THEN 1 ELSE 0 END) AS unknown_tokens
        FROM session_message AS m
        WHERE m.type = 'assistant'
          AND ((m.session_id = ${sessionID} AND m.seq > ${since.seq})
            OR (m.session_id IN (SELECT id FROM descendants) AND m.time_created >= ${time}))`,
    )
    .pipe(Effect.orDie)
  // Read from the projected table: the event log is empty unless the Bus persists, which CLI servers do not. Every
  // kind counts: the retried attempts, side queries and generations that billed this Session are recorded beside the
  // compaction and title spend, and a record that carries no cost or no tokens is as unknown as a response is.
  const recorded = yield* db
    .get<{ cost: number | null; tokens: number | null; unknown: number | null; unknown_tokens: number | null }>(
      sql`${descendants}
        SELECT
          sum(cost) AS cost,
          sum(tokens_input + tokens_cache_write + tokens_output + tokens_reasoning) AS tokens,
          sum(CASE WHEN cost = 0 THEN 1 ELSE 0 END) AS unknown,
          sum(CASE WHEN tokens_input + tokens_cache_read + tokens_cache_write + tokens_output + tokens_reasoning = 0 THEN 1 ELSE 0 END) AS unknown_tokens
        FROM session_usage
        WHERE (session_id = ${sessionID} AND seq > ${since.seq})
          OR (session_id IN (SELECT id FROM descendants) AND time_created >= ${time})`,
    )
    .pipe(Effect.orDie)
  const pending = yield* openUsage(db, sessionID, descendants)
  return {
    steps: messages?.steps ?? 0,
    cost: (messages?.cost ?? 0) + (recorded?.cost ?? 0) + pending.cost,
    tokens: (messages?.tokens ?? 0) + (recorded?.tokens ?? 0) + pending.tokens,
    unknown: (messages?.unknown ?? 0) + (recorded?.unknown ?? 0) + pending.unknown,
    unknownTokens: (messages?.unknown_tokens ?? 0) + (recorded?.unknown_tokens ?? 0) + pending.unknownTokens,
  } satisfies Usage
})

/** The reported-but-unrecorded responses of the Session and its descendants whose row carries no cost yet. */
const openUsage = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID, descendants: SQL) {
  const sum = { cost: 0, tokens: 0, unknown: 0, unknownTokens: 0 }
  if (open.size === 0) return sum
  const family = new Set<string>([
    sessionID,
    ...(yield* db.all<{ id: string }>(sql`${descendants} SELECT id FROM descendants`).pipe(Effect.orDie)).map(
      (row) => row.id,
    ),
  ])
  for (const entry of [...open.values()].filter((entry) => family.has(entry.sessionID))) {
    const row = yield* db
      .get<{ cost: number | null }>(
        sql`SELECT json_extract(data, '$.cost') AS cost FROM session_message WHERE session_id = ${entry.sessionID} AND id = ${entry.messageID}`,
      )
      .pipe(Effect.orDie)
    // Once the step has ended the row holds the usage, and counting it here as well would count it twice.
    if (row && row.cost !== null) continue
    const tokens = entry.spent.tokens
    const total = tokens.input + tokens.cache.write + tokens.output + tokens.reasoning
    sum.cost += entry.spent.cost
    sum.tokens += total
    if (entry.spent.cost === 0 || total + tokens.cache.read === 0) sum.unknown += 1
    if (total + tokens.cache.read === 0) sum.unknownTokens += 1
  }
  return sum
})


/**
 * The limit the turn has reached, as the error that ends it (`limit.cost-unknown` or `limit.tokens-unknown` when a limit
 * cannot be checked, which is a refusal rather than a limit that was reached), or undefined when it may go on. A limit
 * that cannot be checked fails here instead of reading missing spend as free: `priced` says whether the model about to
 * run has a price, and `spent.unknown` and `spent.unknownTokens` whether anything already spent lacks a cost or a
 * token count.
 */
export function exceeded(options: Options, spent: Usage, priced: boolean) {
  if (options.maxSteps !== undefined && spent.steps >= options.maxSteps)
    return {
      type: "limit.steps",
      message: `The turn reached its limit of ${options.maxSteps} ${options.maxSteps === 1 ? "step" : "steps"}.`,
    }
  if (options.maxCost !== undefined && !priced)
    return {
      type: "limit.cost-unknown",
      message: `The turn has a cost limit of $${options.maxCost}, but the model has no price, so its spend cannot be counted.`,
    }
  if (options.maxCost !== undefined && spent.unknown > 0)
    return {
      type: "limit.cost-unknown",
      message: `The turn has a cost limit of $${options.maxCost}, but ${spent.unknown} of its responses or usage records carried no usable cost, so its spend cannot be counted.`,
    }
  if (options.maxCost !== undefined && spent.cost >= options.maxCost)
    return {
      type: "limit.cost",
      message: `The turn reached its cost limit of $${options.maxCost} after spending $${spent.cost.toFixed(4)}.`,
    }
  if (options.maxTokens !== undefined && spent.tokens >= options.maxTokens)
    return {
      type: "limit.tokens",
      message: `The turn reached its limit of ${options.maxTokens} tokens after using ${spent.tokens}.`,
    }
  if (options.maxTokens !== undefined && spent.unknownTokens > 0)
    return {
      type: "limit.tokens-unknown",
      message: `The turn has a limit of ${options.maxTokens} tokens, but ${spent.unknownTokens} of its responses or usage records reported no tokens, so its usage cannot be counted.`,
    }
  return undefined
}

/**
 * The cost or token limit that an ancestor Session's turn has reached, or undefined when each may go on. A subagent is
 * admitted without turn options, so it would otherwise spend without bound while its parent waits for it: the parent
 * checks its own limits only before its next request. The ancestor's step limit is left out because only the
 * ancestor's own responses count toward it, so a parent on its last step would stop the child it just started. The
 * ancestor's usage includes every sibling running beside the child, so parallel subagents share the one budget.
 *
 * Each ancestor's turn is read as it stood when the Session below it was last prompted, by the time that prompt was admitted rather than delivered (a prompt delivered
after the ancestor's turn ended still belongs to it), which is the prompt that the
 * ancestor's subagent tool admitted: a continued child belongs to the turn that continues it, not the one that created
 * it. A background subagent outlives that turn, and the idle marker that closes it must not lift the limit the work was
 * started under, because its latest prompt was admitted inside it.
 */
export const ancestorLimit = Effect.fn("SessionTurn.ancestorLimit")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  priced: boolean,
) {
  const parentOf = (id: SessionSchema.ID) =>
    db
      .select({ parent: SessionTable.parent_id, created: SessionTable.time_created })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(Effect.orDie)
  // When the latest user prompt of the Session was admitted, delivered or still waiting in its inbox: the limit is
  // checked before a continuation prompt is delivered. The admission row survives delivery, so a prompt that reaches
  // the Session after its parent's turn ended is still bound to the turn that admitted it. A Session without
  // admission rows (an import or a fork) falls back to the time its messages were written.
  const prompted = (id: SessionSchema.ID) =>
    db
      .get<{ time: number | null }>(
        sql`SELECT coalesce(
          (SELECT max(time_created) FROM session_admission WHERE session_id = ${id}),
          (SELECT max(time) FROM (
            SELECT time_created AS time FROM session_message WHERE session_id = ${id} AND type = 'user'
            UNION ALL
            SELECT time_created AS time FROM session_inbox WHERE session_id = ${id} AND type = 'user'
          ))
        ) AS time`,
      )
      .pipe(Effect.orDie)
  // A session tree is acyclic, but a bad row must not loop here.
  const seen = new Set<string>([sessionID])
  let below = sessionID
  for (let row = yield* parentOf(sessionID); row?.parent && !seen.has(row.parent); row = yield* parentOf(row.parent)) {
    const id = row.parent
    seen.add(id)
    const admitted = (yield* prompted(below))?.time ?? row.created
    below = id
    const turn = (yield* current(db, id, { time: admitted })).options
    if (turn?.maxCost === undefined && turn?.maxTokens === undefined) continue
    const limit = exceeded(turn, { ...(yield* usage(db, id, turn)), steps: 0 }, priced)
    if (limit) return limit
  }
  return undefined
})
