// clients-ux-15 part 3 and m5-link-warning: a file change whose file is reached through a link says so on its request,
// as the reference warns before such a change: an Edit, a Write, a NotebookEdit and every file of a Patch, both ends of
// a move included (`fromLink` is the source's). The request names where the link really leads, and whether that is outside the session's
// folders, decided by real path on the server, so every client shows the server's value and never works it out from the
// tool's input (class 8). `outside` compares real paths, never strings (class 4): a sibling folder whose name begins with
// the session folder's name is outside. Everything runs through the real Permission service and the real file tools.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Cause, Effect, Exit, Layer, Schema, Stream } from "effect"
import { Agent } from "@orbit/core/agent"
import { Config } from "@orbit/core/config"
import { ConfigPolicyPlugin } from "@orbit/core/config/plugin/policy"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { FileAccess } from "@orbit/core/file-access"
import { FileLedger } from "@orbit/core/file-ledger"
import { FileMutation } from "@orbit/core/file-mutation"
import { Formatter } from "@orbit/core/formatter"
import { Image } from "@orbit/core/image"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTable } from "@orbit/core/project/sql"
import { AbsolutePath } from "@orbit/core/schema"
import { Session } from "@orbit/core/session"
import { SessionMessage } from "@orbit/core/session/message"
import { SessionTable } from "@orbit/core/session/sql"
import { SessionStore } from "@orbit/core/session/store"
import { Tool } from "@orbit/core/tool"
import { EditTool } from "@orbit/core/tool/plugin/edit"
import { NotebookEditTool } from "@orbit/core/tool/plugin/notebook-edit"
import { PatchTool } from "@orbit/core/tool/plugin/patch"
import { fileDiff } from "@orbit/core/tool/plugin/file-diff"
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Document, Info } from "@orbit/schema/config"
import type { ConfigPolicy } from "@orbit/schema/config/policy"
import { transformEnvironmentFiles } from "./fixture/environment"
import { location } from "./fixture/location"
import { untrustedProjectNodes } from "./fixture/project-trust"
import { canLinkFile } from "./fixture/symlink"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin } from "./lib/tool"
import { host } from "./plugin/host"

const sessionID = Session.ID.make("ses_link")
const identity = { agent: Agent.ID.make("test"), messageID: SessionMessage.ID.make("msg_link") }
const it = testEffect(Layer.empty)

const plugins = makeLocationNode({
  name: "test/edit-link-plugins",
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

// Runs one call in the project at `directory`, whose agent asks about everything unless `effect` says otherwise, and
// answers each question with `reply`: once unless told otherwise.
const run = (
  directory: string,
  name: string,
  input: Record<string, unknown>,
  options: {
    effect?: "ask" | "allow"
    reply?: "once" | "always"
    trusted?: boolean
    // Each update of the call while it runs, as a client that follows it gets them.
    updates?: Tool.Metadata[]
    // The file system refuses to remove, or to write, a file of this name.
    refuse?: { act: "remove" | "write"; name: string }
    // The agent's rules after its first one, which is for everything.
    rules?: Permission.Ruleset
    // Orbit's data folder, which holds the project's memory folder.
    data?: string
    // The project's worktree, when the session folder `directory` is below it.
    worktree?: string
    // Policy statements the real configuration policy plugin applies, from a person's document or their organization.
    policy?: { from: "user" | "organization"; statements: ConfigPolicy.Info[] }
    // Each `permission.evaluate` a plugin hook is shown: its action and the leads of each resource.
    evaluations?: Array<{ action: string; leads?: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> }>
  } = {},
) =>
  Effect.gen(function* () {
    yield* seed(directory, options.effect ?? "ask", options.rules, options.worktree)
    if (options.policy) yield* installPolicy(options.policy.from, options.policy.statements)
    const evaluations = options.evaluations
    if (evaluations) {
      const hooks = yield* PluginHooks.Service
      yield* hooks.register("permission", "evaluate", (event) =>
        Effect.sync(() => void evaluations.push({ action: event.action, leads: event.leads })),
      )
    }
    const tools = yield* Tool.Service
    const permission = yield* Permission.Service
    const access = yield* FileAccess.Service
    // "Read" is the door that Read, Grep and LSP open a file through, so it stands for them without their own services.
    const fiber = yield* (
      name === "Read"
        ? access.authorizeRead(String(input.file_path), { sessionID, ...identity, id: Tool.CallID.make("call-Read") })
        : (yield* tools.snapshot()).execute({
            sessionID,
            ...identity,
            call: { type: "tool-call", id: `call-${name}`, name, input },
            progress: (update) => Effect.sync(() => void options.updates?.push(update)),
          })
    ).pipe(Effect.forkScoped)
    const asked: Permission.Request[] = []
    const drive = (): Effect.Effect<Exit.Exit<unknown, unknown>> =>
      Effect.gen(function* () {
        const done = fiber.pollUnsafe()
        if (done) return done
        const [request] = yield* permission.list()
        if (!request) {
          yield* Effect.sleep("2 millis")
          return yield* drive()
        }
        asked.push(request)
        yield* permission.reply({ requestID: request.id, reply: options.reply ?? "once" }).pipe(Effect.exit)
        return yield* drive()
      })
    const exit = yield* drive()
    const grants = (yield* (yield* PermissionSaved.Service).list({ projectID: Project.ID.global })).map(
      (item) => [item.action, item.resource] as const,
    )
    return { exit, request: asked.find((request) => request.action === "Edit"), asked, grants }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          SessionStore.node,
          PermissionSaved.node,
          Agent.node,
          PluginHooks.node,
          ManagedPolicy.node,
          Permission.node,
          Tool.node,
          FileAccess.node,
          FileMutation.node,
          FileLedger.node,
          plugins,
        ]),
        [
          FileLedger.node.replace(FileLedger.permissiveLayer),
          Location.node.replace(
            Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make(directory) },
                  { projectDirectory: AbsolutePath.make(options.worktree ?? directory) },
                ),
              ),
            ),
          ),
          Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
          Image.node.replace(imagePassthrough),
          ...(options.refuse ? [Environment.node.replace(refusing(options.refuse))] : []),
          ...(options.trusted === false ? untrustedProjectNodes : []),
          ...(options.data ? [Global.node.replace(Global.layerWith({ data: options.data }))] : []),
        ],
      ),
    ),
  )

const refusing = (refuse: { act: "remove" | "write"; name: string }) =>
  transformEnvironmentFiles((files) => {
    const refused = (target: string) => new Environment.Failed({ path: target, cause: new Error("refused here") })
    const named = (target: string) => path.basename(target) === refuse.name
    if (refuse.act === "remove")
      return { remove: (target) => (named(target) ? Effect.fail(refused(target)) : files.remove(target)) }
    return { write: (target, bytes) => (named(target) ? Effect.fail(refused(target)) : files.write(target, bytes)) }
  })

// Runs the real configuration policy plugin on the stack's own hooks, so a statement reaches Permission as in a server:
// as an `experimental.policies` entry of the person's document, or as a statement of their organization.
const installPolicy = Effect.fn(function* (from: "user" | "organization", statements: ConfigPolicy.Info[]) {
  const hooks = yield* PluginHooks.Service
  const managed = yield* ManagedPolicy.Service
  if (from === "organization") yield* managed.set("connection", { statements })
  const unused = () => Effect.die("unused")
  const context = host({
    event: { subscribe: () => Stream.empty },
    provider: { list: unused, get: unused, transform: () => Effect.succeed({ dispose: Effect.void }), reload: () => Effect.void },
    permission: { list: unused, get: unused, reply: unused, hook: (name, callback) => hooks.register("permission", name, callback) },
  })
  const document = new Document({
    type: "document",
    scope: "user",
    info: Schema.decodeUnknownSync(Info)({ experimental: { policies: from === "user" ? statements : [] } }),
  })
  yield* ConfigPolicyPlugin.Plugin.effect(context).pipe(Effect.provide(Config.testLayer([document])))
})

const seed = (directory: string, effect: "ask" | "allow", rules: Permission.Ruleset = [], worktree = directory) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(worktree), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "link",
        directory,
        title: "link",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(identity.agent, (agent) => {
        agent.permissions = [{ action: "*", resource: "*", effect }, ...rules]
      }),
    )
  })

type Link = { readonly place: string; readonly outside: boolean }
const fileEntry = (request: Permission.Request | undefined) =>
  ((request?.metadata as { files?: ReadonlyArray<{ place?: string; link?: Link }> } | undefined)?.files ?? [])[0]

