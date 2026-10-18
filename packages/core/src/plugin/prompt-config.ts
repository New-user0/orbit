export * as PromptConfigPlugin from "./prompt-config.js"

import os from "os"
import path from "path"
import { define } from "@orbit/plugin/effect/plugin"
import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import type { Document, Entry } from "@orbit/schema/config"
import type { Session } from "@orbit/schema/session"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { Effect, Option } from "effect"
import { Config } from "../config.js"
import { SessionSystemPrompt } from "../session/system-prompt.js"
import { ShellTool } from "../tool/plugin/shell.js"
import type { PluginInternal } from "./internal.js"

import CORE_RULES from "./system-prompt/core-rules.txt"

export const DEFAULT_ATTRIBUTION = { commit: "Assisted-by: Orbit", pr: "Created with Orbit" } as const

export const GUIDANCE_SLOT = "${ORBIT_TOOL_GUIDANCE}"

/**
 * Builds `system[0]` after the model prompts, for `context`, `compaction` and `generate` alike, so every request of a
 * session carries the same text:
 *
 * 1. The `system_prompt` or `system_prompt_file` config replaces the base, the model overlay included, and is followed by
 *    the core rules. It applies on the main thread (`mainThread`) when the session's agent has no system prompt of its
 *    own and is not a subagent; otherwise the skipped replacement is logged once per session and agent.
 * 2. The git and pull request guidance (`SessionSystemPrompt.renderGit`), when the shell tool is offered, for every agent:
 *    the guidance goes with the tool, not with the base prompt.
 * 3. The `append_system_prompt` text, on the main thread, whichever base was chosen.
 *
 * The output style follows, in its own plugin. The text of the two prompt keys is registered as `personal`, so that the
 * style does not cut its sections and the PowerShell rename does not touch its words.
 *
 * The highest-priority document that sets either replacement key decides, and so does the one that sets the appended
 * text; an empty string is unset. The file is read at each request, as UTF-8. A path on a network share is refused
 * before any file system call, and so is a path that reaches one through a link. A file that cannot be read keeps the
 * default prompt and logs one warning per path, again only after a read of that path has succeeded.
 *
 * `attribution.commit` and `attribution.pr` are read at each request and decided one by one by the highest-priority
 * config that sets them, so a project that sets only `pr` does not undo a user's `commit: ""`. An empty string is a
 * setting, not a gap.
 */
