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

    // The text that replaces the base, or undefined to keep the default prompt.
    const readFile = Effect.fn("PromptConfigPlugin.readFile")(function* (replacement: Replacement) {
      const read = yield* replacementText(fs, ctx.location.directory, replacement)
      if (read.failed !== undefined) {
        yield* warnOnce(read.file, read.failed)
        return undefined
      }
      if (read.file !== undefined) failing.delete(read.file)
      return read.text
    })

    const mainOf = (sessionID: Session.ID) =>
      mainThreadOf(ctx, sessionID).pipe(Effect.map((main) => Option.getOrElse(main, () => false)))

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const system = event.system[0]
        if (!system || sideQuery(event)) return
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
            const value = yield* readFile(keys.replacement)
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
/**
 * Whether a request is a side query (`SideQuery`): a one-shot request whose caller wrote the whole system text, such as
 * WebFetch's extraction instructions. The prompt plugins leave it exactly as written, whichever session, key or model
 * it comes from.
 */
export const sideQuery = (event: { agent: string }) => event.agent === "side"

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

/**
 * The replacement and appended text the config asks for. Only the person's own documents supply them: user (the
 * global and home config; a document with no scope counts as user), flag (`ORBIT_CONFIG` and `ORBIT_CONFIG_CONTENT`)
 * and managed. A project, local or remote document never does, trusted or not. The highest-priority one of those that
 * sets each key decides. Attribution is the other way round: every scope counts, and trust has already removed an
 * untrusted folder's value before it gets here.
 */
export function promptKeys(entries: readonly Entry[]) {
  const documents = entries.filter(
    (entry): entry is Document => entry.type === "document" && ["user", "flag", "managed"].includes(entry.scope ?? "user"),
  )
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

type Replacement = NonNullable<ReturnType<typeof promptKeys>["replacement"]>

/**
 * The text of a replacement: the value itself, or the file's text read as UTF-8 from the folder of the document that
 * names it (or `directory`, for a document without a path). A path on a network share, or one that reaches a share
 * through a link, is refused before any file system call (a share is a request to a host that a config chose); `failed`
 * then says why, as it does for a file that cannot be read. Resolving the path also turns a rooted NT spelling
 * (`\??\UNC\...`) into `<drive>:\??\...`, which cannot be opened as a share. An empty text replaces nothing.
 */
export const replacementText = Effect.fn("PromptConfigPlugin.replacementText")(function* (
  fs: FSUtil.Interface,
  directory: string,
  replacement: Replacement,
) {
  if (replacement.type === "text") return { text: replacement.value, file: undefined, failed: undefined }
  const value = replacement.value
  const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
  const base = replacement.document.path ? path.dirname(replacement.document.path) : directory
  const file = path.resolve(base, expanded)
  const relative = !path.isAbsolute(expanded)
  if (network(expanded) || network(file) || (relative && network(base)))
    return { text: undefined, file, failed: "network paths are not read" }
  if (yield* LinkShare.blocked(fs, file)) return { text: undefined, file, failed: "the path leads to a network share" }
  const text = yield* fs.readFileStringSafe(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (text === undefined) return { text: undefined, file, failed: "the file could not be read" }
  return { text, file, failed: undefined }
})

/**
 * Whether the config's replacement takes the place of Orbit's base prompt on the main thread for an agent that has no
 * prompt of its own, as the hook applies it: the agent is not a subagent's definition, and the replacement has text.
 */
export const replaces = Effect.fn("PromptConfigPlugin.replaces")(function* (
  fs: FSUtil.Interface,
  directory: string,
  entries: readonly Entry[],
  agent: { readonly mode?: string },
) {
  const replacement = promptKeys(entries).replacement
  if (replacement === undefined || agent.mode === "subagent") return false
  return Boolean((yield* replacementText(fs, directory, replacement)).text)
})

// A rooted `\??\` is the NT spelling of a device path. Two separators start a share (`\\host\share`, `//host/share`) or a device path (`\\?\UNC\`, `\\.\`).
const network = LinkShare.isShare