// The project is `<root>/proj`. Beside it are a folder outside and one whose name begins with the project's own.
const rows: Array<{
  name: string
  // Makes the link, or nothing, in the project, and returns the path the tool is given and where the file really is.
  make: (root: string, project: string) => Promise<{ spelled: string; real: string } | "skip">
  outside?: boolean
}> = [
  {
    name: "link-inside",
    make: async (_, project) => {
      await fs.mkdir(path.join(project, "sub"), { recursive: true })
      const made = await link(path.join(project, "sub"), path.join(project, "alias"), "dir")
      return made ?? { spelled: "alias/b.txt", real: path.join(project, "sub", "b.txt") }
    },
    outside: false,
  },
  {
    name: "link-out",
    make: async (root, project) => {
      const made = await link(path.join(root, "outside"), path.join(project, "out"), "dir")
      return made ?? { spelled: "out/b.txt", real: path.join(root, "outside", "b.txt") }
    },
    outside: true,
  },
  {
    name: "junction-out",
    make: async (root, project) => {
      const made = await link(path.join(root, "outside"), path.join(project, "junction"), "junction")
      return made ?? { spelled: "junction/b.txt", real: path.join(root, "outside", "b.txt") }
    },
    outside: true,
  },
  {
    // A sibling whose name begins with the project's: inside by string prefix, outside on disk.
    name: "folder-link-above",
    make: async (root, project) => {
      await fs.mkdir(path.join(root, "proj-other"), { recursive: true })
      const made = await link(path.join(root, "proj-other"), path.join(project, "sibling"), "junction")
      return made ?? { spelled: "sibling/b.txt", real: path.join(root, "proj-other", "b.txt") }
    },
    outside: true,
  },
  { name: "none", make: async (_, project) => ({ spelled: "b.txt", real: path.join(project, "b.txt") }) },
  {
    // A file outside the project, reached through a link in a folder outside that leads elsewhere outside: the external
    // question is answered, and the request still names where the link leads.
    name: "outside-through-link",
    make: async (root) => {
      await fs.mkdir(path.join(root, "elsewhere"), { recursive: true })
      const made = await link(path.join(root, "farther"), path.join(root, "elsewhere", "alias"), "junction")
      return made ?? { spelled: path.join(root, "elsewhere", "alias", "b.txt"), real: path.join(root, "farther", "b.txt") }
    },
    outside: true,
  },
  {
    // The control: a plain file outside the project, with no link on its way, names none.
    name: "outside-plain",
    make: async (root) => {
      await fs.mkdir(path.join(root, "elsewhere"), { recursive: true })
      return { spelled: path.join(root, "elsewhere", "b.txt"), real: path.join(root, "elsewhere", "b.txt") }
    },
  },
]

// A link of the kind asked for, or "skip" where this system will not make one (a symbolic link on Windows needs
// Developer Mode or an elevated shell; a junction always works there, and elsewhere it is a symbolic link).
async function link(target: string, at: string, type: "dir" | "junction") {
  await fs.mkdir(target, { recursive: true })
  return fs.symlink(target, at, type).then(
    () => undefined,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPERM") throw error
      console.warn(`skipped: cannot make a ${type} link here (${error.code})`)
      return "skip" as const
    },
  )
}

describe("an Edit or Write through a link names where it leads, and says whether that is outside the session's folders", () => {
  for (const row of rows)
    for (const tool of ["Edit", "Write"] as const)
      it.live(`${tool}: ${row.name}`, () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (root) =>
            Effect.gen(function* () {
              const project = path.join(root.path, "proj")
              yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
              const made = yield* Effect.promise(() => row.make(root.path, project))
              if (made === "skip") return
              yield* Effect.promise(() => fs.writeFile(made.real, "alpha\nbeta\n"))
              const settled = yield* run(
                project,
                tool,
                tool === "Edit"
                  ? { file_path: made.spelled, old_string: "beta", new_string: "BETA" }
                  : { file_path: made.spelled, content: "written\n" },
              )
              expect(Exit.isSuccess(settled.exit)).toBe(true)
              const entry = fileEntry(settled.request)
              expect(entry).toBeDefined()
              const real = yield* Effect.promise(() => fs.realpath(made.real))
              if (row.outside === undefined) expect(entry?.link).toBeUndefined()
              else expect(entry?.link).toEqual({ place: real, outside: row.outside })
              // The change lands where the link leads, as it did before the request named it.
              expect(yield* Effect.promise(() => fs.readFile(real, "utf8"))).toBe(
                tool === "Edit" ? "alpha\nBETA\n" : "written\n",
              )
            }),
          (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
        ),
      )
})

// The session's folder is itself reached through a link, as a system folder such as macOS's `/var` is: a plain file in
// it is not reached through a link of the repository's, so its request names none. A link of the repository's inside it
// that leads elsewhere in it is named, and is inside: the folder is compared by its real path, not by its spelling.
describe("an Edit or Write in a project folder that is itself reached through a link names no link", () => {
  const cases = [
    { name: "plain", spelled: "b.txt", file: ["b.txt"], named: false },
    { name: "link-inside", spelled: path.join("alias", "b.txt"), file: ["sub", "b.txt"], named: true },
  ]
  for (const tool of ["Edit", "Write"] as const)
    for (const row of cases)
      it.live(row.name === "plain" ? tool : `${tool}: ${row.name}`, () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (root) =>
            Effect.gen(function* () {
              const project = path.join(root.path, "proj")
              const made = yield* Effect.promise(() => link(path.join(root.path, "real-proj"), project, "junction"))
              if (made === "skip") return
              const real = yield* Effect.promise(() => fs.realpath(path.join(root.path, "real-proj")))
              if (row.named) {
                const inner = yield* Effect.promise(() =>
                  link(path.join(real, "sub"), path.join(real, "alias"), "junction"),
                )
                if (inner === "skip") return
              }
              const file = path.join(real, ...row.file)
              yield* Effect.promise(() => fs.writeFile(file, "alpha\nbeta\n"))
              const settled = yield* run(
                project,
                tool,
                tool === "Edit"
                  ? { file_path: row.spelled, old_string: "beta", new_string: "BETA" }
                  : { file_path: row.spelled, content: "written\n" },
              )
              expect(Exit.isSuccess(settled.exit)).toBe(true)
              const entry = fileEntry(settled.request)
              expect(entry).toBeDefined()
              if (row.named) expect(entry?.link).toEqual({ place: file, outside: false })
              else expect(entry?.link).toBeUndefined()
              expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(
                tool === "Edit" ? "alpha\nBETA\n" : "written\n",
              )
            }),
          (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
        ),
      )
})

