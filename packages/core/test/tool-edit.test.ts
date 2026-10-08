import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileLedger } from "@orbit/core/file-ledger"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Environment } from "@orbit/core/environment/index"
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
import { Location } from "@orbit/core/location"
import { FileAccess } from "@orbit/core/file-access"
import { Permission } from "@orbit/core/permission"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { toSessionError } from "@orbit/core/session/to-session-error"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { ToolTraits } from "@orbit/core/tool/traits"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { tmpdir, withTempDir } from "./fixture/tmpdir"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { testEffect } from "./lib/effect"
import { permissionLayer } from "./lib/permission"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions, toolTraits } from "./lib/tool"

const editToolNode = makeLocationNode({
  name: "test/edit-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(EditTool.Plugin)),
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

const sessionID = Session.ID.make("ses_edit_tool_test")
const makeEditFixture = () => {
  const fixture: {
    assertions: Permission.AssertInput[]
    writes: string[]
    reads: number
    denyAction?: string
    // Makes every read fail the way a file system does.
    failReads: boolean
    afterRead: () => Effect.Effect<void>
    formatFile: (target: string) => Effect.Effect<boolean>
  } = {
    assertions: [],
    writes: [],
    reads: 0,
    failReads: false,
    afterRead: () => Effect.void,
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
  fixture: ReturnType<typeof makeEditFixture>,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R | FileLedger.Service>,
  options: {
    // The core tests trust every folder, unless the project is untrusted.
    readonly untrusted?: boolean
    // The permissive ledger allows every change, as most of these tests expect. The real one asks that the session
    // has read the file, and the body records the files it has read.
    readonly ledger?: "permissive" | "real"
  } = {},
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
        LayerNode.group([Tool.node, FileAccess.node, FileMutation.node, FileLedger.node, editToolNode]),
        [
          ...(options.ledger === "real" ? [] : [FileLedger.node.replace(FileLedger.permissiveLayer)]),
          Environment.node.replace(
            transformEnvironmentFiles((files) => ({
              read: (target, range) =>
                (fixture.failReads
                  ? Effect.fail(new Environment.Failed({ path: target, cause: "disk on fire" }))
                  : files.read(target, range)
                ).pipe(
                  Effect.tap(() => Effect.sync(() => fixture.reads++).pipe(Effect.andThen(() => fixture.afterRead()))),
                ),
              write: (target, content) =>
                Effect.sync(() => fixture.writes.push(target)).pipe(Effect.andThen(files.write(target, content))),
            })),
          ),
          Location.node.replace(activeLocation),
          Formatter.node.replace(fixture.formatter),
          Permission.node.replace(fixture.permission),
          ...(options.untrusted ? untrustedProjectNodes : []),
        ],
      ),
    ),
  )
}

const call = (input: typeof EditTool.Input.Type, id = "call-edit") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "Edit", input },
})

// Runs the edit tool's own `validate` and nothing else, as the registry does for a call.
const validateEdit = (registry: Tool.Interface, input: typeof EditTool.Input.Type) =>
  Effect.gen(function* () {
    const tool = (yield* registry.list()).find((item) => item.id === EditTool.name)
    if (tool?.validate === undefined) return yield* Effect.die("The edit tool has no validate")
    return yield* tool.validate(input, {
      sessionID,
      ...toolIdentity,
      id: Tool.CallID.make("call-validate"),
      progress: () => Effect.void,
      traits: ToolTraits.defaults,
    })
  })

const it = testEffect(Layer.empty)

