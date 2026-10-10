import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Tool } from "@orbit/core/tool"
import { FSUtil } from "@orbit/util/fs-util"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { LspTool } from "@orbit/core/tool/plugin/lsp"
import { initRepo } from "./fixture/git"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { allowAllPermission } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const server = path.join(import.meta.dir, "fixtures", "lsp", "fake-server.ts")

const lspToolNode = makeLocationNode({
  name: "test/lsp-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(LspTool.Plugin)),
  deps: [Tool.node, FileAccess.node, Lsp.node, Permission.node, Config.node, FSUtil.node, Location.node],
})

// The lines of main.fake decide what the fake server answers; line numbers below are 1-based as the tool takes them.
const LINES = { plain: 1, multi: 2, impl: 3, fn: 4, list: 5, single: 6, outside: 7 } as const
const SOURCE = ["plain", "multi", "impl here", "fn here", "list", "single", "outside", ""].join("\n")

/**
 * A project folder with one file, a fake language server started with these flags, and a way to call the tool. The
 * folder is a git repository when `repo` is set.
 */
const project = <A, E>(
  options: { readonly flags?: readonly string[]; readonly repo?: boolean; readonly untrusted?: boolean },
  body: (fixture: {
    readonly directory: string
    readonly file: string
    readonly log: string
    readonly marker: string
    readonly call: (input: Record<string, unknown>) => Effect.Effect<{ readonly failed: boolean; readonly text: string }>
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const directory = (yield* tmpdirScoped()).path
    const file = path.join(directory, "main.fake")
    const log = path.join(directory, "requests.log")
    const marker = path.join(directory, "opened.log")
    yield* Effect.promise(async () => {
      await Bun.write(file, SOURCE)
      await Bun.write(log, "")
      await Bun.write(marker, "")
      if (options.repo) await initRepo(directory)
    })
    const flags = [...(options.flags ?? []), `--log=${log}`, `--marker=${marker}`]
    const config = Config.testLayer([
      new Document({
        type: "document",
        info: Schema.decodeUnknownSync(Info)({
          lsp: { fake: { command: [process.execPath, server, ...flags], extensions: [".fake"] } },
        }),
      }),
    ])
    return yield* Effect.gen(function* () {
      const registry = yield* Tool.Service
      const call = (input: Record<string, unknown>) =>
        executeTool(registry, {
          sessionID: Session.ID.make("ses_lsp_tool"),
          ...toolIdentity,
          call: { type: "tool-call", id: "call-lsp", name: "LSP", input: { path: file, ...input } },
        }).pipe(
          Effect.map((settled) =>
            settled.status === "completed"
              ? {
                  failed: false,
                  text: (settled.content ?? [])
                    .map((part) => ("text" in part && typeof part.text === "string" ? part.text : ""))
                    .join(""),
                }
              : { failed: true, text: settled.error?.message ?? "" },
          ),
        )
      return yield* body({ directory, file, log, marker, call })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, lspToolNode]), [
          Config.node.replace(config),
          Permission.node.replace(allowAllPermission),
          ...(options.untrusted
            ? [
                Global.node.replace(tempGlobalLayer),
                WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
              ]
            : []),
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
            ),
          ),
        ]),
      ),
    )
  })

const requests = (log: string) =>
  Effect.promise(async () =>
    (await Bun.file(log).text())
      .split("\n")
      .filter(Boolean)
      .map((row) => JSON.parse(row) as { method: string; params: Record<string, unknown> }),
  )

const at = (action: string, line: keyof typeof LINES) => ({ action, line: LINES[line], character: 1 })

const windowsOnly = process.platform === "win32" ? it.live : it.live.skip

