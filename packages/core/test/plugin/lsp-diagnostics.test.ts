import { describe, expect } from "bun:test"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Global } from "@orbit/util/global"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Context } from "effect"
import { Schema } from "effect"
import { Tool } from "@orbit/schema/tool"
import { SessionMessage } from "@orbit/schema/session-message"
import { Agent } from "@orbit/core/agent"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { LspPlugin } from "@orbit/core/lsp/plugin"
import { Plugin } from "@orbit/core/plugin"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { PluginHost } from "@orbit/core/plugin/host"
import { Session } from "@orbit/core/session"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const asked: { files: string[]; options: { readonly save?: boolean } | undefined }[] = []
const lspLayer = Layer.mock(Lsp.Service, {
  diagnostics: (files, options) =>
    Effect.sync(() => {
      asked.push({ files: [...files], options })
      return Object.fromEntries(
        files.map((file) => [
          file,
          [
            {
              range: { start: { line: 4, character: 2 }, end: { line: 4, character: 8 } },
              severity: 1,
              message: "Cannot find name 'foo'.",
            },
            {
              range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } },
              severity: 2,
              message: "unused",
            },
          ],
        ]),
      )
    }),
})
const it = testEffect(Layer.merge(PluginTestLayer, lspLayer))

const base = (tool: string, input: unknown, result: Tool.Result) => ({
  sessionID: Session.ID.make("ses_lsp_plugin"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_lsp_plugin"),
  id: Tool.CallID.make("call_lsp_plugin"),
  tool,
  input,
  status: "completed" as const,
  result,
})

const fakeServer = path.join(import.meta.dir, "..", "fixtures", "lsp", "fake-server.ts")

describe("LspPlugin", () => {
  const register = Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const location = yield* Location.Service
    yield* LspPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
    return { hooks, location }
  })

  it.effect("resolves a Write's target from its own input, the way the tool does", () =>
    Effect.gen(function* () {
      const { hooks, location } = yield* register
      const rows = [
        ["src/a.fake", path.resolve(location.directory, "src/a.fake")],
        ["~/a.fake", path.join(Global.Path.home, "a.fake")],
        ...(process.platform === "win32"
          ? [
              [
                `/${location.directory[0]!.toLowerCase()}/${location.directory.slice(3).replaceAll("\\", "/")}/src/a.fake`,
                path.resolve(location.directory, "src/a.fake"),
              ],
              ["src/a.fake.", path.resolve(location.directory, "src/a.fake")],
            ]
          : []),
      ] as const
      for (const [given, expected] of rows) {
        asked.length = 0
        yield* hooks.trigger(
          "tool",
          "execute.after",
          base("Write", { file_path: given, content: "x" }, { content: "Wrote it" } as Tool.Result),
        )
        expect({ given, asked }).toEqual({ given, asked: [{ files: [expected], options: { save: true } }] })
      }
      // The older field name, as a plugin hook may leave it.
      asked.length = 0
      yield* hooks.trigger(
        "tool",
        "execute.after",
        base("Write", { path: "src/a.fake" }, { content: "x" } as Tool.Result),
      )
      expect(asked.map((item) => item.files)).toEqual([[path.resolve(location.directory, "src/a.fake")]])
    }),
  )

  it.effect(
    "Patch and NotebookEdit save the files in their metadata, and a failed or unrelated call asks nothing",
    () =>
      Effect.gen(function* () {
        const { hooks, location } = yield* register
        for (const tool of ["Patch", "NotebookEdit"]) {
          asked.length = 0
          yield* hooks.trigger(
            "tool",
            "execute.after",
            base(tool, {}, {
              content: "ok",
              metadata: { files: [{ file: "b.ipynb" }, { file: "gone.ts", status: "deleted" }] },
            } as Tool.Result),
          )
          expect(asked).toEqual([{ files: [path.resolve(location.directory, "b.ipynb")], options: { save: true } }])
        }
        asked.length = 0
        yield* hooks.trigger("tool", "execute.after", {
          ...base("Write", { file_path: "a.fake" }, { content: "x" } as Tool.Result),
          status: "error" as const,
          error: { type: "unknown", message: "failed" } as never,
        })
        yield* hooks.trigger(
          "tool",
          "execute.after",
          base("Read", { file_path: "a.fake" }, { content: "x" } as Tool.Result),
        )
        expect(asked).toEqual([])
      }),
  )

  // The real Lsp and the fake server, in the Location the plugin runs in.
  const real = (body: (hooks: PluginHooks.Interface, directory: string) => Effect.Effect<void, unknown, never>) =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const lsp = yield* Layer.build(
        AppNodeBuilder.build(Lsp.node, [
          Config.node.replace(
            Config.testLayer([
              new Document({
                type: "document",
                info: Schema.decodeUnknownSync(Info)({
                  lsp: { fake: { command: [process.execPath, fakeServer], extensions: [".fake"] } },
                }),
              }),
            ]),
          ),
          Location.node.replace(Layer.succeed(Location.Service, location)),
        ]),
      )
      const hooks = yield* PluginHooks.Service
      yield* LspPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service)).pipe(
        Effect.provideService(Lsp.Service, Context.get(lsp, Lsp.Service)),
      )
      yield* body(hooks, location.directory)
    })

  it.live("a Write with only its input reaches the server, and its result gains only diagnostics", () =>
    real((hooks, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "src", "a.fake")
        yield* Effect.promise(() => Bun.write(file, "here is an ERROR\n"))
        const output = { target: file, created: true }
        const event = base("Write", { file_path: "src/a.fake", content: "x" }, {
          output,
          content: "Wrote src/a.fake",
        } as Tool.Result)
        yield* hooks.trigger("tool", "execute.after", event)
        expect(event.result.output).toEqual(output)
        expect(Object.keys(event.result.metadata ?? {})).toEqual(["diagnostics"])
        expect(event.result.content).toEqual([
          { type: "text", text: "Wrote src/a.fake" },
          {
            type: "text",
            text: expect.stringContaining("checked on save (with text)"),
          },
        ])
        expect(JSON.stringify(event.result.content)).toContain("found ERROR")

        // A clean file leaves the result alone.
        yield* Effect.promise(() => Bun.write(file, "fine\n"))
        const clean = base("Write", { file_path: "src/a.fake" }, { content: "Wrote it" } as Tool.Result)
        yield* hooks.trigger("tool", "execute.after", clean)
        expect(clean.result).toEqual({ content: "Wrote it" })
      }),
    ),
  )

  it.effect("adds language server errors for the files an edit changed", () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const location = yield* Location.Service
      yield* LspPlugin.Plugin.effect(yield* PluginHost.make(yield* Plugin.Service))
      const event = {
        sessionID: Session.ID.make("ses_lsp_plugin"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_lsp_plugin"),
        id: Tool.CallID.make("call_lsp_plugin"),
        tool: "Edit",
        input: { path: "src/a.ts" },
        status: "completed" as const,
        result: {
          content: "Edited src/a.ts (1 replacement)",
          metadata: { files: [{ file: "src/a.ts", patch: "", additions: 1, deletions: 1 }] },
        } as Tool.Result,
      }
      yield* hooks.trigger("tool", "execute.after", event)
      const absolute = path.resolve(location.directory, "src/a.ts")
      expect(asked).toEqual([{ files: [absolute], options: { save: true } }])
      expect(event.result.content).toEqual([
        { type: "text", text: "Edited src/a.ts (1 replacement)" },
        {
          type: "text",
          text: `Language server errors after this change:\n${path.join("src", "a.ts")}:\n  5:3 Cannot find name 'foo'.`,
        },
      ])
      expect(Object.keys(event.result.metadata?.diagnostics as object)).toEqual([absolute, "src/a.ts"])

      const read = { ...event, tool: "Read", result: { content: "x" } as Tool.Result }
      yield* hooks.trigger("tool", "execute.after", read)
      expect(read.result.content).toBe("x")
    }),
  )
})
