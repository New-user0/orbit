export * as SubagentPromptPlugin from "./subagent-prompt.js"

import { define } from "@orbit/plugin/effect/plugin"
import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { Session } from "@orbit/schema/session"
import { Effect, Option } from "effect"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import { PromptConfigPlugin } from "./prompt-config.js"
import type { PluginInternal } from "./internal.js"

/**
 * Renders the base of `system[0]` from the tools the request offers after `PatchTool` has removed some, so the
 * guidance names only tools the agent has.
 *
 * - An agent with a prompt of its own gets its `${ORBIT_TOOL_GUIDANCE}` slot filled here, on root and child sessions
 *   alike, and the text around the slot is registered as the author's (`SessionSystemPrompt.personal`), which the
 *   PowerShell rename and the output style leave as written.
 * - A session runs as a subagent when it has a parent and is not a fork of the main thread
 *   (`PromptConfigPlugin.mainThread`), whatever its agent's `mode`. Without a prompt of its own it gets
 *   `runner/prompt/subagent.txt` instead of the main template, and every subagent then gets the reporting notes.
 * - A fork of the main thread keeps its parent's `system[0]`.
 */
export const Plugin = define({
  id: "orbit.prompt.subagent",
  effect: Effect.fn("SubagentPromptPlugin")(function* (ctx) {
    const reported = new Set<string>()
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const system = event.system[0]
        if (!system || PromptConfigPlugin.sideQuery(event)) return
        const agent = yield* ctx.agent.get({ agentID: event.agent })
        const child = yield* subagent(ctx, event.sessionID)
        const own = agent.data.system !== undefined && agent.data.system !== ""
        if (!own && !child) return
        const tools = Object.keys(event.tools)
        const base = own ? SessionSystemPrompt.render(system.text, tools) : SessionSystemPrompt.make(tools, { subagent: true })
        if (own)
          SessionSystemPrompt.personal.set(event, [
            ...(SessionSystemPrompt.personal.get(event) ?? []),
            ...PromptConfigPlugin.authorText(system.text, base).filter((piece) => piece !== ""),
          ])
        event.system[0] = { ...system, text: child ? `${base}\n\n${SessionSystemPrompt.SUBAGENT_REPORT}` : base }
      }).pipe(
        Effect.catch((error) => {
          const key = `${event.sessionID}:${event.agent}`
          if (reported.has(key)) return Effect.void
          reported.add(key)
          return Effect.logWarning("could not choose the base prompt of an agent", { agent: event.agent, error })
        }),
      )
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

const unreadable = new Set<string>()

/**
 * Whether a session runs as a subagent. A session that cannot be read is not one, so a request is never failed over it;
 * the main thread's prompt stays, and one log line per session says why.
 */
export const subagent = Effect.fn("SubagentPromptPlugin.subagent")(function* (
  ctx: Pick<Context, "session">,
  sessionID: Session.ID,
) {
  const main = yield* PromptConfigPlugin.mainThreadOf(ctx, sessionID)
  if (Option.isSome(main)) return !main.value
  if (!unreadable.has(sessionID)) {
    unreadable.add(sessionID)
    yield* Effect.logWarning("could not read the session to choose its base prompt", { sessionID })
  }
  return false
})
