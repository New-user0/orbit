export * as SessionTurn from "./turn.js"

import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema } from "effect"
import { Model } from "@orbit/schema/model"
import { Options } from "@orbit/schema/session-turn"
import { Database } from "../database/database.js"
import { Event } from "@orbit/schema/event"
import { EventTable } from "../event/sql.js"
import { SessionEvent } from "@orbit/schema/session-event"
import { SessionHistory } from "./history.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

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
export const current = Effect.fn("SessionTurn.current")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const notice = sql<string>`json_extract(${SessionMessageTable.data}, '$.metadata.notice')`
  const read = yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const idle = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "idle")))
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
  return {
    boundary: read.boundary,
    options:
      read.options && prompt?.type === "user" && prompt.turn
        ? { ...prompt.turn, seq: read.options.seq, time: prompt.time.created }
        : undefined,
    fallback: model?._tag === "Some" ? model.value : undefined,
    // fromEntries defines own properties, so a kind named `__proto__` is still a plain count, and assigning them onto an
    // object without a prototype keeps every other name from reading as an inherited member.
    notices: Object.assign(
      Object.create(null) as Record<string, number>,
      Object.fromEntries(read.counts.map((row) => [row.notice, row.count])),
    ),
  } satisfies Current
})

const decodeUsage = Schema.decodeUnknownOption(SessionEvent.UsageRecorded.data)
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

export interface Usage {
  /** Responses in the Session that ended with finish `stop`, `length`, `tool-calls` or `content-filter`. */
  readonly steps: number
  readonly cost: number
  /** Input, cache write, output and reasoning tokens. */
  readonly tokens: number
  /**
   * Responses and usage records, the Session's own or a subagent's, whose price is unknown: a finished response with
   * no recorded cost or no tokens at all, any response or record with tokens and a cost of zero, a response that failed
   * with no recorded cost, and usage records that do not decode. They add nothing (or nothing real) to `cost`, so a
   * cost limit must not read them as free.
   */
  readonly unknown: number
}

/**
 * What the turn spent since `since`: the Session's own responses and usage records after `since.seq`, plus those of
 * every descendant Session (a subagent, however deep) written at or after `since.time`. Pre-output retries leave no
 * response, and a response that failed mid-stream (finish `error`) is not a step, though its spend still counts. Usage
 * records carry the compaction and title spend, which a crash can leave without a row on the message.
 */
