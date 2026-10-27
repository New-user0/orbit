// clients-ux-42: `/memory` lists the instruction files the Location loaded at start-up, the user and project files a
// person can create, and the memory folders while memory is on; choosing one asks the server to make it. The server
// decides every place from its own state and never joins a client's string into a path (class 5): a file is one the
// listing holds, a scope is resolved as a note's would be (class 3), and a folder is the checked value of `MemoryStore`,
// `MemoryTeam` or `MemoryAgent`, made at its real path and checked again afterwards (class 4). A link to a share is
// refused before anything resolves, stats or makes it (class 6). Every row that expects nothing has a control in the
// same test that is made or listed (class 14).
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer, PlatformError, Schema } from "effect"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigInstructionPlugin } from "@orbit/core/config/plugin/instruction"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Environment } from "@orbit/core/environment/index"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Location } from "@orbit/core/location"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { MemoryAgent } from "@orbit/core/memory/agent"
import { MemoryListing } from "@orbit/core/memory/listing"
import { Plugin } from "@orbit/core/plugin"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Document, Info, type Entry } from "@orbit/schema/config"
import type { Instruction } from "@orbit/schema/instruction"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyManagedNode } from "./fixture/config-nodes"
import { location } from "./fixture/location"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)
const linkType = process.platform === "win32" ? "junction" : "dir"
const decodeInfo = Schema.decodeUnknownSync(Info)

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const project = path.join(root, "project")
  const outside = path.join(root, "outside")
  const home = path.join(root, "home")
  yield* Effect.promise(() => Promise.all([project, outside, home].map((folder) => fs.mkdir(folder, { recursive: true }))))
  return {
    root,
    project,
    outside,
    home,
    config: path.join(root, "config"),
    data: path.join(root, "data"),
    orbit: path.join(project, ".orbit"),
    shared: path.join(project, ".orbit", "agent-memory"),
    local: path.join(project, ".orbit", "agent-memory-local"),
    team: path.join(project, ".orbit", "team-memory"),
  }
})
type Layout = Effect.Success<typeof layout>

const provide = (
  l: Layout,
  options: {
    readonly entries?: Entry[]
    readonly directory?: string
    readonly spelled?: string
    readonly git?: boolean
    readonly files?: Layer.Layer<FSUtil.Service>
  } = {},
) => {
  const config = Config.testLayer(options.entries ?? [], { enabled: false, roots: [] })
  const watcher = Watcher.testLayer
  const project = options.spelled ?? l.project
  return Effect.provide(
    Layer.mergeAll(
      config,
      AppNodeBuilder.build(
        LayerNode.group([
          MemoryListing.node,
          MemoryAgent.node,
          Agent.node,
          InstructionDiscovery.node,
          Database.node,
          Bus.node,
          FSUtil.node,
          Global.node,
          Location.node,
          ProjectTrust.node,
          WorkspaceTrust.node,
          Watcher.node,
          ManagedSettings.node,
        ]),
        [
        Config.node.replace(config),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: true })),
        Global.node.replace(Global.layerWith({ config: l.config, home: l.home, data: l.data })),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(
              location(
                { directory: AbsolutePath.make(options.directory ?? project) },
                {
                  projectDirectory: AbsolutePath.make(project),
                  vcs: options.git ? { type: "git", store: AbsolutePath.make(path.join(project, ".git")) } : undefined,
                },
              ),
            ),
          ),
        ),
        Watcher.node.replace(watcher),
        ManagedSettings.node.replace(emptyManagedNode),
        Environment.node.replace(Layer.mock(Environment.Service, { files: {} as never, spawner: {} as never })),
        // The instruction plugin is started by the test itself, so there is nothing to wait for.
        Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
        ...(options.files ? [FSUtil.node.replace(options.files)] : []),
        ],
      ),
      watcher,
    ),
  )
}

const start = Effect.gen(function* () {
  yield* ConfigInstructionPlugin.Plugin.effect(host())
  return yield* MemoryListing.Service
})