// m5-link-warning: every kind of file change, by every spelling a tool takes, against every kind of link.
const notebook = JSON.stringify({
  cells: [{ cell_type: "code", execution_count: null, id: "calc", metadata: {}, outputs: [], source: ["print(1)"] }],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
})
const text = "alpha\nbeta\n"
const patched = (...hunks: string[]) => ({ patchText: ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n") })
const update = (file: string, to?: string) =>
  [`*** Update File: ${file}`, ...(to === undefined ? [] : [`*** Move to: ${to}`]), "@@", "-beta", "+BETA"].join("\n")

// `at` is the file the model names, already spelled; `plain` is a file of the project with no link on its way.
const changes: Array<{
  name: string
  tool: "Edit" | "Write" | "NotebookEdit" | "Patch"
  file: string
  existing?: string
  input: (at: string, plain: string) => Record<string, unknown>
  // Which end of the change `at` is.
  end: "link" | "fromLink"
}> = [
  {
    name: "Edit",
    tool: "Edit",
    file: "b.txt",
    existing: text,
    input: (at) => ({ file_path: at, old_string: "beta", new_string: "BETA" }),
    end: "link",
  },
  { name: "Write (new file)", tool: "Write", file: "new.txt", input: (at) => ({ file_path: at, content: "new\n" }), end: "link" },
  {
    name: "NotebookEdit",
    tool: "NotebookEdit",
    file: "b.ipynb",
    existing: notebook,
    input: (at) => ({ notebook_path: at, mode: "replace", cellId: "calc", source: "print(2)" }),
    end: "link",
  },
  {
    name: "Patch add",
    tool: "Patch",
    file: "new.txt",
    input: (at) => patched(`*** Add File: ${at}\n+new`),
    end: "link",
  },
  { name: "Patch update", tool: "Patch", file: "b.txt", existing: text, input: (at) => patched(update(at)), end: "link" },
  {
    name: "Patch delete",
    tool: "Patch",
    file: "b.txt",
    existing: text,
    input: (at) => patched(`*** Delete File: ${at}`),
    end: "link",
  },
  {
    name: "Patch move from",
    tool: "Patch",
    file: "b.txt",
    existing: text,
    input: (at, plain) => patched(update(at, plain)),
    end: "fromLink",
  },
  {
    name: "Patch move to",
    tool: "Patch",
    file: "new.txt",
    input: (at, plain) => patched(update(plain, at)),
    end: "link",
  },
]

type World = { root: string; project: string }
const forward = (value: string) => value.replaceAll("\\", "/")
const bashDrive = (value: string) => `/${value[0]!.toLowerCase()}${forward(value.slice(2))}`
// How the model spells the folder of the file, where that really is, and whether that is outside; none: no link.
const spelledWays: Array<{
  name: string
  only?: NodeJS.Platform
  spell: (world: World) => string
  real: (world: World) => string
  outside?: boolean
}> = [
  { name: "relative, inside", spell: () => "alias", real: (w) => path.join(w.project, "sub"), outside: false },
  { name: "relative, out", spell: () => "out", real: (w) => path.join(w.root, "outside"), outside: true },
  {
    name: "relative, sibling with the project's prefix",
    spell: () => "sibling",
    real: (w) => path.join(w.root, "proj-other"),
    outside: true,
  },
  { name: "absolute", spell: (w) => path.join(w.project, "out"), real: (w) => path.join(w.root, "outside"), outside: true },
  { name: "dot-dot", spell: () => "plain/../alias", real: (w) => path.join(w.project, "sub"), outside: false },
  {
    name: "tilde",
    spell: (w) => `~/${forward(path.relative(Global.Path.home, path.join(w.project, "out")))}`,
    real: (w) => path.join(w.root, "outside"),
    outside: true,
  },
  {
    name: "absolute, outside through a link outside",
    spell: (w) => path.join(w.root, "elsewhere", "alias"),
    real: (w) => path.join(w.root, "farther"),
    outside: true,
  },
  { name: "backslashes", only: "win32", spell: () => ".\\out", real: (w) => path.join(w.root, "outside"), outside: true },
  { name: "other case", only: "win32", spell: () => "ALIAS", real: (w) => path.join(w.project, "sub"), outside: false },
  {
    name: "git bash drive",
    only: "win32",
    spell: (w) => bashDrive(path.join(w.project, "out")),
    real: (w) => path.join(w.root, "outside"),
    outside: true,
  },
  // The controls: no link on the way names none.
  { name: "plain", spell: () => "sub", real: (w) => path.join(w.project, "sub") },
  { name: "plain outside", spell: (w) => path.join(w.root, "elsewhere"), real: (w) => path.join(w.root, "elsewhere") },
]

const makeWorld = async (root: string): Promise<World> => {
  const project = path.join(root, "proj")
  for (const folder of ["proj/plain", "proj/sub", "outside", "proj-other", "elsewhere", "farther"])
    await fs.mkdir(path.join(root, folder), { recursive: true })
  await fs.symlink(path.join(project, "sub"), path.join(project, "alias"), "junction")
  await fs.symlink(path.join(root, "outside"), path.join(project, "out"), "junction")
  await fs.symlink(path.join(root, "proj-other"), path.join(project, "sibling"), "junction")
  await fs.symlink(path.join(root, "farther"), path.join(root, "elsewhere", "alias"), "junction")
  return { root, project }
}

type Ends = { readonly file: string; readonly place?: string; readonly from?: string; readonly link?: Link; readonly fromLink?: Link }
const entries = (request: Permission.Request | undefined) =>
  (request?.metadata as { files?: ReadonlyArray<Ends> } | undefined)?.files ?? []

describe("every kind of file change names the link it is reached through, by every spelling", () => {
  for (const change of changes)
    for (const way of spelledWays.filter((item) => item.only === undefined || item.only === process.platform))
      it.live(`${change.name}: ${way.name}`, () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (root) =>
            Effect.gen(function* () {
              const world = yield* Effect.promise(() => makeWorld(root.path))
              const real = path.join(way.real(world), change.file)
              const plain = path.join(world.project, "plain", "c.txt")
              yield* Effect.promise(async () => {
                if (change.existing !== undefined) await fs.writeFile(real, change.existing)
                if (change.name === "Patch move to") await fs.writeFile(plain, text)
              })
              const settled = yield* run(
                world.project,
                change.tool,
                change.input(`${way.spell(world)}/${change.file}`, "plain/c.txt"),
              )
              expect(Exit.isSuccess(settled.exit)).toBe(true)
              const entry = entries(settled.request)[0]
              expect(entry).toBeDefined()
              const expected = way.outside === undefined ? undefined : { place: real, outside: way.outside }
              expect(entry?.[change.end]).toEqual(expected)
              // The other end of a move, which no link is on, names none.
              expect(entry?.[change.end === "link" ? "fromLink" : "link"]).toBeUndefined()
              // Only the request says more: what "always" would save is what it was.
              expect(settled.request?.save).toEqual(["*"])
            }),
          (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
        ),
      )
})

describe("a request of several files names the link of each", () => {
  it.live("a Patch of four files: out, inside, none, and a move between two links", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const world = yield* Effect.promise(() => makeWorld(root.path))
          yield* Effect.promise(async () => {
            for (const file of ["outside/a.txt", "proj/sub/b.txt", "proj/plain/c.txt", "proj-other/d.txt"])
              await fs.writeFile(path.join(root.path, file), text)
          })
          const settled = yield* run(
            world.project,
            "Patch",
            patched(update("out/a.txt"), "*** Delete File: alias/b.txt", update("plain/c.txt"), update("sibling/d.txt", "alias/d.txt")),
          )
          expect(Exit.isSuccess(settled.exit)).toBe(true)
          expect(entries(settled.request).map((entry) => ({ link: entry.link, fromLink: entry.fromLink }))).toEqual([
            { link: { place: path.join(root.path, "outside", "a.txt"), outside: true }, fromLink: undefined },
            { link: { place: path.join(world.project, "sub", "b.txt"), outside: false }, fromLink: undefined },
            { link: undefined, fromLink: undefined },
            {
              link: { place: path.join(world.project, "sub", "d.txt"), outside: false },
              fromLink: { place: path.join(root.path, "proj-other", "d.txt"), outside: true },
            },
          ])
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )

  it.live("a move onto a file through a link names it on the entry of what it replaces too", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const world = yield* Effect.promise(() => makeWorld(root.path))
          const real = path.join(root.path, "outside", "onto.txt")
          yield* Effect.promise(async () => {
            await fs.writeFile(path.join(world.project, "plain", "c.txt"), text)
            await fs.writeFile(real, "replaced\n")
          })
          const settled = yield* run(world.project, "Patch", patched(update("plain/c.txt", "out/onto.txt")))
          expect(Exit.isSuccess(settled.exit)).toBe(true)
          const named = { place: real, outside: true }
          expect(entries(settled.request).map((entry) => entry.link)).toEqual([named, named])
          expect(entries(settled.request).map((entry) => entry.fromLink)).toEqual([undefined, undefined])
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )
})

describe("a Patch or NotebookEdit at the edges of what a link is", () => {
  // The link is the file itself, which needs a link to a file: a junction cannot stand for one.
  const linkedFile = canLinkFile ? it.live : it.live.skip
  linkedFile("a file that is itself the link: update, delete and notebook", () =>
    Effect.gen(function* () {
      for (const name of ["update", "delete", "notebook"] as const)
        yield* Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (root) =>
            Effect.gen(function* () {
              const project = path.join(root.path, "proj")
              const file = name === "notebook" ? "real.ipynb" : "real.txt"
              const spelled = name === "notebook" ? "shown.ipynb" : "shown.txt"
              const real = path.join(root.path, file)
              yield* Effect.promise(async () => {
                await fs.mkdir(project)
                await fs.writeFile(real, name === "notebook" ? notebook : text)
                await fs.symlink(real, path.join(project, spelled), "file")
              })
              const settled = yield* run(
                project,
                name === "notebook" ? "NotebookEdit" : "Patch",
                name === "notebook"
                  ? { notebook_path: spelled, mode: "replace", cellId: "calc", source: "print(2)" }
                  : patched(name === "update" ? update(spelled) : `*** Delete File: ${spelled}`),
              )
              expect([name, entries(settled.request)[0]?.link]).toEqual([name, { place: real, outside: true }])
            }),
          (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
        )
    }),
  )

  // A new file under a link that leads nowhere yet: the reference says nothing here, and Orbit says where it would land
  // (class 4). Whether the write then works is the file system's matter.
  for (const tool of ["Write", "Patch"] as const)
    it.live(`${tool} of a new file under a dangling link`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const project = path.join(root.path, "proj")
            const gone = path.join(root.path, "removed")
            yield* Effect.promise(async () => {
              await fs.mkdir(project)
              await fs.mkdir(gone)
              await fs.symlink(gone, path.join(project, "dangling"), "junction")
              await fs.rmdir(gone)
            })
            const settled = yield* run(
              project,
              tool,
              tool === "Write"
                ? { file_path: "dangling/new.txt", content: "new\n" }
                : patched("*** Add File: dangling/new.txt\n+new"),
            )
            expect(entries(settled.request)[0]?.link).toEqual({ place: path.join(gone, "new.txt"), outside: true })
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )

  // A project folder that is itself reached through a link, as macOS's `/var` is, is no link of the repository's.
  for (const tool of ["Patch", "NotebookEdit"] as const)
    for (const named of [false, true])
      it.live(`${tool} in a project folder reached through a link: ${named ? "its own link inside" : "plain"}`, () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (root) =>
            Effect.gen(function* () {
              const real = path.join(root.path, "real-proj")
              const project = path.join(root.path, "proj")
              const file = tool === "Patch" ? "b.txt" : "b.ipynb"
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(real, "sub"), { recursive: true })
                await fs.symlink(real, project, "junction")
                await fs.symlink(path.join(real, "sub"), path.join(real, "alias"), "junction")
                await fs.writeFile(path.join(real, "sub", file), tool === "Patch" ? text : notebook)
              })
              const at = `${named ? "alias" : "sub"}/${file}`
              const settled = yield* run(
                project,
                tool,
                tool === "Patch"
                  ? patched(update(at))
                  : { notebook_path: at, mode: "replace", cellId: "calc", source: "print(2)" },
              )
              expect(Exit.isSuccess(settled.exit)).toBe(true)
              expect(entries(settled.request)[0]?.link).toEqual(
                named ? { place: path.join(real, "sub", file), outside: false } : undefined,
              )
            }),
          (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
        ),
      )
})

