// "What is shown is what runs", the server's half. Every approval is built from the permission request, so this test pins
// that the request carries the place, files and diffs a tool really acts on, whatever spelling of the path the model used
// and whatever keys it added to its input. The rows it records are the committed fixture `fixture/approval-matrix.json`,
// which the terminal UI, Mini, ACP and VS Code matrix tests draw from: a client that shows anything other than the
// request's values fails there, and a tool whose request drifts from what it does fails here (class 8, class 14).
//
// Set UPDATE_APPROVAL_MATRIX=1 to rewrite the fixture after changing a row on purpose.
import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { NotebookEditTool } from "@orbit/core/tool/plugin/notebook-edit"
import { PatchTool } from "@orbit/core/tool/plugin/patch"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { Global } from "@orbit/util/global"
import { FSUtil } from "@orbit/util/fs-util"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_approval_values_test")
const plugins = makeLocationNode({
  name: "test/approval-values-plugins",
  layer: Layer.effectDiscard(
    Effect.all([
      registerToolPlugin(EditTool.Plugin),
      registerToolPlugin(WriteTool.Plugin),
      registerToolPlugin(PatchTool.Plugin),
      registerToolPlugin(NotebookEditTool.Plugin),
    ]),
  ),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Location.node,
    Permission.node,
  ],
})

const it = testEffect(Layer.empty)
const fixturePath = path.join(import.meta.dir, "fixture", "approval-matrix.json")

// Keys a model can add to its own input. A tool's schema drops the ones it does not declare and a request is built from
// what the tool resolved, so none of them may reach a request. Each carries the decoy that must never be shown.
const decoy = "DECOY-MODEL-ADDED"
const added: Record<string, unknown> = {
  path: `${decoy}/path.txt`,
  filePath: `${decoy}/filePath.txt`,
  filepath: `${decoy}/filepath.txt`,
  notebook_path: `${decoy}/notebook.ipynb`,
  file_path: `${decoy}/file_path.txt`,
  cwd: `${decoy}/cwd`,
  workdir: `${decoy}/workdir`,
  paths: [`${decoy}/paths.txt`],
  files: [{ file: `${decoy}/files.txt`, patch: `--- ${decoy}\n+++ ${decoy}\n@@ -1 +1 @@\n-a\n+b\n` }],
  url: `https://${decoy.toLowerCase()}.example/`,
  method: "POST",
}
const withAdded = (own: Record<string, unknown>) => ({
  ...Object.fromEntries(Object.entries(added).filter(([key]) => !(key in own))),
  ...own,
})

