import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FileMutation } from "@orbit/core/file-mutation"
import { FileLedger } from "@orbit/core/file-ledger"
import { Formatter } from "@orbit/core/formatter"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Environment } from "@orbit/core/environment/index"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { Tool } from "@orbit/core/tool"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdir, withTempDir } from "./fixture/tmpdir"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

const writeToolNode = makeLocationNode({
  name: "test/write-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(WriteTool.Plugin)),
  deps: [
    FileLedger.node,
    Tool.node,
    FileAccess.node,
    FileMutation.node,
    Environment.node,
    Formatter.node,
    Permission.node,
  ],
})

const sessionID = Session.ID.make("ses_write_tool_test")
const makeWriteFixture = () => {
  const fixture: {
    assertions: Permission.AssertInput[]
    writes: string[]
    denyAction?: string
    formatFile: (target: string) => Effect.Effect<boolean>
  } = {
    assertions: [],
    writes: [],
    formatFile: () => Effect.succeed(false),
  }

  const permission = permissionLayer({
    assert: (input) =>
      Effect.sync(() => fixture.assertions.push(input)).pipe(
        Effect.andThen(
          input.action === fixture.denyAction
            ? Effect.fail(
                new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            : Effect.void,
        ),
      ),
  })

  const formatter = Layer.mock(Formatter.Service, {
    file: (target) => fixture.formatFile(target),
  })

  return Object.assign(fixture, { permission, formatter })
}

const withTool = <A, E, R>(
  directory: string,
  fixture: ReturnType<typeof makeWriteFixture>,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R | FileLedger.Service>,
  // The core tests trust every folder, unless the project is untrusted.
  untrusted = false,
  // The permissive ledger allows every change. The real one asks that the session has read the file.
  ledger: "permissive" | "real" = "permissive",
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, FileLedger.node, writeToolNode]),
        [
          ...(ledger === "real" ? [] : [FileLedger.node.replace(FileLedger.permissiveLayer)]),
          Environment.node.replace(
            transformEnvironmentFiles((files) => ({
              write: (target, content) =>
                Effect.sync(() => fixture.writes.push(target)).pipe(Effect.andThen(files.write(target, content))),
            })),
          ),
          Location.node.replace(activeLocation),
          Formatter.node.replace(fixture.formatter),
          Permission.node.replace(fixture.permission),
          ...(untrusted ? untrustedProjectNodes : []),
        ],
      ),
    ),
  )
}

const call = (input: typeof WriteTool.Input.Type, id = "call-write") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "Write", input },
})

const it = testEffect(Layer.empty)