export const Plugin = define({
  id: "orbit.prompt.config",
  effect: Effect.fn("PromptConfigPlugin")(function* (ctx) {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const failing = new Set<string>()
    const skipped = new Set<string>()

    const warnOnce = (file: string, reason: string) =>
      failing.has(file)
        ? Effect.void
        : Effect.suspend(() => {
            failing.add(file)
            return Effect.logWarning("system_prompt_file not used", { file, reason })
          })

    // The text of the file, or undefined to keep the default prompt.
    const readFile = Effect.fn("PromptConfigPlugin.readFile")(function* (document: Document, value: string) {
      const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
      const base = document.path ? path.dirname(document.path) : ctx.location.directory
      // Resolving also turns a rooted NT spelling (`\??\UNC\...`) into `<drive>:\??\...`, which cannot be opened as a share.
      const resolved = path.resolve(base, expanded)
      // Before any file system call: a share is a request to a host that a config chose.
      const relative = !path.isAbsolute(expanded)
      if (network(expanded) || network(resolved) || (relative && network(base))) {
        yield* warnOnce(resolved, "network paths are not read")
        return undefined
      }
      if (yield* LinkShare.blocked(fs, resolved)) {
        yield* warnOnce(resolved, "the path leads to a network share")
        return undefined
      }
      const text = yield* fs.readFileStringSafe(resolved).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (text === undefined) {
        yield* warnOnce(resolved, "the file could not be read")
        return undefined
      }
      failing.delete(resolved)
      return text
    })

    const mainOf = (sessionID: Session.ID) =>
      mainThreadOf(ctx, sessionID).pipe(Effect.map((main) => Option.getOrElse(main, () => false)))

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const system = event.system[0]
        if (!system) return
        const entries = yield* config.entries().pipe(
          // Without the settings, keep the guidance and write nothing the person may have switched off into history.
          Effect.catchCause((cause) =>
            Effect.logWarning("could not read the attribution settings", { cause }).pipe(Effect.as(undefined)),
          ),
        )
        const attribution = entries ? resolveAttribution(entries) : { commit: "", pr: "" }
        const keys = promptKeys(entries ?? [])
        const main = keys.replacement || keys.append ? yield* mainOf(event.sessionID) : false

        const pieces: string[] = []
        let text = system.text

        if (main && keys.replacement) {
          const agent = yield* ctx.agent.get({ agentID: event.agent }).pipe(
            Effect.map((found) => found.data),
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!agent || agent.system || agent.mode === "subagent") {
            const key = `${event.sessionID}:${event.agent}`
            if (!skipped.has(key)) {
              skipped.add(key)
              yield* Effect.logInfo("system prompt replacement skipped for this agent", { agent: event.agent })
            }
          } else {
            const value =
              keys.replacement.type === "text"
                ? keys.replacement.value
                : yield* readFile(keys.replacement.document, keys.replacement.value)
            if (value) {
              const rendered = SessionSystemPrompt.render(value, Object.keys(event.tools))
              pieces.push(...authorText(value, rendered))
              text = `${rendered}\n\n${CORE_RULES}`
            }
          }
        }

        if (event.tools[ShellTool.name]) text = `${text}\n\n${SessionSystemPrompt.renderGit(attribution)}`

        if (main && keys.append) {
          pieces.push(keys.append)
          text = `${text}\n\n${keys.append}`
        }

        const personal = pieces.filter((piece) => piece !== "")
        // The prompt of an agent registers its author's text first (`SubagentPromptPlugin`): add to it.
        if (personal.length)
          SessionSystemPrompt.personal.set(event, [...(SessionSystemPrompt.personal.get(event) ?? []), ...personal])
        if (text !== system.text) event.system[0] = { ...system, text }
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
} satisfies PluginInternal.InternalPlugin)

/**
 * Whether a session is the main thread (`mainThread`), or none when it cannot be read, so each caller picks its own
 * answer: the prompt keys then do not apply, and the session is not taken for a subagent.
 */
export const mainThreadOf = Effect.fn("PromptConfigPlugin.mainThreadOf")(function* (
  ctx: Pick<Context, "session">,
  sessionID: Session.ID,
) {
  const session = yield* ctx.session.get({ sessionID }).pipe(Effect.option)
  if (Option.isNone(session)) return Option.none<boolean>()
  if (!session.value.fork) return Option.some(mainThread(session.value))
  const source = yield* ctx.session.get({ sessionID: session.value.fork.sessionID }).pipe(Effect.option)
  return Option.some(mainThread(session.value, Option.getOrUndefined(source)))
})

/**
 * The words of a prompt that are its author's and not Orbit's: the text on each side of the guidance slot, or all of
 * it when there is no slot. `rendered` is `value` with the slot filled; the lines it added are Orbit's.
 */
export function authorText(value: string, rendered: string) {
  const slot = value.indexOf(GUIDANCE_SLOT)
  if (slot < 0) return [rendered]
  return [rendered.slice(0, slot), rendered.slice(rendered.length - (value.length - slot - GUIDANCE_SLOT.length))]
}

/**
 * Whether the config's system prompt keys apply to a session: it has no parent, or it is a fork whose source has no
 * parent. A fork child keeps its parent's agent and so renders its parent's `system[0]`, which keeps the provider cache.
 * A subagent, and a fork of a subagent, keep their own prompt. A fork whose source was deleted is a fresh main
 * conversation (it has no parent), so it keeps the keys and `system[0]` does not change mid-conversation.
 */
export function mainThread(session: Pick<Session.Info, "parentID" | "fork">, source?: Pick<Session.Info, "parentID">) {
  if (session.fork && source) return !source.parentID
  return !session.parentID
}

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

/** The replacement and appended text the config asks for: the highest-priority document that sets each decides. */
export function promptKeys(entries: readonly Entry[]) {
  const documents = entries.filter((entry): entry is Document => entry.type === "document")
  const replacing = documents.findLast((document) => document.info.system_prompt || document.info.system_prompt_file)
  const replacement = !replacing
    ? undefined
    : replacing.info.system_prompt
      ? ({ type: "text", value: replacing.info.system_prompt } as const)
      : ({ type: "file", value: replacing.info.system_prompt_file!, document: replacing } as const)
  return {
    replacement,
    append: documents.findLast((document) => document.info.append_system_prompt)?.info.append_system_prompt,
  }
}

// A rooted `\??\` is the NT spelling of a device path. Two separators start a share (`\\host\share`, `//host/share`) or a device path (`\\?\UNC\`, `\\.\`).
const network = LinkShare.isShare