describe("the warning changes no decision and no grant", () => {
  for (const change of changes) {
    it.live(`${change.name}: "always" saves what it saved`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const world = yield* Effect.promise(() => makeWorld(root.path))
            const real = path.join(world.project, "sub", change.file)
            yield* Effect.promise(async () => {
              if (change.existing !== undefined) await fs.writeFile(real, change.existing)
              if (change.name === "Patch move to") await fs.writeFile(path.join(world.project, "plain", "c.txt"), text)
            })
            const input = change.input(`alias/${change.file}`, "plain/c.txt")
            const settled = yield* run(world.project, change.tool, input, { reply: "always" })
            expect(Exit.isSuccess(settled.exit)).toBe(true)
            expect(entries(settled.request)[0]?.[change.end]).toEqual({ place: real, outside: false })
            expect(settled.grants).toEqual([["Edit", "*"]])
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )
    // The control: where a rule allows the change, a link on the way asks nothing.
    it.live(`${change.name}: an allow still asks nothing`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const world = yield* Effect.promise(() => makeWorld(root.path))
            yield* Effect.promise(async () => {
              if (change.existing !== undefined)
                await fs.writeFile(path.join(world.project, "sub", change.file), change.existing)
              if (change.name === "Patch move to") await fs.writeFile(path.join(world.project, "plain", "c.txt"), text)
            })
            const input = change.input(`alias/${change.file}`, "plain/c.txt")
            const settled = yield* run(world.project, change.tool, input, { effect: "allow" })
            expect(Exit.isSuccess(settled.exit)).toBe(true)
            expect(settled.request).toBeUndefined()
            expect(settled.grants).toEqual([])
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )
  }
})

