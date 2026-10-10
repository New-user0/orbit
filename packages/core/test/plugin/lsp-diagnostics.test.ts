import { describe, expect } from "bun:test"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Global } from "@orbit/util/global"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { LayerNode } from "@orbit/util/effect/layer-node"
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
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import fs from "fs/promises"
import { tmpdirScoped } from "../fixture/tmpdir"
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
      const inside = path.resolve(location.directory, "src/a.fake")
      const outside = path.join(path.dirname(location.directory), "elsewhere", "a.fake")
      const drive = (prefix: string, file: string) =>
        `${prefix}${file[0]!.toLowerCase()}/${file.slice(3).replaceAll("\\", "/")}`
      const rows = [
        ["src/a.fake", inside],
        ["src/../src/a.fake", inside],
        ["../elsewhere/a.fake", outside],
        [outside, outside],
        ["~/a.fake", path.join(Global.Path.home, "a.fake")],
        ...(process.platform === "win32"
          ? [
              [drive("/", inside), inside],
              [drive("/cygdrive/", inside), inside],
              [drive("/mnt/", inside), inside],
              [drive("/", outside), outside],
              [drive("/cygdrive/", outside), outside],
              [drive("/mnt/", outside), outside],
              ["src/a.fake.", inside],
              ["src/a.fake ", inside],
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

  // The real Lsp, ProjectTrust and the fake server, in the Location the plugin runs in. The Location's project is
  // trusted and nothing else is; the server writes a line to `marker` for every document it is told to open.
  const real = (
    body: (
      hooks: PluginHooks.Interface,
      directory: string,
      extra: { readonly trust: WorkspaceTrust.Interface; readonly marker: string },
    ) => Effect.Effect<void, unknown, Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const location = yield* Location.Service
      const marker = path.join((yield* tmpdirScoped()).path, "opened.txt")
      yield* Effect.promise(() => Bun.write(marker, ""))
      const lsp = yield* Layer.build(
        AppNodeBuilder.build(LayerNode.group([Lsp.node, WorkspaceTrust.node]), [
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
          Config.node.replace(
            Config.testLayer([
              new Document({
                type: "document",
                info: Schema.decodeUnknownSync(Info)({
                  lsp: { fake: { command: [process.execPath, fakeServer, `--marker=${marker}`], extensions: [".fake"] } },
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
      const trust = Context.get(lsp, WorkspaceTrust.Service)
      yield* trust.grant(location.directory, { persist: false, via: "test" })
      yield* body(hooks, location.directory, { trust, marker })
    })

  it.live("a Write with only its input reaches the server, and its result gains only diagnostics", () =>
    real((hooks, directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "src", "a.fake")
        yield* Effect.promise(() => Bun.write(file, "here is an ERROR\n"))
        const output = { operation: "write", target: file, resource: "src/a.fake", existed: false }
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

  // A Write to a file outside the project reaches the project's server only when the folder that owns the file is
  // trusted too. Every spelling that the tool accepts for such a path is decided on the file it names.
  it.live("a Write outside the project reaches a server only when the file's own folder is trusted", () =>
    real((hooks, directory, extra) =>
      Effect.gen(function* () {
        const outer = (yield* tmpdirScoped()).path
        const untrusted = path.join(outer, "untrusted")
        const trusted = path.join(outer, "trusted")
        yield* Effect.promise(() =>
          Promise.all(
            [untrusted, trusted].map(async (folder) => {
              await fs.mkdir(path.join(folder, ".git"), { recursive: true })
              await Bun.write(path.join(folder, "a.fake"), "an ERROR\n")
            }),
          ),
        )
        yield* extra.trust.grant(trusted, { persist: false, via: "test" })
        const home = path.join(Global.Path.home, "orbit-n3-home.fake")
        yield* Effect.promise(() => Bun.write(home, "an ERROR\n"))
        yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(home, { force: true })))

        const drive = (prefix: string, file: string) =>
          `${prefix}${file[0]!.toLowerCase()}/${file.slice(3).replaceAll("\\", "/")}`
        const untrustedFile = path.join(untrusted, "a.fake")
        const trustedFile = path.join(trusted, "a.fake")
        const rows: ReadonlyArray<readonly [string, string, boolean]> = [
          ["inside, relative", "inside.fake", true],
          ["untrusted, absolute", untrustedFile, false],
          ["trusted, absolute (control)", trustedFile, true],
          ["untrusted, relative with ..", path.relative(directory, untrustedFile), false],
          ["trusted, relative with ..", path.relative(directory, trustedFile), true],
          ["untrusted, with a dot segment", path.join(untrusted, ".", "a.fake"), false],
          ["the home folder", "~/orbit-n3-home.fake", false],
          ...(process.platform === "win32"
            ? ([
                ["untrusted, Git Bash form", drive("/", untrustedFile), false],
                ["untrusted, Cygwin form", drive("/cygdrive/", untrustedFile), false],
                ["untrusted, WSL form", drive("/mnt/", untrustedFile), false],
                ["untrusted, trailing dot", `${untrustedFile}.`, false],
                ["untrusted, trailing space", `${untrustedFile} `, false],
                ["untrusted, other case", untrustedFile.toUpperCase(), false],
                ["trusted, Git Bash form", drive("/", trustedFile), true],
                ["trusted, Cygwin form", drive("/cygdrive/", trustedFile), true],
                ["trusted, WSL form", drive("/mnt/", trustedFile), true],
                ["trusted, other case", trustedFile.toUpperCase(), true],
              ] as const)
            : []),
        ]
        yield* Effect.promise(() => Bun.write(path.join(directory, "inside.fake"), "an ERROR\n"))
        const outcomes = yield* Effect.forEach(rows, ([name, given]) =>
          Effect.gen(function* () {
            const event = base("Write", { file_path: given, content: "x" }, { content: "Wrote it" } as Tool.Result)
            yield* hooks.trigger("tool", "execute.after", event)
            return [name, JSON.stringify(event.result).includes("found ERROR")] as const
          }),
        )
        expect(outcomes).toEqual(rows.map(([name, , allowed]) => [name, allowed]))
        // The server was never told to open a refused file, by any spelling. (A file reached again by another spelling
        // is sent as a change, so the marker counts each file once.)
        const opened = (yield* Effect.promise(() => Bun.file(extra.marker).text())).toLowerCase()
        expect(opened).toContain("inside.fake")
        expect(opened).not.toContain("untrusted")
        expect(opened).not.toContain("orbit-n3-home")
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