describe("EditTool", () => {
  it.live("changes files, so it is neither read-only nor safe beside other calls", () =>
    withTempDir((tmp) =>
      withTool(tmp.path, makeEditFixture(), (registry) =>
        Effect.gen(function* () {
          expect(yield* toolTraits(registry, "Edit", { file_path: "a.txt", old_string: "a", new_string: "b" })).toMatchObject({
            readOnly: false,
            concurrencySafe: false,
            destructive: false,
          })
        }),
      ),
    ),
  )

  it.live("registers and replaces relative exact text through FileMutation once", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "hello.txt")
      return Effect.promise(() => fs.writeFile(target, "before\nrest\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["Edit", "execute"])
              expect(
                (yield* toolDefinitions(registry, [{ action: "Edit", resource: "*", effect: "deny" }])).map(
                  (tool) => tool.name,
                ),
              ).toEqual(["execute"])
              const settled = yield* executeTool(
                registry,
                call({ file_path: "hello.txt", old_string: "before", new_string: "after" }),
              )
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.content).toEqual([
                {
                  type: "text",
                  text: "Edited hello.txt (1 replacement)",
                },
              ])
              // Compact UI metadata carries the file diffs the TUI renders.
              expect(settled.metadata).toMatchObject({
                files: [{ file: "hello.txt", status: "modified", additions: 1, deletions: 1 }],
              })
              expect(settled.output).toEqual({
                replacements: 1,
                files: [
                  {
                    file: "hello.txt",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    patch: expect.stringContaining("-before\n+after"),
                  },
                ],
              })
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\nrest\n")
              expect(edit.assertions).toMatchObject([
                { sessionID, action: "Edit", resources: ["hello.txt"], save: ["*"] },
              ])
              expect(edit.assertions[0]?.metadata).toMatchObject({
                files: [
                  {
                    file: "hello.txt",
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    patch: expect.stringContaining("-before\n+after"),
                  },
                ],
              })
              expect(edit.writes).toEqual([yield* Effect.promise(() => fs.realpath(target))])
            }),
          ),
        ),
      )
    }),
  )

  it.live("returns the diff for final formatted content", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "formatted.txt")
      edit.formatFile = (file) =>
        Effect.promise(async () => {
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace("after", "AFTER"))
          return true
        })
      return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              const settled = yield* executeTool(
                registry,
                call({ file_path: "formatted.txt", old_string: "before", new_string: "after" }),
              )
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.output.files[0]?.patch).toContain("-before\n+AFTER")
              expect(settled.metadata?.files?.[0]?.patch).toContain("-before\n+AFTER")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("AFTER\n")
            }),
          ),
        ),
      )
    }),
  )

  it.live("accepts an absolute file path inside the active Location", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "absolute.txt")
      return Effect.promise(() => fs.writeFile(target, "before")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ file_path: target, old_string: "before", new_string: "after" })),
          ),
        ),
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result.status).toBe("completed")
            expect(edit.assertions.map((input) => input.action)).toEqual(["Edit"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
          }),
        ),
      )
    }),
  )

  it.live("edits an external symlink target with only its in-location permission", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) => {
        const edit = makeEditFixture()
        if (process.platform === "win32") return Effect.void
        const target = path.join(outside.path, "external.txt")
        const link = path.join(active.path, "link.txt")
        return Effect.promise(async () => {
          await fs.writeFile(target, "before")
          await fs.symlink(target, link)
        }).pipe(
          Effect.andThen(
            withTool(active.path, edit, (registry) =>
              executeTool(registry, call({ file_path: "link.txt", old_string: "before", new_string: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.sync(() => {
              expect(result.status).toBe("completed")
              expect(edit.assertions.map((input) => input.action)).toEqual(["Edit"])
              expect(edit.assertions[0]?.resources).toEqual(["link.txt"])
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
        const edit = makeEditFixture()
        const target = path.join(outside.path, "external.txt")
        return Effect.promise(() => fs.writeFile(target, "before")).pipe(
          Effect.andThen(
            withTool(active.path, edit, (registry) =>
              executeTool(registry, call({ file_path: target, old_string: "before", new_string: "after" })),
            ),
          ),
          Effect.andThen((result) =>
            Effect.gen(function* () {
              expect(result.status).toBe("completed")
              expect(edit.assertions.map((input) => input.action)).toEqual(["external_directory", "Edit"])
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
              expect(edit.writes).toHaveLength(1)
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
  // of it is outside like any other path, so the edit asks about the folder it would reach and changes nothing when that
  // is refused. A junction stands for the link, since it needs no privilege on Windows.
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
              const target = path.join(outside.path, "notes.md")
              yield* Effect.promise(async () => {
                await fs.writeFile(target, "before")
                await fs.symlink(outside.path, path.join(active.path, "docs"), "junction")
              })
              const edit = makeEditFixture()
              const result = yield* withTool(
                active.path,
                edit,
                (registry) =>
                  executeTool(registry, call({ file_path: "docs/notes.md", old_string: "before", new_string: "after" })),
                { untrusted: item.untrusted },
              )
              expect(result.status).toBe("completed")
              expect(edit.assertions.map((input) => input.action)).toEqual(item.actions)
              if (item.untrusted) {
                const real = yield* Effect.promise(() => fs.realpath(outside.path))
                expect(edit.assertions[0]).toMatchObject({ resources: [path.join(real, "*").replaceAll("\\", "/")] })
              }
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after")
            }),
          ([active, outside]) =>
            Effect.promise(() =>
              Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
            ),
        ),
    )

  it.live("changes nothing through a link out of an untrusted project when the approval is denied", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
      ([active, outside]) =>
        Effect.gen(function* () {
          const target = path.join(outside.path, "notes.md")
          yield* Effect.promise(async () => {
            await fs.writeFile(target, "before")
            await fs.symlink(outside.path, path.join(active.path, "docs"), "junction")
          })
          const edit = makeEditFixture()
          edit.denyAction = "external_directory"
          expect(
            yield* withTool(
              active.path,
              edit,
              (registry) =>
                executeTool(registry, call({ file_path: "docs/notes.md", old_string: "before", new_string: "after" })),
              { untrusted: true },
            ),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: external_directory" },
          })
          expect(edit.assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(edit.reads).toBe(0)
          expect(edit.writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("before")
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
          yield* Effect.promise(() => fs.writeFile(external, "before"))
          const edit = makeEditFixture()
          edit.denyAction = "external_directory"
          expect(
            yield* withTool(active.path, edit, (registry) =>
              executeTool(registry, call({ file_path: external, old_string: "before", new_string: "after" })),
            ),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: external_directory" },
          })
          expect(edit.assertions.map((input) => input.action)).toEqual(["external_directory"])
          expect(edit.reads).toBe(0)
          expect(edit.writes).toEqual([])

          const deniedEdit = makeEditFixture()
          deniedEdit.denyAction = "Edit"
          expect(
            yield* withTool(active.path, deniedEdit, (registry) =>
              executeTool(registry, call({ file_path: external, old_string: "before", new_string: "after" })),
            ),
          ).toEqual({
            status: "error",
            error: { type: "permission.rejected", message: "Permission denied: Edit" },
          })
          expect(deniedEdit.assertions.map((input) => input.action)).toEqual(["external_directory", "Edit"])
          expect(deniedEdit.reads).toBe(1)
          expect(deniedEdit.writes).toEqual([])
          expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("before")
        }),
      ([active, outside]) =>
        Effect.promise(() =>
          Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
        ),
    ),
  )

  // The content checks run before the permission is asked, so a denied edit answers "no match" for a text that is not in
  // the file. The ledger keeps that from being a way to learn what a file holds: it lets a call get as far as the content
  // only for a file that the session has read, and the session has then seen the content already.
  it.live("a denied edit of a file the session has not read says nothing about what the file holds", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      edit.denyAction = "Edit"
      const target = path.join(tmp.path, "secret.txt")
      return Effect.promise(() => fs.writeFile(target, "secret content")).pipe(
        Effect.andThen(
          withTool(
            tmp.path,
            edit,
            (registry) =>
              Effect.gen(function* () {
                const matching = yield* executeTool(
                  registry,
                  call({ file_path: "secret.txt", old_string: "secret content", new_string: "replacement" }),
                )
                const missing = yield* executeTool(
                  registry,
                  call({ file_path: "secret.txt", old_string: "not present", new_string: "replacement" }),
                )

                expect(matching).toEqual({
                  status: "error",
                  error: {
                    type: "file.unread",
                    message: "secret.txt has not been read in this session. Read it before changing it.",
                  },
                })
                expect(missing).toEqual(matching)
                expect(edit.assertions).toEqual([])
                expect(edit.reads).toBe(0)
                expect(edit.writes).toEqual([])
              }),
            { ledger: "real" },
          ),
        ),
      )
    }),
  )

  it.live("a denied edit of a file the session has read is refused at the permission once it could work", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      edit.denyAction = "Edit"
      const target = path.join(tmp.path, "secret.txt")
      return Effect.promise(() => fs.writeFile(target, "secret content")).pipe(
        Effect.andThen(
          withTool(
            tmp.path,
            edit,
            (registry) =>
              Effect.gen(function* () {
                yield* (yield* FileLedger.Service).record(sessionID, target)
                const matching = yield* executeTool(
                  registry,
                  call({ file_path: "secret.txt", old_string: "secret content", new_string: "replacement" }),
                )
                const missing = yield* executeTool(
                  registry,
                  call({ file_path: "secret.txt", old_string: "not present", new_string: "replacement" }),
                )

                expect(matching).toEqual({
                  status: "error",
                  error: { type: "permission.rejected", message: "Permission denied: Edit" },
                })
                expect(missing).toMatchObject({ status: "error", error: { type: "edit.no-match" } })
                expect(edit.assertions.map((input) => input.action)).toEqual(["Edit"])
                expect(edit.writes).toEqual([])
              }),
            { ledger: "real" },
          ),
        ),
      )
    }),
  )

  // Each of these edits cannot work. Whatever it is that makes them fail, the person is not asked to approve one, and the
  // call fails with a code that a client can match on. `validate` refuses the ones inside the Location by itself, before
  // `execute` runs, and `execute` ends the same way when it is the only one to run.
  const doomed: ReadonlyArray<{
    readonly name: string
    readonly input: typeof EditTool.Input.Type
    // The permissive ledger allows every change. The real one is used when the file was never read, or was read and
    // has changed since.
    readonly ledger?: "unread" | "stale"
    readonly type: string
    readonly message: string
  }> = [
    {
      name: "identical strings",
      input: { file_path: "matches.txt", old_string: "same", new_string: "same" },
      type: "edit.no-change",
      message: "No changes to apply: old_string and new_string are identical.",
    },
    {
      name: "an empty old_string",
      input: { file_path: "matches.txt", old_string: "", new_string: "after" },
      type: "edit.empty-old-string",
      message: "old_string must not be empty. Use write to create or overwrite a file.",
    },
    {
      name: "an old_string that is not in the file",
      input: { file_path: "matches.txt", old_string: "missing", new_string: "after" },
      type: "edit.no-match",
      message: "Could not find old_string in matches.txt. It must match exactly, including whitespace and indentation.",
    },
    {
      name: "an old_string that is in the file twice",
      input: { file_path: "matches.txt", old_string: "same", new_string: "after" },
      type: "edit.ambiguous",
      message:
        "Found 2 matches for old_string, but expected exactly one. Add more surrounding context to make old_string unique, or set replace_all to true to replace every occurrence.",
    },
    {
      name: "a file that does not exist",
      input: { file_path: "missing.ts", old_string: "before", new_string: "after" },
      type: "file.not-found",
      message: "File not found: missing.ts",
    },
    {
      name: "a directory",
      input: { file_path: "src", old_string: "before", new_string: "after" },
      type: "file.is-directory",
      message: "Path is a directory, not a file: src",
    },
    {
      name: "a file that the session has not read",
      input: { file_path: "matches.txt", old_string: "same", new_string: "after", replace_all: true },
      ledger: "unread",
      type: "file.unread",
      message: "matches.txt has not been read in this session. Read it before changing it.",
    },
    {
      name: "a file that changed since the session read it",
      input: { file_path: "matches.txt", old_string: "same", new_string: "after", replace_all: true },
      ledger: "stale",
      type: "file.stale",
      message: "matches.txt changed since it was last read. Read it again before changing it.",
    },
  ]
  for (const item of doomed)
    it.live(`refuses ${item.name} with ${item.type} and asks for nothing`, () =>
      withTempDir((tmp) => {
        const edit = makeEditFixture()
        const target = path.join(tmp.path, "matches.txt")
        return Effect.promise(async () => {
          await fs.writeFile(target, "same same")
          await fs.mkdir(path.join(tmp.path, "src"))
        }).pipe(
          Effect.andThen(
            withTool(
              tmp.path,
              edit,
              (registry) =>
                Effect.gen(function* () {
                  if (item.ledger === "stale") {
                    yield* (yield* FileLedger.Service).record(sessionID, target)
                    const later = new Date(Date.now() + 60_000)
                    yield* Effect.promise(() => fs.utimes(target, later, later))
                  }
                  const expected = { type: item.type, message: item.message }
                  expect(
                    yield* validateEdit(registry, item.input).pipe(Effect.flip, Effect.map(toSessionError)),
                  ).toEqual(expected)
                  expect(yield* executeTool(registry, call(item.input))).toEqual({ status: "error", error: expected })
                  expect(edit.assertions).toEqual([])
                  expect(edit.writes).toEqual([])
                  expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("same same")
                }),
              { ledger: item.ledger === undefined ? "permissive" : "real" },
            ),
          ),
        )
      }),
    )

  it.live("accepts an edit that can work, in validate and in execute", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "matches.txt")
      return Effect.promise(() => fs.writeFile(target, "same same")).pipe(
        Effect.andThen(
          withTool(
            tmp.path,
            edit,
            (registry) =>
              Effect.gen(function* () {
                yield* (yield* FileLedger.Service).record(sessionID, target)
                const input = { file_path: "matches.txt", old_string: "same", new_string: "after", replace_all: true }
                expect(yield* validateEdit(registry, input).pipe(Effect.exit)).toEqual(Exit.void)
                expect(yield* executeTool(registry, call(input))).toMatchObject({
                  status: "completed",
                  output: { replacements: 2 },
                })
                expect(edit.assertions.map((assertion) => assertion.action)).toEqual(["Edit"])
                expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after after")
              }),
            { ledger: "real" },
          ),
        ),
      )
    }),
  )

  it.live("leaves a path it cannot read to execute, which reports it", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "matches.txt")
      return Effect.promise(() => fs.writeFile(target, "same same")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              edit.failReads = true
              const input = { file_path: "matches.txt", old_string: "same", new_string: "after", replace_all: true }
              expect(yield* validateEdit(registry, input).pipe(Effect.exit)).toEqual(Exit.void)
              // The failure is the file system's, so it is not a validation and it has no code of the tool's own.
              expect(yield* executeTool(registry, call(input))).toEqual({
                status: "error",
                error: { type: "tool.execution", message: "Unable to edit matches.txt" },
              })
              expect(edit.assertions).toEqual([])
              expect(edit.writes).toEqual([])
            }),
          ),
        ),
      )
    }),
  )

  it.live("replaces every exact occurrence when replaceAll is true", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "all.txt")
      return Effect.promise(() => fs.writeFile(target, "same same same")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ file_path: "all.txt", old_string: "same", new_string: "after", replace_all: true })),
          ),
        ),
        Effect.andThen((settled) =>
          Effect.gen(function* () {
            expect(settled.status).toBe("completed")
            if (settled.status !== "completed") return
            expect(settled.output).toMatchObject({ replacements: 3 })
            expect(settled.content).toEqual([{ type: "text", text: "Edited all.txt (3 replacements)" }])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after after after")
            expect(edit.writes).toHaveLength(1)
          }),
        ),
      )
    }),
  )

  it.live("normalizes Unicode typography only after exact matching fails", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "unicode.txt")
      return Effect.promise(() =>
        fs.writeFile(target, "exact - match\ncurly “quotes”\nminus − one\nspace\u00A0here\nexact − match\n"),
      ).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              const normalized = yield* executeTool(
                registry,
                call({
                  file_path: "unicode.txt",
                  old_string: 'curly "quotes"\nminus - one\nspace here',
                  new_string: "normalized",
                }),
              )
              expect(normalized.status).toBe("completed")

              const exact = yield* executeTool(
                registry,
                call({ file_path: "unicode.txt", old_string: "exact - match", new_string: "selected" }),
              )
              expect(exact.status).toBe("completed")
              expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe(
                "selected\nnormalized\nexact − match\n",
              )
            }),
          ),
        ),
      )
    }),
  )

  it.live("ignores trailing whitespace while preserving untouched lines", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "whitespace.txt")
      return Effect.promise(() => fs.writeFile(target, "before  \nmatch  \nnext\t\nafter  \n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ file_path: "whitespace.txt", old_string: "match\nnext", new_string: "changed" })),
          ),
        ),
        Effect.tap((result) => Effect.sync(() => expect(result.status).toBe("completed"))),
        Effect.andThen(Effect.promise(() => fs.readFile(target, "utf8"))),
        Effect.tap((content) => Effect.sync(() => expect(content).toBe("before  \nchanged\nafter  \n"))),
      )
    }),
  )

  it.live("uses non-overlapping trailing-whitespace matches and preserves CRLF", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const overlap = path.join(tmp.path, "overlap.txt")
      const windows = path.join(tmp.path, "windows.txt")
      return Effect.promise(() =>
        Promise.all([fs.writeFile(overlap, "a  \na  \na  \n"), fs.writeFile(windows, "a  \r\nb\t\r\n")]),
      ).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.gen(function* () {
              const replaced = yield* executeTool(
                registry,
                call({ file_path: "overlap.txt", old_string: "a\na", new_string: "x", replace_all: true }),
              )
              expect(replaced).toMatchObject({ status: "completed", output: { replacements: 1 } })
              yield* executeTool(registry, call({ file_path: "windows.txt", old_string: "a\nb", new_string: "x" }))
            }),
          ),
        ),
        Effect.andThen(Effect.promise(() => Promise.all([fs.readFile(overlap, "utf8"), fs.readFile(windows, "utf8")]))),
        Effect.tap(([overlapContent, windowsContent]) =>
          Effect.sync(() => {
            expect(overlapContent).toBe("x\na  \n")
            expect(windowsContent).toBe("x\r\n")
          }),
        ),
      )
    }),
  )

  it.live("preserves BOM and CRLF line endings", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "windows.txt")
      edit.formatFile = (file) =>
        Effect.promise(async () => {
          await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""))
          return true
        })
      return Effect.promise(() => fs.writeFile(target, "\uFEFFbefore\r\nrest\r\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ file_path: "windows.txt", old_string: "before\nrest", new_string: "after\nrest" })),
          ),
        ),
        Effect.andThen(() => Effect.promise(() => fs.readFile(target, "utf8"))),
        Effect.tap((content) => Effect.sync(() => expect(content).toBe("\uFEFFafter\r\nrest\r\n"))),
      )
    }),
  )

  it.live("serializes concurrent edit transactions", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "concurrent.txt")
      // Every read is slow, so both calls are between reading and writing at once unless the lock keeps one of them out.
      edit.afterRead = () => Effect.sleep("50 millis")
      return Effect.promise(() => fs.writeFile(target, "one\ntwo\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            Effect.all(
              [
                executeTool(
                  registry,
                  call({ file_path: "concurrent.txt", old_string: "one", new_string: "ONE" }, "call-edit-one"),
                ),
                executeTool(
                  registry,
                  call({ file_path: "concurrent.txt", old_string: "two", new_string: "TWO" }, "call-edit-two"),
                ),
              ],
              { concurrency: "unbounded" },
            ),
          ),
        ),
        Effect.andThen((results) =>
          Effect.gen(function* () {
            expect(results.map((result) => result.status)).toEqual(["completed", "completed"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ONE\nTWO\n")
          }),
        ),
      )
    }),
  )

  it.live("an edit started while an earlier edit of the file is still formatting is not stale", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "formatting.txt")
      // The first edit has written and is formatting, so the file is newer than the ledger until it records.
      edit.formatFile = () => Effect.sleep("300 millis").pipe(Effect.as(false))
      return Effect.promise(() => fs.writeFile(target, "one\ntwo\n")).pipe(
        Effect.andThen(
          withTool(
            tmp.path,
            edit,
            (registry) =>
              Effect.gen(function* () {
                yield* (yield* FileLedger.Service).record(sessionID, target)
                const first = yield* executeTool(
                  registry,
                  call({ file_path: "formatting.txt", old_string: "one", new_string: "ONE" }, "call-edit-one"),
                ).pipe(Effect.forkChild)
                yield* Effect.sleep("100 millis")
                const second = yield* executeTool(
                  registry,
                  call({ file_path: "formatting.txt", old_string: "two", new_string: "TWO" }, "call-edit-two"),
                )
                return [yield* Fiber.join(first), second]
              }),
            { ledger: "real" },
          ),
        ),
        Effect.andThen((results) =>
          Effect.gen(function* () {
            expect(results.map((result) => result.status)).toEqual(["completed", "completed"])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("ONE\nTWO\n")
          }),
        ),
      )
    }),
  )

  it.live("applies the edit when content changes after matching", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "concurrent.txt")
      // The first read is validate's. The file changes after the one that `execute` matched on.
      edit.afterRead = () => (edit.reads === 2 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
      return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ file_path: "concurrent.txt", old_string: "before", new_string: "after" })),
          ),
        ),
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result).toMatchObject({ status: "completed", output: { replacements: 1 } })
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("after\n")
            expect(edit.writes).toEqual([target])
          }),
        ),
      )
    }),
  )

  it.live("execute decides when the content changes after validate", () =>
    withTempDir((tmp) => {
      const edit = makeEditFixture()
      const target = path.join(tmp.path, "concurrent.txt")
      // The first read is validate's, and it matched. The file changes before `execute` reads it.
      edit.afterRead = () => (edit.reads === 1 ? Effect.promise(() => fs.writeFile(target, "newer\n")) : Effect.void)
      return Effect.promise(() => fs.writeFile(target, "before\n")).pipe(
        Effect.andThen(
          withTool(tmp.path, edit, (registry) =>
            executeTool(registry, call({ file_path: "concurrent.txt", old_string: "before", new_string: "after" })),
          ),
        ),
        Effect.andThen((result) =>
          Effect.gen(function* () {
            expect(result).toMatchObject({ status: "error", error: { type: "edit.no-match" } })
            expect(edit.reads).toBe(2)
            expect(edit.assertions).toEqual([])
            expect(edit.writes).toEqual([])
            expect(yield* Effect.promise(() => fs.readFile(target, "utf8"))).toBe("newer\n")
          }),
        ),
      )
    }),
  )

  // A file outside the Location is not read until its folder has been approved, and an edit that cannot work then fails
  // before anyone is asked to approve it.
  for (const item of [
    {
      name: "is refused",
      deny: "external_directory",
      result: () => ({ type: "permission.rejected", message: "Permission denied: external_directory" }),
      reads: 0,
    },
    {
      name: "is allowed",
      deny: undefined,
      result: (external: string) => ({
        type: "edit.no-match",
        message: `Could not find old_string in ${external}. It must match exactly, including whitespace and indentation.`,
      }),
      reads: 1,
    },
  ])
    it.live(`asks about the folder of an external file before its content when the approval ${item.name}`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) =>
          Effect.gen(function* () {
            const external = path.join(outside.path, "external.txt")
            yield* Effect.promise(() => fs.writeFile(external, "before"))
            const edit = makeEditFixture()
            edit.denyAction = item.deny
            const input = { file_path: external, old_string: "missing", new_string: "after" }
            const { settled, validated } = yield* withTool(active.path, edit, (registry) =>
              Effect.gen(function* () {
                // `validate` has nothing to say about it, and has not looked at it.
                const validated = yield* validateEdit(registry, input).pipe(Effect.exit)
                expect(edit.reads).toBe(0)
                expect(edit.assertions).toEqual([])
                return { validated, settled: yield* executeTool(registry, call(input)) }
              }),
            )
            expect(validated).toEqual(Exit.void)
            expect(settled).toEqual({ status: "error", error: item.result(external) })
            // The approval is the only question, and the content is not read before it.
            expect(edit.assertions.map((assertion) => assertion.action)).toEqual(["external_directory"])
            expect(edit.reads).toBe(item.reads)
            expect(edit.writes).toEqual([])
            expect(yield* Effect.promise(() => fs.readFile(external, "utf8"))).toBe("before")
          }),
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    )

  // A link in a project that is not trusted leads out of it, and what it leads to is outside like any other path. The
  // link is the repository's own, so `validate` must not read through it before the folder is approved. The trusted
  // project is the control: there the same link is the project's own and the content is checked at once.
  for (const item of [
    { project: "untrusted", untrusted: true, actions: ["external_directory"], reads: 0, type: "permission.rejected" },
    { project: "trusted", untrusted: false, actions: [], reads: 1, type: "edit.no-match" },
  ])
    it.live(`reads a file behind a link only when the link is the project's own, in a ${item.project} project`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => Promise.all([tmpdir(), tmpdir()])),
        ([active, outside]) =>
          Effect.gen(function* () {
            const target = path.join(outside.path, "notes.md")
            yield* Effect.promise(async () => {
              await fs.writeFile(target, "before")
              await fs.symlink(outside.path, path.join(active.path, "docs"), "junction")
            })
            const edit = makeEditFixture()
            edit.denyAction = "external_directory"
            const settled = yield* withTool(
              active.path,
              edit,
              (registry) =>
                executeTool(registry, call({ file_path: "docs/notes.md", old_string: "missing", new_string: "after" })),
              { untrusted: item.untrusted },
            )
            expect(settled).toMatchObject({ status: "error", error: { type: item.type } })
            expect(edit.assertions.map((assertion) => assertion.action)).toEqual(item.actions)
            expect(edit.reads).toBe(item.reads)
            expect(edit.writes).toEqual([])
          }),
        ([active, outside]) =>
          Effect.promise(() =>
            Promise.all([active[Symbol.asyncDispose](), outside[Symbol.asyncDispose]()]).then(() => undefined),
          ),
      ),
    )
})
