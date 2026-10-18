export * as PlanPlugin from "./plan.js"

import { ToolFailure } from "@orbit/ai"
import { define } from "@orbit/plugin/effect/plugin"
import { Agent } from "../agent.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Effect } from "effect"
import path from "path"
import { Permission } from "../permission.js"
import { PlanMode } from "../plan-mode.js"
import { ToolNames } from "../tool/names.js"

const plan = PlanMode.agent

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
