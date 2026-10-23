export * as SessionRevert from "./revert.js"

import path from "path"
import { and, asc, eq, gt, lt } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import { ToolNames } from "@orbit/schema/tool-names"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { Instance } from "../instance/service.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { RelativePath } from "../schema.js"
import { Snapshot } from "../snapshot.js"
import { WorkspaceTrust } from "../workspace-trust.js"
import { SessionEvent } from "./event.js"
import { MessageNotFoundError, RewindError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

export { MessageNotFoundError, RewindError }

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  session: SessionSchema.Info
  messageID: SessionMessage.ID
  files?: boolean
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const original = input.session.revert?.snapshot
      ? Snapshot.ID.make(input.session.revert.snapshot)
      : yield* snapshot.capture()
    const planned = yield* plan(database.db, { sessionID: input.session.id, messageID: input.messageID })
    // Like a code-only rewind, the file half puts back only what the session's own file tools changed, and only the
    // paths git reports as different from the state before the revert: a stored name never becomes a path by itself.
    const next =
      input.files === false || !original || planned.size === 0
        ? new Map<RelativePath, Snapshot.ID>()
        : yield* toolEdits(database.db, input.session.id, planned, original)
    const restore = new Map<RelativePath, Snapshot.ID>()
    if (original) {
      for (const file of input.session.revert?.files ?? []) restore.set(RelativePath.make(file.file), original)
    }
    for (const [file, tree] of next) restore.set(file, tree)
    if (restore.size) yield* snapshot.restore({ files: restore })
    const paths = Array.from(next.keys())
    const files = original
      ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
      : []
    const revert = {
      messageID: input.messageID,
      snapshot: original,
      files,
    } satisfies SessionSchema.Info["revert"]
    yield* bus.publish(SessionEvent.RevertEvent.Staged, {
      sessionID: input.session.id,
      revert,
    })
    return revert
  }).pipe(instances.provide(input.session))
})

/**
 * Code-only rewind: puts the files that the session's own file tools changed back as they were when a prompt's work
 * began, and leaves the conversation as it is. The restore set is every path a recorded file-tool call named anywhere in
 * the session, kept only where git reports it as different between the prompt's checkpoint and a capture taken now; a
 * path absent from the checkpoint is removed. A dry run says what would change instead, and answers a rewind that cannot
 * happen with `canRewind: false`; a real run fails with `RewindError`. The folder must be trusted now: the rewind reads
 * its git and writes its files (class 1).
 */
export const files = Effect.fn("SessionRevert.files")(function* (input: {
  session: SessionSchema.Info
  messageID: SessionMessage.ID
  dryRun?: boolean
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service

  return yield* Effect.gen(function* () {
    const trust = yield* ProjectTrust.Service
    if (!(yield* trust.trusted())) {
      const status = yield* trust.status()
      return yield* new WorkspaceTrust.UntrustedError({ directory: status.directory, persistent: status.persistent })
    }
    const refuse = (reason: RewindError["reason"]) => {
      const error = new RewindError({ sessionID: input.session.id, messageID: input.messageID, reason })
      if (input.dryRun) return Effect.succeed({ canRewind: false, error: error.message } satisfies SessionSchema.RewindFiles)
      return Effect.fail(error)
    }
    const rows = yield* database.db
      .select({ id: SessionMessageTable.id, type: SessionMessageTable.type, seq: SessionMessageTable.seq })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.session_id, input.session.id))
      .orderBy(asc(SessionMessageTable.seq))
      .all()
      .pipe(Effect.orDie)
    const target = rows.find((row) => row.id === input.messageID)
    if (!target) return yield* new MessageNotFoundError({ sessionID: input.session.id, messageID: input.messageID })
    const snapshot = yield* Snapshot.Service
    const now = yield* snapshot.capture()
    if (!now) return yield* refuse("disabled")
    const checkpoint = target.type === "user" ? yield* checkpointOf(database.db, rows, target.seq) : undefined
    if (!checkpoint) return yield* refuse("no-checkpoint")
    return yield* Effect.gen(function* () {
      const names = yield* toolNames(database.db, input.session.id)
      const changed = (yield* snapshot.files({ from: checkpoint, to: now })).filter((file) => names.has(file))
      if (!input.dryRun) {
        if (changed.length > 0)
          yield* snapshot.restore({ files: new Map(changed.map((file) => [file, checkpoint] as const)) })
        return { canRewind: true } satisfies SessionSchema.RewindFiles
      }
      const worktree = yield* snapshot.root()
      // Compared from now to the checkpoint, so additions are the lines the rewind would add back.
      const diffs = yield* snapshot.diff({ from: now, to: checkpoint, paths: changed, context: 0 })
      return {
        canRewind: true,
        filesChanged: diffs.map((file) => path.join(worktree, file.file)),
        insertions: diffs.reduce((total, file) => total + file.additions, 0),
        deletions: diffs.reduce((total, file) => total + file.deletions, 0),
      } satisfies SessionSchema.RewindFiles
    }).pipe(
      Effect.catchTag("Snapshot.Error", (cause) =>
        Effect.logError("code rewind failed", { cause }).pipe(Effect.andThen(refuse("failed"))),
      ),
    )
  }).pipe(instances.provide(input.session))
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  const instances = yield* Instance.Service
  const bus = yield* Bus.Service
  yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    if (!session.revert) return
    const original = session.revert.snapshot ? Snapshot.ID.make(session.revert.snapshot) : undefined
    if (original)
      yield* snapshot.restore({
        files: new Map((session.revert.files ?? []).map((file) => [RelativePath.make(file.file), original])),
      })
    yield* bus.publish(SessionEvent.RevertEvent.Cleared, {
      sessionID: session.id,
    })
  }).pipe(instances.provide(session))
})