const withAgents = (list: readonly { readonly id: string; readonly memory?: MemoryAgent.Scope }[]) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      for (const item of list)
        editor.update(Agent.ID.make(item.id), (agent) => {
          if (item.memory !== undefined) agent.memory = item.memory
        })
    })
  })

const settings = (memory: { readonly enabled?: boolean; readonly team?: boolean }) =>
  new Document({ type: "document", scope: "user", info: decodeInfo({ memory }) })

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))
const exists = (file: string) => Effect.promise(() => fs.access(file).then(() => true, () => false))
const isDirectory = (folder: string) =>
  Effect.promise(() => fs.stat(folder).then((info) => info.isDirectory(), () => false))
const entries = (folder: string) => Effect.promise(() => fs.readdir(folder).catch(() => [] as string[]))
const realOf = (file: string) => Effect.promise(() => fs.realpath(file))
// Two real paths name the same place, as the platform compares them.
const same = (a: string, b: string) => FSUtil.contains(a, b) && FSUtil.contains(b, a)

// The reason a call failed with, or "ok".
const outcome = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.map(() => "ok"),
    Effect.catch((error) =>
      Effect.succeed(
        error instanceof MemoryListing.TargetError ? error.reason : error instanceof MemoryListing.WriteError ? "write" : "failed",
      ),
    ),
  )

const folderRows = (listing: Instruction.MemoryListing) =>
  listing.folders.map((item) => (item.type === "agent" ? `agent:${item.agent}:${item.scope}` : item.type))

