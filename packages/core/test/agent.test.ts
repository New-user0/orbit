import path from "path"
import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Layer, Scope, Stream, type Types } from "effect"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Location } from "@orbit/core/location"
import { Permission } from "@orbit/core/permission"
import { AgentPlugin } from "@orbit/core/plugin/agent"
import { AbsolutePath } from "@orbit/core/schema"
import { Global } from "@orbit/util/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const testLocation = location({ directory: AbsolutePath.make("/project") })
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(testLocation))
const mutable = <T>(value: T) => value as Types.DeepMutable<T>
const global = Global.make({ data: "/data", config: "/config", tmp: "/tmp/orbit" })
const globalLayer = Layer.succeed(Global.Service, Global.Service.of(global))

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
    Global.node.replace(globalLayer),
    Location.node.replace(locationLayer),
  ]) as unknown as Layer.Layer<unknown, never>,
)

describe("Agent", () => {
  it.effect("publishes an updated event after agent changes", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const bus = yield* Bus.Service
      const updated = yield* bus
        .subscribe(Agent.Event.Updated)
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
      yield* Effect.yieldNow

      yield* agent.transform((editor) => editor.update(Agent.ID.make("reviewer"), () => {}))

      expect(yield* Fiber.join(updated)).toMatchObject([{ location: { directory: testLocation.directory } }])
    }),
  )

  it.effect("starts without agents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service

      expect(yield* agent.list()).toEqual([])
      expect(yield* agent.get(Agent.ID.make("build"))).toBeUndefined()
    }),
  )

  it.effect("materializes replayable agent transforms", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("reviewer")
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = "Reviews code"
          info.mode = "subagent"
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, description: "Reviews code", mode: "subagent" })
      expect((yield* agent.list()).map((info) => info.id)).toEqual([id])
    }),
  )

  it.effect("lists the selected default agent first", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.transform((editor) => {
        editor.update(Agent.ID.make("build"), (info) => {
          info.mode = "primary"
        })
        editor.update(Agent.ID.make("reviewer"), (info) => {
          info.mode = "primary"
        })
        editor.update(Agent.ID.make("explore"), (info) => {
          info.mode = "subagent"
        })
        editor.default(Agent.ID.make("reviewer"))
      })

      expect((yield* agent.list()).map((info) => String(info.id))).toEqual(["reviewer", "build", "explore"])
    }),
  )

  it.effect("rebuilds state when a transform is replaced", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("reviewer")
      let description = "Old description"
      let hidden = true
      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.description = description
          info.hidden = hidden
        }),
      )
      description = "New description"
      hidden = false
      yield* agent.reload()

      expect(yield* agent.get(id)).toMatchObject({ description: "New description", hidden: false })
    }),
  )

  it.effect("removes a transform when its scope closes", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("scoped")
      const scope = yield* Scope.make()
      yield* agent.transform((editor) => editor.update(id, () => {})).pipe(Scope.provide(scope))
      expect(yield* agent.get(id)).toBeDefined()

      yield* Scope.close(scope, Exit.void)
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies direct agent updates", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("build")

      yield* agent.transform((editor) =>
        editor.update(id, (info) => {
          info.mode = "primary"
          info.hidden = true
        }),
      )

      expect(yield* agent.get(id)).toMatchObject({ id, mode: "primary", hidden: true })
    }),
  )

  it.effect("creates agents with runtime defaults and supports direct removal", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const id = Agent.ID.make("custom")

      yield* agent.transform((editor) => editor.update(id, () => {}))
      const info = yield* agent.get(id)
      expect(info?.mode).toBe("primary")
      expect(info?.permissions.slice(0, Agent.Info.default(id).permissions.length)).toEqual(
        Agent.Info.default(id).permissions,
      )
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "shell", "*", "*"), info?.permissions ?? [])
          .effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "tool-output", "*"), info?.permissions ?? [])
          .effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.config, "*"), info?.permissions ?? []).effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.tmp, "*"), info?.permissions ?? []).effect,
      ).toBe("allow")

      // Orbit's own folder allows keep their mark in the agent, so that `Permission` leaves them out for a place a link
      // leads to; a rule of the person's with the same value has none (permissions-23).
      const folders = (info?.permissions ?? []).filter(
        (rule) => rule.action === "external_directory" && rule.effect === "allow",
      )
      expect(folders).toHaveLength(4)
      expect(folders.map(Agent.isOwnFolder)).toEqual([true, true, true, true])
      expect(folders.map((rule) => Agent.isOwnFolder({ ...rule }))).toEqual([false, false, false, false])

      yield* agent.transform((editor) => editor.remove(id))
      expect(yield* agent.get(id)).toBeUndefined()
    }),
  )

  it.effect("applies managed external directories without opting built-in agents into bash", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      const agents = yield* agent.list()
      expect(agents.map((item) => String(item.id)).sort()).toEqual([
        "build",
        "compaction",
        "explore",
        "general",
        "side",
        "summary",
        "title",
      ])
      expect((yield* agent.get(Agent.defaultID))?.system).toBeUndefined()
      const permissions = (yield* agent.get(Agent.defaultID))?.permissions ?? []
      const compaction = yield* agent.get(Agent.ID.make("compaction"))
      expect(compaction?.mode).toBe("primary")
      expect(compaction?.hidden).toBe(true)
      expect(compaction?.system).toBeUndefined()
      expect(compaction?.model).toBeUndefined()
      expect(compaction?.request).toEqual(Agent.Info.default(Agent.ID.make("compaction")).request)
      expect(compaction?.permissions).toEqual(permissions.filter((rule) => rule.action !== "AskUserQuestion"))
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "shell", "*", "*"), permissions).effect,
      ).toBe("allow")
      expect(
        Permission.evaluate("external_directory", path.join(global.data, "tool-output", "*"), permissions).effect,
      ).toBe("allow")
      expect(Permission.evaluate("external_directory", path.join(global.config, "*"), permissions).effect).toBe("allow")
      expect(Permission.evaluate("external_directory", path.join(global.tmp, "*"), permissions).effect).toBe("allow")
      const explore = yield* agent.get(Agent.ID.make("explore"))
      expect(Permission.evaluate("read", ".env", explore?.permissions ?? []).effect).toBe("ask")
      expect(Permission.evaluate("read", ".env.local", explore?.permissions ?? []).effect).toBe("ask")
      expect(Permission.evaluate("read", ".env.example", explore?.permissions ?? []).effect).toBe("allow")
      expect(Permission.evaluate("read", "src/index.ts", explore?.permissions ?? []).effect).toBe("allow")
      for (const item of agents) {
        expect(item.permissions.some((rule) => rule.action === "bash" && rule.effect !== "deny")).toBe(false)
      }
    }),
  )

  // The plugin host hands the real editor to a plugin, as this does, so the rules a plugin takes over by reference keep
  // their mark. Permission leaves the marked allows out for a place a link leads to; Explore takes them over, and a
  // plugin that copied them would turn them into the person's (permissions-23).
  it.effect("keeps the mark of Orbit's own folder allows in every built-in agent, Explore among them", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: {
            ...agentHost(agent),
            transform: (callback) =>
              agent.transform((editor) =>
                callback({
                  list: () => mutable(editor.list()),
                  get: (id) => mutable(editor.get(Agent.ID.make(id))),
                  default: (id) => editor.default(id === undefined ? undefined : Agent.ID.make(id)),
                  update: (id, update) => editor.update(Agent.ID.make(id), update),
                  remove: (id) => editor.remove(Agent.ID.make(id)),
                }),
              ),
          },
        }),
      )
      const valued = new Set(Agent.folders(global).map((rule) => rule.resource))
      const agents = yield* agent.list()
      expect(agents.map((item) => String(item.id))).toContain("explore")
      for (const item of agents) {
        const own = item.permissions.filter(
          (rule) => rule.action === "external_directory" && rule.effect === "allow" && valued.has(rule.resource),
        )
        expect([String(item.id), own.length >= 4, own.every(Agent.isOwnFolder)]).toEqual([String(item.id), true, true])
      }
    }),
  )

  it.effect("denies the subagent tool for built-in subagents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* AgentPlugin.Plugin.effect(
        host({
          agent: agentHost(agent),
        }),
      )

      yield* Effect.forEach(["general", "explore"], (id) =>
        Effect.gen(function* () {
          const info = yield* agent.get(Agent.ID.make(id))
          if (!info) throw new Error(`expected built-in agent: ${id}`)
          expect(info.mode).toBe("subagent")
          expect(info.permissions).toContainEqual({ action: "Agent", resource: "*", effect: "deny" })
          expect(Permission.evaluate("subagent", "*", info.permissions).effect).toBe("deny")
        }),
      )
    }),
  )
})

