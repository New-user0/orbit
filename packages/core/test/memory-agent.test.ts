// context-memory-10: an agent with `memory: user | project | local` keeps its notes in a folder of its own, as the
// reference's agents do. `MemoryAgent` maps an agent and a scope to that folder: user `<data>/memory/agents/<id>`,
// project `<dir>/.orbit/agent-memory/<id>` and local `<dir>/.orbit/agent-memory-local/<id>`, where `<dir>` is the
// Location's own folder. The two roots inside the folder are the repository's, so a clone chooses what they are: they
// are resolved once per Location, only after the project is trusted (class 1), never through a link to a share (class
// 6), and only while each really is that folder of the real Location folder (class 4). An id becomes a path only after
// the plain-name check (class 5). A refused root or id costs only itself, with one line in the log (class 7). Every row
// that expects nothing has a control in the same test that resolves.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Logger, Schema } from "effect"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { MemoryAgent } from "@orbit/core/memory/agent"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const linkType = process.platform === "win32" ? "junction" : "dir"
const decodeInfo = Schema.decodeUnknownSync(Info)

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const data = path.join(root, "data")
  const project = path.join(root, "project")
  const outside = path.join(root, "outside")
  yield* Effect.promise(() =>
    Promise.all([data, project, outside].map((folder) => fs.mkdir(folder, { recursive: true }))),
  )
  return {
    root,
    data,
    project,
    outside,
    user: path.join(data, "memory", "agents"),
    orbit: path.join(project, ".orbit"),
    shared: path.join(project, ".orbit", "agent-memory"),
    local: path.join(project, ".orbit", "agent-memory-local"),
  }
})
type Layout = Effect.Success<typeof layout>

const provide = (
  l: Layout,
  options: {
    readonly entries?: Entry[]
    readonly untrusted?: boolean
    readonly files?: Layer.Layer<FSUtil.Service>
    readonly directory?: string
  } = {},
) =>
  Effect.provide(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, MemoryAgent.node]), [
      Global.node.replace(Global.layerWith({ data: l.data, config: path.join(l.root, "config") })),
      Config.node.replace(Config.testLayer(options.entries ?? [])),
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of({
            directory: AbsolutePath.make(options.directory ?? l.project),
            project: {
              id: Project.ID.global,
              directory: AbsolutePath.make(l.project),
              canonical: AbsolutePath.make(l.project),
            },
            vcs: undefined,
          }),
        ),
      ),
      ...(options.untrusted ? [WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))] : []),
      ...(options.files === undefined ? [] : [FSUtil.node.replace(options.files)]),
    ]),
  )

const logged = (logs: string[]) =>
  Logger.layer([
    Logger.make(({ message }) => {
      logs.push(String(message))
    }),
  ])

const service = MemoryAgent.Service
const folders = (list: readonly MemoryAgent.Folder[]) => list.map((item) => item.folder)

// Two real paths name the same place, as the platform compares them.
const same = (a: string, b: string) => FSUtil.contains(a, b) && FSUtil.contains(b, a)
const realOf = (folder: string) => Effect.promise(() => fs.realpath(folder))

const exists = (file: string) =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )

