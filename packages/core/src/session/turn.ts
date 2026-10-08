export * as SessionTurn from "./turn.js"

import { and, desc, eq, gt, gte, inArray, sql } from "drizzle-orm"
import { Effect, Schema, type DateTime } from "effect"
import { Model } from "@orbit/schema/model"
import { Options } from "@orbit/schema/session-turn"
import { Database } from "../database/database.js"
import { SessionHistory } from "./history.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

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
 * Only an idle marker or a queued input closes a turn, and nothing records where a history was cut. So a steer joins
 * the last turn in front of it, and inherits its options, fallback model and notice counts, whenever the history in
 * front of it does not end in an idle marker. That holds for:
 * - a steer that arrives after the runner's last check for input but before the idle marker, which the same busy
 *   period promotes (the doorbell in `SessionRunCoordinator`);
 * - the first steer after a fork that stops before an idle marker, such as a fork before a queued prompt;
 * - the first steer after a committed revert, which deletes the idle marker that followed the history it keeps;
 * - the first steer after an import of a session that was exported in the middle of a turn;
 * - the first steer after a crash cut off a subagent's Session, or after a shutdown interrupted it without a reason:
 *   neither records an idle marker, and the next start resumes only top-level Sessions and background subagents, so it
 *   clears the claim of any other child (`SessionStore.releaseChildClaims`) without publishing a terminal event.
 * A queued input starts a new turn in all five. Closing them for steers takes a durable record of where the history was
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
