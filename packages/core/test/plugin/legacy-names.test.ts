import { expect } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { Agent } from "@orbit/core/agent"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginModule } from "@orbit/core/plugin/module"
import { PluginPromise } from "@orbit/core/plugin/promise"
import { Tool } from "@orbit/core/tool"
import { ToolInputRepairPlugin } from "@orbit/core/plugin/tool-input-repair"
import { ToolNames } from "@orbit/core/tool/names"
import { Session } from "@orbit/schema/session"
import { SessionMessage } from "@orbit/schema/session-message"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect, Schema } from "effect"
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
        const modules = yield* PluginModule.make()
        const loaded = yield* modules.load({ type: "add", target: directory, options: {} })
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

// A legacy guard reads the old field name. Whatever ran before it, and however that replaced `event.input`, it must read
// the value, or it fails open: legacy plugin kind x field x what ran before.
const fields = [
  ["Edit", "file_path", "path", "/protected/file"],
  ["Write", "file_path", "path", "/protected/file"],
  ["Read", "file_path", "path", "/protected/file"],
  ["NotebookEdit", "notebook_path", "path", "/protected/book.ipynb"],
  ["Bash", "run_in_background", "background", true],
] as const

// Each replaces `event.input` the way the input repair or another plugin does: with an object that has no old-name view.
const earlier = {
  "nothing (control)": (input: Record<string, unknown>) => input,
  "a spread copy": (input: Record<string, unknown>) => ({ ...input }),
  "a repaired copy": (input: Record<string, unknown>) => JSON.parse(JSON.stringify(input)) as Record<string, unknown>,
} as const

const guardSource = (log: string, field: string) => `
import fs from "node:fs"
export default {
  id: "legacy-names-guard",
  async setup(ctx) {
    await ctx.tool.hook("execute.before", (event) => {
      fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ seen: event.input[${JSON.stringify(field)}] ?? null }))
    })
  },
}
`

type Entry = Parameters<Plugin.Interface["activate"]>[0][number]

// One activation holds the whole list: activating again replaces the plugins of the first call.
for (const kind of ["effect", "promise", "module export"] as const)
  for (const [tool, current, old, value] of fields)
    for (const [ran, replace] of Object.entries(earlier))
      it.live(`a ${kind} guard on ${tool} ${old} still reads it after ${ran}`, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const hooks = yield* PluginHooks.Service
          const seen: { value?: unknown } = {}
          const directory = (yield* tmpdirScoped()).path
          const log = path.join(directory, "log.json")
          const list: Entry[] = [
            {
              id: "legacy-names-earlier",
              revision: "1",
              toolNames: "reference",
              effect: (ctx) =>
                ctx.tool.hook("execute.before", (event) =>
                  Effect.sync(() => {
                    event.input = replace(event.input as Record<string, unknown>)
                  }),
                ),
            },
          ]
          if (kind === "effect")
            list.push({
              id: "legacy-names-effect",
              revision: "1",
              effect: (ctx) =>
                ctx.tool.hook("execute.before", (event) =>
                  Effect.sync(() => void (seen.value = (event.input as Record<string, unknown>)[old])),
                ),
            })
          if (kind === "promise")
            list.push({
              ...PluginPromise.fromPromise({
                id: "legacy-names-promise",
                async setup(ctx) {
                  await ctx.tool.hook("execute.before", (event) => {
                    seen.value = (event.input as Record<string, unknown>)[old]
                  })
                },
              }),
              revision: "1",
            })
          if (kind === "module export") {
            yield* Effect.promise(() => Bun.write(path.join(directory, "index.ts"), guardSource(log, old)))
            const modules = yield* PluginModule.make()
            const loaded = yield* modules.load({ type: "add", target: directory, options: {} })
            if ("pending" in loaded) return yield* Effect.die(new Error("module did not load"))
            list.push(loaded)
          }
          yield* plugins.activate(list)
          const input = { [current]: value, ...(tool === "Bash" ? { command: "ls" } : {}) }
          const event = yield* hooks.trigger("tool", "execute.before", { ...base, tool, input })
          const read =
            kind === "module export"
              ? (JSON.parse(fs.readFileSync(log, "utf8")) as { seen: unknown }).seen
              : (seen.value ?? null)
          expect(read).toEqual(value)
          // Nothing the guard did not touch changes on the way back to the registry.
          expect(ToolNames.lowerInput(tool, event.input)).toEqual(input)
        }),
    )

