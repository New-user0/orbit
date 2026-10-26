import { and, asc, desc, eq, gte, lt, notInArray, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "../database/database.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { Instructions } from "../instructions/index.js"
import { InstructionState } from "./instruction-state.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

const decode = Schema.decodeUnknownEffect(SessionMessage.Info)

/**
 * Which completed compactions bound a history read. Local summaries always do. Native
 * windows do for model-neutral readers (`latest`), never for the original transcript
 * (`local`), and only when the target model can replay them (a provenance).
 */
export type Boundary = "latest" | "local" | SessionProviderContext.Provenance

const replayable = (message: SessionMessage.Info, boundary: Boundary) =>
  !SessionProviderContext.isCheckpoint(message) ||
  boundary === "latest" ||
  (boundary !== "local" && SessionProviderContext.compatible(message.providerContext.provenance, boundary))

/** The newest completed compaction that bounds a read, optionally only among those recorded before `before`. */
export const latestCompaction = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
  before?: number,
) {
  return yield* db
    .select({
      id: SessionMessageTable.id,
      seq: SessionMessageTable.seq,
      retain: sql<SessionMessage.ID | null>`json_extract(${SessionMessageTable.data}, '$.retain')`,
    })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "compaction"),
        before === undefined ? undefined : lt(SessionMessageTable.seq, before),
        sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
        boundary === "latest"
          ? undefined
          : or(
              sql`json_extract(${SessionMessageTable.data}, '$.providerContext') is null`,
              boundary === "local"
                ? undefined
                : and(
                    ...Object.entries(boundary).map(
                      ([key, value]) =>
                        sql`json_extract(${SessionMessageTable.data}, ${`$.providerContext.provenance.${key}`}) = ${value}`,
                    ),
                  ),
            ),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
})

export const decodeMessageRow = (row: typeof SessionMessageTable.$inferSelect) =>
  decode({ ...row.data, id: row.id, type: row.type }).pipe(
    Effect.tap((message) =>
      SessionProviderContext.isCheckpoint(message)
        ? SessionProviderContext.validate(message.providerContext)
        : Effect.void,
    ),
    Effect.mapError(
      () =>
        new MessageDecodeError({
          sessionID: SessionSchema.ID.make(row.session_id),
          messageID: SessionMessage.ID.make(row.id),
        }),
    ),
  )

const KEPT_LEFT_OUT: SessionMessage.Type[] = ["system", "compaction"]
const FAILED_OPEN_LEFT_OUT: SessionMessage.Type[] = ["system"]

type Checkpoint = NonNullable<Effect.Success<ReturnType<typeof latestCompaction>>>

/**
 * Where the view a checkpoint bounds begins. A checkpoint without `retain` begins at itself. One with `retain` begins
 * at the message it names, which must be a row recorded before the checkpoint and not before the view of the checkpoint
 * before it. The stored value may come from an import, so a row that fails any of that, or that is another session's or
 * is not there, makes the view fail open: it begins where the previous view does (at the first row of the session when
 * there is none), so the checkpoint's whole summarized span stays visible beside its summary. The ID is a bound
 * parameter and is never logged (class 5).
 */
const viewStart = (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
  checkpoint: Checkpoint,
): Effect.Effect<{ readonly start: number; readonly kept: boolean }> =>
  Effect.gen(function* () {
    if (checkpoint.retain === null) return { start: checkpoint.seq, kept: false }
    const previous = yield* latestCompaction(db, sessionID, boundary, checkpoint.seq)
    const floor = previous ? (yield* viewStart(db, sessionID, boundary, previous)).start : 0
    // A stored row is not decoded here: the value is only a bound parameter, so one that names no row fails open below.
    const row = yield* db
      .select({ seq: SessionMessageTable.seq, type: SessionMessageTable.type })
      .from(SessionMessageTable)
      .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.id, checkpoint.retain)))
      .get()
      .pipe(Effect.orDie)
    if (row && row.seq < checkpoint.seq && row.seq >= floor && row.type !== "compaction" && row.type !== "system")
      return { start: row.seq, kept: true }
    yield* Effect.logWarning("retained checkpoint skipped", { sessionID, checkpointID: checkpoint.id })
    return { start: floor, kept: false }
  })

const messageEntries = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  const compaction = yield* latestCompaction(db, sessionID, boundary)
  const view = compaction ? yield* viewStart(db, sessionID, boundary, compaction) : undefined
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        view ? gte(SessionMessageTable.seq, view.start) : undefined,
        // Rows from before the checkpoint that its summary or baseline supersedes: instruction updates, and (when it
        // keeps a span) earlier compaction rows too.
        compaction && view
          ? or(
              gte(SessionMessageTable.seq, compaction.seq),
              notInArray(SessionMessageTable.type, view.kept ? KEPT_LEFT_OUT : FAILED_OPEN_LEFT_OUT),
            )
          : undefined,
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const entries = yield* Effect.forEach(rows, (row) =>
    decodeMessageRow(row).pipe(Effect.map((message) => ({ seq: row.seq, message }))),
  )
  // Re-expansion may cross a native checkpoint whose completion already advanced the instruction
  // epoch: the baseline supersedes the chronological updates before it. Forks seed their baseline
  // at sequence 0 but retain parent sequences, so the copied checkpoint still retires them.
  const native = entries.findLast((entry) => SessionProviderContext.isCheckpoint(entry.message))
  // Skipped native checkpoints are not textual summaries. Their original transcript remains available.
  return entries.filter(
    (entry) =>
      !(entry.message.type === "system" && native && entry.seq < native.seq) && replayable(entry.message, boundary),
  )
})

export const load = Effect.fn("SessionHistory.load")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  boundary: Boundary,
) {
  return (yield* messageEntries(db, sessionID, boundary)).map((entry) => entry.message)
})

export const entriesForRunner = Effect.fn("SessionHistory.entriesForRunner")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, boundary)
        return {
          initial: yield* InstructionState.initial(db, sessionID, instructions),
          entries: messages,
        }
      }),
    )
    .pipe(Effect.orDie)
})

export const preview = Effect.fn("SessionHistory.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  boundary: Boundary,
) {
  const observed = yield* Instructions.read(instructions)
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const messages = yield* messageEntries(db, sessionID, boundary)
        // An active assistant may contain an unresolved tool call, so only preview the settled prefix.
        const unsettled = messages.findIndex(
          (entry) => entry.message.type === "assistant" && entry.message.time.completed === undefined,
        )
        const settled = unsettled === -1 ? messages : messages.slice(0, unsettled)
        const assembled = yield* InstructionState.preview(db, sessionID, instructions, observed)
        return {
          initial: assembled.initial,
          messages: settled.map((entry) => entry.message),
          instructionUpdate: assembled.update,
        }
      }),
    )
    .pipe(Effect.catch((error) => (error instanceof Instructions.InitializationBlocked ? error : Effect.die(error))))
})

/** Returns the session's first user message. */
export const firstUserMessage = Effect.fn("SessionHistory.firstUserMessage")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, sessionID), eq(SessionMessageTable.type, "user")))
    .orderBy(asc(SessionMessageTable.seq))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const message = yield* decodeMessageRow(row).pipe(Effect.orElseSucceed(() => undefined))
  return message?.type === "user" ? message : undefined
})

export * as SessionHistory from "./history.js"
