// context-memory-10 part 2: a trusted project may ship a snapshot of a user-scope agent's memory in
// `.orbit/agent-memory-snapshots/<id>/`, with a `snapshot.json` that names when it was taken. While memory is on, an
// agent that a config file defines with `memory: user` and whose own folder holds no Markdown file gets the snapshot's
// files copied in, with `.snapshot-synced.json` beside them; a folder that already holds one is left alone, as the
// reference leaves it. The snapshot is the repository's and the target is the person's own folder, shared by every
// project, so nothing of it is read before the project is trusted (class 1), the root and each agent folder follow
// `MemoryAgent`'s rules (links, shares, real paths: classes 4 and 6), names are plain (class 5), and one bad entry costs
// only itself (class 7). Every row that expects nothing has a control in the same test that copies (class 14).
import { NodeFileSystem } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Logger, Schema } from "effect"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { MemoryAgent } from "@orbit/core/memory/agent"
import { MemoryAgentSnapshot } from "@orbit/core/memory/agent-snapshot"
import { Project } from "@orbit/core/project"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { grantFolder } from "./fixture/grant"
import { recordedFileSystem } from "./fixture/recorded-fs"
import { canLinkFile } from "./fixture/symlink"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const linkType = process.platform === "win32" ? "junction" : "dir"
const decodeInfo = Schema.decodeUnknownSync(Info)
const UPDATED = "2026-10-01T00:00:00.000Z"

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
    snapshots: path.join(project, ".orbit", "agent-memory-snapshots"),
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
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        Config.node,
        WorkspaceTrust.node,
        Agent.node,
        MemoryAgent.node,
        MemoryAgentSnapshot.node,
      ]),
      [
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
      ],
    ),
  )

// The real file system, except that a listing reports each link as a plain file: what a listing taken just before a
// file was swapped for a link says.
const linksListedAsFiles = Layer.effect(
  FSUtil.Service,
  Effect.gen(function* () {
    const real = yield* FSUtil.Service
    return FSUtil.Service.of({
      ...real,
      readDirectoryEntries: (folder) =>
        real
          .readDirectoryEntries(folder)
          .pipe(
            Effect.map((entries) =>
              entries.map((entry) => (entry.type === "symlink" ? { ...entry, type: "file" as const } : entry)),
            ),
          ),
    })
  }),
).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))

const logged = (logs: string[]) =>
  Logger.layer([
    Logger.make(({ message }) => {
      logs.push(String(message))
    }),
  ])

type Source = "user" | "project" | "local" | "flag" | "managed" | "remote"

// Agents as the config plugin defines them: `source` names the document's scope, and `plugin` an agent a plugin ships.
const define = (
  list: readonly {
    readonly id: string
    readonly memory?: MemoryAgent.Scope
    readonly source?: Source
    readonly plugin?: string
  }[],
) =>
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) => {
      for (const item of list)
        editor.update(Agent.ID.make(item.id), (agent) => {
          if (item.memory !== undefined) agent.memory = item.memory
          if (item.source !== undefined)
            agent.source = {
              scope: item.source,
              path: AbsolutePath.make(path.resolve(`/config/${item.source}/agents/${item.id}.md`)),
              ...(item.plugin === undefined ? {} : { plugin: item.plugin }),
            }
        })
    })
  })

const reviewer = [{ id: "reviewer", memory: "user", source: "user" }] as const

const sync = Effect.gen(function* () {
  const snapshots = yield* MemoryAgentSnapshot.Service
  yield* snapshots.sync()
})

const write = (file: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, text)
  })

// A snapshot of `files` with its `snapshot.json`, in `folder`.
const snapshotAt = (folder: string, files: Record<string, string>, updatedAt = UPDATED) =>
  Effect.gen(function* () {
    yield* write(path.join(folder, "snapshot.json"), JSON.stringify({ updatedAt }))
    for (const [name, text] of Object.entries(files)) yield* write(path.join(folder, name), text)
  })

const files = { "MEMORY.md": "- [Style](style.md) SNAPSHOT-INDEX\n", "style.md": "STYLE-TEXT\n", "notes.txt": "NOTES\n" }

const exists = (file: string) =>
  Effect.promise(() =>
    fs.access(file).then(
      () => true,
      () => false,
    ),
  )

const listed = (folder: string) =>
  Effect.promise(() => fs.readdir(folder).then((names) => names.toSorted(), () => undefined))

const text = (file: string) => Effect.promise(() => fs.readFile(file, "utf8"))

// `count` Markdown files named in order, each with `pad` after its own line.
const notes = (count: number, pad: string) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`note-${String(index).padStart(4, "0")}.md`, `NOTE-${index}\n${pad}`]),
  )

// Waits until a Markdown file shows up in a folder just below `root` (an agent's folder, or the one its copy is made in
// beside it) and returns that folder's name and how many entries it held then.
const firstCopied = (root: string) =>
  Effect.promise(async () => {
    for (let attempt = 0; attempt < 10_000; attempt++) {
      const folders = await fs.readdir(root).catch(() => [])
      for (const name of folders) {
        const inside = await fs.readdir(path.join(root, name)).catch(() => [])
        if (inside.some((entry) => entry.endsWith(".md"))) return { name, count: inside.length }
      }
      await Bun.sleep(1)
    }
    return { name: "", count: 0 }
  })