// Fix loop 1 (class 3): where the last part of the path is itself a link, a delete and a move's source remove that link,
// and everything else writes through it. The request names what is changed, and the disk says the same.
describe("a file that is itself a link: what is shown is what runs", () => {
  const linkedFile = canLinkFile ? it.live : it.live.skip
  const acts = ["delete", "move from", "update", "edit", "write", "notebook", "move to"] as const
  // `link` is where the link is and `real` the file it leads to, both as they are on the disk.
  const shapes = [
    { name: "out", spelled: "shown", link: ["proj", "shown"], real: ["outside", "real"], outside: true },
    { name: "inside", spelled: "shown", link: ["proj", "shown"], real: ["proj", "sub", "real"], outside: false },
    { name: "in a linked folder out", spelled: "out/shown", link: ["outside", "shown"], real: ["farther", "real"], outside: true },
    { name: "in a linked folder inside", spelled: "alias/shown", link: ["proj", "sub", "shown"], real: ["outside", "real"], outside: true },
    // Here the folder's real place holds its spelled one, so it is told from no link only by not being the same path.
    { name: "in a folder linked to one above it", spelled: "up/shown", link: ["shown"], real: ["farther", "real"], outside: true },
  ]
  for (const trusted of [true, false])
    for (const act of acts)
      for (const shape of shapes)
        linkedFile(`${act}, ${shape.name}, in ${trusted ? "a trusted" : "an untrusted"} folder`, () =>
          Effect.acquireUseRelease(
            Effect.promise(() => tmpdir()),
            (root) =>
              Effect.gen(function* () {
                const world = yield* Effect.promise(() => makeWorld(root.path))
                const suffix = act === "notebook" ? ".ipynb" : ".txt"
                const link = `${path.join(world.root, ...shape.link)}${suffix}`
                const real = `${path.join(world.root, ...shape.real)}${suffix}`
                const before = act === "notebook" ? notebook : text
                yield* Effect.promise(async () => {
                  await fs.writeFile(real, before)
                  await fs.symlink(real, link, "file")
                  await fs.symlink(world.root, path.join(world.project, "up"), "junction")
                  await fs.writeFile(path.join(world.project, "plain", "c.txt"), text)
                })
                const at = `${shape.spelled}${suffix}`
                const updates: Tool.Metadata[] = []
                const [tool, input] =
                  act === "edit"
                    ? (["Edit", { file_path: at, old_string: "beta", new_string: "BETA" }] as const)
                    : act === "write"
                      ? (["Write", { file_path: at, content: "written\n" }] as const)
                      : act === "notebook"
                        ? (["NotebookEdit", { notebook_path: at, mode: "replace", cellId: "calc", source: "print(2)" }] as const)
                        : ([
                            "Patch",
                            patched(
                              act === "delete"
                                ? `*** Delete File: ${at}`
                                : act === "move from"
                                  ? update(at, "plain/moved.txt")
                                  : act === "move to"
                                    ? update("plain/c.txt", at)
                                    : update(at),
                            ),
                          ] as const)
                const settled = yield* run(world.project, tool, input, { trusted, updates })
                expect(Exit.isSuccess(settled.exit)).toBe(true)
                const metadata = settled.request?.metadata as {
                  paths: string[]
                  files: Array<{ file: string; place: string; from?: string; patch: string; link?: Link; fromLink?: Link }>
                }
                const entry = metadata.files[0]!
                const removes = act === "delete" || act === "move from"
                // A link is named wherever it is: the one that is removed, and the file that is written through one.
                expect(act === "move from" ? entry.fromLink : entry.link).toEqual({ place: real, outside: shape.outside })
                const [linkThere, content] = yield* Effect.promise(async () => [
                  await fs.lstat(link).then((info) => info.isSymbolicLink(), () => false),
                  await fs.readFile(real, "utf8"),
                ])
                // The disk: what was removed is the link, and what it led to is as it was.
                expect(linkThere).toBe(!removes)
                if (!removes) {
                  expect(content).not.toBe(before)
                  return
                }
                expect(content).toBe(before)
                // The request: the link is the place that is changed, and the file it leads to is none of them.
                const place = act === "move from" ? entry.from : entry.place
                expect(place).toBe(link)
                expect(metadata.paths).toContain(link)
                expect(metadata.paths).not.toContain(real)
                expect(updates.findLast((update) => Array.isArray(update.places))?.places).toContain(link)
                expect(updates.findLast((update) => Array.isArray(update.places))?.places).not.toContain(real)
                // Nor is it the file's name or the one in the header of its diff.
                const name = forward(real)
                if (act === "delete") expect(forward(entry.file)).not.toBe(name)
                expect(entry.patch.split("\n").filter((line) => line.startsWith("--- ")).map(forward)).toEqual([
                  `--- ${forward(link)}`,
                ])
                // The result: what the model and the person are told was changed is what was.
                if (!Exit.isSuccess(settled.exit)) return
                const result = settled.exit.value as {
                  content: Array<{ text?: string }>
                  metadata: { files: Array<{ file: string; from?: string }> }
                }
                const removed = removedName(trusted, shape, link)
                const said = act === "delete" ? `D ${removed}` : "M plain/moved.txt"
                expect(result.content[0]?.text).toBe(`Success. Updated the following files:\n${said}`)
                const changed = result.metadata.files[0]!
                expect(act === "delete" ? changed.file : changed.from).toBe(removed)
              }),
            (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
          ),
        )
})

// Fix loop 2 (class 3): a failure says the same, in its message and in the names a code rewind reads from it.
describe("a file that is itself a link: a failure names what was to be removed", () => {
  const linkedFile = canLinkFile ? it.live : it.live.skip
  const shapes = [
    { name: "out", spelled: "shown", link: ["proj", "shown"], real: ["outside", "real"], outside: true },
    { name: "inside", spelled: "shown", link: ["proj", "shown"], real: ["proj", "sub", "real"], outside: false },
    { name: "in a linked folder out", spelled: "out/shown", link: ["outside", "shown"], real: ["farther", "real"], outside: true },
    { name: "in a linked folder inside", spelled: "alias/shown", link: ["proj", "sub", "shown"], real: ["outside", "real"], outside: true },
  ]
  const failures = [
    {
      name: "a delete after a first write",
      input: (at: string) => patched("*** Add File: first.txt\n+first", `*** Delete File: ${at}`),
      refuse: { act: "remove", name: "shown.txt" } as const,
      message: (removed: string) => `Failed to delete ${removed}: refused here. Completed before failure: first.txt`,
      touched: (removed: string) => [{ file: "first.txt" }, { file: removed }],
    },
    {
      name: "a move's source",
      input: (at: string) => patched(update(at, "plain/moved.txt")),
      refuse: { act: "remove", name: "shown.txt" } as const,
      message: (removed: string) => `Wrote plain/moved.txt but failed to remove ${removed}: refused here`,
      touched: (removed: string) => [{ file: "plain/moved.txt", from: removed }],
    },
    {
      name: "a write after a delete",
      input: (at: string) => patched(`*** Delete File: ${at}`, "*** Add File: second.txt\n+second"),
      refuse: { act: "write", name: "second.txt" } as const,
      message: (removed: string) => `Failed to write second.txt: refused here. Completed before failure: ${removed}`,
      touched: (removed: string) => [{ file: removed }, { file: "second.txt" }],
    },
    {
      name: "a delete of a link to nothing",
      dangling: true,
      input: (at: string) => patched(`*** Delete File: ${at}`),
      message: (removed: string) => `patch verification failed: Failed to delete ${removed}: file does not exist`,
    },
  ]
  for (const trusted of [true, false])
    for (const failure of failures)
      for (const shape of shapes)
        linkedFile(`${failure.name}, ${shape.name}, in ${trusted ? "a trusted" : "an untrusted"} folder`, () =>
          Effect.acquireUseRelease(
            Effect.promise(() => tmpdir()),
            (root) =>
              Effect.gen(function* () {
                const world = yield* Effect.promise(() => makeWorld(root.path))
                const link = `${path.join(world.root, ...shape.link)}.txt`
                const real = `${path.join(world.root, ...shape.real)}.txt`
                yield* Effect.promise(async () => {
                  await fs.writeFile(real, text)
                  await fs.symlink(real, link, "file")
                  if (failure.dangling) await fs.rm(real)
                })
                const settled = yield* run(world.project, "Patch", failure.input(`${shape.spelled}.txt`), {
                  trusted,
                  refuse: failure.refuse,
                })
                if (!Exit.isFailure(settled.exit)) throw new Error("the patch did not fail")
                const error = Cause.squash(settled.exit.cause) as { message: string; metadata?: { files?: unknown } }
                const removed = removedName(trusted, shape, link)
                expect(error.message).toBe(failure.message(removed))
                if (failure.touched) expect(error.metadata?.files).toEqual(failure.touched(removed))
              }),
            (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
          ),
        )
})

// Fix loop 6 (classes 3 and 4): a delete, or a move's source, that is a link in a folder reached through a link of the
// project removes that link where it really is: `out/config.txt` removes `<root>/outside/config.txt`, while the request
// named only the spelling and the file the link leads to (`<root>/farther`). The person's rules for the folder the link
// is in decide the removal, as they do when the model names that folder itself (the control).
describe("the rules for the folder of a link that is removed decide its removal", () => {
  const linkedFile = canLinkFile ? it.live : it.live.skip
  const ways = [
    { name: "through the project's link", spelled: () => "out/config.txt" },
    { name: "the folder named itself", spelled: (root: string) => path.join(root, "outside", "config.txt") },
  ]
  const outside = (root: string) => `${forward(path.join(root, "outside"))}/*`
  const cases = [
    {
      name: "a deny for the folder refuses it",
      options: (root: string) => ({ rules: [{ action: "Edit", resource: outside(root), effect: "deny" as const }] }),
      removed: false,
      check: () => {},
    },
    {
      name: "an ask for the folder asks, where everything else is allowed",
      options: (root: string) => ({
        effect: "allow" as const,
        rules: [{ action: "Edit", resource: outside(root), effect: "ask" as const }],
      }),
      removed: true,
      check: (settled: { request?: Permission.Request }) => expect(settled.request?.action).toBe("Edit"),
    },
    {
      name: "the folder is asked about",
      options: () => ({}),
      removed: true,
      check: (settled: { asked: Permission.Request[] }, root: string) =>
        expect(
          settled.asked.filter((item) => item.action === "external_directory").flatMap((item) => item.resources),
        ).toContain(outside(root)),
    },
  ]
  for (const trusted of [true, false])
    for (const act of ["delete", "move from"] as const)
      for (const way of ways)
        for (const item of cases)
          linkedFile(`${item.name}: ${act}, ${way.name}, in ${trusted ? "a trusted" : "an untrusted"} folder`, () =>
            Effect.acquireUseRelease(
              Effect.promise(() => tmpdir()),
              (root) =>
                Effect.gen(function* () {
                  const world = yield* Effect.promise(() => makeWorld(root.path))
                  const link = path.join(world.root, "outside", "config.txt")
                  const real = path.join(world.root, "farther", "config.txt")
                  yield* Effect.promise(async () => {
                    await fs.writeFile(real, text)
                    await fs.symlink(real, link, "file")
                  })
                  const at = way.spelled(world.root)
                  const settled = yield* run(
                    world.project,
                    "Patch",
                    patched(act === "delete" ? `*** Delete File: ${at}` : update(at, "plain/moved.txt")),
                    { ...item.options(world.root), trusted },
                  )
                  expect(Exit.isSuccess(settled.exit)).toBe(item.removed)
                  const [linkThere, content] = yield* Effect.promise(async () => [
                    await fs.lstat(link).then(
                      (info) => info.isSymbolicLink(),
                      () => false,
                    ),
                    await fs.readFile(real, "utf8"),
                  ])
                  expect(linkThere).toBe(!item.removed)
                  expect(content).toBe(text)
                  item.check(settled, world.root)
                }),
              (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
            ),
          )

  // How many times the folder of the link that is removed is asked about. A link of a project that is not trusted yet
  // leads to a folder of Orbit's own: that folder's allow does not answer for it, as it does not for a file the link leads
  // to. In a trusted project, or through a link outside the project, which is not the repository's, the allow does. A
  // link that stays in the project needs no folder question, and a folder named directly is asked about once, for the
  // target. `own` makes the folder one of Orbit's own.
  const own = { trusted: true, spelled: "out/config.txt", link: ["outside"], real: ["farther"], own: true }
  const inside = { spelled: "alias/config.txt", link: ["proj", "sub"], real: ["farther"], own: false, asked: 0 }
  const named = { spelled: path.join("elsewhere", "config.txt"), absolute: true, link: ["elsewhere"], real: ["farther"] }
  const folderRows = [
    { ...own, name: "an own folder through the project's link", asked: 0 },
    { ...own, name: "an own folder through the project's link", trusted: false, asked: 1 },
    {
      name: "an own folder through a link outside the project",
      trusted: false,
      spelled: path.join("elsewhere", "alias", "config.txt"),
      absolute: true,
      link: ["farther"],
      real: ["outside"],
      own: true,
      asked: 0,
    },
    { ...inside, name: "a folder in the project through its link inside", trusted: true },
    { ...inside, name: "a folder in the project through its link inside", trusted: false },
    { ...named, name: "a folder outside the project named directly", trusted: true, own: false, asked: 1 },
    { ...named, name: "a folder outside the project named directly", trusted: false, own: false, asked: 1 },
  ]
  for (const row of folderRows)
    linkedFile(`${row.name}, in ${row.trusted ? "a trusted" : "an untrusted"} folder`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const world = yield* Effect.promise(() => makeWorld(root.path))
            const folder = path.join(world.root, ...row.link)
            const link = path.join(folder, "config.txt")
            const real = path.join(world.root, ...row.real, "config.txt")
            yield* Effect.promise(async () => {
              await fs.writeFile(real, text)
              await fs.symlink(real, link, "file")
            })
            const unused = path.join(world.root, "unused")
            const at = row.absolute ? path.join(world.root, row.spelled) : row.spelled
            const settled = yield* run(world.project, "Patch", patched(`*** Delete File: ${at}`), {
              trusted: row.trusted,
              rules: row.own ? Agent.folders({ data: unused, tmp: unused, config: folder }) : [],
            })
            expect(Exit.isSuccess(settled.exit)).toBe(true)
            expect(
              settled.asked
                .filter((item) => item.action === "external_directory")
                .flatMap((item) => item.resources)
                .filter((resource) => resource === `${forward(folder)}/*`),
            ).toHaveLength(row.asked)
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )
})

// Fix loop 7 (classes 3 and 8): a rule written for the path of a link as the project spells it decides a delete, or a
// move's source, that removes that link, in an untrusted folder as in a trusted one. Until the folder is trusted, the
// request of a link that leads out names the place it leads to, so the spelling of what is removed was no subject of the
// rules, and the removal was neither refused nor asked about. The trusted rows are the control.
describe("a rule for the spelling of a link that is removed decides its removal", () => {
  const linkedFile = canLinkFile ? it.live : it.live.skip
  const shapes = [
    { name: "out", spelled: "shown.txt", link: ["proj", "shown"], real: ["outside", "real"] },
    { name: "inside", spelled: "shown.txt", link: ["proj", "shown"], real: ["proj", "sub", "real"] },
    { name: "in a linked folder out", spelled: "out/shown.txt", link: ["outside", "shown"], real: ["farther", "real"] },
    { name: "in a linked folder inside", spelled: "alias/shown.txt", link: ["proj", "sub", "shown"], real: ["outside", "real"] },
    { name: "in a folder linked to one above it", spelled: "up/shown.txt", link: ["shown"], real: ["farther", "real"] },
  ]
  for (const trusted of [true, false])
    for (const act of ["delete", "move from"] as const)
      for (const effect of ["deny", "ask"] as const)
        for (const spelling of ["relative", "absolute"] as const)
          for (const shape of shapes)
            linkedFile(
              `${effect} for its ${spelling} spelling: ${act}, ${shape.name}, in ${trusted ? "a trusted" : "an untrusted"} folder`,
              () =>
                Effect.acquireUseRelease(
                  Effect.promise(() => tmpdir()),
                  (root) =>
                    Effect.gen(function* () {
                      const world = yield* Effect.promise(() => makeWorld(root.path))
                      const link = `${path.join(world.root, ...shape.link)}.txt`
                      const real = `${path.join(world.root, ...shape.real)}.txt`
                      yield* Effect.promise(async () => {
                        await fs.writeFile(real, text)
                        await fs.symlink(real, link, "file")
                        await fs.symlink(world.root, path.join(world.project, "up"), "junction")
                      })
                      const resource =
                        spelling === "relative" ? shape.spelled : forward(path.join(world.project, shape.spelled))
                      const settled = yield* run(
                        world.project,
                        "Patch",
                        patched(
                          act === "delete" ? `*** Delete File: ${shape.spelled}` : update(shape.spelled, "plain/moved.txt"),
                        ),
                        { effect: "allow", trusted, rules: [{ action: "Edit", resource, effect }] },
                      )
                      const removed = effect === "ask"
                      expect(Exit.isSuccess(settled.exit)).toBe(removed)
                      const [linkThere, content] = yield* Effect.promise(async () => [
                        await fs.lstat(link).then(
                          (info) => info.isSymbolicLink(),
                          () => false,
                        ),
                        await fs.readFile(real, "utf8"),
                      ])
                      expect(linkThere).toBe(!removed)
                      expect(content).toBe(text)
                      // Everything else is allowed, so the only question about the change is the one the rule asks.
                      if (removed) expect(settled.request?.action).toBe("Edit")
                    }),
                  (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
                ),
            )

  // The memory folder is written without a question only while every place a call reaches is in its real folder. The
  // spelling of a link that is removed joins the subjects only where an untrusted link leads out, so a delete in a memory
  // folder reached through a linked data folder stays without a question, by either spelling (classes 3 and 4).
  for (const spelling of ["linked", "real"] as const)
    linkedFile(`a link in the memory folder is removed without a question, by the ${spelling} spelling of the data folder`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const world = yield* Effect.promise(() => makeWorld(root.path))
            const data = path.join(world.root, "data")
            const linked = path.join(world.root, "data-link")
            const memory = path.join(data, "memory", Project.ID.global)
            const real = path.join(memory, "kept.md")
            const link = path.join(memory, "note.md")
            yield* Effect.promise(async () => {
              await fs.mkdir(memory, { recursive: true })
              await fs.symlink(data, linked, "junction")
              await fs.writeFile(real, text)
              await fs.symlink(real, link, "file")
            })
            const at = path.join(spelling === "linked" ? linked : data, "memory", Project.ID.global, "note.md")
            const settled = yield* run(world.project, "Patch", patched(`*** Delete File: ${at}`), {
              trusted: false,
              data: linked,
            })
            expect(Exit.isSuccess(settled.exit)).toBe(true)
            expect(settled.asked).toEqual([])
            expect(yield* Effect.promise(() => fs.lstat(link).then(() => true, () => false))).toBe(false)
            expect(yield* Effect.promise(() => fs.readFile(real, "utf8"))).toBe(text)
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )
})

// Fix loop 8 (classes 3 and 8): a rule written for a path as the project spells it decides every call that writes or
// reads through a link there, in an untrusted folder as in a trusted one. Until the folder is trusted, a link that leads
// out makes the request name the place it leads to, so the spelled path was no subject of the rules: a deny let the write
// land outside and an ask asked nothing. The shapes are a file that is itself a link out of the project and a file below a
// folder link out of it; "Read" is the door of Read, Grep and LSP. The trusted rows are the control.
describe("a rule for the spelling of a path a link leads out of decides the call through it", () => {
  const linkedFile = canLinkFile ? it.live : it.live.skip
  const fileTools = [
    { name: "Edit", file: "shown.txt", existing: text, input: (at: string) => changes[0]!.input(at, "") },
    { name: "Write", file: "shown.txt", existing: text, input: (at: string) => ({ file_path: at, content: "new\n" }) },
    { name: "NotebookEdit", file: "shown.ipynb", existing: notebook, input: (at: string) => changes[2]!.input(at, "") },
    { name: "Patch update", file: "shown.txt", existing: text, input: (at: string) => patched(update(at)) },
    { name: "Patch move to", file: "shown.txt", existing: text, input: (at: string) => patched(update("plain/b.txt", at)) },
    { name: "Read", file: "shown.txt", existing: text, input: (at: string) => ({ file_path: at }) },
  ]
  const folderTools = [
    ...changes.filter((change) => change.name !== "Patch delete" && change.name !== "Patch move from"),
    { name: "Read", tool: "Read", file: "b.txt", existing: text, input: (at: string) => ({ file_path: at }) },
  ]
  const rows = [
    ...fileTools.map((item) => ({ ...item, shape: "a file link", tool: item.name.split(" ")[0]!, at: item.file })),
    ...folderTools.map((item) => ({ ...item, shape: "a folder link", at: `out/${item.file}` })),
  ]
  for (const trusted of [true, false])
    for (const row of rows)
      for (const effect of ["deny", "ask"] as const)
        for (const spelling of ["relative", "absolute"] as const)
          (row.shape === "a file link" ? linkedFile : it.live)(
            `${effect} for its ${spelling} spelling: ${row.name} through ${row.shape}, in ${trusted ? "a trusted" : "an untrusted"} folder`,
            () =>
              Effect.acquireUseRelease(
                Effect.promise(() => tmpdir()),
                (root) =>
                  Effect.gen(function* () {
                    const world = yield* Effect.promise(() => makeWorld(root.path))
                    const real = path.join(world.root, "outside", row.shape === "a file link" ? `real${path.extname(row.file)}` : row.file)
                    yield* Effect.promise(async () => {
                      await fs.writeFile(path.join(world.project, "plain", "b.txt"), text)
                      if (row.existing !== undefined) await fs.writeFile(real, row.existing)
                      if (row.shape === "a file link") await fs.symlink(real, path.join(world.project, row.at), "file")
                    })
                    const action = row.tool === "Read" ? "Read" : "Edit"
                    const settled = yield* run(world.project, row.tool, row.input(row.at, "plain/b.txt"), {
                      effect: "allow",
                      trusted,
                      rules: [
                        { action: "external_directory", resource: "*", effect: "allow" },
                        {
                          action,
                          resource: spelling === "relative" ? row.at : forward(path.join(world.project, row.at)),
                          effect,
                        },
                      ],
                    })
                    const asked = settled.asked.filter((request) => request.action === action)
                    expect([Exit.isSuccess(settled.exit), asked.length]).toEqual(effect === "deny" ? [false, 0] : [true, 1])
                    // A deny leaves the place the link leads to as it was.
                    if (effect === "deny")
                      expect(yield* Effect.promise(() => fs.readFile(real, "utf8").catch(() => undefined))).toBe(row.existing)
                  }),
                (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
              ),
          )
})

/// Fix loop 11, GAP B (classes 3 and 8): a policy written for a path as the project spells it refuses every call that
// writes, removes or reads through a link there, in an untrusted folder as in a trusted one, whether a person's document
// or their organization states it. Until the folder is trusted, the resource of such a call is the place the link leads
// to, so the policy plugin, which was shown the resource and its aliases only, let the call through. It is now shown the
// request's leads in every spelling a rule is tried in, and refuses on them in a pass of its own. The trusted rows are
// the control.
describe("a policy for the spelling of a path a link leads out of refuses the call through it", () => {
  const linkedFile = canLinkFile ? it.live : it.live.skip
  const fileTools = [
    { name: "Edit", file: "shown.txt", existing: text, input: (at: string) => changes[0]!.input(at, "") },
    { name: "Write", file: "shown.txt", existing: text, input: (at: string) => ({ file_path: at, content: "new\n" }) },
    { name: "NotebookEdit", file: "shown.ipynb", existing: notebook, input: (at: string) => changes[2]!.input(at, "") },
    { name: "Patch update", file: "shown.txt", existing: text, input: (at: string) => patched(update(at)) },
    { name: "Patch move to", file: "shown.txt", existing: text, input: (at: string) => patched(update("plain/b.txt", at)) },
    // These two remove the link itself, so what a refusal keeps is the link.
    { name: "Patch delete", file: "shown.txt", existing: text, input: (at: string) => patched(`*** Delete File: ${at}`) },
    {
      name: "Patch move from",
      file: "shown.txt",
      existing: text,
      input: (at: string) => patched(update(at, "plain/moved.txt")),
    },
    { name: "Read", file: "shown.txt", existing: text, input: (at: string) => ({ file_path: at }) },
  ]
  const folderTools = [
    ...changes,
    { name: "Read", tool: "Read", file: "b.txt", existing: text, input: (at: string) => ({ file_path: at }) },
  ]
  const rows = [
    ...fileTools.map((item) => ({
      ...item,
      shape: "a file link",
      tool: item.name.split(" ")[0]!,
      at: item.file,
      named: item.file,
    })),
    ...folderTools.map((item) => ({ ...item, shape: "a folder link", at: `out/${item.file}`, named: "out/*" })),
  ]
  for (const trusted of [true, false])
    for (const row of rows)
      for (const from of ["user", "organization"] as const)
        for (const spelling of ["relative", "absolute"] as const)
          (row.shape === "a file link" ? linkedFile : it.live)(
            `${from} policy for its ${spelling} spelling: ${row.name} through ${row.shape}, in ${trusted ? "a trusted" : "an untrusted"} folder`,
            () =>
              Effect.acquireUseRelease(
                Effect.promise(() => tmpdir()),
                (root) =>
                  Effect.gen(function* () {
                    const world = yield* Effect.promise(() => makeWorld(root.path))
                    const real = path.join(
                      world.root,
                      "outside",
                      row.shape === "a file link" ? `real${path.extname(row.file)}` : row.file,
                    )
                    yield* Effect.promise(async () => {
                      await fs.writeFile(path.join(world.project, "plain", "b.txt"), text)
                      if (row.existing !== undefined) await fs.writeFile(real, row.existing)
                      if (row.shape === "a file link") await fs.symlink(real, path.join(world.project, row.at), "file")
                    })
                    const action = row.tool === "Read" ? "Read" : "Edit"
                    const named = spelling === "relative" ? row.named : forward(path.join(world.project, row.named))
                    const settled = yield* run(world.project, row.tool, row.input(row.at, "plain/b.txt"), {
                      effect: "allow",
                      trusted,
                      rules: [{ action: "external_directory", resource: "*", effect: "allow" }],
                      policy: { from, statements: [{ action: "permission", resource: `${action}:${named}`, effect: "deny" }] },
                    })
                    expect(Exit.isSuccess(settled.exit)).toBe(false)
                    expect(settled.asked.filter((request) => request.action === action)).toEqual([])
                    // The place the link leads to is as it was, and so is the link.
                    expect(yield* Effect.promise(() => fs.readFile(real, "utf8").catch(() => undefined))).toBe(
                      row.existing,
                    )
                    expect(
                      yield* Effect.promise(() =>
                        fs.lstat(path.join(world.project, row.shape === "a file link" ? row.at : "out")).then(
                          (info) => info.isSymbolicLink(),
                          () => false,
                        ),
                      ),
                    ).toBe(true)
                  }),
                (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
              ),
          )

  // The leads never widen: a policy that allows only the spelling of a lead does not lift a deny of the resource, in a
  // trusted folder (where the resource is the spelling and the lead the real place) as in an untrusted one (the other
  // way round). Merged into the aliases, the later allow would decide both. In a trusted folder the link's absolute
  // spelling is one of the resource's aliases, so an allow written with it must not reach the lead's pass either.
  for (const trusted of [true, false])
    for (const from of ["user", "organization"] as const)
      for (const spelling of ["relative", "absolute"] as const)
        it.live(
          `a later allow of a lead's ${spelling === "relative" ? "" : "absolute "}spelling keeps a ${from} deny of the real place (${trusted ? "trusted" : "untrusted"})`,
          () =>
            Effect.acquireUseRelease(
              Effect.promise(() => tmpdir()),
              (root) =>
                Effect.gen(function* () {
                  const world = yield* Effect.promise(() => makeWorld(root.path))
                  const real = path.join(world.root, "outside", "b.txt")
                  yield* Effect.promise(() => fs.writeFile(real, text))
                  const settled = yield* run(world.project, "Edit", changes[0]!.input("out/b.txt", ""), {
                    effect: "allow",
                    trusted,
                    rules: [{ action: "external_directory", resource: "*", effect: "allow" }],
                    policy: {
                      from,
                      statements: [
                        {
                          action: "permission",
                          resource: `Edit:${forward(path.join(world.root, "outside"))}/*`,
                          effect: "deny",
                        },
                        {
                          action: "permission",
                          resource:
                            spelling === "relative" ? "Edit:out/*" : `Edit:${forward(path.join(world.project, "out"))}/*`,
                          effect: "allow",
                        },
                      ],
                    },
                  })
                  expect(Exit.isSuccess(settled.exit)).toBe(false)
                  expect(yield* Effect.promise(() => fs.readFile(real, "utf8"))).toBe(text)
                }),
              (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
            ),
        )

  // The control: with no policy for the path, the same call runs.
  for (const trusted of [true, false])
    it.live(`with no policy for the path, an Edit through a folder link runs (${trusted ? "trusted" : "untrusted"})`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const world = yield* Effect.promise(() => makeWorld(root.path))
            const real = path.join(world.root, "outside", "b.txt")
            yield* Effect.promise(() => fs.writeFile(real, text))
            const settled = yield* run(world.project, "Edit", changes[0]!.input("out/b.txt", ""), {
              effect: "allow",
              trusted,
              rules: [{ action: "external_directory", resource: "*", effect: "allow" }],
              policy: { from: "user", statements: [{ action: "permission", resource: "Edit:plain/*", effect: "deny" }] },
            })
            expect(Exit.isSuccess(settled.exit)).toBe(true)
            expect(yield* Effect.promise(() => fs.readFile(real, "utf8"))).toBe("alpha\nBETA\n")
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )
})

// Fix loop 12 (classes 3 and 8): a policy that denies everything and then allows a few paths decides a file tool as the
// same allowlist written as rules does. The absolute spelling of a file tool's resource is one of its own spellings,
// decided with it, so a later allow of the relative path lifts the broad deny; and the spellings of one place a link
// leads to are one subject, so a project reached through a link is allowed by the path it spells. An allow written for
// a link's own spelling still lifts no deny of the place it leads out to.
describe("an allowlist policy decides a file tool as the same rules do", () => {
  const tools = [
    ...["Edit", "Write (new file)", "NotebookEdit", "Patch update"].map(
      (name) => changes.find((change) => change.name === name)!,
    ),
    { name: "Read", tool: "Read", file: "b.txt", existing: text, input: (at: string) => ({ file_path: at }) },
  ]
  const places = [
    { name: "no link", folder: "plain", session: "project", runs: true },
    { name: "the project through a link", folder: "plain", session: "link", runs: true },
    { name: "a link out", folder: "out", session: "project", runs: false },
  ] as const
  for (const place of places)
    for (const trusted of [true, false])
      for (const by of ["rules", "user", "organization"] as const)
        for (const tool of tools)
          it.live(
            `${tool.name} with ${place.name}, by ${by === "rules" ? "rules" : `${by} policy`} (${trusted ? "trusted" : "untrusted"})`,
            () =>
              Effect.acquireUseRelease(
                Effect.promise(() => tmpdir()),
                (root) =>
                  Effect.gen(function* () {
                    const world = yield* Effect.promise(() => makeWorld(root.path))
                    const session = place.session === "link" ? path.join(world.root, "projlink") : world.project
                    const real = path.join(
                      place.folder === "out" ? path.join(world.root, "outside") : path.join(world.project, "plain"),
                      tool.file,
                    )
                    yield* Effect.promise(async () => {
                      if (place.session === "link") await fs.symlink(world.project, session, "junction")
                      if (tool.existing !== undefined) await fs.writeFile(real, tool.existing)
                    })
                    const action = tool.tool === "Read" ? "Read" : "Edit"
                    const allowlist = [
                      { resource: "*", effect: "deny" as const },
                      { resource: `${place.folder}/*`, effect: "allow" as const },
                    ]
                    const at = `${place.folder}/${tool.file}`
                    const settled = yield* run(session, tool.tool, tool.input(at, "plain/b.txt"), {
                      effect: "allow",
                      trusted,
                      rules: [
                        { action: "external_directory", resource: "*", effect: "allow" },
                        ...(by === "rules" ? allowlist.map((rule) => ({ action, ...rule })) : []),
                      ],
                      ...(by === "rules"
                        ? {}
                        : {
                            policy: {
                              from: by,
                              statements: allowlist.map((rule) => ({
                                action: "permission",
                                resource: `${action}:${rule.resource}`,
                                effect: rule.effect,
                              })),
                            },
                          }),
                    })
                    expect(Exit.isSuccess(settled.exit)).toBe(place.runs)
                    expect(settled.asked.filter((request) => request.action === action)).toEqual([])
                    const now = yield* Effect.promise(() => fs.readFile(real, "utf8").catch(() => undefined))
                    if (place.runs && tool.tool !== "Read") expect(now).not.toBe(tool.existing)
                    else expect(now).toBe(tool.existing)
                  }),
                (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
              ),
          )
})

// Fix loop 11, GAP A (classes 3, 4 and 8): with the session folder below the worktree, the project spells a file under a
// link out `../out/b.txt`. A trusted folder asks with that spelling, so a rule written for it decides; an untrusted one
// asks for the place the link leads to with that spelling as a lead, which was tried relative to the session folder only
// when it did not climb out of it. It is now kept while it stays in the project's folders. The absolute spelling and the
// trusted folder are the controls.
describe("a rule for the ../ spelling of a path a link leads out of decides the call through it", () => {
  const rows = [
    ...changes,
    { name: "Read", tool: "Read", file: "b.txt", existing: text, input: (at: string) => ({ file_path: at }) },
  ]
  for (const trusted of [true, false])
    for (const row of rows)
      for (const effect of ["deny", "ask"] as const)
        for (const spelling of ["dot-dot", "absolute"] as const)
          it.live(
            `${effect} for its ${spelling} spelling: ${row.name}, in ${trusted ? "a trusted" : "an untrusted"} folder`,
            () =>
              Effect.acquireUseRelease(
                Effect.promise(() => tmpdir()),
                (root) =>
                  Effect.gen(function* () {
                    const world = yield* Effect.promise(() => makeWorld(root.path))
                    const real = path.join(world.root, "outside", row.file)
                    yield* Effect.promise(async () => {
                      await fs.writeFile(path.join(world.project, "plain", "b.txt"), text)
                      if (row.existing !== undefined) await fs.writeFile(real, row.existing)
                    })
                    const action = row.tool === "Read" ? "Read" : "Edit"
                    const settled = yield* run(
                      path.join(world.project, "plain"),
                      row.tool,
                      row.input(`../out/${row.file}`, "b.txt"),
                      {
                        effect: "allow",
                        trusted,
                        worktree: world.project,
                        rules: [
                          { action: "external_directory", resource: "*", effect: "allow" },
                          {
                            action,
                            resource: spelling === "dot-dot" ? "../out/*" : `${forward(path.join(world.project, "out"))}/*`,
                            effect,
                          },
                        ],
                      },
                    )
                    const asked = settled.asked.filter((request) => request.action === action)
                    expect([Exit.isSuccess(settled.exit), asked.length]).toEqual(
                      effect === "deny" ? [false, 0] : [true, 1],
                    )
                    if (effect === "deny")
                      expect(yield* Effect.promise(() => fs.readFile(real, "utf8").catch(() => undefined))).toBe(
                        row.existing,
                      )
                  }),
                (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
              ),
          )

  // A climbing relative of a place outside the project is still no subject: no project spells that file so, and a rule
  // for `../outside/*` must not decide a call that a link of the worktree leads there.
  for (const trusted of [true, false])
    it.live(`a rule for a ../ spelling outside the project does not decide (${trusted ? "trusted" : "untrusted"})`, () =>
      Effect.acquireUseRelease(
        Effect.promise(() => tmpdir()),
        (root) =>
          Effect.gen(function* () {
            const world = yield* Effect.promise(() => makeWorld(root.path))
            const real = path.join(world.root, "outside", "b.txt")
            yield* Effect.promise(() => fs.writeFile(real, text))
            const settled = yield* run(world.project, "Edit", changes[0]!.input("out/b.txt", ""), {
              effect: "allow",
              trusted,
              rules: [
                { action: "external_directory", resource: "*", effect: "allow" },
                { action: "Edit", resource: "../outside/*", effect: "deny" },
              ],
            })
            expect(Exit.isSuccess(settled.exit)).toBe(true)
            expect(yield* Effect.promise(() => fs.readFile(real, "utf8"))).toBe("alpha\nBETA\n")
          }),
        (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
      ),
    )

  // The session folder reached through a link (`<root>/projlink/plain`, its worktree `<root>/projlink`): a lead the
  // disk names by its real path is respelled under the worktree as the session spells it, and the `../` relative of
  // that respelling is kept because its place is in the worktree as spelled, not as the disk has it. A rule and a
  // policy for `../out/*` decide alike (class 3).
  for (const trusted of [true, false])
    for (const row of rows)
      for (const kind of ["deny", "ask", "policy"] as const)
        it.live(
          `${kind} for its dot-dot spelling with the session folder through a link: ${row.name}, in ${trusted ? "a trusted" : "an untrusted"} folder`,
          () =>
            Effect.acquireUseRelease(
              Effect.promise(() => tmpdir()),
              (root) =>
                Effect.gen(function* () {
                  const world = yield* Effect.promise(() => makeWorld(root.path))
                  const projlink = path.join(world.root, "projlink")
                  const real = path.join(world.root, "outside", row.file)
                  yield* Effect.promise(async () => {
                    await fs.symlink(world.project, projlink, "junction")
                    await fs.writeFile(path.join(world.project, "plain", "b.txt"), text)
                    if (row.existing !== undefined) await fs.writeFile(real, row.existing)
                  })
                  const action = row.tool === "Read" ? "Read" : "Edit"
                  const settled = yield* run(
                    path.join(projlink, "plain"),
                    row.tool,
                    row.input(`../out/${row.file}`, "b.txt"),
                    {
                      effect: "allow",
                      trusted,
                      worktree: projlink,
                      rules: [
                        { action: "external_directory", resource: "*", effect: "allow" },
                        ...(kind === "policy" ? [] : [{ action, resource: "../out/*", effect: kind }]),
                      ],
                      ...(kind === "policy"
                        ? {
                            policy: {
                              from: "user" as const,
                              statements: [
                                { action: "permission", resource: `${action}:../out/*`, effect: "deny" as const },
                              ],
                            },
                          }
                        : {}),
                    },
                  )
                  const asked = settled.asked.filter((request) => request.action === action)
                  expect([Exit.isSuccess(settled.exit), asked.length]).toEqual(kind === "ask" ? [true, 1] : [false, 0])
                  if (kind !== "ask")
                    expect(yield* Effect.promise(() => fs.readFile(real, "utf8").catch(() => undefined))).toBe(
                      row.existing,
                    )
                }),
              (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
            ),
        )

  // What a plugin hook is shown: the spellings of a lead relative to the session folder are written with forward
  // slashes, whatever the platform's separator, and the `../` one is there with the session folder reached directly or
  // through a link, as the rules try it.
  for (const trusted of [true, false])
    for (const session of ["direct", "a link"] as const)
      it.live(
        `a hook is shown the ../ spelling of a lead, the session folder ${session} (${trusted ? "trusted" : "untrusted"})`,
        () =>
          Effect.acquireUseRelease(
            Effect.promise(() => tmpdir()),
            (root) =>
              Effect.gen(function* () {
                const world = yield* Effect.promise(() => makeWorld(root.path))
                const worktree = session === "direct" ? world.project : path.join(world.root, "projlink")
                yield* Effect.promise(async () => {
                  if (session === "a link") await fs.symlink(world.project, worktree, "junction")
                  await fs.writeFile(path.join(world.root, "outside", "b.txt"), text)
                })
                const evaluations: Array<{ action: string; leads?: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> }> =
                  []
                const settled = yield* run(
                  path.join(worktree, "plain"),
                  "Edit",
                  changes[0]!.input("../out/b.txt", ""),
                  {
                    effect: "allow",
                    trusted,
                    worktree,
                    rules: [{ action: "external_directory", resource: "*", effect: "allow" }],
                    evaluations,
                  },
                )
                expect(Exit.isSuccess(settled.exit)).toBe(true)
                const relatives = evaluations
                  .filter((evaluation) => evaluation.action === "Edit")
                  .flatMap((evaluation) => Object.values(evaluation.leads ?? {}).flat(2))
                  .filter((lead) => !path.isAbsolute(lead))
                // A trusted folder asks with the `../` spelling itself, and its lead is the real place outside the
                // project, which no project spells relative to the session folder.
                expect([...new Set(relatives)]).toEqual(trusted ? [] : ["../out/b.txt"])
              }),
            (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
          ),
      )
})

// The name of a link that is removed: as it is spelled in the project, or where it is when an untrusted one leads out.
function removedName(trusted: boolean, shape: { spelled: string; outside: boolean }, link: string) {
  return !trusted && shape.outside ? forward(link) : `${shape.spelled}.txt`
}

// Fix loop 1 (class 9): a name with a break in it leaves a diff's header one line, so no client draws it as raw text.
describe("the header of an approval's diff is one line", () => {
  for (const [name, value, shown] of [
    ["a line feed", "\n", "\\n"],
    ["CR and LF", "\r\n", "\\n"],
    ["a carriage return", "\r", "\\x0d"],
    ["a line separator", "\u2028", "\\u{2028}"],
    ["a paragraph separator", "\u2029", "\\u{2029}"],
    ["several breaks", "\nb.txt\r\nc.txt\n", "\\nb.txt\\nc.txt\\n"],
  ] as const) {
    it.live(`fileDiff of a name with ${name}`, () =>
      Effect.sync(() => {
        const file = `a.txt${value}Link ends inside the project`
        const diff = fileDiff(file, "old\n", "new\n")
        expect(diff.file).toBe(file)
        const lines = diff.patch.split("\n")
        expect(lines).toContain(`+++ a.txt${shown}Link ends inside the project`)
        expect(lines.filter((line) => line.startsWith("Link ends"))).toEqual([])
      }),
    )
  }
  // NTFS takes the separators, so this runs on every system, through the real tool.
  it.live("a Patch of a file with a line separator in its name", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (root) =>
        Effect.gen(function* () {
          const world = yield* Effect.promise(() => makeWorld(root.path))
          const settled = yield* run(world.project, "Patch", patched("*** Add File: a\u2028Link ends inside.txt\n+new"))
          const entry = entries(settled.request)[0] as { patch?: string } | undefined
          expect(entry?.patch).toContain("a\\u{2028}Link ends inside.txt")
          expect(entry?.patch).not.toContain("\u2028")
        }),
      (root) => Effect.promise(() => root[Symbol.asyncDispose]()),
    ),
  )
})