export const commit = Effect.fn("SessionRevert.commit")(function* (bus: Bus.Interface, session: SessionSchema.Info) {
  if (!session.revert) return
  yield* bus.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    to: session.revert.messageID,
  })
})

const plan = Effect.fn("SessionRevert.plan")(function* (db: Database.Interface["db"], input: BoundaryInput) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const decode = Schema.decodeUnknownEffect(SessionMessage.Info)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, Snapshot.ID.make(message.snapshot.start))
  }
  return files
})

// The paths of `planned` that a file tool named and that differ between their tree and the state before the revert.
const toolEdits = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  planned: ReadonlyMap<RelativePath, Snapshot.ID>,
  original: Snapshot.ID,
) {
  const snapshot = yield* Snapshot.Service
  const names = yield* toolNames(db, sessionID)
  const trees = yield* Effect.forEach(new Set(planned.values()), (tree) =>
    snapshot.files({ from: tree, to: original }).pipe(Effect.map((changed) => [tree, new Set(changed)] as const)),
  )
  const differs = new Map(trees)
  return new Map(
    Array.from(planned).filter(([file, tree]) => names.has(file) && differs.get(tree)?.has(file)),
  )
})

/**
 * A prompt's checkpoint: the start snapshot of the first step recorded after it, before the next prompt. A step that
 * recorded none, or a location switch after it (its tree lives in another folder's repository), leaves the prompt
 * without one.
 */
const checkpointOf = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  rows: ReadonlyArray<{ readonly id: SessionMessage.ID; readonly type: string; readonly seq: number }>,
  seq: number,
) {
  const after = rows.filter((row) => row.seq > seq)
  const step = after.find((row) => row.type === "assistant" || row.type === "user")
  if (step?.type !== "assistant") return undefined
  if (after.some((row) => row.type === "location-switched" && row.seq > step.seq)) return undefined
  const stored = yield* db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, step.id))
    .get()
    .pipe(Effect.orDie)
  const start = Option.getOrUndefined(decodeCheckpoint(stored?.data))?.snapshot?.start
  return start !== undefined && Snapshot.isTree(start) ? Snapshot.ID.make(start) : undefined
})

const decodeCheckpoint = Schema.decodeUnknownOption(
  Schema.Struct({ snapshot: Schema.optional(Schema.Struct({ start: Schema.optional(Schema.String) })) }),
)

// The tools whose recorded calls name the files they changed, in `metadata.files[].file` and a move's `from`.
const fileTools = new Set(["Edit", "Write", "Patch", "NotebookEdit"])
const decodeCall = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("tool"),
    name: Schema.String,
    state: Schema.Struct({
      status: Schema.Literals(["completed", "error"]),
      metadata: Schema.Struct({ files: Schema.Array(Schema.Unknown) }),
    }),
  }),
)
const decodeFile = Schema.decodeUnknownOption(
  Schema.Struct({ file: Schema.String, from: Schema.optional(Schema.String) }),
)
const decodeContent = Schema.decodeUnknownOption(Schema.Struct({ content: Schema.Array(Schema.Unknown) }))

/**
 * Every path a recorded file-tool call of the session named, relative to the snapshot's work tree: in the whole session,
 * or in the steps between two message sequence numbers. A call names its files by the Location's spelling, so each name
 * is joined under the Location's folder; a name that leaves the work tree is ignored, and so is a malformed entry, which
 * costs only itself (class 7).
 */
export const toolNames = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  range?: { readonly after: number; readonly before?: number },
) {
  const location = yield* Location.Service
  const snapshot = yield* Snapshot.Service
  const prefix = path.relative(yield* snapshot.root(), location.directory).replaceAll("\\", "/")
  const rows = yield* db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "assistant"),
        range ? gt(SessionMessageTable.seq, range.after) : undefined,
        range?.before === undefined ? undefined : lt(SessionMessageTable.seq, range.before),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const names = rows
    .flatMap((row) => Option.toArray(decodeContent(row.data)).flatMap((message) => message.content))
    .flatMap((part) => Option.toArray(decodeCall(part)))
    .filter((call) => fileTools.has(ToolNames.canonical(call.name)))
    .flatMap((call) => call.state.metadata.files.flatMap((entry) => Option.toArray(decodeFile(entry))))
    .flatMap((entry) => (entry.from === undefined ? [entry.file] : [entry.file, entry.from]))
    .flatMap((name) => worktreeName(prefix, name) ?? [])
  return new Set(names)
})

function worktreeName(prefix: string, name: string) {
  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /[:\0]/.test(name)) return undefined
  const joined = path.posix.normalize(path.posix.join(prefix, name.replaceAll("\\", "/")))
  if (joined === "." || joined === ".." || joined.startsWith("../")) return undefined
  return RelativePath.make(joined)
}
