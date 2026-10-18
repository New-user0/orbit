export * as VcsInstructions from "./instructions.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Trust } from "@orbit/schema/trust"
import { Context, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { Bus } from "../bus.js"
import { Config } from "../config.js"
import { Database } from "../database/database.js"
import { Git } from "../git.js"
import { Instructions } from "../instructions/index.js"
import { ReminderText } from "../session/reminder-text.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { AbsolutePath } from "../schema.js"
import { InstructionState } from "../session/instruction-state.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"

export const key = Instructions.Key.make("core/vcs-snapshot")

/** Characters of status the model is shown; longer output is cut here and says so. */
export const STATUS_LIMIT = 2_000
const COMMITS = 5
// Room for STATUS_LIMIT characters at up to four bytes each, with plenty over.
const STATUS_BYTES = 64 * 1024
// Bounds one capture, as the reference bounds each of its commands; a timeout is treated like a failed status.
const CAPTURE_TIMEOUT = "10 minutes"

export const Snapshot = Schema.Struct({
  branch: Schema.String,
  main: Schema.String,
  /** Empty when git has no `user.name`. */
  user: Schema.String,
  /** Already cut to STATUS_LIMIT characters. */
  status: Schema.String,
  truncated: Schema.Boolean,
  commits: Schema.Array(Schema.String),
  /** False when taken before the session had any instruction state, true when taken partway through it. */
  late: Schema.Boolean,
})
export type Snapshot = typeof Snapshot.Type

type Lineage = Pick<SessionSchema.Info, "id" | "parentID">

export interface Interface {
  /**
   * The snapshot of the repository for one session, captured once. It starts no git while the folder is untrusted
   * (class 1) and is removed from a session that held one when trust is taken away. A session that already holds a
   * snapshot reads `unavailable`, so the stored value stands; this source can therefore never block initialization.
   */
  readonly source: (session: Lineage, options?: { readonly enabled?: boolean }) => Instructions.List
}

export class Service extends Context.Service<Service, Interface>()("@orbit/VcsInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const db = (yield* Database.Service).db
    const git = yield* Git.Service
    const location = yield* Location.Service
    const store = yield* SessionStore.Service
    const trust = yield* ProjectTrust.Service
    const directory = AbsolutePath.make(location.directory)

    // What this process already captured for a session since trust last changed. A preview and the admission that follows
    // it share one snapshot, and a repository that fails does not run git again at every step.
    // The capture runs in a fiber of the layer, not of the reader, so a reader that is interrupted (a stopped step, a
    // dropped preview, a failing sibling source) does not leave an interrupt behind for every later step.
    const scope = yield* Effect.scope
    const memo = new Map<string, Fiber.Fiber<Snapshot | Instructions.Removed>>()
    yield* bus.subscribe(Trust.Event.Updated).pipe(
      Stream.runForEach(() => Effect.sync(() => memo.clear())),
      Effect.forkScoped({ startImmediately: true }),
    )

    const capture = Effect.fn("VcsInstructions.capture")(function* (late: boolean) {
      const status = yield* git.status.short(directory, STATUS_BYTES).pipe(
        Effect.map((text) => text.replace(/[\r\n]+$/, "")),
        Effect.catch((error) =>
          Effect.logWarning("git snapshot skipped: git status failed", { directory, error: error.message }).pipe(
            Effect.as(undefined),
          ),
        ),
      )
      if (status === undefined) return Instructions.removed
      const [branch, main, user, commits] = yield* Effect.all(
        [
          git.history.current(directory),
          git.history.mainBranch(directory),
          git.history.userName(directory),
          git.history.recent(directory, COMMITS),
        ],
        { concurrency: "unbounded" },
      )
      const cut = cutStatus(status)
      return { branch: branch ?? "HEAD", main, user: user ?? "", ...cut, commits, late } satisfies Snapshot
    })

    const read = Effect.fn("VcsInstructions.read")(function* (session: Lineage, enabled: boolean) {
      // The session's agent leaves the snapshot out (`context.git_status`): no git runs and the parent's snapshot is not reused.
      if (!enabled) return Instructions.removed
      // Asked before anything else, and at every read, so that a revoke takes effect at the next step (class 1).
      if (!(yield* trust.trusted())) return Instructions.removed
      if (Config.latest(yield* config.entries(), "git_status") === false) return Instructions.removed
      if (location.vcs?.type !== "git") return Instructions.removed

      const stored = yield* InstructionState.current(db, session.id)
      if (stored?.[key] !== undefined) {
        memo.delete(session.id)
        return Instructions.unavailable
      }

      // A subagent sees its parent's snapshot, as it does the parent's other instructions.
      const parent = session.parentID === undefined ? undefined : yield* store.get(session.parentID)
      if (parent && parent.location.directory === location.directory) {
        const inherited = yield* InstructionState.value(db, parent.id, key)
        if (inherited !== undefined) {
          // A parent value that no longer matches the schema costs only itself: this session captures its own.
          const decoded = Schema.decodeUnknownOption(Snapshot)(inherited)
          if (Option.isSome(decoded)) return decoded.value
          yield* Effect.logWarning("git snapshot of the parent session ignored: it does not match the schema", {
            sessionID: parent.id,
          })
        }
      }

      const running =
        memo.get(session.id) ??
        (yield* capture(stored !== undefined).pipe(
          Effect.timeoutOption(CAPTURE_TIMEOUT),
          Effect.flatMap((result) =>
            Option.isSome(result)
              ? Effect.succeed(result.value)
              : Effect.logWarning("git snapshot skipped: git took too long", { directory }).pipe(
                  Effect.as(Instructions.removed),
                ),
          ),
          Effect.withSpan("VcsInstructions.capture"),
          Effect.forkIn(scope),
          Effect.tap((fiber) => Effect.sync(() => memo.set(session.id, fiber))),
        ))
      return yield* Fiber.join(running)
    })

    return Service.of({
      source: (session, options) =>
        Instructions.make({
          key,
          codec: Schema.toCodecJson(Snapshot),
          read: read(session, options?.enabled !== false),
          render: {
            initial: render,
            changed: (_previous, current) => `The git snapshot was replaced by a newer one.\n\n${render(current)}`,
            removed: () =>
              "The git snapshot given earlier no longer applies. Do not rely on the repository state it described.",
          },
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Config.node, Database.node, Git.node, Location.node, ProjectTrust.node, SessionStore.node],
})

/** Cuts status at STATUS_LIMIT UTF-16 units, never between the halves of a surrogate pair. */
export function cutStatus(text: string) {
  if (text.length <= STATUS_LIMIT) return { status: text, truncated: false }
  const last = text.charCodeAt(STATUS_LIMIT - 1)
  const end = last >= 0xd800 && last <= 0xdbff ? STATUS_LIMIT - 1 : STATUS_LIMIT
  return { status: text.slice(0, end), truncated: true }
}

// Written for the model: the facts of the repository when the session began, in plain lines with no instructions.
// Branch names, the user, status lines and commit subjects come from the repository, so a look-alike of a reminder tag
// in them is escaped.
export function render(snapshot: Snapshot) {
  return ReminderText.neutralize(lines(snapshot))
}

function lines(snapshot: Snapshot) {
  return [
    snapshot.late
      ? "This is the state of the git repository, captured partway through the session rather than at its start, for example once the folder was trusted. It is a snapshot and is not updated as the work goes on."
      : "This is the state of the git repository when the session began. It is a snapshot and is not updated as the work goes on.",
    `Current branch: ${snapshot.branch}`,
    `Main branch (pull requests usually target this branch): ${snapshot.main}`,
    ...(snapshot.user === "" ? [] : [`Git user: ${snapshot.user}`]),
    [
      "Status:",
      snapshot.status === "" ? "(clean)" : snapshot.status,
      ...(snapshot.truncated
        ? [
            `... (the status is longer than ${STATUS_LIMIT.toLocaleString("en-US")} characters and was cut here; run git status in the shell tool to see the rest)`,
          ]
        : []),
    ].join("\n"),
    ["Recent commits:", ...snapshot.commits].join("\n"),
  ].join("\n\n")
}
