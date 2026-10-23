// context-memory-9: what the memory folder does beyond the spec rows. A managed deny decides a memory file, as the
// person's deny does, while a managed ask does not reach it (class 8); the guide is still given, naming the folder, when
// the folder cannot be made; and the sources say what changed when the folder or the index moves on.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema } from "effect"
import { Document, Info, type Entry } from "@orbit/schema/config"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileAccess } from "@orbit/core/file-access"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { MemoryInstructions } from "@orbit/core/memory/instructions"
import { Permission } from "@orbit/core/permission"
import { PermissionSaved } from "@orbit/core/permission/saved"
import { PluginHooks } from "@orbit/core/plugin/hooks"
import { Project } from "@orbit/core/project"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionStore } from "@orbit/core/session/store"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { insertSession } from "./lib/session-row"

const probe = Agent.ID.make("probe")
const session = SessionSchema.ID.make("ses_memory_folder")

const layout = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const folders = { project: path.join(root, "project"), data: path.join(root, "data"), tmp: path.join(root, "tmp") }
  yield* Effect.promise(() =>
    Promise.all(Object.values(folders).map((folder) => fs.mkdir(folder, { recursive: true }))),
  )
  return { root, ...folders, memory: path.join(folders.data, "memory", Project.ID.global) }
})
type Layout = Effect.Success<typeof layout>

const user = (memory: Record<string, unknown>) =>
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(path.resolve("/config/user/orbit.json")),
    info: Schema.decodeUnknownSync(Info)({ memory }),
  })

const permissions = (l: Layout) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        Bus.node,
        SessionStore.node,
        PermissionSaved.node,
        Agent.node,
        PluginHooks.node,
        ManagedPolicy.node,
        Permission.node,
        FileAccess.node,
        ProjectTrust.node,
      ]),
      [
        Global.node.replace(Global.layerWith({ tmp: l.tmp, data: l.data, config: path.join(l.root, "config") })),
        Config.node.replace(Config.testLayer()),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
        ),
      ],
    ),
  )

// An Edit of `file` as the file tools ask it: the folder first, then the file.
const edit = (file: string) =>
  Effect.gen(function* () {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const base = { sessionID: session, agent: probe }
    const target = yield* access.resolve({ path: file, kind: "file" })
    const external = access.externalRequest([target], base)
    if (external) {
      const folder = (yield* permission.ask({ ...external, id: Permission.ID.create() })).effect
      if (folder !== "allow") return folder
    }
    return (yield* permission.ask({
      id: Permission.ID.create(),
      action: "Edit",
      resources: [target.resource],
      ...FileAccess.leadsOf([target]),
      ...base,
    })).effect
  })

describe("managed rules in the memory folder", () => {
  it.live("deny a memory file, while a managed ask does not reach one", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const out = yield* Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((editor) =>
          editor.update(probe, (agent) => {
            agent.permissions = agent.permissions.filter(
              (rule) => !(rule.action === "*" && rule.resource === "*" && rule.effect === "allow"),
            )
          }),
        )
        yield* insertSession({ id: session, directory: l.project, agent: probe })
        const policy = yield* ManagedPolicy.Service
        yield* policy.set("file", {
          statements: [],
          rules: [
            { action: "Edit", resource: path.join(l.memory, "denied.md"), effect: "deny" },
            { action: "Edit", resource: "*", effect: "ask" },
          ],
        })
        return {
          denied: yield* edit(path.join(l.memory, "denied.md")),
          asked: yield* edit(path.join(l.memory, "other.md")),
          project: yield* edit(path.join(l.project, "a.md")),
        }
      }).pipe(permissions(l))
      // The managed ask still reaches a project file, which is the control for the memory file it does not reach.
      expect(out).toEqual({ denied: "deny", asked: "allow", project: "ask" })
    }),
  )
})

const sources = (l: Layout, entries: Entry[]) =>
  Effect.provide(
    AppNodeBuilder.build(
      LayerNode.group([Database.node, Bus.node, MemoryInstructions.node, InstructionDiscovery.node]),
      [
        Global.node.replace(Global.layerWith({ data: l.data, config: path.join(l.root, "config") })),
        Config.node.replace(Config.testLayer(entries)),
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(l.project) }))),
        ),
      ],
    ),
  )

const read = (list: Instructions.List) =>
  Instructions.read(list).pipe(
    Effect.map((entries) => Object.fromEntries(entries.map((entry) => [String(entry.key), entry.value]))),
  )

describe("the memory sources", () => {
  // The folder cannot be made below a file. The guide still names it, as the reference still builds its prompt.
  it.live("give the guide when the folder cannot be made", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const blocker = path.join(l.root, "a-file")
      yield* Effect.promise(() => fs.writeFile(blocker, "not a folder"))
      const folder = path.join(blocker, "memory")
      const values = yield* Effect.gen(function* () {
        const memory = yield* MemoryInstructions.Service
        return yield* read(yield* memory.load({ sessionID: session, guide: true, index: false }))
      }).pipe(sources(l, [user({ directory: folder })]))
      expect(values["core/memory-guide"]).toBe(folder)
    }),
  )

  it.live("say that the guide and the index changed, and that they no longer apply", () =>
    Effect.gen(function* () {
      const l = yield* layout
      const list = yield* Effect.gen(function* () {
        const memory = yield* MemoryInstructions.Service
        return yield* memory.load({ sessionID: session, guide: true, index: true })
      }).pipe(sources(l, []))
      const [guide, index] = list
      const value = { path: path.join(l.memory, "MEMORY.md"), content: "- NEW-ENTRY" }
      expect(guide!.changed(l.memory, path.join(l.root, "elsewhere"))).toContain(path.join(l.root, "elsewhere"))
      expect(guide!.removed(l.memory)).toContain("switched off")
      expect(index!.changed({ ...value, content: "- OLD" }, value)).toContain("- NEW-ENTRY")
      expect(index!.removed(value)).toContain("no longer applies")
    }),
  )
})
