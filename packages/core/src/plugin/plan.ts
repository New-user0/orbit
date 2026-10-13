export * as PlanPlugin from "./plan.js"

import { Message, ToolFailure } from "@orbit/ai"
import { define } from "@orbit/plugin/effect/plugin"
import { Agent } from "../agent.js"
import type { SessionEvent } from "@orbit/schema/session-event"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Effect, Stream } from "effect"
import path from "path"
import { Permission } from "../permission.js"
import { PlanMode } from "../plan-mode.js"
import { ToolNames } from "../tool/names.js"

const plan = PlanMode.agent

const enter = (directory: string) => `<system-reminder>
You are in Plan mode. Discuss the plan with the user directly in the conversation. Do not create or update plan files unless the user explicitly asks you to; when they do, write them only in:
${directory}

Do not modify any other files or ask a subagent to do so.

You remain in Plan mode until the user switches agents or approves your plan. When the plan is ready, call ExitPlanMode with it so the user can approve it. If the user asks you to implement changes before approving a plan, do not do so; present the plan instead.
</system-reminder>`

const leave = `<system-reminder>
You are NO LONGER in Plan mode. The previous Plan restrictions no longer apply. Any Plan mode instructions from earlier in this conversation are no longer active.
</system-reminder>`

export const Plugin = define({
  id: "orbit.plan",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const directory = PlanMode.directory(global.home)
    // Deny and ask rules are decided by where a path really leads, so when a link is part of the plan folder's path
    // (a linked home or ~/.orbit) the allow is also written for that real place.
    const real = yield* realFolder(fs, directory)
    const folders = real === path.resolve(directory) ? [directory] : [directory, real]
    const enterReminder = enter(directory)
    yield* ctx.agent.transform((editor) => {
      editor.update(plan, (item) => {
        item.name = Agent.Name.make("Plan")
        item.description = "Read-only agent for exploring the codebase and planning work before implementation."
        item.mode = "primary"
        item.permissions.push({ action: "AskUserQuestion", resource: "*", effect: "allow" })
        item.permissions.push(Agent.modeRule({ action: "Edit", resource: "*", effect: "deny" as const }))
        // Shell commands can change files too, so in Plan mode each one needs the user's approval.
        item.permissions.push({ action: "Bash", resource: "*", effect: "ask" })
        folders.forEach((folder) => {
          item.permissions.push({ action: "Edit", resource: path.join(folder, "*"), effect: "allow" })
          item.permissions.push({ action: "external_directory", resource: path.join(folder, "*"), effect: "allow" })
        })
      })
    })

    yield* ctx.tool.hook("execute.after", (event) => {
      if (event.agent !== plan) return Effect.void
      if (event.status !== "error") return Effect.void
      if (!["Edit", "Write", "Patch"].includes(ToolNames.canonical(event.tool))) return Effect.void
      if (!(event.error.error instanceof Permission.BlockedError)) return Effect.void
      event.error = new ToolFailure({
        message: `Cannot use ${event.tool} to modify files outside the Plan directory: ${directory}`,
      })
      return Effect.void
    })

    // Compaction and committed reverts can strip reminders while the session's agent stays
    // put. Reconcile per request, appending near the tail so the cached prefix stays warm.
    yield* ctx.session.hook("context", (event) => {
      const reminder = lastReminder(event.messages, enterReminder)
      const missing = event.agent === plan && reminder !== enterReminder
      const stale = event.agent !== plan && reminder === enterReminder
      const text = missing ? enterReminder : stale ? leave : undefined
      if (!text) return Effect.void
      // Before the user's prompt, matching where agent-switch reminders land.
      const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
      event.messages.splice(at, 0, Message.user(text))
      return ctx.session
        .synthetic({ sessionID: event.sessionID, text, resume: false })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to persist Plan mode reminder", { sessionID: event.sessionID, cause }),
          ),
        )
    })

    yield* ctx.event.subscribe().pipe(
      Stream.filter(
        (event): event is SessionEvent.Created | SessionEvent.AgentSelected =>
          event.type === "session.created" || event.type === "session.agent.selected",
      ),
      Stream.runForEach((event) => {
        const text = switchReminder(event, enterReminder)
        if (!text) return Effect.void
        return ctx.session
          .synthetic({
            sessionID: event.data.sessionID,
            text,
            resume: false,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to inject Plan mode reminder", { sessionID: event.data.sessionID, cause }),
            ),
          )
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
})

// The folder with the links of its path followed. The folder may not exist yet, so the nearest part that does is
// resolved and the rest is appended.
const realFolder: (fs: FSUtil.Interface, folder: string) => Effect.Effect<string> = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  folder: string,
) {
  const lexical = path.resolve(folder)
  const resolved = yield* fs.resolve(lexical)
  if (resolved !== lexical) return resolved
  const parent = path.dirname(lexical)
  if (parent === lexical) return lexical
  return path.join(yield* realFolder(fs, parent), path.basename(lexical))
})

function switchReminder(
  event: SessionEvent.Created | SessionEvent.AgentSelected,
  enterReminder: string,
): string | undefined {
  if (event.type === "session.created") {
    if (event.data.agent !== plan) return undefined
    return enterReminder
  }
  if (event.data.agent === event.data.previous) return undefined
  if (event.data.agent === plan) return enterReminder
  if (event.data.previous === plan) return leave
  return undefined
}

function lastReminder(messages: ReadonlyArray<Message>, enterReminder: string) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    return part.text === enterReminder || part.text === leave ? part.text : found
  }, undefined)
}
