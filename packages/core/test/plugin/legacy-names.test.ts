import { expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Agent } from "@orbit/core/agent"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginModule } from "@orbit/core/plugin/module"
import { PluginPromise } from "@orbit/core/plugin/promise"
import { Tool } from "@orbit/core/tool"
import { Session } from "@orbit/schema/session"
import { SessionMessage } from "@orbit/schema/session-message"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect } from "effect"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const base = {
  sessionID: Session.ID.make("ses_legacy_names"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_legacy_names"),
  id: Tool.CallID.make("call_legacy_names"),
}

// What a hook reports about each surface, and what it writes back: the name it was told, which the registry must read
// as the tool whichever spelling that was.
type Seen = { before?: string; after?: string; action?: string }

const hooked = (ctx: Context, seen: Seen) =>
  Effect.gen(function* () {
    yield* ctx.tool.hook("execute.before", (event) =>
      Effect.sync(() => {
        seen.before = event.tool
        event.tool = event.tool
      }),
    )
    yield* ctx.tool.hook("execute.after", (event) => Effect.sync(() => void (seen.after = event.tool)))
    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.sync(() => {
        seen.action = event.action
      }),
    )
  })

// The record a module-export plugin writes, because it is loaded from a file and shares no closure with the test.
const moduleSource = (log: string, toolNames: boolean) => `
import fs from "node:fs"
const write = (key, value) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify([key, value]) + "\\n")
export default {
  id: "legacy-names-module",
  ${toolNames ? 'toolNames: "reference",' : ""}
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      write("before", event.tool)
      event.tool = event.tool
    })
    await ctx.tool.hook("execute.after", (event) => write("after", event.tool))
    await ctx.permission.hook("evaluate", (event) => {
      write("action", event.action)
    })
  },
}
`

const kinds = [
  ["effect", false],
  ["effect", true],
  ["promise", false],
  ["promise", true],
  ["module export", false],
  ["module export", true],
] as const

for (const [kind, reference] of kinds)
  it.live(`a ${kind} plugin ${reference ? "that opts in to" : "written for"} the ${reference ? "reference" : "old"} names`, () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const seen: Seen = {}
      const toolNames = reference ? ({ toolNames: "reference" } as const) : {}
      if (kind === "effect")
        yield* plugins.activate([
          { id: "legacy-names-effect", revision: "1", ...toolNames, effect: (ctx) => hooked(ctx, seen) },
        ])
      if (kind === "promise")
        yield* plugins.activate([
          {
            ...PluginPromise.fromPromise({
              id: "legacy-names-promise",
              ...toolNames,
              async setup(ctx) {
                await ctx.tool.hook("execute.before", (event) => {
                  seen.before = event.tool
                  event.tool = event.tool
                })
                await ctx.tool.hook("execute.after", (event) => void (seen.after = event.tool))
                await ctx.permission.hook("evaluate", (event) => {
                  seen.action = event.action
                })
              },
            }),
            revision: "1",
          },
        ])
      const directory = (yield* tmpdirScoped()).path
      const log = path.join(directory, "log.jsonl")
      if (kind === "module export") {
        yield* Effect.promise(() => Bun.write(path.join(directory, "index.ts"), moduleSource(log, reference)))
        const loaded = yield* (yield* PluginModule.make()).load({ type: "add", target: directory, options: {} })
        if ("pending" in loaded) return yield* Effect.die(new Error("module did not load"))
        expect(loaded.toolNames).toBe(reference ? "reference" : undefined)
        yield* plugins.activate([loaded])
      }

      const before = yield* hooks.trigger("tool", "execute.before", { ...base, tool: "Bash", input: {} })
      yield* hooks.trigger("tool", "execute.after", {
        ...base,
        tool: "Write",
        input: {},
        status: "completed",
        result: { content: [] },
      } as never)
      const evaluated = yield* hooks.trigger("permission", "evaluate", {
        sessionID: base.sessionID,
        action: "Edit",
        resources: [],
        effect: "ask",
      })

      const reported =
        kind === "module export"
          ? Object.fromEntries(
              fs
                .readFileSync(log, "utf8")
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line) as [string, string]),
            )
          : seen
      // The hook is told the name it was written for, and the registry reads whatever it writes back as the tool.
      expect(reported).toEqual(
        reference
          ? { before: "Bash", after: "Write", action: "Edit" }
          : { before: "shell", after: "write", action: "edit" },
      )
      expect(before.tool).toBe("Bash")
      expect(evaluated.action).toBe("Edit")
    }),
  )
