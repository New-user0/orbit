import { describe, expect } from "bun:test"
import path from "path"
import { Document, Info } from "@orbit/schema/config"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Config } from "@orbit/core/config"
import { Location } from "@orbit/core/location"
import { Lsp } from "@orbit/core/lsp/index"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { Layer } from "effect"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { Tool } from "@orbit/core/tool"
import { FSUtil } from "@orbit/util/fs-util"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { Session } from "@orbit/core/session"
import { LspTool } from "@orbit/core/tool/plugin/lsp"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { allowAllPermission, permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity, toolTraits } from "./lib/tool"

const server = path.join(import.meta.dir, "fixtures", "lsp", "fake-server.ts")
const configured = (lsp: unknown) =>
  Config.testLayer([new Document({ type: "document", info: Schema.decodeUnknownSync(Info)({ lsp }) })])

const withLsp = <A, E>(directory: string, lsp: unknown, body: (service: Lsp.Interface) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* body(yield* Lsp.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(Lsp.node, [
        Config.node.replace(configured(lsp)),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
      ]),
    ),
  )

const lspToolNode = makeLocationNode({
  name: "test/lsp-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(LspTool.Plugin)),
  deps: [Tool.node, FileAccess.node, Lsp.node, Permission.node, Config.node, FSUtil.node, Location.node],
})

describe("Lsp", () => {
  it.live("the lsp tool only reads, so it is read-only, safe beside other calls and ended by a new message", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      expect(yield* toolTraits(registry, "LSP", { action: "hover", path: "a.ts" })).toMatchObject({
        readOnly: true,
        concurrencySafe: true,
        destructive: false,
        interruptBehavior: "cancel",
      })
    }).pipe(
      Effect.provide(
        AppNodeBuilder.build(LayerNode.group([Tool.node, lspToolNode]), [
          Config.node.replace(configured(false)),
          Permission.node.replace(permissionLayer()),
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
            ),
          ),
        ]),
      ),
    ),
  )

  it.live("reports a configured server's diagnostics after each change, and answers requests", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "main.fake")
      yield* withLsp(directory, { fake: { command: [process.execPath, server], extensions: [".fake"] } }, (lsp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => Bun.write(file, "fine\nhere is an ERROR\n"))
          const first = yield* lsp.diagnostics([file, path.join(directory, "other.txt")])
          expect(Object.keys(first)).toEqual([file])
          expect(first[file]).toEqual([
            expect.objectContaining({
              message: "found ERROR",
              range: expect.objectContaining({ start: { line: 1, character: 11 } }),
            }),
          ])

          yield* Effect.promise(() => Bun.write(file, "all fine now\n"))
          expect((yield* lsp.diagnostics([file]))[file]).toEqual([])

          expect(yield* lsp.request("textDocument/hover", file, { position: { line: 0, character: 0 } })).toEqual({
            contents: { kind: "markdown", value: "a fake symbol" },
          })
        }),
      )
      yield* withLsp(directory, false, (lsp) =>
        lsp.diagnostics([file]).pipe(Effect.map((found) => expect(found).toEqual({}))),
      )
    }),
  )

  it.live("a save brings the save-only diagnostic and carries the text only when the server asks for it", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "main.fake")
      yield* Effect.promise(() => Bun.write(file, "here is an ERROR\n"))
      const messages = (found: Record<string, Lsp.Diagnostic[]>) => found[file]!.map((item) => item.message)
      yield* withLsp(directory, { fake: { command: [process.execPath, server], extensions: [".fake"] } }, (lsp) =>
        Effect.gen(function* () {
          // The very first call opens the file before it saves; the fake reports a save that came first.
          expect(messages(yield* lsp.diagnostics([file], { save: true }))).toEqual([
            "found ERROR",
            "checked on save (with text)",
          ])
          expect(messages(yield* lsp.diagnostics([file]))).toEqual(["found ERROR"])
          yield* Effect.promise(() => Bun.write(file, "again an ERROR\n"))
          expect(messages(yield* lsp.diagnostics([file], { save: true }))).toEqual([
            "found ERROR",
            "checked on save (with text)",
          ])
        }),
      )
      // Only `save: { includeText: true }` asks for the text: a bare `save: {}`, `save: true` and a numeric sync kind do not.
      for (const mode of ["--plain-save", "--save-true", "--sync-kind"]) {
        yield* withLsp(
          directory,
          { fake: { command: [process.execPath, server, mode], extensions: [".fake"] } },
          (lsp) =>
            lsp.diagnostics([file], { save: true }).pipe(
              Effect.map((found) =>
                expect({ mode, found: messages(found) }).toEqual({
                  mode,
                  found: ["found ERROR", "checked on save (no text)"],
                }),
              ),
            ),
        )
      }
    }),
  )

  it.live("the lsp tool's diagnostics action never saves", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "main.fake")
      yield* Effect.promise(() => Bun.write(file, "here is an ERROR\n"))
      yield* Effect.gen(function* () {
        const registry = yield* Tool.Service
        const settled = yield* executeTool(registry, {
          sessionID: Session.ID.make("ses_lsp_tool"),
          ...toolIdentity,
          call: { type: "tool-call", id: "call-lsp", name: "LSP", input: { action: "diagnostics", path: file } },
        })
        expect(settled.status).toBe("completed")
        const text = JSON.stringify(settled.content)
        expect(text).toContain("found ERROR")
        expect(text).not.toContain("checked on save")
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Tool.node, lspToolNode]), [
            Config.node.replace(configured({ fake: { command: [process.execPath, server], extensions: [".fake"] } })),
            Permission.node.replace(allowAllPermission),
            Location.node.replace(
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
              ),
            ),
          ]),
        ),
      )
    }),
  )

  it.live("starts no server while the project is untrusted, and starts one once it is trusted", () =>
    Effect.gen(function* () {
      const directory = (yield* tmpdirScoped()).path
      const file = path.join(directory, "main.fake")
      yield* Effect.promise(() => Bun.write(file, "here is an ERROR\n"))
      yield* Effect.gen(function* () {
        const lsp = yield* Lsp.Service
        const trust = yield* WorkspaceTrust.Service
        const hover = lsp.request("textDocument/hover", file, { position: { line: 0, character: 0 } })

        // The server is in config that trust never touches, so only the folder's decision keeps it from starting.
        expect(yield* lsp.diagnostics([file])).toEqual({})
        expect(yield* lsp.diagnostics([file], { save: true })).toEqual({})
        expect((yield* hover.pipe(Effect.flip)).message).toBe("Language servers stay off until this folder is trusted.")

        yield* trust.grant(directory, { persist: false, via: "test" })
        expect(Object.keys(yield* lsp.diagnostics([file]))).toEqual([file])
        expect((yield* lsp.diagnostics([file], { save: true }))[file]?.map((item) => item.message)).toEqual([
          "found ERROR",
          "checked on save (with text)",
        ])
        expect(yield* hover).toEqual({ contents: { kind: "markdown", value: "a fake symbol" } })

        yield* trust.revoke(directory)
        expect(yield* lsp.diagnostics([file])).toEqual({})
        expect(yield* lsp.diagnostics([file], { save: true })).toEqual({})
        expect((yield* hover.pipe(Effect.flip)).message).toBe("Language servers stay off until this folder is trusted.")
      }).pipe(
        Effect.provide(
          AppNodeBuilder.build(LayerNode.group([Lsp.node, WorkspaceTrust.node]), [
            Config.node.replace(configured({ fake: { command: [process.execPath, server], extensions: [".fake"] } })),
            WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
            Location.node.replace(
              Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
              ),
            ),
          ]),
        ),
      )
    }),
  )
})