describe("Agent.scratchpad", () => {
  const spelled = Global.make({ data: "/data", config: "/config", tmp: "/tmp/orbit" })
  const real = Global.make({ data: "/data", config: "/config", tmp: "/real/tmp" })
  const person = { action: "Edit", resource: "src/*", effect: "deny" as const }

  test("is one allow for editing under the folder of sessions, Orbit's own, for each spelling of the temporary folder", () => {
    const one = Agent.scratchpad(spelled)
    expect(one.map((rule) => rule.resource)).toEqual([path.join("/tmp/orbit", "sessions", "*")])
    expect(one.every((rule) => rule.action === "Edit" && rule.effect === "allow" && Agent.isOwnFolder(rule))).toBe(true)
    const two = Agent.scratchpad(spelled, real)
    expect(two.map((rule) => rule.resource)).toEqual([
      path.join("/tmp/orbit", "sessions", "*"),
      path.join("/real/tmp", "sessions", "*"),
    ])
  })

  test("is cut to the folder of one session, in the place of the rule it came from", () => {
    const [first, second] = Agent.scratchpad(spelled, real)
    const rules = [person, first!, person, second!]
    const cut = Agent.narrowScratchpad(rules, "ses_a")
    // Other rules are the same objects, and a later rule of the person's still comes after the allow.
    expect(cut[0]).toBe(person)
    expect(cut[2]).toBe(person)
    expect(cut.map((rule) => rule.resource)).toEqual([
      "src/*",
      path.join("/tmp/orbit", "sessions", "ses_a", "*"),
      "src/*",
      path.join("/real/tmp", "sessions", "ses_a", "*"),
    ])
    expect(cut.map((rule) => rule.effect)).toEqual(["deny", "allow", "deny", "allow"])
    // Orbit's own, like the one it came from, and the rule that came from is not changed.
    expect([cut[1], cut[3]].every((rule) => Agent.isOwnFolder(rule!))).toBe(true)
    expect(first!.resource).toBe(path.join("/tmp/orbit", "sessions", "*"))
    // Each names its folder for both spellings, so a call through a link is held to the real place.
    expect(Agent.scratchpadFolders(cut[1]!)).toEqual([
      path.join("/tmp/orbit", "sessions", "ses_a"),
      path.join("/real/tmp", "sessions", "ses_a"),
    ])
    expect(Agent.scratchpadFolders(first!)).toBeUndefined()
    expect(Agent.scratchpadFolders(person)).toBeUndefined()
  })

  test("leaves a session that has no scratchpad with none of them", () => {
    const [first, second] = Agent.scratchpad(spelled, real)
    expect(Agent.narrowScratchpad([person, first!, second!], undefined)).toEqual([person])
  })

  test("is not made by copying a rule: a copy is the person's", () => {
    const [first] = Agent.scratchpad(spelled)
    const copy = { ...first! }
    expect(Agent.narrowScratchpad([copy], "ses_a")).toEqual([copy])
    expect(Agent.narrowScratchpad([copy], "ses_a")[0]).toBe(copy)
    expect(Agent.isOwnFolder(copy)).toBe(false)
  })

  it.effect("is in every agent, before the rules that a mode or a plugin adds", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.transform((editor) =>
        editor.update(Agent.ID.make("reviewer"), (info) => {
          info.permissions.push({ action: "Edit", resource: "*", effect: "deny" })
        }),
      )
      const info = yield* agent.get(Agent.ID.make("reviewer"))
      const rules = info?.permissions ?? []
      const at = rules.findIndex(
        (rule) => rule.action === "Edit" && rule.resource === path.join(global.tmp, "sessions", "*"),
      )
      expect(at).toBeGreaterThan(-1)
      expect(Agent.isOwnFolder(rules[at]!)).toBe(true)
      // The plugin's deny comes later, so for this agent it decides the folder, as the person's rules do for every agent.
      expect(rules.findIndex((rule) => rule.action === "Edit" && rule.resource === "*" && rule.effect === "deny")).toBeGreaterThan(at)
    }),
  )
})