describe("MemoryListing.list", () => {
  it.live("lists the loaded instruction files in load order, imports under their importer, then the user and project rows when they are missing", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const start_ = path.join(l.project, "sub")
      yield* write(path.join(start_, "AGENTS.md"), "start @./docs/a.md\n")
      yield* write(path.join(start_, "docs", "a.md"), "imported")
      const listing = yield* Effect.gen(function* () {
        const memory = yield* start
        return yield* memory.list()
      }).pipe(provide(l, { directory: start_ }))
      const agents = yield* realOf(path.join(start_, "AGENTS.md"))
      const imported = yield* realOf(path.join(start_, "docs", "a.md"))
      expect(listing.files.map((file) => [file.path, file.kind, file.importedBy, file.role, file.exists])).toEqual([
        [agents, "project", undefined, undefined, true],
        [imported, "project", agents, undefined, true],
        [path.join(l.config, "ORBIT.md"), "user", undefined, "user", false],
        [path.join(l.project, "AGENTS.md"), "project", undefined, "project", false],
      ])
      expect(listing.files.map((file) => file.target)).toEqual([
        { type: "file", path: agents },
        { type: "file", path: imported },
        { type: "scope", scope: "user" },
        { type: "scope", scope: "project" },
      ])
      // The loaded files carry their length; a missing one has none.
      expect(listing.files.map((file) => file.chars)).toEqual(["start @./docs/a.md\n".length, "imported".length, 0, 0])
      // No local row is added, as the reference adds none.
      expect(listing.files.some((file) => file.kind === "local")).toBe(false)
      expect(listing).toMatchObject({ enabled: true, git: false, available: true })
      // Listing makes nothing.
      expect(yield* exists(path.join(l.project, "AGENTS.md"))).toBe(false)
      expect(yield* exists(path.join(l.config, "ORBIT.md"))).toBe(false)
    }),
  )

  it.live("marks the loaded user and project files with their role instead of adding rows", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* write(path.join(l.config, "ORBIT.md"), "mine")
      yield* write(path.join(l.project, "AGENTS.md"), "ours")
      // The Location is reached through a link to the project, so its spelling is not the real path the loader lists.
      const spelled = path.join(l.root, "spelled")
      yield* Effect.promise(() => fs.symlink(l.project, spelled, linkType))
      const listing = yield* Effect.gen(function* () {
        const memory = yield* start
        return yield* memory.list()
      }).pipe(provide(l, { spelled, git: true }))
      expect(listing.files.map((file) => [file.path, file.role, file.target.type])).toEqual([
        [yield* realOf(path.join(l.config, "ORBIT.md")), "user", "file"],
        [yield* realOf(path.join(l.project, "AGENTS.md")), "project", "file"],
      ])
      expect(listing.git).toBe(true)
    }),
  )

  it.live("lists no nested file loaded on demand and no conditional rule", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* write(path.join(l.project, "AGENTS.md"), "root file")
      yield* write(path.join(l.project, "pkg", "AGENTS.md"), "nested file")
      yield* write(path.join(l.project, "pkg", "x.ts"), "")
      yield* write(path.join(l.orbit, "rules", "ts.md"), "---\npaths:\n  - \"**/*.ts\"\n---\nconditional rule")
      const out = yield* Effect.gen(function* () {
        const memory = yield* start
        const listing = yield* memory.list()
        const discovery = yield* InstructionDiscovery.Service
        return { listing, conditional: yield* discovery.conditionalRules() }
      }).pipe(provide(l))
      // The rule is known, as one that waits for a read: the row below fails only because the listing leaves it out.
      expect(out.conditional.map((rule) => path.basename(rule.path))).toEqual(["ts.md"])
      const listed = out.listing.files.map((file) => file.path)
      expect(listed).toContain(yield* realOf(path.join(l.project, "AGENTS.md")))
      expect(listed.some((file) => file.includes(`pkg${path.sep}AGENTS.md`))).toBe(false)
      expect(listed.some((file) => file.endsWith("ts.md"))).toBe(false)
    }),
  )

  it.live("lists the memory folder, the team folder while team memory is on, and each agent with a memory scope, only while memory is on", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const agents = [
        { id: "review", memory: "user" as const },
        { id: "deep/one", memory: "project" as const },
        { id: "local1", memory: "local" as const },
        // An id that a plugin gives an agent through the editor is never a plain name: it costs only its own row.
        { id: "../escape", memory: "project" as const },
        { id: "plain" },
      ]
      const run = (entries: Entry[]) =>
        Effect.gen(function* () {
          const memory = yield* start
          yield* withAgents(agents)
          return yield* memory.list()
        }).pipe(provide(l, { entries }))
      const on = yield* run([settings({ team: true })])
      expect(folderRows(on)).toEqual(["memory", "team", "agent:review:user", "agent:deep/one:project", "agent:local1:local"])
      expect(on.folders.map((item) => item.target)).toEqual([
        { type: "memory" },
        { type: "team" },
        { type: "agent", agent: "review" },
        { type: "agent", agent: "deep/one" },
        { type: "agent", agent: "local1" },
      ])
      const listed = Object.fromEntries(on.folders.map((item) => [item.type === "agent" ? item.agent : item.type, item]))
      expect(listed.team?.path).toBe(l.team)
      expect(listed["deep/one"]?.path).toBe(path.join(l.shared, "deep", "one"))
      expect(listed.local1?.path).toBe(path.join(l.local, "local1"))
      expect(listed.review?.path).toBe(path.join(l.data, "memory", "agents", "review"))
      // Nothing is there yet, and listing made nothing.
      expect(on.folders.map((item) => item.exists)).toEqual([false, false, false, false, false])
      expect(yield* exists(l.orbit)).toBe(false)
      // The files stay whatever the folders are.
      expect(on.files.map((file) => file.role)).toEqual(["user", "project"])

      const teamOff = yield* run([])
      expect(folderRows(teamOff)).toEqual(["memory", "agent:review:user", "agent:deep/one:project", "agent:local1:local"])
      const off = yield* run([settings({ enabled: false, team: true })])
      expect(off.enabled).toBe(false)
      expect(off.folders).toEqual([])
      expect(off.files.map((file) => file.role)).toEqual(["user", "project"])

      // A folder that is not listed is not made: the team folder while team memory is off, and every folder while
      // memory is off. The rows that are listed are made (the control).
      const attempt = (entries: Entry[], targets: Instruction.MemoryTarget[]) =>
        Effect.gen(function* () {
          const memory = yield* start
          yield* withAgents(agents)
          return yield* Effect.forEach(targets, (target) => outcome(memory.ensure(target)))
        }).pipe(provide(l, { entries }))
      expect(yield* attempt([], [{ type: "team" }, { type: "memory" }])).toEqual(["unknown", "ok"])
      expect(
        yield* attempt([settings({ enabled: false, team: true })], [{ type: "memory" }, { type: "team" }, { type: "agent", agent: "review" }]),
      ).toEqual(["unknown", "unknown", "unknown"])
      expect(yield* exists(l.team)).toBe(false)
      expect(yield* exists(path.join(l.data, "memory", "agents"))).toBe(false)

      // A folder that is there is listed as there.
      yield* Effect.promise(() => fs.mkdir(path.join(l.local, "local1"), { recursive: true }))
      const made = yield* run([])
      expect(made.folders.find((item) => item.type === "agent" && item.agent === "local1")?.exists).toBe(true)
    }),
  )
})

