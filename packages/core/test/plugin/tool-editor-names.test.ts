import { expect } from "bun:test"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { PluginPromise } from "@orbit/core/plugin/promise"
import { Tool } from "@orbit/core/tool"
import { Effect, Schema } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

// A plugin written against the old names edits the registry by `shell` or `write`. Each row is a spelling of a
// built-in's registry id; the editor must reach the same entry through either.
const spellings = [
  ["shell", "Bash"],
  ["Bash", "Bash"],
  ["write", "Write"],
  ["Write", "Write"],
] as const

const seeded = ["Bash", "Write"] as const

type Got = { value?: string }

const operate = (
  editor: {
    get: (id: string) => { name: string } | undefined
    update: (id: string, update: (tool: { description: string }) => void) => void
    remove: (id: string) => void
  },
  operation: string,
  spelling: string,
  got: Got,
) => {
  if (operation === "get") got.value = editor.get(spelling)?.name
  if (operation === "update") editor.update(spelling, (tool) => void (tool.description = "wrapped"))
  if (operation === "remove") editor.remove(spelling)
}

const kinds = {
  effect: (spelling: string, operation: string, got: Got) =>
    Effect.gen(function* () {
      const host = yield* PluginHost.make(yield* Plugin.Service)
      yield* host.tool.transform((editor) =>
        seeded.forEach((name) =>
          editor.add({
            name,
            description: `${name} built-in`,
            input: Schema.Struct({}),
            options: { codemode: false },
            execute: () => Effect.succeed({ content: "ok" }),
          }),
        ),
      )
      yield* host.tool.transform((editor) => operate(editor, operation, spelling, got))
    }),
  promise: (spelling: string, operation: string, got: Got) =>
    Effect.gen(function* () {
      yield* PluginPromise.fromPromise({
        id: "editor-names-promise",
        async setup(context) {
          await context.tool.transform((editor) =>
            seeded.forEach((name) =>
              editor.add({
                name,
                description: `${name} built-in`,
                input: { type: "object", properties: {}, additionalProperties: false },
                options: { codemode: false },
                execute: async () => ({ content: "ok" }),
              }),
            ),
          )
          await context.tool.transform((editor) => operate(editor, operation, spelling, got))
        },
      }).effect(yield* PluginHost.make(yield* Plugin.Service))
    }),
}

for (const kind of Object.keys(kinds) as Array<keyof typeof kinds>)
  for (const operation of ["get", "update", "remove"] as const)
    for (const [spelling, id] of spellings)
      it.live(`a ${kind} plugin's editor ${operation}s ${id} through the spelling ${spelling}`, () =>
        Effect.gen(function* () {
          const got: Got = {}
          yield* kinds[kind](spelling, operation, got)
          const snapshot = yield* (yield* Tool.Service).snapshot()
          const definition = (name: string) => snapshot.definitions.find((item) => item.name === name)
          const other = id === "Bash" ? "Write" : "Bash"
          if (operation === "get") expect(got.value).toBe(id)
          if (operation === "update") {
            expect(definition(id)?.description).toBe("wrapped")
            expect(definition(other)?.description).toBe(`${other} built-in`)
          }
          if (operation === "remove") {
            expect(definition(id)).toBeUndefined()
            expect(definition(other)).toBeDefined()
          }
        }),
      )
