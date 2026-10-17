export * as SessionScratchpad from "./scratchpad.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Global } from "@orbit/util/global"
import { plain } from "@orbit/util/plain"
import { and, eq, isNull, or } from "drizzle-orm"
import { Cause, Context, Effect, Layer, Schema, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Instructions } from "../instructions/index.js"
import { SessionAffinity } from "./affinity.js"
import { SessionEvent } from "./event.js"
import type { SessionSchema } from "./schema.js"
import { SessionTable } from "./sql.js"

type Lineage = Pick<SessionSchema.Info, "id" | "parentID" | "fork">

// A client chooses the ID of a session it creates, and the ID of the parent or the fork source it names, and the ID
// becomes the name of a folder here (class 5). So it names one only when it is `ses_` and plain letters, digits and
// underscores. That leaves out every separator, `..`, drive colon and trailing dot or space, and no Windows device name
// starts with `ses_`. A generated ID is `ses_` and 26 letters and digits.
const KEY = /^ses_[A-Za-z0-9_]{1,96}$/

/**
 * The name of the scratchpad folder that a session uses: the ID of the session its lineage goes back to, so a subagent
 * and a fork share the folder of the session they came from (`SessionAffinity`). Undefined when that ID cannot name a
 * folder, and such a session has no scratchpad.
 */
export const key = (session: Lineage): string | undefined => {
  const affinity = SessionAffinity.get(session)
  return KEY.test(affinity) ? affinity : undefined
}

export interface Interface {
  /** The folder of the session's scratchpad, or undefined when the session has none. It only works the path out. */
  readonly path: (session: Lineage) => string | undefined
  /**
   * The baseline section that names the folder. Reading it only works the path out, so a preview and a generation read
   * it without creating anything.
   */
  readonly source: (session: Lineage) => Instructions.List
  /**
   * Makes the folder if it is not there, closed to other users. A drain calls it once, before its first step. It never
   * fails: a session does not stop for a scratch folder, so a folder that cannot be made is logged, and the model finds
   * out when it writes there.
   */
  readonly ensure: (session: Lineage) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionScratchpad") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const global = yield* Global.Service
    const db = (yield* Database.Service).db
    const root = Agent.scratchpadRoot(global.tmp)

    const folder = (session: Lineage) => {
      const name = key(session)
      return name === undefined ? undefined : path.join(root, name)
    }

    const ensure = Effect.fn("SessionScratchpad.ensure")(function* (session: Lineage) {
      const directory = folder(session)
      if (directory === undefined)
        return yield* Effect.logWarning("session scratchpad skipped: the ID that would name its folder cannot", {
          // A client chose it, so the characters that act on a terminal are written out, and a long one is cut.
          id: plain(SessionAffinity.get(session)).slice(0, 100),
        })
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 })
        // `lstat` does not follow a link, so a link that stands where the folder should be is not taken for it: what
        // the model writes there would land wherever the link leads.
        return (await fs.lstat(directory)).isDirectory()
      }).pipe(
        Effect.flatMap((made) =>
          made ? Effect.void : Effect.logWarning("session scratchpad not used: the folder is a link", { directory }),
        ),
        Effect.catch((error) => Effect.logWarning("session scratchpad not created", { directory, error })),
      )
    })

    // A session's folder goes with it. Nothing is read from the folder and nothing is followed: a link is removed as a
    // link, never what it points to. A fork that is still there keeps using the folder of the session it came from, so
    // the folder stays until no session is left that uses it.
    const remove = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      if (!KEY.test(sessionID)) return
      const used = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(
          or(
            eq(SessionTable.parent_id, sessionID),
            and(isNull(SessionTable.parent_id), eq(SessionTable.fork_session_id, sessionID)),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (used) return
      yield* Effect.tryPromise(() => fs.rm(path.join(root, sessionID), { recursive: true, force: true }))
    })
    yield* bus.subscribe(SessionEvent.Deleted).pipe(
      Stream.runForEach((event) =>
        remove(event.data.sessionID).pipe(
          // A folder that stays is left to the temporary folder's cleaning. It never stops the next one from going.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logWarning("session scratchpad not removed", { sessionID: event.data.sessionID, cause }),
          ),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      path: folder,
      source: (session) =>
        Instructions.make({
          key: Instructions.Key.make("core/scratchpad"),
          codec: Schema.toCodecJson(Schema.String),
          read: Effect.sync(() => folder(session) ?? Instructions.removed),
          render: {
            initial: section,
            changed: (_previous, directory) =>
              [
                "Your scratchpad moved. Keep temporary files in the new folder from now on:",
                "",
                `\`${directory}\``,
              ].join("\n"),
          },
        }),
      ensure,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Database.node, Global.node] })

// Written for the model: where temporary files go, what the folder is for and whose it is. It makes no claim about approval, because Plan mode refuses edits.
function section(directory: string) {
  return [
    "# Scratchpad",
    "",
    "**ALL temporary files go in this session's scratchpad. Never use the system temp folder unless the user tells you to.**",
    "",
    `\`${directory}\``,
    "",
    "Use it for:",
    "- intermediate results of multi-step work",
    "- throwaway scripts and config files",
    "- notes and working files for analysis",
    "- any other file that only matters while the task runs",
    "",
    "Subagents of this session share the folder, and none of it lands in the user's project.",
  ].join("\n")
}