describe("LSP tool", () => {
  it.live("implementation prints each location, a link at its whole target when it has no selection", () =>
    project({}, ({ call, directory }) =>
      Effect.gen(function* () {
        const found = yield* call(at("implementation", "impl"))
        expect(found.failed).toBe(false)
        expect(found.text).toBe("2 implementations:\n  src/impl-a.fake:5:3\n  src/impl-b.fake:10:2")
        expect((yield* call(at("implementation", "plain"))).text).toContain("No implementation found")
        void directory
      }),
    ),
  )

  it.live("workspace_symbols sends the query alone, and prints symbols grouped by file", () =>
    project({}, ({ call, log }) =>
      Effect.gen(function* () {
        const found = yield* call({ action: "workspace_symbols", query: "foo" })
        expect(found.text).toBe(
          [
            "8 symbols in the workspace:",
            "",
            "src/a.fake:",
            "  alpha (Function), line 4, in Box",
            "  gamma (Class), line 10",
            "  mystery (Unknown), line 12",
            "",
            "src/b.fake:",
            "  beta (Variable), line 8",
            "",
            "src/bare.fake:",
            "  bare (Function)",
            "",
            "src/lines.fake:",
            "  two lines (x: number) (Function), line 2",
            "",
            "jdt://contents/lib.jar/Thing.class:",
            "  jar (Class), line 1",
            "",
            "ignored/h.fake:",
            "  hidden (Function), line 1",
          ].join("\n"),
        )
        const sent = (yield* requests(log)).filter((item) => item.method === "workspace/symbol")
        // No document key, and the query exactly as given.
        expect(sent.map((item) => item.params)).toEqual([{ query: "foo" }])
      }),
    ),
  )

  it.live("workspace_symbols without a query sends an empty one, and the path chooses the server", () =>
    project({}, ({ call, log, marker }) =>
      Effect.gen(function* () {
        yield* call({ action: "workspace_symbols" })
        const sent = (yield* requests(log)).filter((item) => item.method === "workspace/symbol")
        expect(sent.map((item) => item.params)).toEqual([{ query: "" }])
        // The file was opened so the server loads its project.
        expect((yield* Effect.promise(() => Bun.file(marker).text())).trim().split("\n")).toHaveLength(1)
      }),
    ),
  )

  it.live("prepare_call_hierarchy lists every item and says so when there is none", () =>
    project({}, ({ call }) =>
      Effect.gen(function* () {
        expect((yield* call(at("prepare_call_hierarchy", "fn"))).text).toBe(
          "2 call hierarchy items:\n  first (Function) at src/fn.fake:6 [(a: number)]\n  second (Method) at src/fn.fake:21",
        )
        expect((yield* call(at("prepare_call_hierarchy", "plain"))).text).toBe(
          "No call hierarchy item at that position.",
        )
      }),
    ),
  )

  it.live("incoming and outgoing calls use only the first prepared item and print call sites", () =>
    project({}, ({ call, log }) =>
      Effect.gen(function* () {
        const incoming = yield* call(at("incoming_calls", "fn"))
        expect(incoming.failed).toBe(false)
        expect(incoming.text).toBe(
          [
            "3 incoming calls:",
            "",
            "src/c1.fake:",
            "  one (Function), line 8, calls at 4:2, 5:3",
            "  three (Function), line 13, calls at 10:4",
            "",
            "src/c2.fake:",
            "  two (Method), line 9, calls at 7:1",
          ].join("\n"),
        )
        const outgoing = yield* call(at("outgoing_calls", "fn"))
        expect(outgoing.text).toStartWith("3 outgoing calls (call positions are in the inspected file):")
        expect(outgoing.text).toContain("  one (Function), line 8, called from 4:2, 5:3")
        const sent = yield* requests(log)
        expect(sent.filter((item) => item.method.startsWith("callHierarchy/")).map((item) => item.params)).toEqual([
          expect.objectContaining({ item: expect.objectContaining({ name: "first", data: { token: "first" } }) }),
          expect.objectContaining({ item: expect.objectContaining({ name: "first", data: { token: "first" } }) }),
        ])
        // Each call list took exactly the keys an item carries, with nothing about a document added.
        expect(Object.keys(sent.find((item) => item.method === "callHierarchy/incomingCalls")!.params)).toEqual(["item"])
      }),
    ),
  )

  it.live("a call action with nothing prepared is a plain result and sends no second request", () =>
    project({}, ({ call, log }) =>
      Effect.gen(function* () {
        const found = yield* call(at("incoming_calls", "plain"))
        expect(found.failed).toBe(false)
        expect(found.text).toContain("No call hierarchy item")
        expect((yield* requests(log)).map((item) => item.method)).toEqual(["textDocument/prepareCallHierarchy"])
      }),
    ),
  )

  it.live("a null call list says there are no calls", () =>
    project({ flags: ["--null-calls"] }, ({ call }) =>
      Effect.gen(function* () {
        expect((yield* call(at("incoming_calls", "fn"))).text).toStartWith("No incoming calls found.")
        expect((yield* call(at("outgoing_calls", "fn"))).text).toStartWith("No outgoing calls found.")
      }),
    ),
  )

  it.live("every position action fails without a line or a character, and the others do not need one", () =>
    project({}, ({ call }) =>
      Effect.gen(function* () {
        for (const action of [
          "definition",
          "references",
          "hover",
          "implementation",
          "prepare_call_hierarchy",
          "incoming_calls",
          "outgoing_calls",
        ]) {
          const missing = yield* call({ action })
          expect({ action, ...missing }).toEqual({
            action,
            failed: true,
            text: expect.stringContaining(`"${action}" needs a line and character.`),
          })
          expect((yield* call({ action, line: 1 })).failed).toBe(true)
        }
        expect((yield* call({ action: "symbols" })).failed).toBe(false)
        expect((yield* call({ action: "workspace_symbols" })).failed).toBe(false)
      }),
    ),
  )

  it.live("an extension with no server says so", () =>
    project({}, ({ call, directory }) =>
      Effect.gen(function* () {
        const other = path.join(directory, "notes.unknown")
        yield* Effect.promise(() => Bun.write(other, "x"))
        const found = yield* call({ ...at("definition", "plain"), path: other })
        expect(found).toEqual({ failed: true, text: expect.stringContaining("No language server is available for notes.unknown") })
      }),
    ),
  )

  it.live("definition, references, hover and symbols print the shared shapes", () =>
    project({}, ({ call }) =>
      Effect.gen(function* () {
        expect((yield* call(at("definition", "plain"))).text).toBe("Definition: src/one.fake:5:3")
        expect((yield* call(at("definition", "multi"))).text).toBe(
          "2 definitions:\n  src/one.fake:1:1\n  src/two.fake:11:3",
        )
        expect((yield* call(at("references", "single"))).text).toBe("1 reference:\n  src/b.fake:3:5")
        expect((yield* call(at("references", "plain"))).text).toBe(
          "4 references in 3 files:\n\nignored/a.fake:\n  1:1\n\nsrc/b.fake:\n  3:5\n  6:2\n\nsrc/c.fake:\n  2:1",
        )
        expect((yield* call(at("hover", "plain"))).text).toBe("a fake symbol")
        expect((yield* call(at("hover", "list"))).text).toBe("At 3:5:\n\nfirst part\n\nsecond part")
      }),
    ),
  )

  it.live("document symbols show kind, detail and the line of the symbol's range", () =>
    project({}, ({ call, file }) =>
      Effect.gen(function* () {
        expect((yield* call({ action: "symbols" })).text).toBe(
          `Symbols in ${file}:\nOuter (Class) detail text, line 2\n  inner (Method), line 4`,
        )
      }),
    ),
  )

  it.live("a result two levels up is shown absolute and one level up relative, with forward slashes", () =>
    project({}, ({ call, directory }) =>
      Effect.gen(function* () {
        const found = yield* call(at("references", "outside"))
        const two = path.resolve(directory, "..", "..", "two-up.fake").split(path.sep).join("/")
        expect(found.text).toBe(`2 references in 2 files:\n\n../one-up.fake:\n  1:1\n\n${two}:\n  1:1`)
        expect(found.text).not.toContain("\\")
      }),
    ),
  )

  windowsOnly(
    "a server's lower-case, encoded drive still resolves under the Location",
    () =>
      project({ flags: ["--encoded-uris"] }, ({ call }) =>
        call(at("definition", "plain")).pipe(
          Effect.map((found) => expect(found.text).toBe("Definition: src/one.fake:5:3")),
        ),
      ),
  )

  it.live("results in git-ignored files are left out, tracked ones stay, and the count follows", () =>
    project({ repo: true }, ({ call, directory }) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await Bun.write(path.join(directory, ".gitignore"), "ignored/\n")
          await fs.mkdir(path.join(directory, "ignored"))
          await Bun.write(path.join(directory, "ignored", "a.fake"), "x")
        })
        const hidden = yield* call(at("references", "plain"))
        expect(hidden.text).toBe("3 references in 2 files:\n\nsrc/b.fake:\n  3:5\n  6:2\n\nsrc/c.fake:\n  2:1")
        expect((yield* call({ action: "workspace_symbols" })).text).not.toContain("hidden")
        // Hover, symbols and the call lists are never filtered.
        expect((yield* call({ action: "symbols" })).failed).toBe(false)
        // A file git tracks is never hidden, even when a pattern matches it.
        yield* Effect.promise(async () => {
          const { $ } = await import("bun")
          await $`git add -f ignored/a.fake`.cwd(directory).quiet()
        })
        expect((yield* call(at("references", "plain"))).text).toStartWith("4 references in 3 files:")
      }),
    ),
  )

  it.live("outside a repository nothing is hidden", () =>
    project({}, ({ call }) =>
      call(at("references", "plain")).pipe(
        Effect.map((found) => expect(found.text).toStartWith("4 references in 3 files:")),
      ),
    ),
  )

  it.live("a server that answers content-modified is retried silently, then answers", () =>
    project({ flags: ["--content-modified=2"] }, ({ call, log }) =>
      Effect.gen(function* () {
        const found = yield* call(at("hover", "plain"))
        expect(found).toEqual({ failed: false, text: "a fake symbol" })
        expect((yield* requests(log)).filter((item) => item.method === "textDocument/hover")).toHaveLength(3)
      }),
    ),
  )

  it.live("content-modified fails with the server's error after three retries", () =>
    project({ flags: ["--content-modified=9"] }, ({ call, log }) =>
      Effect.gen(function* () {
        const found = yield* call(at("hover", "plain"))
        expect(found).toEqual({ failed: true, text: expect.stringContaining("content modified") })
        expect((yield* requests(log)).filter((item) => item.method === "textDocument/hover")).toHaveLength(4)
      }),
    ),
  )

  it.live("any other server error fails at once", () =>
    project({ flags: ["--fail=-32603"] }, ({ call, log }) =>
      Effect.gen(function* () {
        const found = yield* call(at("hover", "plain"))
        expect(found).toEqual({ failed: true, text: expect.stringContaining("forced failure") })
        expect((yield* requests(log)).filter((item) => item.method === "textDocument/hover")).toHaveLength(1)
      }),
    ),
  )

  it.live("a file over 10 MB is refused and the server is never told about it, one of exactly 10 MB is sent", () =>
    project({}, ({ call, directory, marker }) =>
      Effect.gen(function* () {
        const big = path.join(directory, "big.fake")
        yield* Effect.promise(() => Bun.write(big, "a".repeat(10_000_001)))
        const refused = yield* call({ ...at("hover", "plain"), path: big })
        expect(refused).toEqual({
          failed: true,
          text: expect.stringContaining("big.fake is 11 MB; language servers are only sent files up to 10 MB."),
        })
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("")
        const exact = path.join(directory, "exact.fake")
        yield* Effect.promise(() => Bun.write(exact, "a".repeat(10_000_000)))
        expect((yield* call({ ...at("hover", "plain"), path: exact })).failed).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toContain("exact.fake")
      }),
    ),
  )

  it.live("while the folder is untrusted no server starts, for the new actions too", () =>
    project({ untrusted: true }, ({ call, marker, log }) =>
      Effect.gen(function* () {
        for (const input of [{ action: "workspace_symbols" }, at("incoming_calls", "fn"), at("implementation", "impl")]) {
          const found = yield* call(input)
          expect({ input, ...found }).toEqual({
            input,
            failed: true,
            text: expect.stringContaining("Language servers stay off until this folder is trusted."),
          })
        }
        expect(yield* Effect.promise(() => Bun.file(marker).text())).toBe("")
        expect(yield* Effect.promise(() => Bun.file(log).text())).toBe("")
      }),
    ),
  )
})