describe("agent memory snapshots", () => {
  // The reference's copy: every plain file but `snapshot.json`, whatever its extension, as text, then the marker that
  // names the snapshot it came from, as JSON. The second row's time holds an escape and a line break: it reaches the
  // marker exactly and no log message (class 9).
  it.live("copies a project's snapshot into an empty user-scope agent folder and writes the synced marker", () =>
    Effect.gen(function* () {
      for (const updatedAt of [UPDATED, "2026\u001b[31m\nINJECTED"]) {
        const l = yield* layout
        yield* snapshotAt(path.join(l.snapshots, "reviewer"), files, updatedAt)
        const logs: string[] = []
        yield* Effect.gen(function* () {
          yield* define(reviewer)
          yield* sync
        }).pipe(provide(l), Effect.provide(logged(logs)))
        const folder = path.join(l.user, "reviewer")
        expect(yield* listed(folder)).toEqual([".snapshot-synced.json", "MEMORY.md", "notes.txt", "style.md"])
        for (const [name, body] of Object.entries(files)) expect(yield* text(path.join(folder, name))).toBe(body)
        const marker = yield* text(path.join(folder, ".snapshot-synced.json"))
        expect(JSON.parse(marker)).toEqual({ syncedFrom: updatedAt })
        expect(marker).not.toContain("\u001b")
        expect(logs.filter((line) => line.includes("files copied"))).toHaveLength(1)
        expect(logs.filter((line) => line.includes("\u001b") || line.includes("INJECTED"))).toEqual([])
      }
    }),
  )

  // The reference keeps the person's memory once the folder holds a Markdown file, whatever the snapshot's time: its
  // "newer snapshot" path ends in a dialog that keeps it. Only a plain file whose name ends in `.md`, in that case,
  // counts: a link or a folder named so, `NOTES.MD` and a text file each still copy (class 4).
  it.live("leaves a user-scope agent folder that holds a Markdown file alone, whatever the snapshot's time", () =>
    Effect.gen(function* () {
      type Row = { readonly name: string; readonly copy: boolean; readonly make: (folder: string, l: Layout) => Effect.Effect<void> }
      const rows: Row[] = [
        { name: "a Markdown file", copy: false, make: (folder) => write(path.join(folder, "old.md"), "OLD\n") },
        {
          name: "a Markdown file and an older marker",
          copy: false,
          make: (folder) =>
            Effect.gen(function* () {
              yield* write(path.join(folder, "old.md"), "OLD\n")
              yield* write(path.join(folder, ".snapshot-synced.json"), JSON.stringify({ syncedFrom: "2000-01-01" }))
            }),
        },
        { name: "an empty folder", copy: true, make: (folder) => Effect.promise(() => fs.mkdir(folder, { recursive: true })) },
        ...(canLinkFile
          ? [
              {
                name: "a link named y.md",
                copy: true,
                make: (folder: string, l: Layout) =>
                  Effect.gen(function* () {
                    yield* write(path.join(l.outside, "y.md"), "OUTSIDE\n")
                    yield* Effect.promise(() => fs.symlink(path.join(l.outside, "y.md"), path.join(folder, "y.md")))
                  }),
              },
            ]
          : []),
        {
          name: "a folder named z.md",
          copy: true,
          make: (folder) => Effect.promise(() => fs.mkdir(path.join(folder, "z.md"), { recursive: true })),
        },
        { name: "only NOTES.MD", copy: true, make: (folder) => write(path.join(folder, "NOTES.MD"), "UPPER\n") },
        { name: "only x.txt", copy: true, make: (folder) => write(path.join(folder, "x.txt"), "TEXT\n") },
      ]
      const out = yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const l = yield* layout
          const folder = path.join(l.user, "reviewer")
          yield* Effect.promise(() => fs.mkdir(folder, { recursive: true }))
          yield* row.make(folder, l)
          const before = yield* listed(folder)
          const marker = yield* Effect.promise(() => fs.readFile(path.join(folder, ".snapshot-synced.json"), "utf8").catch(() => ""))
          yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
          yield* Effect.gen(function* () {
            yield* define(reviewer)
            yield* sync
          }).pipe(provide(l))
          const copied = yield* exists(path.join(folder, "MEMORY.md"))
          const after = yield* listed(folder)
          const markerAfter = yield* Effect.promise(() =>
            fs.readFile(path.join(folder, ".snapshot-synced.json"), "utf8").catch(() => ""),
          )
          return {
            name: row.name,
            copied,
            unchanged: JSON.stringify(after) === JSON.stringify(before) && markerAfter === marker,
            synced: markerAfter === JSON.stringify({ syncedFrom: UPDATED }),
          }
        }),
      )
      expect(out).toEqual(
        rows.map((row) => ({ name: row.name, copied: row.copy, unchanged: !row.copy, synced: row.copy })),
      )
    }),
  )

  // Class 8, T7: the reference looks only at the agents of its agent files, so Orbit looks only at an agent a config
  // document of the person, the project, the local file or the administrator defines with `memory: user`. A project or
  // local scope, a built-in the person tunes, an agent a plugin adds through the editor, a `--agents` or a well-known
  // agent and a plugin's agent copy nothing. The person's own agent is the control.
  it.live("copies only for user-scope agents that a config file defines", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const agents = [
        { id: "mine", memory: "user", source: "user", copy: true },
        { id: "theirs", memory: "user", source: "project", copy: true },
        { id: "local-file", memory: "user", source: "local", copy: true },
        { id: "managed", memory: "user", source: "managed", copy: true },
        { id: "shared", memory: "project", source: "user", copy: false },
        { id: "machine", memory: "local", source: "user", copy: false },
        { id: "no-memory", source: "user", copy: false },
        { id: "build", memory: "user", copy: false },
        { id: "flagged", memory: "user", source: "flag", copy: false },
        { id: "remote", memory: "user", source: "remote", copy: false },
        { id: "plugged", memory: "user", source: "user", plugin: "a-plugin", copy: false },
      ] as const
      for (const agent of agents) yield* snapshotAt(path.join(l.snapshots, agent.id), files)
      yield* Effect.gen(function* () {
        yield* define(agents)
        yield* sync
      }).pipe(provide(l))
      const out = yield* Effect.forEach([...agents], (agent) =>
        exists(path.join(l.user, agent.id, "MEMORY.md")).pipe(Effect.map((copy) => ({ id: agent.id, copy }))),
      )
      expect(out).toEqual(agents.map((agent) => ({ id: agent.id, copy: agent.copy })))
      expect(yield* exists(path.join(l.orbit, "agent-memory"))).toBe(false)
      expect(yield* exists(path.join(l.orbit, "agent-memory-local"))).toBe(false)
    }),
  )

  // Class 1: while memory is off (by config or by the switch) no call of the file system names the snapshot root, and
  // in a project that is not trusted none names `.orbit`. Neither counts as the run: once memory is on, or the project
  // is granted, the next sync copies.
  it.live("reads no snapshot while memory is off or the project is not trusted, and copies once it is", () =>
    Effect.gen(function* () {
      const off = (memory: Record<string, unknown>) =>
        new Document({
          type: "document",
          scope: "user",
          path: AbsolutePath.make(path.resolve("/config/user/orbit.json")),
          info: decodeInfo({ memory }),
        })
      const rows = ["config", "switch", "untrusted"] as const
      for (const row of rows) {
        const l = yield* layout
        yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
        const entries: Entry[] = row === "config" ? [off({ enabled: false })] : []
        const recorded = recordedFileSystem()
        const previous = process.env.ORBIT_DISABLE_AUTO_MEMORY
        const out = yield* Effect.gen(function* () {
          yield* define(reviewer)
          if (row === "switch") process.env.ORBIT_DISABLE_AUTO_MEMORY = "1"
          yield* sync
          const named = recorded.calls.filter((call) =>
            call.toLowerCase().includes((row === "untrusted" ? l.orbit : l.snapshots).toLowerCase()),
          )
          const before = yield* exists(path.join(l.user, "reviewer"))
          if (row === "config") entries.length = 0
          if (row === "switch") delete process.env.ORBIT_DISABLE_AUTO_MEMORY
          if (row === "untrusted") yield* grantFolder(l.project, { persist: false, via: "test" })
          yield* sync
          return { named, before }
        }).pipe(
          provide(l, { entries, untrusted: row === "untrusted", files: recorded.layer }),
          Effect.ensuring(
            Effect.sync(() => {
              if (previous === undefined) delete process.env.ORBIT_DISABLE_AUTO_MEMORY
              else process.env.ORBIT_DISABLE_AUTO_MEMORY = previous
            }),
          ),
        )
        expect({ row, named: out.named, before: out.before }).toEqual({ row, named: [], before: false })
        expect({ row, after: yield* text(path.join(l.user, "reviewer", "MEMORY.md")) }).toEqual({
          row,
          after: files["MEMORY.md"],
        })
      }
    }),
  )

  // Classes 4 and 7, T2: a `snapshot.json` that is malformed, of the wrong shape, a link out of the folder or a folder
  // means no snapshot for that agent, with one line in the log that names it and not the file's text; one that is
  // missing is the normal case and logs nothing. A second agent's good snapshot copies in the same sync.
  it.live(
    "takes no snapshot whose snapshot.json is missing, malformed or not a file in its folder, and one bad snapshot costs only its agent",
    () =>
      Effect.gen(function* () {
        const l = yield* layout
        const bad = [
          { id: "brace", body: "{" },
          { id: "array", body: "[]" },
          { id: "empty-object", body: "{}" },
          { id: "empty-time", body: JSON.stringify({ updatedAt: "" }) },
          { id: "number-time", body: JSON.stringify({ updatedAt: 5, note: "SECRET-TEXT" }) },
        ]
        for (const row of bad) {
          yield* write(path.join(l.snapshots, row.id, "snapshot.json"), row.body)
          yield* write(path.join(l.snapshots, row.id, "MEMORY.md"), "BAD\n")
        }
        yield* write(path.join(l.snapshots, "missing", "MEMORY.md"), "MISSING\n")
        yield* Effect.promise(() => fs.mkdir(path.join(l.snapshots, "folder", "snapshot.json"), { recursive: true }))
        yield* write(path.join(l.snapshots, "folder", "MEMORY.md"), "FOLDER\n")
        const linked = canLinkFile ? ["linked"] : []
        if (canLinkFile) {
          yield* write(path.join(l.outside, "snapshot.json"), JSON.stringify({ updatedAt: UPDATED }))
          yield* write(path.join(l.snapshots, "linked", "MEMORY.md"), "LINKED\n")
          yield* Effect.promise(() =>
            fs.symlink(path.join(l.outside, "snapshot.json"), path.join(l.snapshots, "linked", "snapshot.json")),
          )
        }
        // An agent whose own folder's place is taken by a file cannot be copied into: that costs only this agent.
        yield* snapshotAt(path.join(l.snapshots, "blocked"), files)
        yield* write(path.join(l.user, "blocked"), "A FILE\n")
        yield* snapshotAt(path.join(l.snapshots, "good"), files)
        const refused = [...bad.map((row) => row.id), "folder", ...linked]
        // `absent` has no snapshot folder at all, the usual case, which logs nothing either.
        const ids = [...refused, "missing", "absent", "blocked", "good"]
        const logs: string[] = []
        yield* Effect.gen(function* () {
          yield* define(ids.map((id) => ({ id, memory: "user", source: "user" }) as const))
          yield* sync
        }).pipe(provide(l), Effect.provide(logged(logs)))
        const copied = yield* Effect.forEach(ids, (id) =>
          exists(path.join(l.user, id, "MEMORY.md")).pipe(Effect.map((copy) => ({ id, copy }))),
        )
        expect(copied).toEqual(ids.map((id) => ({ id, copy: id === "good" })))
        const lines = logs.filter((line) => line.includes("snapshot.json"))
        expect(lines).toHaveLength(refused.length)
        for (const id of refused) expect({ id, lines: lines.filter((line) => line.includes(` ${id} `)).length }).toEqual({ id, lines: 1 })
        expect(logs.filter((line) => line.includes(" missing ") || line.includes(" absent "))).toEqual([])
        expect(logs.filter((line) => line.includes(" blocked "))).toHaveLength(1)
        expect(yield* text(path.join(l.user, "blocked"))).toBe("A FILE\n")
        expect(logs.filter((line) => line.includes("SECRET-TEXT"))).toEqual([])
      }),
  )

  // Class 4, T1: the root follows the rule of part 1's roots. A root that is a link (out, to a folder of the project,
  // `.orbit`, `.git` or `src`, nowhere, a loop) or an `.orbit` that is a link copies nothing, with one line in the log,
  // and the valid snapshot it leads to stays where it is. A plain layout is the control.
  it.live(
    "copies nothing when .orbit or the snapshot root is a link",
    () =>
      Effect.gen(function* () {
        type Row = { readonly name: string; readonly make: (l: Layout) => Effect.Effect<void> }
        const linkRoot = (name: string, target: (l: Layout) => string, valid = true): Row => ({
          name,
          make: (l) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => fs.mkdir(l.orbit, { recursive: true }))
              if (valid) yield* snapshotAt(path.join(target(l), "reviewer"), files)
              yield* Effect.promise(() => fs.symlink(target(l), l.snapshots, linkType))
            }),
        })
        const rows: Row[] = [
          linkRoot("root a link out", (l) => path.join(l.outside, "snapshots")),
          linkRoot("root a link to the project", (l) => l.project),
          linkRoot("root a link to .orbit", (l) => l.orbit),
          linkRoot("root a link to .git", (l) => path.join(l.project, ".git")),
          linkRoot("root a link to src", (l) => path.join(l.project, "src")),
          linkRoot("root a dangling link", (l) => path.join(l.outside, "missing"), false),
          {
            name: "root a link in a loop",
            make: (l) =>
              Effect.promise(async () => {
                await fs.mkdir(l.orbit, { recursive: true })
                await fs.symlink(path.join(l.orbit, "loop"), l.snapshots, linkType)
                await fs.symlink(l.snapshots, path.join(l.orbit, "loop"), linkType)
              }),
          },
          {
            name: ".orbit a link out",
            make: (l) =>
              Effect.gen(function* () {
                const settings = path.join(l.outside, "settings")
                yield* snapshotAt(path.join(settings, "agent-memory-snapshots", "reviewer"), files)
                yield* Effect.promise(() => fs.symlink(settings, l.orbit, linkType))
              }),
          },
        ]
        const out = yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const l = yield* layout
            yield* row.make(l)
            const logs: string[] = []
            yield* Effect.gen(function* () {
              yield* define(reviewer)
              yield* sync
            }).pipe(provide(l), Effect.provide(logged(logs)))
            return {
              name: row.name,
              copied: yield* exists(path.join(l.user, "reviewer")),
              lines: logs.filter((line) => line.includes("agent-memory-snapshots")).length,
            }
          }),
        )
        expect(out).toEqual(rows.map((row) => ({ name: row.name, copied: false, lines: 1 })))
        const plain = yield* layout
        yield* snapshotAt(path.join(plain.snapshots, "reviewer"), files)
        yield* Effect.gen(function* () {
          yield* define(reviewer)
          yield* sync
        }).pipe(provide(plain))
        expect(yield* exists(path.join(plain.user, "reviewer", "MEMORY.md"))).toBe(true)
      }),
    30_000,
  )

  // Class 4, T1: inside the accepted root, an agent's snapshot folder (or a nested id's first segment) that is a link
  // out of the root, or one that leads nowhere, copies nothing from where it leads. A plain sibling is the control.
  it.live("copies nothing through an agent snapshot folder that leads out of the root", () =>
    Effect.gen(function* () {
      const l = yield* layout
      yield* snapshotAt(path.join(l.outside, "reviewer"), files)
      yield* snapshotAt(path.join(l.outside, "team", "deep"), files)
      yield* snapshotAt(path.join(l.snapshots, "other"), files)
      yield* Effect.promise(async () => {
        await fs.symlink(path.join(l.outside, "reviewer"), path.join(l.snapshots, "reviewer"), linkType)
        await fs.symlink(path.join(l.outside, "missing"), path.join(l.snapshots, "gone"), linkType)
        await fs.symlink(path.join(l.outside, "team"), path.join(l.snapshots, "team"), linkType)
      })
      const ids = ["reviewer", "gone", "team/deep", "other"]
      yield* Effect.gen(function* () {
        yield* define(ids.map((id) => ({ id, memory: "user", source: "user" }) as const))
        yield* sync
      }).pipe(provide(l))
      const out = yield* Effect.forEach(ids, (id) =>
        exists(path.join(l.user, ...id.split("/"), "MEMORY.md")).pipe(Effect.map((copy) => ({ id, copy }))),
      )
      expect(out).toEqual(ids.map((id) => ({ id, copy: id === "other" })))
      expect(yield* exists(path.join(l.outside, "missing"))).toBe(false)
    }),
  )

  // Classes 4 and 5, T4: only a plain file of the snapshot folder is copied. A link to a file outside, a link to a
  // folder and a folder are skipped without a line, as the reference skips them; a name that is not one plain segment
  // (a leading dot, a space, 70 characters, and where the platform allows them a colon and a control character) is
  // skipped with one line each. `ok.md` and the index are the control.
  it.live("skips links, folders and names that are not plain, and copies the rest", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.snapshots, "reviewer")
      // Windows cannot name a file with a colon or a control character, so those two rows run on the other platforms.
      const refused = [".hidden.md", "has space.md", `${"a".repeat(67)}.md`, ...(process.platform === "win32" ? [] : ["a:b.md", "bell\u0007.md"])]
      yield* snapshotAt(folder, { "ok.md": "OK\n", "MEMORY.md": "- INDEX\n" })
      for (const name of refused) yield* write(path.join(folder, name), "REFUSED\n")
      yield* write(path.join(folder, "sub", "inner.md"), "INNER\n")
      yield* write(path.join(l.outside, "marker.md"), "OUTSIDE-MARKER\n")
      yield* write(path.join(l.outside, "dir", "inner.md"), "OUTSIDE-DIR\n")
      yield* Effect.promise(async () => {
        if (canLinkFile) await fs.symlink(path.join(l.outside, "marker.md"), path.join(folder, "link.md"))
        await fs.symlink(path.join(l.outside, "dir"), path.join(folder, "dir-link"), linkType)
      })
      const logs: string[] = []
      yield* Effect.gen(function* () {
        yield* define(reviewer)
        yield* sync
      }).pipe(provide(l), Effect.provide(logged(logs)))
      expect(yield* listed(path.join(l.user, "reviewer"))).toEqual([".snapshot-synced.json", "MEMORY.md", "ok.md"])
      expect(yield* text(path.join(l.user, "reviewer", "ok.md"))).toBe("OK\n")
      expect(logs.filter((line) => line.includes("not a plain name"))).toHaveLength(refused.length)
      expect(logs.filter((line) => line.includes("link.md") || line.includes("dir-link") || line.includes("sub"))).toEqual([])
      // Only the two files that were copied are counted.
      expect(logs.filter((line) => line.includes("files copied"))).toEqual(["agent memory snapshot of reviewer: 2 files copied"])
    }),
  )

  // Class 4, T4: a source is read only at its real path inside the snapshot folder, even when the listing called it a
  // plain file. A file swapped for a link between the listing and the read (here, a listing that reports each link as
  // a file) is not followed out of the folder: it costs only itself, with one line, and the rest copies.
  if (canLinkFile)
    it.live("reads no source that became a link after the snapshot folder was listed", () =>
      Effect.gen(function* () {
        const l = yield* layout
        const folder = path.join(l.snapshots, "reviewer")
        yield* snapshotAt(folder, { "MEMORY.md": "- INDEX\n" })
        yield* write(path.join(l.outside, "secret.md"), "OUTSIDE-SECRET\n")
        yield* Effect.promise(() => fs.symlink(path.join(l.outside, "secret.md"), path.join(folder, "swapped.md")))
        const logs: string[] = []
        yield* Effect.gen(function* () {
          yield* define(reviewer)
          yield* sync
        }).pipe(provide(l, { files: linksListedAsFiles }), Effect.provide(logged(logs)))
        expect(yield* listed(path.join(l.user, "reviewer"))).toEqual([".snapshot-synced.json", "MEMORY.md"])
        expect(logs.filter((line) => line.includes("swapped.md"))).toHaveLength(1)
        // The file that was not copied is not counted.
        expect(logs.filter((line) => line.includes("files copied"))).toEqual(["agent memory snapshot of reviewer: 1 files copied"])
      }),
    )

  // Classes 4 and 7, T4/T5: a name in the user-scope folder that is a link (`MEMORY.md` and the marker to files
  // outside, `notes.txt` to nothing) is never written through: the files outside keep their text and nothing is made
  // where the dangling one points. The other files still copy. A user-scope folder that is itself a link out of the
  // user root gets nothing.
  it.live("never writes through a link in the user-scope agent folder", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
      yield* snapshotAt(path.join(l.snapshots, "linked"), files)
      yield* write(path.join(l.outside, "memory.md"), "OUTSIDE-INDEX\n")
      yield* write(path.join(l.outside, "marker.json"), "OUTSIDE-MARKER\n")
      yield* Effect.promise(async () => {
        await fs.mkdir(folder, { recursive: true })
        await fs.mkdir(path.join(l.outside, "agent"), { recursive: true })
        if (canLinkFile) {
          await fs.symlink(path.join(l.outside, "memory.md"), path.join(folder, "MEMORY.md"))
          await fs.symlink(path.join(l.outside, "marker.json"), path.join(folder, ".snapshot-synced.json"))
          await fs.symlink(path.join(l.outside, "missing.txt"), path.join(folder, "notes.txt"))
        }
        await fs.symlink(path.join(l.outside, "agent"), path.join(l.user, "linked"), linkType)
      })
      yield* Effect.gen(function* () {
        yield* define([...reviewer, { id: "linked", memory: "user", source: "user" }])
        yield* sync
      }).pipe(provide(l))
      expect(yield* text(path.join(folder, "style.md"))).toBe(files["style.md"])
      expect(yield* listed(path.join(l.outside, "agent"))).toEqual([])
      if (!canLinkFile) return
      expect(yield* text(path.join(l.outside, "memory.md"))).toBe("OUTSIDE-INDEX\n")
      expect(yield* text(path.join(l.outside, "marker.json"))).toBe("OUTSIDE-MARKER\n")
      expect(yield* exists(path.join(l.outside, "missing.txt"))).toBe(false)
      // The links themselves stay where they are: nothing is moved over them either.
      for (const name of ["MEMORY.md", ".snapshot-synced.json", "notes.txt"])
        expect({ name, link: (yield* Effect.promise(() => fs.lstat(path.join(folder, name)))).isSymbolicLink() }).toEqual({
          name,
          link: true,
        })
    }),
  )

  // Class 6: resolving a link to a share connects to the host it names, which the repository chooses. `.orbit` or the
  // snapshot root as such a link: no call but a readLink names it, and the sync ends at once. A plain layout copies.
  if (process.platform === "win32" && canLinkFile)
    it.live(
      "does not resolve a snapshot root that is a link to a share",
      () =>
        Effect.gen(function* () {
          const share = "\\\\203.0.113.171\\share\\x"
          for (const linked of ["orbit", "root"] as const) {
            const l = yield* layout
            yield* Effect.promise(async () => {
              if (linked === "orbit") return fs.symlink(share, l.orbit, "dir")
              await fs.mkdir(l.orbit, { recursive: true })
              await fs.symlink(share, l.snapshots, "dir")
            })
            const recorded = recordedFileSystem()
            const started = Date.now()
            yield* Effect.gen(function* () {
              yield* define(reviewer)
              yield* sync
            }).pipe(provide(l, { files: recorded.layer }))
            expect(Date.now() - started).toBeLessThan(15_000)
            const named = (linked === "orbit" ? l.orbit : l.snapshots).toLowerCase()
            const calls = recorded.calls.filter((call) => {
              const arg = call.slice(call.indexOf(" ") + 1).toLowerCase()
              return arg === named || arg.startsWith(`${named}${path.sep}`)
            })
            expect({ linked, calls: calls.filter((call) => !call.startsWith("readLink ")) }).toEqual({ linked, calls: [] })
            expect(yield* exists(path.join(l.user, "reviewer"))).toBe(false)
          }
          const plain = yield* layout
          yield* snapshotAt(path.join(plain.snapshots, "reviewer"), files)
          yield* Effect.gen(function* () {
            yield* define(reviewer)
            yield* sync
          }).pipe(provide(plain, { files: recordedFileSystem().layer }))
          expect(yield* exists(path.join(plain.user, "reviewer", "MEMORY.md"))).toBe(true)
        }),
      // Room for the 15 s bound above to be the check that fails when a share is resolved.
      30_000,
    )

  // Class 7, T4: a file that cannot be written (its name is taken by a folder in the user-scope folder) costs only
  // itself, with one line in the log; the other files and the marker are written.
  it.live("keeps one file that cannot be copied from stopping the rest", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* Effect.promise(() => fs.mkdir(path.join(folder, "notes.txt"), { recursive: true }))
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), { "MEMORY.md": files["MEMORY.md"], "notes.txt": "NOTES\n", "style.md": "STYLE-TEXT\n" })
      const logs: string[] = []
      yield* Effect.gen(function* () {
        yield* define(reviewer)
        yield* sync
      }).pipe(provide(l), Effect.provide(logged(logs)))
      expect(yield* text(path.join(folder, "MEMORY.md"))).toBe(files["MEMORY.md"])
      expect(yield* text(path.join(folder, "style.md"))).toBe("STYLE-TEXT\n")
      expect(JSON.parse(yield* text(path.join(folder, ".snapshot-synced.json")))).toEqual({ syncedFrom: UPDATED })
      expect(logs.filter((line) => line.includes("notes.txt"))).toHaveLength(1)
      // The file that was not written is not counted as copied.
      expect(logs.filter((line) => line.includes("files copied"))).toEqual(["agent memory snapshot of reviewer: 2 files copied"])
    }),
  )

  // Class 7: a marker that cannot be written (its name is taken by a folder) costs only itself, with one line in the
  // log; the files it would have named stay copied and the copy is reported as done, not as a failed agent.
  it.live("keeps a marker that cannot be written from failing the agent's copy", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* Effect.promise(() => fs.mkdir(path.join(folder, ".snapshot-synced.json"), { recursive: true }))
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
      const logs: string[] = []
      yield* Effect.gen(function* () {
        yield* define(reviewer)
        yield* sync
      }).pipe(provide(l), Effect.provide(logged(logs)))
      for (const [name, body] of Object.entries(files)) expect(yield* text(path.join(folder, name))).toBe(body)
      expect(logs.filter((line) => line.includes(".snapshot-synced.json not written"))).toHaveLength(1)
      expect(logs.filter((line) => line.includes("files copied"))).toEqual(["agent memory snapshot of reviewer: 3 files copied"])
      expect(logs.filter((line) => line.includes("reviewer not copied"))).toEqual([])
    }),
  )

  // Class 7: the same for an agent whose folder is not there yet, where the marker is written into the new folder
  // before it is moved into place: a marker write that fails costs only the marker, and the files still arrive.
  it.live("keeps a marker that cannot be written into a new folder from failing the agent's copy", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
      // The real file system, except that writing the marker fails.
      const markerFails = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const real = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...real,
            writeFileString: (file, data, options) =>
              path.basename(file) === ".snapshot-synced.json"
                ? real.writeFileString(path.join(l.outside, "missing", "marker"), data, options)
                : real.writeFileString(file, data, options),
          })
        }),
      ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
      const logs: string[] = []
      yield* Effect.gen(function* () {
        yield* define(reviewer)
        yield* sync
      }).pipe(provide(l, { files: markerFails }), Effect.provide(logged(logs)))
      expect(yield* listed(folder)).toEqual(Object.keys(files).toSorted())
      for (const [name, body] of Object.entries(files)) expect(yield* text(path.join(folder, name))).toBe(body)
      expect(logs.filter((line) => line.includes(".snapshot-synced.json not written"))).toHaveLength(1)
      expect(logs.filter((line) => line.includes("files copied"))).toEqual(["agent memory snapshot of reviewer: 3 files copied"])
      expect(logs.filter((line) => line.includes("reviewer not copied"))).toEqual([])
      expect(yield* listed(l.user)).toEqual(["reviewer"])
    }),
  )

  // Class 12: the snapshot is read from the Location's own folder, as the reference reads its working folder, so a
  // worktree's sync copies the worktree's snapshot and the checkout, which has none, copies nothing.
  it.live("resolves the snapshot from the Location's own folder, a worktree's included", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const worktree = path.join(l.root, "worktree")
      yield* snapshotAt(path.join(worktree, ".orbit", "agent-memory-snapshots", "reviewer"), files)
      const run = (directory: string) =>
        Effect.gen(function* () {
          yield* define(reviewer)
          yield* sync
        }).pipe(provide(l, { directory }))
      yield* run(l.project)
      expect(yield* exists(path.join(l.user, "reviewer"))).toBe(false)
      yield* run(worktree)
      expect(yield* text(path.join(l.user, "reviewer", "MEMORY.md"))).toBe(files["MEMORY.md"])
    }),
  )

  // Class 12: the copy runs once per agent list, as the reference's load is memoised: two syncs at once copy once, and
  // a later one reads no `snapshot.json`. A change to the agents (`Agent.Event.Updated`, the reference's cache clear)
  // arms the next sync, which looks again.
  it.live("copies once per agent list, and looks again after the agents change", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
      const recorded = recordedFileSystem()
      const logs: string[] = []
      const meta = path.join(l.snapshots, "reviewer", "snapshot.json").toLowerCase()
      const reads = () => recorded.calls.filter((call) => call.toLowerCase().includes(meta)).length
      const out = yield* Effect.gen(function* () {
        yield* define(reviewer)
        yield* Effect.all([sync, sync], { concurrency: 2 })
        const first = logs.filter((line) => line.includes("files copied")).length
        yield* Effect.promise(() => fs.rm(folder, { recursive: true, force: true }))
        recorded.calls.length = 0
        yield* sync
        const again = { reads: reads(), copied: yield* exists(folder) }
        yield* define([{ id: "helper" }])
        yield* sync
        return { first, again, after: { reads: reads(), copied: yield* exists(path.join(folder, "MEMORY.md")) } }
      }).pipe(provide(l, { files: recorded.layer }), Effect.provide(logged(logs)))
      expect(out.first).toBe(1)
      expect(out.again).toEqual({ reads: 0, copied: false })
      expect(out.after.copied).toBe(true)
      expect(out.after.reads).toBeGreaterThan(0)
    }),
  )

  // Class 7, carried from the review of #180: a folder that holds a Markdown file is the person's memory and is never
  // copied into again, so a copy that stops after its first file would leave part of a snapshot for good. The sync is
  // interrupted, as a fiber, once the first file has been copied anywhere under the user root; nothing of the snapshot
  // is left behind, neither in the agent's folder nor beside it, and the next load copies it whole.
  it.live("leaves nothing of an agent's copy that is interrupted after its first file, and the next load copies it whole", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      // Enough files that the copy is still running when the first one shows up.
      const many = notes(500, "")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), many)
      const expected = [".snapshot-synced.json", ...Object.keys(many)].toSorted()
      const out = yield* Effect.gen(function* () {
        yield* define(reviewer)
        const fiber = yield* Effect.forkChild(sync)
        const first = yield* firstCopied(l.user)
        yield* Fiber.interrupt(fiber)
        const interrupted = { folder: yield* listed(folder), user: yield* listed(l.user) }
        yield* sync
        return { first, interrupted, next: yield* listed(folder) }
      }).pipe(provide(l))
      // The interrupt came once a file had been copied, beside the agent's folder under a hidden name, and while the copy
      // was still running.
      expect(out.first.name).toStartWith(".reviewer.snapshot-")
      expect(out.first.count).toBeGreaterThan(0)
      expect(out.first.count).toBeLessThan(expected.length)
      expect(out.interrupted).toEqual({ folder: undefined, user: [] })
      expect(out.next).toEqual(expected)
      expect(JSON.parse(yield* text(path.join(folder, ".snapshot-synced.json")))).toEqual({ syncedFrom: UPDATED })
    }),
    // Writing the snapshot and copying it twice took more than the default 5 s on a loaded Windows runner.
    60_000,
  )

  // Class 7: stopping a session must not wait for a large snapshot to be copied. The interrupt returns in well under the
  // time the whole copy takes (the next load's copy measures that) and leaves no part of it.
  it.live("returns at once from an interrupt during a large copy and leaves no part of it", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), notes(1_000, "x".repeat(16_384)))
      const out = yield* Effect.gen(function* () {
        yield* define(reviewer)
        const fiber = yield* Effect.forkChild(sync)
        yield* firstCopied(l.user)
        const stopping = Date.now()
        yield* Fiber.interrupt(fiber)
        const stopped = Date.now() - stopping
        const interrupted = { folder: yield* listed(folder), user: yield* listed(l.user) }
        const starting = Date.now()
        yield* sync
        return { stopped, whole: Date.now() - starting, interrupted, next: (yield* listed(folder))?.length }
      }).pipe(provide(l))
      expect(out.interrupted).toEqual({ folder: undefined, user: [] })
      expect(out.next).toBe(1_001)
      expect(out.stopped).toBeLessThan(out.whole / 2)
    }),
    60_000,
  )

  // Class 7: into a folder that is already there (it holds no Markdown file yet) the files are moved one by one, and
  // that move is the one step an interrupt waits for. Here the interrupt lands just after the first file is moved in;
  // every file and the marker still arrive, so the folder never holds part of the snapshot.
  it.live("finishes moving the files into an existing folder once the first is in, however it is interrupted", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* write(path.join(folder, "keep.txt"), "KEEP\n")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
      const moved = yield* Deferred.make<void>()
      // The real file system, except that each rename is followed by a short pause, so the interrupt below arrives while
      // the rest are still to be moved.
      const slowMoves = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const real = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...real,
            rename: (from, to) =>
              real
                .rename(from, to)
                .pipe(Effect.andThen(Deferred.succeed(moved, undefined)), Effect.andThen(Effect.sleep("50 millis"))),
          })
        }),
      ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
      yield* Effect.gen(function* () {
        yield* define(reviewer)
        const fiber = yield* Effect.forkChild(sync)
        yield* Deferred.await(moved)
        yield* Fiber.interrupt(fiber)
      }).pipe(provide(l, { files: slowMoves }))
      expect(yield* listed(folder)).toEqual([".snapshot-synced.json", ...Object.keys(files), "keep.txt"].toSorted())
      for (const [name, body] of Object.entries(files)) expect(yield* text(path.join(folder, name))).toBe(body)
      expect(yield* text(path.join(folder, "keep.txt"))).toBe("KEEP\n")
      expect(yield* listed(l.user)).toEqual(["reviewer"])
    }),
  )

  // Class 7, from the third review of #187: a folder that is not there yet gets the copy in one rename of the hidden
  // folder, and an interrupt waits for that rename too. Here the rename signals and then runs the real rename 100 ms
  // later from a callback, as an operating system rename still in flight would; the interrupt lands in between. Without
  // the wait, the cleanup removes the hidden folder under the rename and the agent ends up with nothing.
  it.live("finishes moving a new folder into place when it is interrupted during the move", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const folder = path.join(l.user, "reviewer")
      yield* snapshotAt(path.join(l.snapshots, "reviewer"), files)
      const moving = yield* Deferred.make<void>()
      const lateMoves = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const real = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...real,
            rename: (from, to) =>
              Deferred.succeed(moving, undefined).pipe(
                Effect.andThen(
                  Effect.callback<void>((resume) => {
                    setTimeout(
                      () =>
                        fs.rename(from, to).then(
                          () => resume(Effect.void),
                          (error) => resume(Effect.die(error)),
                        ),
                      100,
                    )
                  }),
                ),
              ),
          })
        }),
      ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
      yield* Effect.gen(function* () {
        yield* define(reviewer)
        const fiber = yield* Effect.forkChild(sync)
        yield* Deferred.await(moving)
        yield* Fiber.interrupt(fiber)
      }).pipe(provide(l, { files: lateMoves }))
      expect(yield* listed(folder)).toEqual([".snapshot-synced.json", ...Object.keys(files)].toSorted())
      for (const [name, body] of Object.entries(files)) expect(yield* text(path.join(folder, name))).toBe(body)
      expect(yield* listed(l.user)).toEqual(["reviewer"])
    }),
  )
})