// The other side: a legacy plugin leaves an input that names a field the old way, and every later reader of the current
// name must read what the tool will run on, or a guard on `file_path` is told the value that was replaced.
const writers = {
  "an accessor write (control)": (input: Record<string, unknown>, old: string, value: unknown) => {
    input[old] = value
    return input
  },
  "a spread with the old name": (input: Record<string, unknown>, old: string, value: unknown) => ({
    ...input,
    [old]: value,
  }),
  "an object of its own": (input: Record<string, unknown>, old: string, value: unknown) => ({
    ...Object.fromEntries(
      Object.entries(input).filter(([key]) => !key.endsWith("path") && key !== "run_in_background"),
    ),
    [old]: value,
  }),
  "Object.assign": (input: Record<string, unknown>, old: string, value: unknown) =>
    Object.assign({}, input, { [old]: value }),
} as const

for (const reader of ["reference effect", "reference promise", "built-in effect"] as const)
  for (const [tool, current, old, value] of fields)
    for (const [wrote, write] of Object.entries(writers))
      it.live(`a ${reader} reader of ${tool} ${current} reads what a legacy plugin wrote with ${wrote}`, () =>
        Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const hooks = yield* PluginHooks.Service
          const changed = typeof value === "boolean" ? !value : "/changed"
          const seen: { value?: unknown } = {}
          const list: Entry[] = [
            {
              id: "legacy-names-writer",
              revision: "1",
              effect: (ctx) =>
                ctx.tool.hook("execute.before", (event) =>
                  Effect.sync(() => {
                    event.input = write(event.input as Record<string, unknown>, old, changed)
                  }),
                ),
            },
          ]
          if (reader === "reference promise")
            list.push({
              ...PluginPromise.fromPromise({
                id: "legacy-names-reader",
                toolNames: "reference",
                async setup(ctx) {
                  await ctx.tool.hook("execute.before", (event) => {
                    seen.value = (event.input as Record<string, unknown>)[current]
                  })
                },
              }),
              revision: "1",
            })
          else
            list.push({
              id: "legacy-names-reader",
              revision: "1",
              ...(reader === "built-in effect" ? { source: { type: "builtin" as const } } : { toolNames: "reference" as const }),
              effect: (ctx) =>
                ctx.tool.hook("execute.before", (event) =>
                  Effect.sync(() => void (seen.value = (event.input as Record<string, unknown>)[current])),
                ),
            })
          yield* plugins.activate(list)
          const input = { [current]: value, ...(tool === "Bash" ? { command: "ls" } : {}) }
          const event = yield* hooks.trigger("tool", "execute.before", { ...base, tool, input })
          expect(seen.value).toEqual(changed)
          expect((ToolNames.lowerInput(tool, event.input) as Record<string, unknown>)[current]).toEqual(changed)
        }),
    )

// The real repair runs as a built-in and replaces `event.input` with a copy; a legacy guard after it reads the old names.
it.live("a legacy guard reads the old field names of an input the real repair rewrote", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const registry = yield* Tool.Service
    const seen: unknown[] = []
    const executed: unknown[] = []
    yield* plugins.activate([
      { ...ToolInputRepairPlugin.Plugin, source: { type: "builtin" }, revision: "1" },
      {
        id: "legacy-names-edit",
        revision: "1",
        toolNames: "reference",
        effect: (ctx) =>
          ctx.tool.transform((draft) =>
            draft.add({
              name: "Edit",
              options: { codemode: false },
              description: "Edit",
              input: Schema.Struct({ file_path: Schema.String, replace_all: Schema.optional(Schema.Boolean) }),
              execute: (input) => Effect.sync(() => executed.push(input)).pipe(Effect.as({ content: "ok" })),
            }),
          ),
      },
      {
        id: "legacy-names-guard",
        revision: "1",
        effect: (ctx) =>
          ctx.tool.hook("execute.before", (event) =>
            Effect.sync(() => {
              const input = event.input as Record<string, unknown>
              seen.push([input.path, input.replaceAll])
            }),
          ),
      },
    ])
    const snapshot = yield* registry.snapshot()
    yield* snapshot.execute({
      ...base,
      call: {
        type: "tool-call",
        id: "call-legacy-repair",
        name: "Edit",
        input: '{"file_path":"/p","replace_all":"true","x":1}',
      },
    })
    expect(seen).toEqual([["/p", true]])
    expect(executed).toEqual([{ file_path: "/p", replace_all: true }])
  }),
)