describe("language server capabilities", () => {
  it.live("initialize declares implementation, call hierarchy, workspace symbols and link support", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const recorded = path.join(directory, "init.json")
      const file = path.join(directory, "main.fake")
      yield* Effect.promise(() => Bun.write(file, SOURCE))
      const config = Config.testLayer([
        new Document({
          type: "document",
          info: Schema.decodeUnknownSync(Info)({
            lsp: { fake: { command: [process.execPath, server, `--record-init=${recorded}`], extensions: [".fake"] } },
          }),
        }),
      ])
      yield* Effect.gen(function* () {
        const lsp = yield* Lsp.Service
        yield* lsp.request("textDocument/hover", file, { position: { line: 0, character: 0 } })
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(Lsp.node, [
            Config.node.replace(config),
            Location.node.replace(
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
              ),
            ),
          ]),
        ),
      )
      const capabilities = (yield* Effect.promise(() => Bun.file(recorded).json())).capabilities
      expect(capabilities.textDocument).toMatchObject({
        definition: { linkSupport: true },
        implementation: { linkSupport: true },
        callHierarchy: {},
        references: {},
        hover: { contentFormat: ["markdown", "plaintext"] },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
      })
      expect(capabilities.workspace).toMatchObject({ symbol: {}, configuration: true, workspaceFolders: true })
    }),
  )
})
