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
 * A subagent's base prompt. A session runs as a subagent when it has a parent and is not a fork of the main thread
 * (`PromptConfigPlugin.mainThread`), whatever its agent's `mode`, so an agent in `all` mode gets this base as a child and the main one as a
 * root session. An agent with no prompt of its own gets `runner/prompt/subagent.txt`
 * instead of the main template, rendered here from the tools the request offers after `PatchTool` has removed some, so
 * the guidance names only tools the subagent has. Every subagent, its own prompt or not, then gets the reporting notes.
 * A fork of the main thread keeps its parent's `system[0]` unchanged.
 */
export const Plugin = define({
  id: "orbit.prompt.subagent",
  effect: Effect.fn("SubagentPromptPlugin")(function* (ctx) {
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const system = event.system[0]
        if (!system) return
        if (!(yield* subagent(ctx, event.sessionID))) return
        const agent = yield* ctx.agent.get({ agentID: event.agent })
        const base = agent.data.system
          ? system.text
          : SessionSystemPrompt.make(Object.keys(event.tools), { subagent: true })
        event.system[0] = { ...system, text: `${base}\n\n${SessionSystemPrompt.SUBAGENT_REPORT}` }
      }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

/**
 * Whether a session runs as a subagent. A session that cannot be read is not one, so a request is never failed over it;
 * the main thread's prompt stays, and one log line says why.
 */
export const subagent = Effect.fn("SubagentPromptPlugin.subagent")(function* (
  ctx: Pick<Context, "session">,
  sessionID: Session.ID,
) {
  const read = (id: Session.ID) =>
    ctx.session.get({ sessionID: id }).pipe(
      Effect.option,
      Effect.catchDefect((defect) =>
        Effect.logWarning("could not read the session to choose its base prompt", { sessionID: id, defect }).pipe(
          Effect.as(Option.none()),
        ),
      ),
    )
  const session = yield* read(sessionID)
  if (Option.isNone(session)) return false
  if (!session.value.fork) return !PromptConfigPlugin.mainThread(session.value)
  const source = yield* read(session.value.fork.sessionID)
  return !PromptConfigPlugin.mainThread(session.value, Option.getOrUndefined(source))
})