export const usage = Effect.fn("SessionTurn.usage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  since: { readonly seq: number; readonly time: DateTime.Utc },
) {
  const time = DateTime.toEpochMillis(since.time)
  const descendants = sql`WITH RECURSIVE descendants(id) AS (
    SELECT id FROM session_v2 WHERE parent_id = ${sessionID}
    UNION
    SELECT child.id FROM session_v2 AS child JOIN descendants ON child.parent_id = descendants.id
  )`
  const ended = sql`json_extract(data, '$.finish') IN ('stop', 'length', 'tool-calls', 'content-filter')`
  const tokens = sql`coalesce(json_extract(data, '$.tokens.input'), 0) + coalesce(json_extract(data, '$.tokens.cache.write'), 0) + coalesce(json_extract(data, '$.tokens.output'), 0) + coalesce(json_extract(data, '$.tokens.reasoning'), 0)`
  const read = sql`${tokens} + coalesce(json_extract(data, '$.tokens.cache.read'), 0)`
  // Spend whose price is unknown: a finished response with no cost or no tokens, any response with tokens and a zero
  // cost (a model with no price, or a free one), and a failed one that recorded no cost.
  const unpriced = sql`(${ended} AND (json_extract(data, '$.cost') IS NULL OR ${read} = 0))
    OR (${read} > 0 AND coalesce(json_extract(data, '$.cost'), 0) = 0)
    OR (json_extract(data, '$.finish') = 'error' AND json_extract(data, '$.cost') IS NULL)`
  const messages = yield* db
    .get<{ steps: number | null; cost: number | null; tokens: number | null; unknown: number | null }>(
      sql`${descendants}
        SELECT
          sum(CASE WHEN session_id = ${sessionID} AND ${ended} THEN 1 ELSE 0 END) AS steps,
          sum(coalesce(json_extract(data, '$.cost'), 0)) AS cost,
          sum(${tokens}) AS tokens,
          sum(CASE WHEN ${unpriced} THEN 1 ELSE 0 END) AS unknown
        FROM session_message
        WHERE type = 'assistant'
          AND ((session_id = ${sessionID} AND seq > ${since.seq})
            OR (session_id IN (SELECT id FROM descendants) AND time_created >= ${time}))`,
    )
    .pipe(Effect.orDie)
  const records = yield* db
    .all<{ data: string }>(
      sql`${descendants}
        SELECT data FROM event
        WHERE type = ${Event.versionedType(SessionEvent.UsageRecorded.type, SessionEvent.UsageRecorded.durable.version)}
          AND ((aggregate_id = ${sessionID} AND seq > ${since.seq})
            OR (aggregate_id IN (SELECT id FROM descendants) AND created >= ${time}))`,
    )
    .pipe(Effect.orDie)
  // The raw read returns the stored text, so a row that is not JSON is a record that cannot be counted.
  const decoded = records.map((row) => Option.flatMap(parseJson(row.data), decodeUsage))
  const recorded = decoded.flatMap((item) => (Option.isSome(item) ? [item.value] : []))
  return {
    steps: messages?.steps ?? 0,
    cost: (messages?.cost ?? 0) + recorded.reduce((total, item) => total + item.cost, 0),
    tokens:
      (messages?.tokens ?? 0) +
      recorded.reduce(
        (total, item) =>
          total + item.tokens.input + item.tokens.cache.write + item.tokens.output + item.tokens.reasoning,
        0,
      ),
    unknown:
      (messages?.unknown ?? 0) +
      decoded.length -
      recorded.length +
      recorded.filter(
        (item) =>
          item.cost === 0 &&
          item.tokens.input + item.tokens.cache.read + item.tokens.cache.write + item.tokens.output + item.tokens.reasoning > 0,
      ).length,
  } satisfies Usage
})

/**
 * The limit the turn has reached, as the error that ends it (`limit.cost-unknown` when a cost limit cannot be checked,
 * which is a refusal rather than a limit that was reached), or undefined when it may go on. A cost limit that cannot
 * be checked against a price fails here instead of reading missing spend as free: `priced` says whether the model about
 * to run has a price, and `spent.unknown` whether anything already spent lacks one.
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
  return undefined
}

/**
 * The cost or token limit that an ancestor Session's turn has reached, or undefined when each may go on. A subagent is
 * admitted without turn options, so it would otherwise spend without bound while its parent waits for it: the parent
 * checks its own limits only before its next request. The ancestor's step limit is left out because only the
 * ancestor's own responses count toward it, so a parent on its last step would stop the child it just started. The
 * ancestor's usage includes every sibling running beside the child, so parallel subagents share the one budget.
 */
export const ancestorLimit = Effect.fn("SessionTurn.ancestorLimit")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  priced: boolean,
) {
  const parentOf = (id: SessionSchema.ID) =>
    db
      .select({ parent: SessionTable.parent_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, id))
      .get()
      .pipe(
        Effect.orDie,
        Effect.map((row) => row?.parent ?? undefined),
      )
  // A session tree is acyclic, but a bad row must not loop here.
  const seen = new Set<string>([sessionID])
  for (let id = yield* parentOf(sessionID); id !== undefined && !seen.has(id); id = yield* parentOf(id)) {
    seen.add(id)
    const turn = (yield* current(db, id)).options
    if (turn?.maxCost === undefined && turn?.maxTokens === undefined) continue
    const limit = exceeded(turn, { ...(yield* usage(db, id, turn)), steps: 0 }, priced)
    if (limit) return limit
  }
  return undefined
})
