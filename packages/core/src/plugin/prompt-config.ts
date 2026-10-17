export * as PromptConfigPlugin from "./prompt-config.js"

import { define } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { Document, Entry } from "@orbit/schema/config"
import { Effect } from "effect"
import { Config } from "../config.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import { ShellTool } from "../tool/plugin/shell.js"
import type { PluginInternal } from "./internal.js"

export const DEFAULT_ATTRIBUTION = { commit: "Assisted-by: Orbit", pr: "Created with Orbit" } as const

/**
 * Appends the git and pull request guidance (`SessionSystemPrompt.renderGit`) to `system[0]` of every request that offers
 * the shell tool, for every agent, including subagents and agents with a system prompt of their own: the guidance goes
 * with the tool, not with the base prompt. Like `OptimizePlugin`, it covers `context`, `compaction` and `generate`, so
 * all of them carry the same `system[0]`. It runs after the model prompts, so the section follows whichever base was
 * chosen, and before the output style, which can drop the coding sections but not this one.
 *
 * `attribution.commit` and `attribution.pr` are read at each request and decided one by one by the highest-priority
 * config that sets them, so a project that sets only `pr` does not undo a user's `commit: ""`. An empty string is a
 * setting, not a gap.
 */
export const Plugin = define({
  id: "orbit.prompt.config",
  effect: Effect.fn("PromptConfigPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (!event.tools[ShellTool.name]) return
        const system = event.system[0]
        if (!system) return
        const attribution = yield* config.entries().pipe(
          Effect.map(resolveAttribution),
          // Without the settings, keep the guidance and write nothing the person may have switched off into history.
          Effect.catchCause((cause) =>
            Effect.logWarning("could not read the attribution settings", { cause }).pipe(
              Effect.as({ commit: "", pr: "" }),
            ),
          ),
        )
        event.system[0] = { ...system, text: `${system.text}\n\n${SessionSystemPrompt.renderGit(attribution)}` }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

export function resolveAttribution(entries: readonly Entry[]) {
  return {
    commit: field(entries, "commit"),
    pr: field(entries, "pr"),
  }
}

function field(entries: readonly Entry[], key: "commit" | "pr") {
  const document = entries.findLast(
    (entry): entry is Document => entry.type === "document" && entry.info.attribution?.[key] !== undefined,
  )
  return document?.info.attribution?.[key] ?? DEFAULT_ATTRIBUTION[key]
}
