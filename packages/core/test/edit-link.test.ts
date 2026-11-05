// clients-ux-15 part 3: an Edit or Write whose file is reached through a link says so on its request, as the reference
// warns before such a change. The request names where the link really leads, and whether that is outside the session's
// folders, decided by real path on the server, so every client shows the server's value and never works it out from the
// tool's input (class 8). `outside` compares real paths, never strings (class 4): a sibling folder whose name begins with
// the session folder's name is outside. Everything runs through the real Permission service and the real file tools.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { Agent } from "@orbit/core/agent"
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
import { WriteTool } from "@orbit/core/tool/plugin/write"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin } from "./lib/tool"

const sessionID = Session.ID.make("ses_link")
const identity = { agent: Agent.ID.make("test"), messageID: SessionMessage.ID.make("msg_link") }
const it = testEffect(Layer.empty)

const plugins = makeLocationNode({
  name: "test/edit-link-plugins",
  layer: Layer.effectDiscard(Effect.all([registerToolPlugin(EditTool.Plugin), registerToolPlugin(WriteTool.Plugin)])),
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

// Runs one call in the project at `directory`, whose agent asks about everything, and allows each question once.
const run = (directory: string, name: string, input: Record<string, unknown>) =>
  Effect.gen(function* () {
    yield* seed(directory)
    const tools = yield* Tool.Service
    const permission = yield* Permission.Service
    const fiber = yield* (yield* tools.snapshot())
      .execute({ sessionID, ...identity, call: { type: "tool-call", id: `call-${name}`, name, input } })
      .pipe(Effect.forkScoped)
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
        yield* permission.reply({ requestID: request.id, reply: "once" }).pipe(Effect.exit)
        return yield* drive()
      })
    const exit = yield* drive()
    return { exit, request: asked.find((request) => request.action === "Edit") }
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
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ),
          Formatter.node.replace(Layer.mock(Formatter.Service, { file: () => Effect.succeed(false) })),
          Image.node.replace(imagePassthrough),
        ],
      ),
    ),
  )

const seed = (directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make(directory), sandboxes: [] })
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
        agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
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
