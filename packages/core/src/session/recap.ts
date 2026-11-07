export * as SessionRecap from "./recap.js"

import { body } from "@orbit/util/plain"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { and, desc, eq, inArray, sql } from "drizzle-orm"
import { Context, Duration, Effect, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SideQuery } from "../side-query.js"
import { NotFoundError } from "./error.js"
import { SessionEvent } from "./event.js"
import type { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"
import { SessionStore } from "./store.js"

/** How much of the conversation the recap model reads. */
const RECENT_MESSAGES = 30

// One terse paragraph, sent as the last user message with no system prompt. Session notes go before it once they exist.
const INSTRUCTION =
  "Someone has just returned to this conversation after a break. Help them pick it up again in one to three brief " +
  "sentences. Open with the larger goal of the work, described broadly (the thing being made or the fault being chased, " +
  "without implementation details), and then say what ought to happen next. Do not list progress or recount commits."

export interface Interface {
  /**
   * Writes the away summary for a person returning to the Session: one call on the side agent's model or the small
   * model, never the primary one, at most once per turn of the person's input. Returns the recorded text, or
   * `undefined` when nothing was recorded: a recap is already there, another request is writing one, there is no
   * input to recap, no small model, or the call failed. Interrupting it records nothing.
   */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<{ readonly text: string } | undefined, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionRecap") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const sideQuery = yield* SideQuery.Service
    const store = yield* SessionStore.Service
    // Sessions with a recap being written, so that two clients asking at once make one call.
    const writing = new Set<SessionSchema.ID>()

    // Only the person's own input starts a turn: a prompt or a `!` command. Notices, instruction updates, compactions
    // and model or agent switches do not, and neither does a prompt another agent wrote: a subagent's task is not a
    // conversation the person comes back to.
    const due = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const latest = yield* db
        .select({ type: SessionMessageTable.type })
        .from(SessionMessageTable)
        .where(
          and(
            eq(SessionMessageTable.session_id, sessionID),
            inArray(SessionMessageTable.type, ["user", "shell", "recap"]),
            sql`json_extract(${SessionMessageTable.data}, '$.metadata.origin') is not 'agent'`,
          ),
        )
        .orderBy(desc(SessionMessageTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return latest?.type === "user" || latest?.type === "shell"
    })

    const write = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      if (!(yield* due(sessionID))) return undefined
      const answer = yield* sideQuery
        .text({
          sessionID,
          purpose: "session.away_summary",
          system: "",
          prompt: INSTRUCTION,
          model: "small-only",
          history: { recent: RECENT_MESSAGES },
          cache: "none",
          // No deadline of its own: the client drops the request when the person comes back.
          timeout: Duration.infinity,
        })
        .pipe(Effect.orElseSucceed(() => undefined))
      if (!answer) return undefined
      // Model text drawn from repository content, so it is stored escaped and every reader gets the safe form.
      const text = body(answer.text.trim())
      yield* bus.publish(SessionEvent.RecapRecorded, { sessionID, text })
      return { text }
    })

    const generate: Interface["generate"] = Effect.fn("SessionRecap.generate")(function* (sessionID) {
      if (!(yield* store.get(sessionID))) return yield* new NotFoundError({ sessionID })
      if (writing.has(sessionID)) return undefined
      writing.add(sessionID)
      return yield* write(sessionID).pipe(Effect.ensuring(Effect.sync(() => writing.delete(sessionID))))
    })

    return Service.of({ generate })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, SessionStore.node, SideQuery.node],
})