describe("agent memory folders", () => {
  // Class 5 (nested ids) and decision 8: each scope has its root, a nested id nests folders, and `memory.directory`
  // moves the private folder but not the user scope's agent folders, as the reference keeps them under its config home.
  it.live("maps user, project and local scopes to their folders", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const custom = path.join(l.root, "custom-memory")
      const run = (entries: Entry[]) =>
        Effect.gen(function* () {
          const agents = yield* service
          return {
            user: yield* agents.folder("reviewer", "user"),
            project: yield* agents.folder("reviewer", "project"),
            local: yield* agents.folder("reviewer", "local"),
            nestedUser: yield* agents.folder("review/deep", "user"),
            nestedProject: yield* agents.folder("review/deep", "project"),
            nestedLocal: yield* agents.folder("review/deep", "local"),
          }
        }).pipe(provide(l, { entries }))
      const plain = yield* run([])
      const moved = yield* run([
        new Document({
          type: "document",
          scope: "user",
          path: AbsolutePath.make(path.resolve("/config/user/orbit.json")),
          info: decodeInfo({ memory: { directory: custom } }),
        }),
      ])
      for (const out of [plain, moved])
        expect({
          user: out.user?.folder,
          project: out.project?.folder,
          local: out.local?.folder,
          nestedUser: out.nestedUser?.folder,
          nestedProject: out.nestedProject?.folder,
          nestedLocal: out.nestedLocal?.folder,
        }).toEqual({
          user: path.join(l.user, "reviewer"),
          project: path.join(l.shared, "reviewer"),
          local: path.join(l.local, "reviewer"),
          nestedUser: path.join(l.user, "review", "deep"),
          nestedProject: path.join(l.shared, "review", "deep"),
          nestedLocal: path.join(l.local, "review", "deep"),
        })
      // The real place of a folder that is not there yet keeps its name below the nearest part that exists.
      const realProject = yield* realOf(l.project)
      expect(same(plain.project!.real, path.join(realProject, ".orbit", "agent-memory", "reviewer"))).toBe(true)
      expect(same(plain.nestedUser!.real, path.join(yield* realOf(l.data), "memory", "agents", "review", "deep"))).toBe(
        true,
      )
      // Mapping a folder makes nothing.
      expect(yield* exists(l.user)).toBe(false)
      expect(yield* exists(l.orbit)).toBe(false)
    }),
  )

  // Classes 5 and 7: the `Agent.ID` brand is not checked, so an agent that a plugin adds through the editor can carry any
  // id. Only a plain name becomes a folder; any other gets none, with one line in the log however often it is asked.
  it.live("maps an agent to no folder when its id is not a plain name", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const ids = ["../x", "a/../b", "x:y", "con", ".x", "x.", "C:/x", "a\\b"]
      const logs: string[] = []
      const out = yield* Effect.gen(function* () {
        const agents = yield* service
        const refused = yield* Effect.forEach(ids, (id) =>
          Effect.gen(function* () {
            const first = yield* agents.folder(id, "user")
            const again = yield* agents.folder(id, "project")
            return { id, folder: first?.folder ?? again?.folder }
          }),
        )
        return { refused, control: yield* agents.folder("plain", "user") }
      }).pipe(provide(l), Effect.provide(logged(logs)))
      expect(out.refused).toEqual(ids.map((id) => ({ id, folder: undefined })))
      expect(out.control?.folder).toBe(path.join(l.user, "plain"))
      const lines = logs.filter((line) => line.includes("not a plain name"))
      expect(lines).toHaveLength(ids.length)
      expect(yield* exists(path.join(l.data, "memory"))).toBe(false)
    }),
  )
})

