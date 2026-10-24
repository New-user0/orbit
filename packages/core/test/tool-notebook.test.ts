import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileLedger } from "@orbit/core/file-ledger"
import { readNow } from "./fixture/ledger"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Environment } from "@orbit/core/environment/index"
import { FileMutation } from "@orbit/core/file-mutation"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { Notebook } from "@orbit/core/tool/notebook"
import { NotebookEditTool } from "@orbit/core/tool/plugin/notebook-edit"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolTraits } from "./lib/tool"

const notebookToolNode = makeLocationNode({
  name: "test/notebook-edit-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(NotebookEditTool.Plugin)),
  deps: [
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    FileLedger.node,
    Environment.node,
    Location.node,
    Permission.node,
  ],
})

const sessionID = Session.ID.make("ses_notebook_tool_test")
const it = testEffect(Layer.empty)

const notebook = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: {},
      source: ["# Title\n", "Some notes"],
    },
    {
      cell_type: "code",
      execution_count: 1,
      id: "calc",
      metadata: {},
      outputs: [
        { output_type: "stream", name: "stdout", text: ["2\n"] },
        { output_type: "display_data", data: { "image/png": "aGk=", "text/plain": ["<Figure>"] }, metadata: {} },
      ],
      source: ["print(1 + 1)"],
    },
  ],
  metadata: { kernelspec: { name: "python3" } },
  nbformat: 4,
  nbformat_minor: 5,
}

// Runs inside the permission assert, so it stands for a write that lands while the person is deciding.
let afterApproval = (): Effect.Effect<void> => Effect.void
// Runs after each write of the notebook, so it stands for something that changes the file before the tool reads it back.
let afterWrite = (_target: string): Effect.Effect<void> => Effect.void

const withTool = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R | FileLedger.Service>,
  // The permissive ledger allows every change. The real one asks that the session has read the file.
  ledger: "permissive" | "real" = "permissive",
) =>
  Effect.gen(function* () {
    return yield* body(yield* Tool.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, FileLedger.node, notebookToolNode]),
        [
          ...(ledger === "real" ? [] : [FileLedger.node.replace(FileLedger.permissiveLayer)]),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ),
          Permission.node.replace(permissionLayer({ assert: () => Effect.suspend(() => afterApproval()) })),
          Environment.node.replace(
            transformEnvironmentFiles((files) => ({
              write: (target, content) =>
                files.write(target, content).pipe(Effect.andThen(Effect.suspend(() => afterWrite(target)))),
            })),
          ),
        ],
      ),
    ),
  )

const call = (input: typeof NotebookEditTool.Input.Type) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: "call-notebook", name: "NotebookEdit", input },
})

describe("Notebook", () => {
  it.effect("renders cells with their ids, sources and text outputs", () =>
    Effect.sync(() => {
      expect(Notebook.render(Notebook.parse(JSON.stringify(notebook))!)).toBe(
        [
          '<cell index="0" id="intro" type="markdown">',
          "# Title\nSome notes",
          "</cell>",
          "",
          '<cell index="1" id="calc" type="code">',
          "print(1 + 1)",
          "<outputs>",
          "2",
          "<Figure>",
          "[image/png output omitted]",
          "</outputs>",
          "</cell>",
        ].join("\n"),
      )
      expect(Notebook.parse("{}")).toBeUndefined()
      expect(Notebook.parse("not json")).toBeUndefined()
    }),
  )
})