describe("MemoryListing.ensure", () => {
  it.live("makes an agent's memory folder at the checked real path and returns that path", () =>
    Effect.gen(function* () {
      const l = yield* layout
      // The Location is reached through a link, so the folder as spelled is not where it really is.
      const spelled = path.join(l.root, "spelled")
      yield* Effect.promise(() => fs.symlink(l.project, spelled, linkType))
      const agents = [
        { id: "review", memory: "user" as const },
        { id: "deep/one", memory: "project" as const },
        { id: "local1", memory: "local" as const },
      ]
      const out = yield* Effect.gen(function* () {
        const memory = yield* start
        yield* withAgents(agents)
        const resolver = yield* MemoryAgent.Service
        const listing = yield* memory.list()
        return yield* Effect.forEach(agents, (agent) =>
          Effect.gen(function* () {
            const checked = yield* resolver.folder(agent.id, agent.memory)
            const first = yield* memory.ensure({ type: "agent", agent: agent.id })
            const second = yield* memory.ensure({ type: "agent", agent: agent.id })
            const row = listing.folders.find((item) => item.type === "agent" && item.agent === agent.id)
            return { agent, checked, first, second, listed: row?.path }
          }),
        )
      }).pipe(provide(l, { spelled }))
      for (const row of out) {
        expect(row.checked).toBeDefined()
        expect(row.first).toMatchObject({ path: row.checked!.real, created: true, type: "folder" })
        expect(row.second).toMatchObject({ path: row.checked!.real, created: false, type: "folder" })
        expect(row.listed).toBe(row.checked!.folder)
        expect(yield* isDirectory(row.first.path)).toBe(true)
        expect(same(row.first.path, yield* realOf(row.first.path))).toBe(true)
      }
      // The project and local folders are spelled through the link and made where it leads.
      const project = out.find((row) => row.agent.memory === "project")!
      expect(project.listed).toBe(path.join(spelled, ".orbit", "agent-memory", "deep", "one"))
      expect(same(project.first.path, path.join(yield* realOf(l.project), ".orbit", "agent-memory", "deep", "one"))).toBe(true)
    }),
  )

  it.live("makes the team folder while team memory is on at the checked real path and returns that path", () =>
    Effect.gen(function* () {
      const l = yield* layout
      // As for an agent's folder, the Location is reached through a link.
      const spelled = path.join(l.root, "spelled")
      yield* Effect.promise(() => fs.symlink(l.project, spelled, linkType))
      const out = yield* Effect.gen(function* () {
        const memory = yield* start
        const listing = yield* memory.list()
        const first = yield* memory.ensure({ type: "team" })
        const second = yield* memory.ensure({ type: "team" })
        return { listed: listing.folders.find((item) => item.type === "team")?.path, first, second }
      }).pipe(provide(l, { spelled, entries: [settings({ team: true })] }))
      const real = path.join(yield* realOf(l.project), ".orbit", "team-memory")
      expect(out.listed).toBe(path.join(spelled, ".orbit", "team-memory"))
      expect(out.first).toMatchObject({ created: true, type: "folder" })
      expect(out.second).toMatchObject({ path: out.first.path, created: false, type: "folder" })
      expect(same(out.first.path, real)).toBe(true)
      expect(yield* isDirectory(l.team)).toBe(true)
    }),
  )

  // The folder is checked again once it is made: a link put at its place after its service checked it (the file system
  // below plants one just before the make) is refused, and nothing is made where it leads (class 4).
  it.live("refuses a folder that a link took the place of between its check and its make", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const planted: string[] = []
      const swapping = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const real = yield* FSUtil.Service
          return new Proxy(real, {
            get: (target, key) => {
              const value: unknown = (target as unknown as Record<string | symbol, unknown>)[key]
              if (typeof value !== "function") return value
              if (key !== "makeDirectory") return value.bind(target)
              return (folder: string, ...rest: unknown[]) =>
                Effect.promise(async () => {
                  if (path.basename(folder) !== "deep" || planted.length > 0) return
                  await fs.mkdir(path.dirname(folder), { recursive: true })
                  await fs.symlink(l.outside, folder, linkType)
                  planted.push(folder)
                }).pipe(Effect.andThen(value.apply(target, [folder, ...rest]) as Effect.Effect<void, unknown>))
            },
          })
        }),
      ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
      const reason = yield* Effect.gen(function* () {
        const memory = yield* start
        yield* withAgents([{ id: "deep", memory: "project" }])
        return yield* outcome(memory.ensure({ type: "agent", agent: "deep" }))
      }).pipe(provide(l, { files: swapping }))
      expect(planted).toHaveLength(1)
      expect(reason).toBe("refused")
      expect(yield* entries(l.outside)).toEqual([])
    }),
  )

  it.live("refuses a memory folder that is a link or a file, and makes nothing through it", () =>
    Effect.gen(function* () {
      type Row = {
        readonly name: string
        readonly target: Instruction.MemoryTarget
        readonly make: (l: Layout, marker: string) => Promise<void>
        readonly kept: (l: Layout, marker: string) => Promise<void>
      }
      const empty = async (_l: Layout, marker: string) => expect(await fs.readdir(marker)).toEqual([])
      const rows: Row[] = [
        {
          name: "an agent's id folder that is a link out",
          target: { type: "agent", agent: "review" },
          make: async (l, marker) => {
            await fs.mkdir(l.shared, { recursive: true })
            await fs.symlink(marker, path.join(l.shared, "review"), linkType)
          },
          kept: empty,
        },
        {
          name: "an agent's id folder that is a dangling link",
          target: { type: "agent", agent: "review" },
          make: async (l, marker) => {
            await fs.mkdir(l.shared, { recursive: true })
            await fs.symlink(path.join(marker, "gone"), path.join(l.shared, "review"), linkType)
          },
          kept: async (l, marker) => {
            await empty(l, marker)
          },
        },
        {
          name: ".orbit that is a link",
          target: { type: "agent", agent: "review" },
          make: (l, marker) => fs.symlink(marker, l.orbit, linkType),
          kept: empty,
        },
        {
          name: ".orbit/agent-memory that is a link onto src",
          target: { type: "agent", agent: "review" },
          make: async (l) => {
            await fs.mkdir(path.join(l.project, "src"), { recursive: true })
            await fs.mkdir(l.orbit, { recursive: true })
            await fs.symlink(path.join(l.project, "src"), l.shared, linkType)
          },
          kept: async (l) => expect(await fs.readdir(path.join(l.project, "src"))).toEqual([]),
        },
        {
          name: "the team folder that is a link",
          target: { type: "team" },
          make: async (l, marker) => {
            await fs.mkdir(l.orbit, { recursive: true })
            await fs.symlink(marker, l.team, linkType)
          },
          kept: empty,
        },
        {
          name: "a file at an agent's folder",
          target: { type: "agent", agent: "local1" },
          make: async (l) => {
            await fs.mkdir(l.local, { recursive: true })
            await fs.writeFile(path.join(l.local, "local1"), "KEEP")
          },
          kept: async (l) => expect(await fs.readFile(path.join(l.local, "local1"), "utf8")).toBe("KEEP"),
        },
      ]
      for (const row of rows) {
        const l = yield* layout
        const marker = path.join(l.outside, "marker")
        yield* Effect.promise(() => fs.mkdir(marker, { recursive: true }))
        yield* Effect.promise(() => row.make(l, marker))
        const out = yield* Effect.gen(function* () {
          const memory = yield* start
          yield* withAgents([
            { id: "review", memory: "project" },
            { id: "local1", memory: "local" },
            { id: "other", memory: "user" },
          ])
          const listing = yield* memory.list()
          return {
            listed: listing.folders.find((item) => JSON.stringify(item.target) === JSON.stringify(row.target)),
            reason: yield* outcome(memory.ensure(row.target)),
            control: yield* outcome(memory.ensure({ type: "agent", agent: "other" })),
          }
        }).pipe(provide(l, { entries: [settings({ team: true })] }))
        expect({ name: row.name, reason: out.reason, control: out.control }).toEqual({
          name: row.name,
          reason: "refused",
          control: "ok",
        })
        // A folder that leads elsewhere is not listed; a file planted at the folder's place is listed and still refused.
        if (row.name !== "a file at an agent's folder") expect(out.listed).toBeUndefined()
        yield* Effect.promise(() => row.kept(l, marker))
        expect(yield* isDirectory(path.join(l.data, "memory", "agents", "other"))).toBe(true)
      }
    }),
  )

  // Class 6: resolving a link to a share connects to the host it names, which the repository chooses. The recorded file
  // system is the oracle: no call but a readLink names the link or a path below it. A plain layout is the control.
  if (process.platform === "win32" && canLinkFile)
    it.live(
      "asks about a share before it resolves, stats or makes a memory folder",
      () =>
        Effect.gen(function* () {
          const share = "\\\\203.0.113.171\\share\\x"
          const l = yield* layout
          yield* Effect.promise(async () => {
            await fs.mkdir(l.orbit, { recursive: true })
            await fs.symlink(share, l.shared, "dir")
          })
          const recorded = recordedFileSystem()
          const started = Date.now()
          const out = yield* Effect.gen(function* () {
            const memory = yield* start
            yield* withAgents([{ id: "deep", memory: "project" }])
            const listing = yield* memory.list()
            return { listing, reason: yield* outcome(memory.ensure({ type: "agent", agent: "deep" })) }
          }).pipe(provide(l, { files: recorded.layer }))
          expect(Date.now() - started).toBeLessThan(15_000)
          const named = l.shared.toLowerCase()
          const calls = recorded.calls.filter((call) => {
            const arg = call.slice(call.indexOf(" ") + 1).toLowerCase()
            return arg === named || arg.startsWith(`${named}${path.sep}`)
          })
          expect(calls.filter((call) => !call.startsWith("readLink "))).toEqual([])
          expect(folderRows(out.listing)).toEqual(["memory"])
          expect(out.reason).toBe("refused")

          const plain = yield* layout
          const control = yield* Effect.gen(function* () {
            const memory = yield* start
            yield* withAgents([{ id: "deep", memory: "project" }])
            return yield* memory.ensure({ type: "agent", agent: "deep" })
          }).pipe(provide(plain, { files: recordedFileSystem().layer }))
          expect(yield* isDirectory(control.path)).toBe(true)
        }),
      // Room for the 15 s bound above to be the check that fails when a share is resolved.
      30_000,
    )

  // The memory folder is decided when the Location starts; a link to a share that appears on its way afterwards is asked
  // about before ensure stats or makes anything below it (class 6).
  if (process.platform === "win32" && canLinkFile)
    it.live(
      "asks about a share before it makes the memory folder, when a link to one appears after the start",
      () =>
        Effect.gen(function* () {
          const share = "\\\\203.0.113.171\\share\\x"
          const l = yield* layout
          yield* Effect.promise(() => fs.mkdir(l.data, { recursive: true }))
          const recorded = recordedFileSystem()
          const started = Date.now()
          const reason = yield* Effect.gen(function* () {
            const memory = yield* start
            yield* Effect.promise(() => fs.symlink(share, path.join(l.data, "memory"), "dir"))
            // Only what ensure touches counts; the start read the folder before the link was there.
            recorded.calls.length = 0
            return yield* outcome(memory.ensure({ type: "memory" }))
          }).pipe(provide(l, { files: recorded.layer }))
          expect(Date.now() - started).toBeLessThan(15_000)
          const named = [path.join(l.data, "memory"), path.join(yield* realOf(l.data), "memory")].map((item) => item.toLowerCase())
          const calls = recorded.calls.filter((call) => {
            const arg = call.slice(call.indexOf(" ") + 1).toLowerCase()
            return named.some((item) => arg === item || arg.startsWith(`${item}${path.sep}`))
          })
          expect(calls.filter((call) => !call.startsWith("readLink "))).toEqual([])
          expect(reason).toBe("refused")
        }),
      30_000,
    )

  // A folder that cannot be made (a permission, a read-only volume) is a write failure, which the server answers with 503,
  // not a refusal that blames the place (class 7). The file system below denies the make of one folder; another agent's
  // folder in the same run is the control that is made.
  it.live("answers a memory folder that cannot be made as a write failure, not a refusal", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const denying = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const real = yield* FSUtil.Service
          return new Proxy(real, {
            get: (target, key) => {
              const value: unknown = (target as unknown as Record<string | symbol, unknown>)[key]
              if (typeof value !== "function") return value
              if (key !== "makeDirectory") return value.bind(target)
              return (folder: string, ...rest: unknown[]) =>
                path.basename(folder) === "denied"
                  ? Effect.fail(
                      PlatformError.systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "makeDirectory",
                        description: "permission denied",
                        pathOrDescriptor: folder,
                      }),
                    )
                  : (value.apply(target, [folder, ...rest]) as Effect.Effect<void, unknown>)
            },
          })
        }),
      ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
      const out = yield* Effect.gen(function* () {
        const memory = yield* start
        yield* withAgents([
          { id: "denied", memory: "project" },
          { id: "other", memory: "project" },
        ])
        return {
          denied: yield* memory.ensure({ type: "agent", agent: "denied" }).pipe(Effect.flip),
          control: yield* outcome(memory.ensure({ type: "agent", agent: "other" })),
        }
      }).pipe(provide(l, { files: denying }))
      expect(out.denied).toBeInstanceOf(MemoryListing.WriteError)
      expect(out.denied.message).toContain("permission denied")
      expect(out.control).toBe("ok")
      expect(yield* exists(path.join(l.shared, "denied"))).toBe(false)
      expect(yield* isDirectory(path.join(l.shared, "other"))).toBe(true)
    }),
  )

  it.live("creates a missing project file empty, once, never through a link and never over a file that appeared", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const file = path.join(l.project, "AGENTS.md")
      const out = yield* Effect.gen(function* () {
        const memory = yield* start
        const first = yield* memory.ensure({ type: "scope", scope: "project" })
        yield* Effect.promise(() => fs.appendFile(file, "kept"))
        const second = yield* memory.ensure({ type: "scope", scope: "project" })
        return { first, second }
      }).pipe(provide(l))
      expect(out.first).toEqual({ path: yield* realOf(file), created: true, type: "file" })
      expect(out.second).toEqual({ path: yield* realOf(file), created: false, type: "file" })
      expect(yield* read(file)).toBe("kept")

      // A file written after the listing named the project file as missing keeps its text.
      const appeared = yield* layout
      const late = path.join(appeared.project, "AGENTS.md")
      const after = yield* Effect.gen(function* () {
        const memory = yield* start
        const listing = yield* memory.list()
        yield* write(late, "LATE")
        return { listing, ensured: yield* memory.ensure({ type: "scope", scope: "project" }) }
      }).pipe(provide(appeared))
      expect(after.listing.files.find((item) => item.role === "project")?.exists).toBe(false)
      expect(after.ensured).toMatchObject({ created: false, type: "file" })
      expect(yield* read(late)).toBe("LATE")

      // A dangling link at the file's place is never created through, in a trusted project as well.
      if (!canLinkFile) return
      const linked = yield* layout
      const target = path.join(linked.outside, "new.md")
      yield* Effect.promise(() => fs.symlink(target, path.join(linked.project, "AGENTS.md"), "file"))
      const reason = yield* Effect.gen(function* () {
        const memory = yield* start
        return yield* outcome(memory.ensure({ type: "scope", scope: "project" }))
      }).pipe(provide(linked))
      expect(reason).toBe("outside")
      expect(yield* exists(target)).toBe(false)
    }),
  )

  it.live("creates the user file in the config folder, making the folder", () =>
    Effect.gen(function* () {
      const l = yield* layout
      expect(yield* exists(l.config)).toBe(false)
      const ensured = yield* Effect.gen(function* () {
        const memory = yield* start
        return yield* memory.ensure({ type: "scope", scope: "user" })
      }).pipe(provide(l))
      const file = path.join(l.config, "ORBIT.md")
      expect(ensured).toEqual({ path: yield* realOf(file), created: true, type: "file" })
      expect(yield* read(file)).toBe("")
    }),
  )

  it.live("refuses a listed file that is no longer a plain file at its real path", () =>
    Effect.gen(function* () {
      const rows = [
        {
          name: "a folder",
          swap: (file: string) =>
            Effect.promise(async () => {
              await fs.rm(file)
              await fs.mkdir(file)
            }),
        },
        ...(canLinkFile
          ? [
              {
                name: "a link to another file",
                swap: (file: string) =>
                  Effect.promise(async () => {
                    const other = path.join(path.dirname(file), "other.md")
                    await fs.writeFile(other, "other")
                    await fs.rm(file)
                    await fs.symlink(other, file, "file")
                  }),
              },
            ]
          : []),
      ]
      for (const row of rows) {
        const l = yield* layout
        yield* write(path.join(l.project, "AGENTS.md"), "root @./docs/a.md\n")
        yield* write(path.join(l.project, "docs", "a.md"), "imported")
        const out = yield* Effect.gen(function* () {
          const memory = yield* start
          const listing = yield* memory.list()
          const imported = listing.files.find((file) => file.importedBy !== undefined)!.path
          const root = listing.files.find((file) => file.role === "project")!.path
          yield* row.swap(imported)
          return {
            root,
            reason: yield* outcome(memory.ensure({ type: "file", path: imported })),
            control: yield* memory.ensure({ type: "file", path: root }),
          }
        }).pipe(provide(l))
        expect({ name: row.name, reason: out.reason }).toEqual({ name: row.name, reason: "refused" })
        expect(out.control).toEqual({ path: out.root, created: false, type: "file" })
      }
    }),
  )

  it.live("refuses a target the listing does not hold, and joins no path from it", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* write(path.join(l.project, "AGENTS.md"), "root")
      const marker = path.join(l.root, "marker")
      yield* Effect.promise(() => fs.mkdir(marker))
      const targets: Instruction.MemoryTarget[] = [
        { type: "file", path: path.join(l.project, "unlisted.md") },
        { type: "file", path: path.join(l.project, "..", "marker", "x.md") },
        { type: "file", path: "../marker/x.md" },
        { type: "agent", agent: "../marker" },
        { type: "agent", agent: "../escape" },
        { type: "agent", agent: "a/../b" },
        { type: "agent", agent: "con" },
        // Loaded, but without a memory scope.
        { type: "agent", agent: "plain" },
        // Not loaded at all.
        { type: "agent", agent: "missing" },
        { type: "scope", scope: "local" },
      ]
      const out = yield* Effect.gen(function* () {
        const memory = yield* start
        yield* withAgents([{ id: "plain" }, { id: "../escape", memory: "project" }, { id: "con", memory: "user" }])
        const refused = yield* Effect.forEach(targets, (target) => outcome(memory.ensure(target)))
        return { refused, control: yield* outcome(memory.ensure({ type: "memory" })) }
      }).pipe(provide(l))
      expect(out.refused).toEqual(targets.map(() => "unknown"))
      expect(out.control).toBe("ok")
      expect(yield* entries(marker)).toEqual([])
      expect(yield* exists(path.join(l.project, "unlisted.md"))).toBe(false)
      expect(yield* exists(path.join(l.project, "ORBIT.local.md"))).toBe(false)
      expect(yield* exists(l.orbit)).toBe(false)
      // No agent folder was made for any of them.
      expect(yield* entries(path.join(l.data, "memory", "agents"))).toEqual([])
    }),
  )
})