const notebook = JSON.stringify({
  cells: [{ cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["print(1)"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
})

type World = { project: string; outside: string }
type Row = {
  id: string
  tool: string
  input: Record<string, unknown>
  request: { action: string; resources: readonly string[]; metadata?: Record<string, unknown> }
  truth: { places: string[]; files: { place: string; from?: string }[] }
}
const recorded: Row[] = []

// Each spelling of the path to a file: the folder it really is in, and how the input writes the path up to the file's
// name. A link row reaches the outside folder through a junction (a symlink off Windows) named `linked`.
const spellings: {
  name: string
  link?: true
  folder: (world: World) => string
  spelled: (world: World) => string
  only?: NodeJS.Platform
}[] = [
  { name: "relative path", folder: (w) => path.join(w.project, "src"), spelled: () => "src/file" },
  {
    name: "absolute path",
    folder: (w) => path.join(w.project, "src"),
    spelled: (w) => path.join(w.project, "src", "file"),
  },
  { name: "dot-dot path", folder: (w) => w.outside, spelled: (w) => `../${path.basename(w.outside)}/file` },
  { name: "absolute path outside", folder: (w) => w.outside, spelled: (w) => path.join(w.outside, "file") },
  {
    name: "tilde path",
    folder: (w) => w.outside,
    spelled: (w) => `~/${path.relative(Global.Path.home, w.outside).replaceAll("\\", "/")}/file`,
  },
  { name: "link", link: true, folder: (w) => w.outside, spelled: () => "linked/file" },
  {
    name: "git bash drive path",
    only: "win32",
    folder: (w) => w.outside,
    spelled: (w) => `/${w.outside[0]!.toLowerCase()}${w.outside.slice(2).replaceAll("\\", "/")}/file`,
  },
]

const tools = ["Edit", "Write", "NotebookEdit", "Patch", "Patch (move)", "Read", "LSP"] as const

describe("approval values: the request carries what the tool acts on", () => {
  for (const trusted of [false, true])
    for (const tool of tools)
      for (const spelling of spellings.filter((item) => item.only === undefined || item.only === process.platform))
        it.live(`${tool} by ${spelling.name} in ${trusted ? "a trusted" : "an untrusted"} folder`, () =>
          Effect.acquireUseRelease(
            Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
            ([project, outside]) =>
              Effect.gen(function* () {
                const world = { project: project.path, outside: outside.path }
                const extension = tool === "NotebookEdit" ? ".ipynb" : ".txt"
                const folder = spelling.folder(world)
                const spelled = `${spelling.spelled(world)}${extension}`
                const moved = `${spelling.spelled(world)}-moved.txt`
                // Where the file is, and the place a request must name for it: through a link in an untrusted folder
                // that is the real folder, and in a trusted one the path the project spells.
                const real = path.join(folder, `file${extension}`)
                const named = (name: string) =>
                  spelling.link && trusted ? path.join(project.path, "linked", name) : path.join(folder, name)
                yield* Effect.promise(async () => {
                  await fs.mkdir(folder, { recursive: true })
                  if (spelling.link) await fs.symlink(outside.path, path.join(project.path, "linked"), "junction")
                  if (tool !== "Write") await fs.writeFile(real, tool === "NotebookEdit" ? notebook : "alpha\n")
                })
                const input: Record<string, unknown> =
                  tool === "Edit"
                    ? { file_path: spelled, old_string: "alpha", new_string: "beta" }
                    : tool === "Write"
                      ? { file_path: spelled, content: "written\n" }
                      : tool === "NotebookEdit"
                        ? { notebook_path: spelled, mode: "replace", cellId: "calc", source: "print(2)" }
                        : tool === "Patch"
                          ? {
                              patchText: `*** Begin Patch\n*** Update File: ${spelled}\n@@\n-alpha\n+beta\n*** End Patch`,
                            }
                          : tool === "Patch (move)"
                            ? {
                                patchText: `*** Begin Patch\n*** Update File: ${spelled}\n*** Move to: ${moved}\n@@\n-alpha\n+beta\n*** End Patch`,
                              }
                            : { file_path: spelled }
                const call = withAdded(input)
                const assertions: Permission.AssertInput[] = []
                // The places the tool reports as its first act, for a client to name when no rule asks about the call.
                const reported: Tool.Metadata[] = []
                const progress = (update: Tool.Metadata) => Effect.sync(() => void reported.push(update))
                yield* withTools(project.path, assertions, trusted, (registry, access) =>
                  tool === "Read" || tool === "LSP"
                    ? // Read and LSP ask through the same door: the place is resolved once, for both.
                      access
                        .authorizeRead(spelled, { sessionID, ...toolIdentity, id: Tool.CallID.make("call-values"), progress })
                        .pipe(Effect.asVoid)
                    : executeTool(registry, {
                        sessionID,
                        progress,
                        ...toolIdentity,
                        call: {
                          type: "tool-call",
                          id: "call-values",
                          name: tool === "Patch (move)" ? "Patch" : tool,
                          input: call,
                        },
                      }).pipe(
                        Effect.tap((result) => Effect.sync(() => expect(result.status).toBe("completed"))),
                        Effect.asVoid,
                      ),
                )

                // The request about the file (an external folder is asked first, on its own request).
                const request = assertions.find((item) => item.action !== "external_directory")
                expect(request).toBeDefined()
                const places =
                  tool === "Patch (move)" ? [named("file.txt"), named("file-moved.txt")] : [named(path.basename(real))]
                const same = (items: readonly string[]) => items.map((item) => FSUtil.resolve(item))
                expect(same(request!.metadata?.paths as string[])).toEqual(same(places))
                expect(JSON.stringify(request)).not.toContain(decoy)
                // The tool reported the same places before it asked or acted (the last report is the whole of a patch).
                expect(same(reported.at(-1)?.places as string[])).toEqual(same(places))
                expect(JSON.stringify(reported)).not.toContain(decoy)

                // The runner acted where the request says, and on no decoy.
                const content = (name: string) => fs.readFile(name, "utf8")
                const acted = yield* Effect.promise(async () =>
                  tool === "Edit" || tool === "Patch"
                    ? content(real)
                    : tool === "Write"
                      ? content(real)
                      : tool === "NotebookEdit"
                        ? content(real)
                        : tool === "Patch (move)"
                          ? content(path.join(folder, "file-moved.txt"))
                          : "",
                )
                if (tool === "Edit" || tool === "Patch" || tool === "Patch (move)") expect(acted).toBe("beta\n")
                if (tool === "Write") expect(acted).toBe("written\n")
                if (tool === "NotebookEdit") expect(acted).toContain("print(2)")

                // Each diff names the place it will be written to, and a moved file the place it comes from.
                const files = (request!.metadata?.files ?? []) as { file: string; place?: string; from?: string }[]
                if (tool !== "Read" && tool !== "LSP") {
                  expect(files).toHaveLength(1)
                  expect(same([files[0]!.place!])).toEqual(same([places.at(-1)!]))
                  if (tool === "Patch (move)") expect(same([files[0]!.from!])).toEqual(same([places[0]!]))
                }

                recorded.push(
                  normalize(
                    {
                      id: `${tool}/${spelling.name}/${trusted ? "trusted" : "untrusted"}`,
                      tool: tool === "Patch (move)" ? "Patch" : tool,
                      input: call,
                      request: {
                        action: request!.action,
                        resources: request!.resources,
                        metadata: request!.metadata,
                      },
                      truth: {
                        places,
                        files: files.map(() => ({
                          place: places.at(-1)!,
                          ...(tool === "Patch (move)" ? { from: places[0]! } : {}),
                        })),
                      },
                    },
                    world,
                  ),
                )
              }),
            ([project, outside]) =>
              Effect.promise(() =>
                Promise.all([project[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
              ),
          ),
        )

  // The requests of the tools that are not in the matrix above are written by hand in `approval-matrix-pinned.json`. Each
  // row names the core test that pins that request, and that test must still assert every key the row carries.
  it.live("each hand-written row is pinned by a core test that asserts its keys", () =>
    Effect.promise(async () => {
      const pinned = JSON.parse(
        await fs.readFile(path.join(import.meta.dir, "fixture", "approval-matrix-pinned.json"), "utf8"),
      ) as {
        id: string
        pinnedBy: string
        request: { metadata: Record<string, unknown> }
      }[]
      expect(pinned.length).toBeGreaterThan(0)
      for (const row of pinned) {
        const source = await fs.readFile(path.join(import.meta.dir, row.pinnedBy), "utf8")
        for (const key of Object.keys(row.request.metadata).filter((item) => item !== "root" && item !== "format"))
          expect([row.id, source.includes(key)]).toEqual([row.id, true])
      }
    }),
  )

  // The committed fixture is what the client tests draw from: every row of this run is in it, as the tools asked.
  it.live("the committed matrix is what the tools asked", () =>
    Effect.promise(async () => {
      expect(recorded.length).toBeGreaterThan(0)
      if (process.env.UPDATE_APPROVAL_MATRIX) {
        // A row that only exists on one platform is kept from the fixture that is already there.
        const current: Row[] = await fs.readFile(fixturePath, "utf8").then(
          (text) => JSON.parse(text),
          () => [],
        )
        const rows = [...current.filter((item) => !recorded.some((row) => row.id === item.id)), ...recorded]
        await fs.writeFile(
          fixturePath,
          `${JSON.stringify(
            rows.toSorted((a, b) => a.id.localeCompare(b.id)),
            null,
            2,
          )}\n`,
        )
        return
      }
      const committed: Row[] = JSON.parse(await fs.readFile(fixturePath, "utf8"))
      for (const row of recorded) expect(committed.find((item) => item.id === row.id)).toEqual(row)
    }),
  )
})

const withTools = <A, E, R>(
  directory: string,
  assertions: Permission.AssertInput[],
  trusted: boolean,
  body: (registry: Tool.Interface, access: FileAccess.Interface) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const access = yield* FileAccess.Service
    return yield* body(registry, access)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, FileLedger.node, plugins]), [
        FileLedger.node.replace(FileLedger.permissiveLayer),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
        Permission.node.replace(permissionLayer({ assert: (input) => Effect.sync(() => void assertions.push(input)) })),
        ...(trusted ? [] : untrustedProjectNodes),
      ]),
    ),
  )

// The recorded rows name no temporary folder: the project and the outside folder are tokens, in whichever slash style
// the tool wrote them, and the folders' own names are tokens too.
function normalize(row: Row, world: World): Row {
  // The Git Bash spelling of a Windows drive path is `/c/Users/...`.
  const bash = (value: string) => (/^[A-Za-z]:/.test(value) ? `/${value[0]!.toLowerCase()}${value.slice(2)}` : value)
  const forms = (value: string) =>
    [value, value.replaceAll("\\", "/"), bash(value.replaceAll("\\", "/"))].flatMap((item) => [
      JSON.stringify(item).slice(1, -1),
      item,
    ])
  const replacements = [
    ...forms(world.outside).map((item) => [item, "{outside}"] as const),
    ...forms(world.project).map((item) => [item, "{project}"] as const),
    [path.basename(world.outside), "{outsideName}"] as const,
  ]
  const text = replacements.reduce((current, [from, to]) => current.replaceAll(from, to), JSON.stringify(row))
  // The slashes after a token are forward slashes in the fixture, so that it reads the same on every platform.
  return JSON.parse(text, (_key, value) =>
    typeof value === "string" && /\{(?:project|outside)\}/.test(value) ? value.replaceAll("\\", "/") : value,
  )
}