describe("agent memory roots in the repository", () => {
  type Row = {
    readonly name: string
    readonly off: readonly ("project" | "local")[]
    readonly make: (l: Layout) => Promise<void>
  }
  const linkRoot = (scope: "project" | "local", target: (l: Layout) => string, name: string): Row => ({
    name: `${scope} root ${name}`,
    off: [scope],
    make: async (l) => {
      const root = scope === "project" ? l.shared : l.local
      await fs.mkdir(l.orbit, { recursive: true })
      await fs.mkdir(path.dirname(target(l)), { recursive: true })
      if (!name.includes("dangling") && !name.includes("loop")) await fs.mkdir(target(l), { recursive: true })
      await fs.symlink(target(l), root, linkType)
      if (name.includes("loop")) await fs.symlink(root, target(l), linkType)
    },
  })
  const rows: Row[] = [
    ...(["project", "local"] as const).flatMap((scope) => [
      linkRoot(scope, (l) => path.join(l.outside, "notes"), "a link out"),
      linkRoot(scope, (l) => l.project, "a link to the project"),
      linkRoot(scope, (l) => path.join(l.project, ".git"), "a link to .git"),
      linkRoot(scope, (l) => path.join(l.project, "src"), "a link to src"),
      linkRoot(scope, (l) => path.join(l.outside, "missing"), "a dangling link"),
      linkRoot(scope, (l) => path.join(l.orbit, "loop"), "a link in a loop"),
    ]),
    {
      name: "project root a link to .orbit",
      off: ["project"],
      make: async (l) => {
        await fs.mkdir(l.orbit, { recursive: true })
        await fs.symlink(l.orbit, l.shared, linkType)
      },
    },
    {
      name: ".orbit a link out",
      off: ["project", "local"],
      make: async (l) => {
        const settings = path.join(l.outside, "settings")
        await fs.mkdir(path.join(settings, "agent-memory"), { recursive: true })
        await fs.mkdir(path.join(settings, "agent-memory-local"), { recursive: true })
        await fs.symlink(settings, l.orbit, linkType)
      },
    },
    {
      name: ".orbit a link to another folder of the project",
      off: ["project", "local"],
      make: async (l) => {
        const settings = path.join(l.project, "settings")
        await fs.mkdir(path.join(settings, "agent-memory"), { recursive: true })
        await fs.symlink(settings, l.orbit, linkType)
      },
    },
    {
      name: ".orbit a dangling link",
      off: ["project", "local"],
      make: async (l) => {
        await fs.symlink(path.join(l.outside, "missing"), l.orbit, linkType)
      },
    },
  ]

  // Classes 4 and 7: the carve-out drops every ask and a mode's deny for what is in a root, so a root that is a link,
  // out of the project or onto the project itself, `.orbit`, `.git` or `src`, or one that leads nowhere, turns that
  // scope off for the Location with one line in the log. The user root stays, and a plain layout is the control.
  it.live("turns project and local agent memory off when .orbit or its root is a link", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const l = yield* layout
          yield* Effect.promise(() => row.make(l))
          const logs: string[] = []
          const out = yield* Effect.gen(function* () {
            const agents = yield* service
            const first = folders(yield* agents.current())
            const second = folders(yield* agents.current())
            return {
              first,
              second,
              project: (yield* agents.folder("x", "project"))?.folder,
              local: (yield* agents.folder("x", "local"))?.folder,
              user: (yield* agents.folder("x", "user"))?.folder,
            }
          }).pipe(provide(l), Effect.provide(logged(logs)))
          const expected = {
            current: [
              l.user,
              ...(row.off.includes("project") ? [] : [l.shared]),
              ...(row.off.includes("local") ? [] : [l.local]),
            ],
            project: row.off.includes("project") ? undefined : path.join(l.shared, "x"),
            local: row.off.includes("local") ? undefined : path.join(l.local, "x"),
            user: path.join(l.user, "x"),
            lines: row.off.length,
          }
          return {
            name: row.name,
            actual: {
              current: out.first,
              project: out.project,
              local: out.local,
              user: out.user,
              lines: logs.filter((line) => line.includes("agent memory is off")).length,
            },
            expected,
            again: out.second,
          }
        }),
      )
      for (const result of results) {
        expect({ name: result.name, ...result.actual }).toEqual({ name: result.name, ...result.expected })
        expect(result.again).toEqual(result.actual.current)
      }
      const plain = yield* layout
      const control = yield* Effect.gen(function* () {
        const agents = yield* service
        return folders(yield* agents.current())
      }).pipe(provide(plain))
      expect(control).toEqual([plain.user, plain.shared, plain.local])
    }),
  )

  // Class 4 (S1, S2): an id segment inside a root can be a link too. One that leads out of the root or nowhere gives the
  // agent no folder, and nothing is made where it points. A plain sibling id in the same root is the control.
  it.live("refuses an agent folder whose id segment is a link, and makes nothing through it", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const marker = path.join(l.outside, "marker")
      const missing = path.join(l.outside, "missing")
      yield* Effect.promise(async () => {
        await fs.mkdir(marker, { recursive: true })
        await fs.mkdir(l.shared, { recursive: true })
        await fs.mkdir(l.user, { recursive: true })
        await fs.symlink(marker, path.join(l.shared, "review"), linkType)
        await fs.symlink(missing, path.join(l.shared, "gone"), linkType)
        await fs.symlink(marker, path.join(l.user, "review"), linkType)
      })
      const out = yield* Effect.gen(function* () {
        const agents = yield* service
        return {
          nested: yield* agents.folder("review/deep", "project"),
          linked: yield* agents.folder("review", "project"),
          dangling: yield* agents.folder("gone/deep", "project"),
          user: yield* agents.folder("review/deep", "user"),
          control: yield* agents.folder("other", "project"),
        }
      }).pipe(provide(l))
      expect({
        nested: out.nested,
        linked: out.linked,
        dangling: out.dangling,
        user: out.user,
        control: out.control?.folder,
      }).toEqual({
        nested: undefined,
        linked: undefined,
        dangling: undefined,
        user: undefined,
        control: path.join(l.shared, "other"),
      })
      expect(yield* Effect.promise(() => fs.readdir(marker))).toEqual([])
      expect(yield* exists(missing)).toBe(false)
    }),
  )

  // Class 6: resolving a link to a share connects to the host it names, which the repository chooses. The recorded file
  // system is the oracle: no call but a readLink names `.orbit` or a root below it, and the scope is off at once. A plain
  // layout is the control.
  if (process.platform === "win32" && canLinkFile)
    it.live("does not resolve an agent memory root that is a link to a share", () =>
      Effect.gen(function* () {
        const share = "\\\\203.0.113.171\\share\\x"
        for (const linked of ["orbit", "root"] as const) {
          const l = yield* layout
          yield* Effect.promise(async () => {
            if (linked === "orbit") return fs.symlink(share, l.orbit, "dir")
            await fs.mkdir(l.orbit, { recursive: true })
            await fs.symlink(share, l.shared, "dir")
          })
          const recorded = recordedFileSystem()
          const started = Date.now()
          const out = yield* Effect.gen(function* () {
            const agents = yield* service
            return {
              current: folders(yield* agents.current()),
              project: yield* agents.folder("x", "project"),
            }
          }).pipe(provide(l, { files: recorded.layer }))
          expect(Date.now() - started).toBeLessThan(15_000)
          const named = linked === "orbit" ? l.orbit : l.shared
          const calls = recorded.calls.filter((call) => call.toLowerCase().includes(` ${named.toLowerCase()}`))
          expect({ linked, calls: calls.filter((call) => !call.startsWith("readLink ")) }).toEqual({ linked, calls: [] })
          expect(out.project).toBeUndefined()
          expect(out.current).not.toContain(l.shared)
        }
        const plain = yield* layout
        const control = yield* Effect.gen(function* () {
          const agents = yield* service
          return folders(yield* agents.current())
        }).pipe(provide(plain, { files: recordedFileSystem().layer }))
        expect(control).toEqual([plain.user, plain.shared, plain.local])
      }),
    )

  // Class 1: nothing of the repository's roots is resolved before the project is trusted: only the user root is there,
  // and no call of the file system names `.orbit`. The trusted run is the control.
  it.live("resolves no project or local root before the project is trusted", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* Effect.promise(() => fs.mkdir(l.shared, { recursive: true }))
      const recorded = recordedFileSystem()
      const run = (untrusted: boolean, files: Layer.Layer<FSUtil.Service>) =>
        Effect.gen(function* () {
          const agents = yield* service
          return {
            current: folders(yield* agents.current()),
            project: (yield* agents.folder("x", "project"))?.folder,
            local: (yield* agents.folder("x", "local"))?.folder,
            user: (yield* agents.folder("x", "user"))?.folder,
          }
        }).pipe(provide(l, { untrusted, files }))
      const untrusted = yield* run(true, recorded.layer)
      expect(untrusted).toEqual({
        current: [l.user],
        project: undefined,
        local: undefined,
        user: path.join(l.user, "x"),
      })
      expect(recorded.calls.filter((call) => call.toLowerCase().includes(l.orbit.toLowerCase()))).toEqual([])
      const trusted = yield* run(false, recordedFileSystem().layer)
      expect(trusted).toEqual({
        current: [l.user, l.shared, l.local],
        project: path.join(l.shared, "x"),
        local: path.join(l.local, "x"),
        user: path.join(l.user, "x"),
      })
    }),
  )

  // Class 12 and decision 3: project and local memory follow the Location's own folder, as the reference follows the
  // working folder, so a worktree-isolated agent keeps its project memory in its worktree.
  it.live("resolves project and local memory from the Location's own folder, a worktree's included", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const worktree = path.join(l.root, "worktree")
      yield* Effect.promise(() => fs.mkdir(worktree, { recursive: true }))
      const run = (directory: string) =>
        Effect.gen(function* () {
          const agents = yield* service
          return {
            project: (yield* agents.folder("x", "project"))?.folder,
            local: (yield* agents.folder("x", "local"))?.folder,
            user: (yield* agents.folder("x", "user"))?.folder,
          }
        }).pipe(provide(l, { directory }))
      const checkout = yield* run(l.project)
      const tree = yield* run(worktree)
      expect(checkout).toEqual({
        project: path.join(l.shared, "x"),
        local: path.join(l.local, "x"),
        user: path.join(l.user, "x"),
      })
      expect(tree).toEqual({
        project: path.join(worktree, ".orbit", "agent-memory", "x"),
        local: path.join(worktree, ".orbit", "agent-memory-local", "x"),
        user: path.join(l.user, "x"),
      })
    }),
  )
})