describe("Agent.folders", () => {
  const spelled = Global.make({ data: "/data", config: "/config", tmp: "/tmp/orbit" })
  const leads = Global.make({ data: "/real/data", config: "/real/config", tmp: "/real/tmp" })
  const resources = (rules: ReturnType<typeof Agent.folders>) => rules.map((rule) => rule.resource)

  // Each row is a root that may be reached through a link: the allow must also be written for where it leads.
  for (const root of ["data", "config", "tmp"] as const) {
    test(`also allows the real path of the ${root} folder`, () => {
      const rules = Agent.folders(spelled, { ...spelled, [root]: leads[root] })
      const wanted = resources(Agent.folders(leads)).filter((resource) => resource.startsWith(path.normalize(leads[root])))
      expect(wanted.length).toBeGreaterThan(0)
      expect(resources(rules)).toEqual(expect.arrayContaining(wanted))
      expect(resources(rules)).toEqual(expect.arrayContaining(resources(Agent.folders(spelled))))
      expect(rules.every((rule) => rule.effect === "allow" && Agent.isOwnFolder(rule))).toBe(true)
    })
  }

  test("writes nothing twice when no folder is reached through a link", () => {
    expect(Agent.folders(spelled, spelled)).toHaveLength(4)
  })

  it.effect("follows a config folder that is a link when the agent service starts", () =>
    Effect.gen(function* () {
      const fs = yield* Effect.promise(() => import("fs/promises"))
      const os = yield* Effect.promise(() => import("os"))
      const root = yield* Effect.promise(() => fs.realpath(os.tmpdir()))
      const base = yield* Effect.promise(() => fs.mkdtemp(path.join(root, "orbit-own-")))
      yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(base, { recursive: true, force: true })))
      const target = path.join(base, "target")
      const link = path.join(base, "link")
      yield* Effect.promise(async () => {
        await fs.mkdir(target)
        await fs.symlink(target, link, "junction")
      })
      const linked = Global.make({ data: "/data", config: link, tmp: "/tmp/orbit" })
      const layer = AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, Location.node]), [
        Global.node.replace(Layer.succeed(Global.Service, Global.Service.of(linked))),
        Location.node.replace(locationLayer),
      ]) as unknown as Layer.Layer<Agent.Service, never>
      const agent = yield* Effect.gen(function* () {
        const service = yield* Agent.Service
        yield* service.transform((editor) => editor.update(Agent.ID.make("reviewer"), () => {}))
        return yield* service.get(Agent.ID.make("reviewer"))
      }).pipe(Effect.provide(Layer.fresh(layer)))
      const allowed = agent!.permissions.filter(Agent.isOwnFolder).map((rule) => rule.resource)
      expect(allowed).toContain(path.join(link, "*"))
      expect(allowed).toContain(path.join(target, "*"))
    }),
  )
})