describe("NotebookEditTool", () => {
  it.effect("changes notebooks, so it is neither read-only nor safe beside other calls", () =>
    withTool(import.meta.dir, (registry) =>
      Effect.gen(function* () {
        expect(yield* toolTraits(registry, "NotebookEdit", {})).toMatchObject({
          readOnly: false,
          concurrencySafe: false,
          destructive: false,
        })
      }),
    ),
  )

  it.live("replaces, inserts and deletes cells, keeping the file's layout and metadata", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "analysis.ipynb")
      const read = () => Effect.promise(() => fs.readFile(target, "utf8")).pipe(Effect.map((text) => JSON.parse(text)))
      return Effect.promise(() => fs.writeFile(target, `${JSON.stringify(notebook, null, 1)}\n`)).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const replaced = yield* executeTool(
                registry,
                call({ notebook_path: "analysis.ipynb", mode: "replace", cellId: "calc", source: "print(2 + 2)\nprint(3)" }),
              )
              expect(replaced.status).toBe("completed")
              const afterReplace = yield* read()
              expect(afterReplace.cells[1]).toMatchObject({
                id: "calc",
                source: ["print(2 + 2)\n", "print(3)"],
                outputs: [],
                execution_count: null,
              })
              expect(afterReplace.metadata).toEqual(notebook.metadata)
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toStartWith('{\n "cells"')

              yield* executeTool(
                registry,
                call({ notebook_path: "analysis.ipynb", mode: "insert", index: 1, cellType: "markdown", source: "Next" }),
              )
              const afterInsert = yield* read()
              expect(afterInsert.cells.map((cell: { source: string[] }) => cell.source.join(""))).toEqual([
                "# Title\nSome notes",
                "Next",
                "print(2 + 2)\nprint(3)",
              ])
              expect(afterInsert.cells[1].id).toMatch(/^[0-9a-f]{8}$/)

              yield* executeTool(registry, call({ notebook_path: "analysis.ipynb", mode: "delete", index: 0 }))
              expect((yield* read()).cells).toHaveLength(2)

              const missing = yield* executeTool(
                registry,
                call({ notebook_path: "analysis.ipynb", mode: "replace", cellId: "nope", source: "x" }),
              )
              expect(missing.status).toBe("error")
            }),
          ),
        ),
      )
    }),
  )

  it.live("fails edit.stale and keeps the external bytes when the notebook changes during approval", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "analysis.ipynb")
      const external = `${JSON.stringify({ ...notebook, metadata: { kernelspec: { name: "other" } } }, null, 1)}\n`
      afterApproval = () => Effect.promise(() => fs.writeFile(target, external))
      return Effect.promise(() => fs.writeFile(target, `${JSON.stringify(notebook, null, 1)}\n`)).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            executeTool(
              registry,
              call({ notebook_path: "analysis.ipynb", mode: "replace", cellId: "calc", source: "print(2)" }),
            ),
          ),
        ),
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result).toMatchObject({ status: "error", error: { type: "edit.stale" } })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(external)
          }),
        ),
        Effect.ensuring(Effect.sync(() => void (afterApproval = () => Effect.void))),
      )
    }),
  )

  it.live("completes when the notebook is touched during approval", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "analysis.ipynb")
      afterApproval = () =>
        Effect.promise(() => fs.utimes(target, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000)))
      return Effect.promise(() => fs.writeFile(target, `${JSON.stringify(notebook, null, 1)}\n`)).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            executeTool(
              registry,
              call({ notebook_path: "analysis.ipynb", mode: "replace", cellId: "calc", source: "print(2)" }),
            ),
          ),
        ),
        Effect.andThen((result) => Effect.sync(() => expect(result.status).toBe("completed"))),
        Effect.ensuring(Effect.sync(() => void (afterApproval = () => Effect.void))),
      )
    }),
  )

  it.live("names a notebook the session has not read, and one that changed since, with the ledger's codes", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "analysis.ipynb")
      const input = { notebook_path: "analysis.ipynb", mode: "delete", index: 0 } as const
      return Effect.promise(() => fs.writeFile(target, `${JSON.stringify(notebook, null, 1)}\n`)).pipe(
        Effect.andThen(
          withTool(
            tmp.path,
            (registry) =>
              Effect.gen(function* () {
                expect(yield* executeTool(registry, call(input))).toEqual({
                  status: "error",
                  error: {
                    type: "file.unread",
                    message: "analysis.ipynb has no read in this session behind it; read it before changing it.",
                  },
                })

                yield* readNow(sessionID, target)
                const later = new Date(Date.now() + 60_000)
                yield* Effect.promise(async () => {
                  await fs.appendFile(target, "\n")
                  await fs.utimes(target, later, later)
                })
                expect(yield* executeTool(registry, call(input))).toEqual({
                  status: "error",
                  error: {
                    type: "file.stale",
                    message: "analysis.ipynb changed on disk after your last read, so read it again before changing it.",
                  },
                })
                expect(JSON.parse(yield* Effect.promise(() => fs.readFile(target, "utf8"))).cells).toHaveLength(2)
              }),
            "real",
          ),
        ),
      )
    }),
  )
})

// clients-ux-5: a code rewind learns which files the session's file tools changed from the calls it recorded. A
// NotebookEdit that fails after it wrote (here the notebook becomes a folder before the tool reads it back) still changed
// the file, so the failed call names it too.
describe("NotebookEditTool records the file it changed, for code rewind", () => {
  it.live("names the file in a call that failed after writing", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "analysis.ipynb")
      afterWrite = (written) =>
        Effect.promise(async () => {
          await fs.rm(written)
          await fs.mkdir(written)
        })
      return Effect.promise(() => fs.writeFile(target, `${JSON.stringify(notebook, null, 1)}\n`)).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            registry.snapshot().pipe(
              Effect.flatMap((tools) =>
                tools.execute(call({ notebook_path: "analysis.ipynb", mode: "replace", cellId: "calc", source: "x" })),
              ),
              Effect.flip,
            ),
          ),
        ),
        Effect.map((failure) => expect(failure.metadata?.files).toEqual([{ file: "analysis.ipynb" }])),
        Effect.ensuring(Effect.sync(() => void (afterWrite = () => Effect.void))),
      )
    }),
  )
})
