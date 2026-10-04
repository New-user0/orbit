export * as PlanMode from "./plan-mode.js"

import { Agent } from "@orbit/schema/agent"
import { Effect } from "effect"
import path from "path"
import type { SessionMessage } from "./session/message.js"
import type { SessionSchema } from "./session/schema.js"
import type { SessionStore } from "./session/store.js"

/** The agent a session runs as while it is in Plan mode. */
export const agent = Agent.ID.make("plan")

/** Subagents Plan mode may start: they search and read, and cannot change anything. */
export const readOnlyAgents: ReadonlySet<string> = new Set([Agent.ID.make("explore")])

/** Where Plan mode saves plans. It is the only place the plan agent may edit. */
export const directory = (home: string) => path.join(home, ".orbit", "plan")

/**
 * The agent a session was using when it last entered Plan mode, so approving a plan can switch back to it.
 * It is read from the durable `agent-switched` history, which survives a restart. Undefined when the history has no
 * entry into Plan mode (the session started there) or the session had no agent selected when it entered; callers fall
 * back to the default agent.
 *
 * Takes anything that lists session messages, so both `SessionStore` and `Session` work.
 */
export const previousAgent = Effect.fn("PlanMode.previousAgent")(function* <E>(
  store: { readonly messages: (input: SessionStore.MessagesInput) => Effect.Effect<SessionMessage.Info[], E> },
  sessionID: SessionSchema.ID,
) {
  const switches = yield* store.messages({ sessionID, type: "agent-switched", order: "desc" })
  // Selecting Plan while already in it records plan -> plan, which says nothing about where to return to.
  return switches.find(
    (message): message is SessionMessage.AgentSelected =>
      message.type === "agent-switched" && message.agent === agent && message.previous !== agent,
  )?.previous
})