describe("WriteTool", () => {
  it.live("changes files, so it is neither read-only nor safe beside other calls", () =>
    withTempDir((tmp) =>
      withTool(tmp.path, makeWriteFixture(), (registry) =>
        Effect.gen(function* () {
          expect(yield* toolTraits(registry, "Write", { file_path: "a.txt", content: "a" })).toMatchObject({
            readOnly: false,
            concurrencySafe: false,
            destructive: false,
          })
        }),
      ),
    ),
  )

  it.live("registers and creates a relative file through FileMutation once", () =>
    withTempDir((tmp) => {
      const fixture = makeWriteFixture()
      return withTool(tmp.path, fixture, (registry) =>
        Effect.gen(function* () {
          expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["Write", "execute"])
          const settled = yield* executeTool(registry, call({ file_path: "src/new.txt", content: "created" }))
          expect(settled).toEqual({
            status: "completed",
            output: {
              operation: "write",
              target: path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
              resource: "src/new.txt",
              existed: false,
            },
            content: [{ type: "text", text: "Created file successfully: src/new.txt" }],
          })
          expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "src", "new.txt"), "utf8"))).toBe(
            "created",
          )
          expect(fixture.assertions).toMatchObject([
            { sessionID, action: "Edit", resources: ["src/new.txt"], save: ["*"] },
          ])
          expect(fixture.assertions[0]?.metadata).toMatchObject({
            files: [
              {
                file: "src/new.txt",
                status: "added",
                additions: 1,
                deletions: 0,
                patch: expect.stringContaining("+created"),
              },
            ],
          })
          expect(fixture.writes).toEqual([
            path.join(yield* Effect.promise(() => fs.realpath(tmp.path)), "src", "new.txt"),
          ])
        }),
      )
    }),
  )

  it.live("formats the committed file", () =>
    withTempDir((tmp) => {
      const fixture = makeWriteFixture()
      const target = path.join(tmp.path, "formatted.txt")
      fixture.formatFile = (file) =>
        Effect.promise(async () => {
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).toUpperCase())
          return true
        })
      return withTool(tmp.path, fixture, (registry) =>
        Effect.gen(function* () {
          expect(yield* executeTool(registry, call({ file_path: "formatted.txt", content: "format me" }))).toMatchObject({
            status: "completed",
          })
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("FORMAT ME")
        }),
      )
    }),
  )

  it.live("overwrites a relative existing file and reports that it wrote the file", () =>
    withTempDir((tmp) => {
      const fixture = makeWriteFixture()
      return Effect.promise(() => fs.writeFile(path.join(tmp.path, "existing.txt"), "before")).pipe(
        Effect.andThen(
          withTool(tmp.path, fixture, (registry) =>
            executeTool(registry, call({ file_path: "existing.txt", content: "after" })),
          ),
        ),
        Effect.andThen((settled) =>
          Effect.gen(function* () {
            expect(settled.status).toBe("completed")
            if (settled.status !== "completed") return
            expect(settled.content).toEqual([{ type: "text", text: "Wrote file successfully: existing.txt" }])
            expect(settled.output).toMatchObject({ resource: "existing.txt", existed: true })
            expect(fixture.assertions[0]?.metadata).toMatchObject({
              files: [
                {
                  file: "existing.txt",
                  status: "modified",
                  additions: 1,
                  deletions: 1,
                  patch: expect.stringMatching(/-before[\s\S]*\+after/),
                },
              ],
            })
            expect(yield* Effect.promise(() => fs.readFile(path.join(tmp.path, "existing.txt"), "utf8"))).toBe("after")
            expect(fixture.writes).toHaveLength(1)
          }),
        ),
      )
    }),
  )

  it.live("preserves exactly one BOM when overwriting existing files", () =>
    withTempDir((tmp) => {
      const fixture = makeWriteFixture()
      const preserved = path.join(tmp.path, "preserved.txt")
      const deduplicated = path.join(tmp.path, "deduplicated.txt")
      fixture.formatFile = (target) =>
        Effect.promise(async () => {
          await fs.writeFile(target, `\uFEFF\uFEFF\uFEFF${(await fs.readFile(target, "utf8")).replace(/^\uFEFF+/, "")}`)
          return true
        })
      return Effect.promise(() =>
        Promise.all([fs.writeFile(preserved, "\uFEFFbefore"), fs.writeFile(deduplicated, "\uFEFFbefore")]),
      ).pipe(
        Effect.andThen(
          withTool(tmp.path, fixture, (registry) =>
            Effect.gen(function* () {
              yield* executeTool(registry, call({ file_path: "preserved.txt", content: "after" }, "call-preserved"))
              yield* executeTool(
                registry,
                call({ file_path: "deduplicated.txt", content: "\uFEFFafter" }, "call-deduplicated"),
              )

              expect(yield* Effect.promise(() => fs.readFile(preserved, "utf8"))).toBe("\uFEFFafter")
              expect(yield* Effect.promise(() => fs.readFile(deduplicated, "utf8"))).toBe("\uFEFFafter")
            }),
          ),
        ),
      )
    }),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    withTempDir((tmp) => {
      const fixture = makeWriteFixture()
      const target = path.join(tmp.path, "absolute.txt")
      return withTool(tmp.path, fixture, (registry) =>
        executeTool(registry, call({ file_path: target, content: "inside" })),
      ).pipe(
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result).toMatchObject({
              status: "completed",
              content: [{ type: "text", text: "Created file successfully: absolute.txt" }],
            })
            expect(fixture.assertions.map((input) => input.action)).toEqual(["Edit"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("inside")
          }),
        ),
      )
    }),
  )

  it.live("writes an external symlink target with only its in-location permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const fixture = makeWriteFixture()
        if (process.platform === "win32") return Effect.void
        const target = path.join(outside.path, "external.txt")
        const link = path.join(active.path, "link.txt")
        return Effect.promise(async () => {
          await fs.writeFile(target, "before")
          await fs.symlink(target, link)
        }).pipe(
          Effect.andThen(
            withTool(active.path, fixture, (registry) =>
              executeTool(registry, call({ file_path: "link.txt", content: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.sync(() => {
              expect(result.status).toBe("completed")
              expect(fixture.assertions.map((input) => input.action)).toEqual(["Edit"])
              expect(fixture.assertions[0]?.resources).toEqual(["link.txt"])
            }),
          ),
          Effect.andThen(Effect.promise(() => fs.readFile(target, "utf8"))),
          Effect.tap((content) => Effect.sync(() => expect(content).toBe("after"))),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("approves an explicit external absolute path before edit", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const fixture = makeWriteFixture()
        const target = path.join(outside.path, "external.txt")
        return withTool(active.path, fixture, (registry) =>
          executeTool(registry, call({ file_path: target, content: "external" })),
        ).pipe(
          Effect.andThen((settled) =>
            Effect.gen(function* () {
              const absoluteTarget = target
              expect(fixture.assertions.map((input) => input.action)).toEqual(["external_directory", "Edit"])
              expect(fixture.assertions[0]).toMatchObject({
                resources: [path.join(outside.path, "*").replaceAll("\\", "/")],
              })
              expect(fixture.assertions[1]).toMatchObject({
                resources: [absoluteTarget.replaceAll("\\", "/")],
                save: ["*"],
              })
              expect(settled).toMatchObject({
                status: "completed",
                output: {
                  target: absoluteTarget,
                  resource: absoluteTarget.replaceAll("\\", "/"),
                  existed: false,
                },
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("external")
              expect(fixture.writes).toEqual([absoluteTarget])
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("saves external directory approval at the nearest project directory", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const fixture = makeWriteFixture()
        const repo = path.join(outside.path, "repo")
        const nested = path.join(repo, "packages", "app")
        const target = path.join(nested, "external.txt")
        return Effect.promise(() =>
          Promise.all([fs.mkdir(path.join(repo, ".git"), { recursive: true }), fs.mkdir(nested, { recursive: true })]),
        ).pipe(
          Effect.andThen(
            withTool(active.path, fixture, (registry) =>
              executeTool(registry, call({ file_path: target, content: "external" })),
            ),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              expect(fixture.assertions[0]).toMatchObject({
                action: "external_directory",
                resources: [path.join(nested, "*").replaceAll("\\", "/")],
                save: [path.join(repo, "*").replaceAll("\\", "/")],
              })
            }),
          ),
        )
      },
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  // The repository ships its links, and a clone recreates them. In a project that is not trusted a link that leads out
  // of it is outside like any other path, so the write asks about the folder it would reach and creates nothing when
  // that is refused. A junction stands for the link, since it needs no privilege on Windows.
  for (const item of [
    { project: "untrusted", untrusted: true, actions: ["external_directory", "Edit"] },
    { project: "trusted", untrusted: false, actions: ["Edit"] },
  ])
    it.live(
      `${item.untrusted ? "asks" : "does not ask"} about the folder a link leads to in a ${item.project} project`,
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
          ([active, outside]) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => fs.symlink(outside.path, path.join(active.path, "out"), "junction"))
              const created = path.join(outside.path, "pwned.txt")
              const fixture = makeWriteFixture()
              const settled = yield* withTool(
                active.path,
                fixture,
                (registry) => executeTool(registry, call({ file_path: "out/pwned.txt", content: "pwned" })),
                item.untrusted,
              )
              expect(settled.status).toBe("completed")
              expect(fixture.assertions.map((input) => input.action)).toEqual(item.actions)
              if (item.untrusted) {
                const real = yield* Effect.promise(() => fs.realpath(outside.path))
                expect(fixture.assertions[0]).toMatchObject({ resources: [path.join(real, "*").replaceAll("\\", "/")] })
              }
              expect(yield* Effect.promise(() => fs.readFile(created, "utf8"))).toBe("pwned")
            }),
          ([active, outside]) =>
            Effect.promise(() =>
              Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
            ),
        ),
    )

  it.live("creates nothing through a link out of an untrusted project when the approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.symlink(outside.path, path.join(active.path, "out"), "junction"))
          const fixture = makeWriteFixture()
          fixture.denyAction = "external_directory"
          expect(
            yield* withTool(
              active.path,
              fixture,
              (registry) => executeTool(registry, call({ file_path: "out/pwned.txt", content: "pwned" })),
              true,
            ),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: external_directory" },
          })
          expect(fixture.assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(fixture.writes).toEqual([])
          expect(yield* Effect.promise(() => Bun.file(path.join(outside.path, "pwned.txt")).exists())).toBe(false)
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("does not write when external_directory or edit approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const external = path.join(outside.path, "denied.txt")
          const fixture = makeWriteFixture()
          fixture.denyAction = "external_directory"
          expect(
            yield* withTool(active.path, fixture, (registry) =>
              executeTool(registry, call({ file_path: external, content: "blocked" })),
            ),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: external_directory" },
          })
          expect(fixture.assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(fixture.writes).toEqual([])

          const deniedEdit = makeWriteFixture()
          deniedEdit.denyAction = "Edit"
          expect(
            yield* withTool(active.path, deniedEdit, (registry) =>
              executeTool(registry, call({ file_path: "denied.txt", content: "blocked" })),
            ),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: Edit" },
          })
          expect(deniedEdit.assertions.map((input) => input.action)).toEqual(["Edit"])
          expect(deniedEdit.writes).toEqual([])
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  it.live("names a file the session has not read, and one that changed since, with the ledger's codes", () =>
    withTempDir((tmp) => {
      const fixture = makeWriteFixture()
      const target = path.join(tmp.path, "ledger.txt")
      return Effect.promise(() => fs.writeFile(target, "before")).pipe(
        Effect.andThen(
          withTool(
            tmp.path,
            fixture,
            (registry) =>
              Effect.gen(function* () {
                expect(yield* executeTool(registry, call({ file_path: "ledger.txt", content: "after" }))).toEqual({
                  status: "error",
                  error: {
                    type: "file.unread",
                    message: "ledger.txt has not been read in this session. Read it before changing it.",
                  },
                })

                yield* (yield* FileLedger.Service).record(sessionID, target)
                const later = new Date(Date.now() + 60_000)
                yield* Effect.promise(() => fs.utimes(target, later, later))
                expect(yield* executeTool(registry, call({ file_path: "ledger.txt", content: "after" }))).toEqual({
                  status: "error",
                  error: {
                    type: "file.stale",
                    message: "ledger.txt changed since it was last read. Read it again before changing it.",
                  },
                })
                expect(fixture.assertions).toEqual([])
                expect(fixture.writes).toEqual([])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
              }),
            false,
            "real",
          ),
        ),
      )
    }),
  )
})
