export * as PlanMode from "./plan-mode.js"

import { Agent } from "@orbit/schema/agent"
import { Effect } from "effect"
import path from "path"
import type { SessionMessage } from "./session/message.js"
import type { SessionSchema } from "./session/schema.js"
import type { SessionStore } from "./session/store.js"

/** The agent a session runs as while it is in Plan mode. */
export const agent = Agent.ID.make("plan")

/**
 * The subagents Plan mode is limited to: they search and read. `allowedSubagents` is built from this list.
 *
 * "Read-only" is a property of these agents' built-in permissions, which user config can widen. Enforcement trusts the
 * id rather than an agent's effective permissions, so a config that widens one of these agents also widens what Plan
 * mode can do through it.
 */
export const readOnlyAgents: ReadonlySet<string> = new Set([Agent.ID.make("explore")])

/**
 * What a session running as the Plan agent may start as a subagent: the read-only agents, and Plan itself when config
 * lets it run as a subagent (it is a primary agent by default). `SubagentTool` admission refuses every other agent,
 * `general` (which can edit) included. It decides by the caller's identity, not by a permission rule: rules are
 * last-match, so a `* * allow` that config appends after the Plan agent's rules would reopen every agent.
 *
 * A Plan subagent runs under the Plan agent's own rules, so allowing it opens nothing the Plan agent cannot already do.
 */
export const allowedSubagents: ReadonlySet<string> = new Set([...readOnlyAgents, agent])

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
