import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Schema, Context, Deferred, Duration, Effect, Layer, LayerMap, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { define } from "@orbit/plugin/effect/plugin"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Command } from "@orbit/core/command"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Instance } from "@orbit/core/instance"
import { LocationServiceMap } from "@orbit/core/location-services"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { Tool } from "@orbit/core/tool"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ManagedSettings } from "@orbit/core/managed-settings"
import type { ConfigManaged } from "@orbit/schema/config/managed"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { AbsolutePath } from "@orbit/core/schema"
import { Database } from "../../src/database/database"
import { Bus } from "../../src/bus"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { advance } from "../lib/clock"
import { testEffect } from "../lib/effect"

const id = Plugin.ID.make("account-prompts")

// Host and instance plugins share one ID; each registers a distinct command so the winner is observable.
const greeter = (command: string, plugin: string = id) =>
  define({
    id: plugin,
    effect: (ctx) =>
      ctx.command.transform((editor) => editor.add({ name: command, execute: () => Effect.void })).pipe(Effect.asVoid),
  })

// Every supervisor activation scans the config plugin operations once, so counting scans counts activations.
const source: { activations: number; operations: ConfigPluginSource.Operation[] } = { activations: 0, operations: [] }
const sourceLayer = Layer.succeed(
  ConfigPluginSource.Service,
  ConfigPluginSource.Service.of({
    operations: () =>
      Effect.sync(() => {
        source.activations++
        return source.operations
      }),
    changes: () => Stream.never,
  }),
)

// One policy for the test and every location it builds, so a restriction set here reaches the supervisor.
const sharedPolicy = Effect.runSync(
  Layer.build(ManagedPolicy.layer).pipe(
    Effect.map((context) => Context.get(context, ManagedPolicy.Service)),
    Effect.scoped,
  ),
)

const policyLayer = Layer.succeed(ManagedPolicy.Service, sharedPolicy)

const instances = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        Instance.layer(ref, { discovery: false, plugins: [greeter("instance-greet")], replacements: bindings }),
      { idleTimeToLive: Duration.infinity },
    )
    const bindings: LayerNode.Replacements = [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      ConfigPluginSource.node.replace(sourceLayer),
      ManagedPolicy.node.replace(policyLayer),
      // The real one would write the machine's own managed settings over the policy this test sets.
      ManagedSettings.node.replace(ManagedSettings.emptyLayer),
      LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
      Instance.node.replace(
        Layer.succeed(Instance.Service, {
          provide: (session) => Effect.provide(map.get(session.location)),
        }),
      ),
    ]
    return map
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, ManagedPolicy.node, LocationServiceMap.node]), [
    Global.node.replace(tempGlobalLayer),
    offlineModels,
    LocationServiceMap.node.replace(instances),
    ManagedPolicy.node.replace(policyLayer),
  ]),
)

describe("PluginSupervisor", () => {
  it.live("reports a duplicate plugin ID as a failure without dropping the generation", () =>
    Effect.gen(function* () {
      const sdk = yield* SdkPlugins.Service
      yield* sdk.register(greeter("host-greet"))
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      const state = yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        const commands = yield* Command.Service
        return {
          inventory: yield* plugins.list(),
          host: yield* commands.get("host-greet"),
          instance: yield* commands.get("instance-greet"),
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )

      // Earlier boot order wins: the host SDK plugin activates and the instance copy is reported.
      expect(state.inventory.filter((plugin) => plugin.id === id)).toEqual([
        { id, source: { type: "sdk" }, state: { status: "active" }, features: { server: true } },
        {
          id,
          source: { type: "sdk" },
          state: { status: "failed", error: `Duplicate plugin ID: ${id}` },
          features: { server: true },
        },
      ])
      expect(state.host).toBeDefined()
      expect(state.instance).toBeUndefined()
      // Builtins stay active: the duplicate is a plugin failure, not a generation defect.
      expect(
        state.inventory.some((plugin) => plugin.id?.startsWith("orbit.") && plugin.state.status === "active"),
      ).toBe(true)
    }),
  )

  it.effect("activates the initial generation without waiting for the reload debounce", () =>
    Effect.gen(function* () {
      source.activations = 0
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        // The TestClock never advances here, so any timer between boot and the first activation would hang this.
        yield* plugins.awaitActivation
        expect(yield* commands.get("instance-greet")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.activations).toBe(1)
    }),
  )

  it.effect("refreshes every 24 hours without adding an immediate reload", () =>
    Effect.gen(function* () {
      source.activations = 0
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        yield* TestClock.adjust("23 hours")
        expect(source.activations).toBe(1)

        yield* TestClock.adjust("1 hour")
        yield* advance(() => source.activations === 2)
        yield* plugins.awaitActivation

        yield* TestClock.adjust("24 hours")
        yield* advance(() => source.activations === 3)
        yield* plugins.awaitActivation
        expect(source.activations).toBe(3)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  it.effect("reloads for a trigger published while the initial generation is activating", () =>
    Effect.gen(function* () {
      source.activations = 0
      const sdk = yield* SdkPlugins.Service
      const entered = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      yield* sdk.register(
        define({
          id: "gated",
          effect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
        }),
      )
      let late = false
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* Deferred.await(entered)
        // Generation 0 is mid-setup: the reload feed must already be subscribed for this update to count.
        yield* sdk.register(
          define({
            id: "late",
            effect: (ctx) =>
              ctx.command
                .transform((editor) => editor.add({ name: "late-greet", execute: () => Effect.void }))
                .pipe(Effect.tap(() => Effect.sync(() => (late = true)))),
          }),
        )
        yield* Deferred.succeed(gate, undefined)
        yield* advance(() => late)
        yield* plugins.awaitActivation
        expect(yield* commands.get("late-greet")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.activations).toBe(2)
    }),
  )

  for (const targets of [["orbit.config.policy", "orbit.config.agent"], ["*"]]) {
    it.effect(`keeps policy enforcement through plugin removals: ${targets}`, () =>
      Effect.gen(function* () {
        source.operations = targets.map((target) => ({ type: "remove", target }))
        const directory = yield* tmpdirScoped()
        const locations = yield* LocationServiceMap.Service
        const inventory = yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          return yield* plugins.list()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
        const status = (id: string) => inventory.find((plugin) => plugin.id === id)?.state.status
        expect(status("orbit.config.policy")).toBe("active")
        // Removals still apply to everything else, including instance and builtin plugins.
        expect(status("orbit.config.agent")).toBeUndefined()
        expect(inventory.some((plugin) => plugin.id === id)).toBe(targets[0] !== "*")
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            source.operations = []
          }),
        ),
      ),
    )
  }

  // The memory index activates late so it renders last, but the Memory tool itself stays an early built-in that
  // SDK, instance and package plugins can remove or replace.
  for (const mode of ["remove", "replace"] as const) {
    it.effect(`lets an SDK plugin ${mode} the built-in Memory tool`, () =>
      Effect.gen(function* () {
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(
          define({
            id: `memory-${mode}`,
            effect: (ctx) =>
              ctx.tool
                .transform((editor) => {
                  if (mode === "remove") return editor.remove("Memory")
                  editor.add({
                    name: "Memory",
                    options: { codemode: false },
                    description: "plugin memory",
                    input: Schema.Struct({}),
                    execute: () => Effect.succeed({ content: "ok" }),
                  })
                })
                .pipe(Effect.asVoid),
          }),
        )
        const directory = yield* tmpdirScoped()
        const locations = yield* LocationServiceMap.Service
        const memory = yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const tools = yield* Tool.Service
          return (yield* tools.list()).find((tool) => tool.name === "Memory")
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
        if (mode === "remove") return expect(memory).toBeUndefined()
        expect(memory?.description).toBe("plugin memory")
      }),
    )
  }

  it.effect("coalesces a burst of reload triggers after the initial generation into one activation", () =>
    Effect.gen(function* () {
      source.activations = 0
      const sdk = yield* SdkPlugins.Service
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation
        expect(source.activations).toBe(1)

        yield* sdk.register(greeter("greet-a", "a"))
        yield* sdk.register(greeter("greet-b", "b"))
        yield* sdk.register(greeter("greet-c", "c"))
        yield* advance(() => source.activations > 1)
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-a")).toBeDefined()
        expect(yield* commands.get("greet-c")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
      expect(source.activations).toBe(2)
    }),
  )

  describe("under the organization's plugin lists", () => {
    // Each plugin writes one file when its module is evaluated and another when its setup runs.
    const plugin = (directory: string, name: string, pluginID: string) =>
      Effect.promise(async () => {
        const root = path.join(directory, name)
        await Bun.write(
          path.join(root, "index.ts"),
          [
            `import { writeFileSync } from "node:fs"`,
            `writeFileSync(${JSON.stringify(path.join(directory, `${name}.top`))}, "x")`,
            `export default { id: ${JSON.stringify(pluginID)}, async setup() { writeFileSync(${JSON.stringify(path.join(directory, `${name}.setup`))}, "x") } }`,
          ].join("\n"),
        )
        return root
      })
    // The 8.3 short name of an existing folder, or undefined when this machine cannot report one.
    const shortName = (folder: string) => {
      const result = Bun.spawnSync(
        ["powershell", "-NoProfile", "-Command", "(New-Object -ComObject Scripting.FileSystemObject).GetFolder($env:P).ShortPath"],
        { env: { ...process.env, P: folder } },
      )
      return result.stdout.toString().trim() || undefined
    }
    const exists = (file: string) => Effect.promise(() => Bun.file(file).exists())
    const inventory = (restrictions: ConfigManaged.Restrictions, operations: ConfigPluginSource.Operation[]) =>
      Effect.gen(function* () {
        const policy = sharedPolicy
        yield* policy.set("file", { statements: [], restrictions })
        source.operations = operations
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(greeter("host-greet", "host.plugin"))
        const directory = yield* tmpdirScoped()
        const locations = yield* LocationServiceMap.Service
        return yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          return yield* plugins.list()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            source.operations = []
          }),
        ),
      )
    const state = (list: readonly Plugin.Info[], id: string) =>
      list.find((item) => item.id === id)?.state
    const failedTargets = (list: readonly Plugin.Info[]) =>
      list.flatMap((item) => (item.state.status === "failed" && item.source?.type === "local" ? [item.source.path] : []))

    it.live("never loads a blocked or unlisted local target, and loads the allowed one", () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const good = yield* plugin(tmp, "good", "corp.good")
        const blocked = yield* plugin(tmp, "blocked", "corp.blocked")
        const unlisted = yield* plugin(tmp, "unlisted", "corp.unlisted")
        const add = (target: string) => ({ type: "add" as const, target, options: {} })
        const list = yield* inventory({ plugins: { allow: [good, blocked], block: [blocked] } }, [
          add(good),
          add(blocked),
          add(unlisted),
        ])
        expect(state(list, "corp.good")).toEqual({ status: "active" })
        expect(yield* exists(path.join(tmp, "good.top"))).toBe(true)
        // The module is never evaluated, so top-level code does not run, and the failure says why.
        for (const name of ["blocked", "unlisted"]) {
          expect(yield* exists(path.join(tmp, `${name}.top`))).toBe(false)
          expect(yield* exists(path.join(tmp, `${name}.setup`))).toBe(false)
        }
        expect(failedTargets(list).toSorted()).toEqual([blocked, unlisted].toSorted())
        expect(list.filter((item) => item.state.status === "failed" && "error" in item.state)).toSatisfy((failed) =>
          failed.every((item) => item.state.status === "failed" && item.state.error === "Blocked by managed settings"),
        )
      }),
    )

    it.live("names the organization in the failure", () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const blocked = yield* plugin(tmp, "blocked", "corp.blocked")
        const policy = sharedPolicy
        yield* policy.set("file", { statements: [], restrictions: { plugins: { block: [blocked] } }, organization: "Acme" })
        source.operations = [{ type: "add", target: blocked, options: {} }]
        const locations = yield* LocationServiceMap.Service
        const list = yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          return yield* plugins.list()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(tmp) }))),
          Effect.ensuring(Effect.sync(() => (source.operations = []))),
        )
        expect(list.find((item) => item.source?.type === "local")?.state).toMatchObject({
          status: "failed",
          error: "Blocked by Acme's managed settings",
        })
      }),
    )

    it.live("drops a plugin whose ID is blocked after it loads: setup never runs", () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const bad = yield* plugin(tmp, "bad", "acme.bad")
        const fine = yield* plugin(tmp, "fine", "corp.fine")
        const add = (target: string) => ({ type: "add" as const, target, options: {} })
        const list = yield* inventory({ plugins: { block: ["acme.*"] } }, [add(bad), add(fine)])
        expect(state(list, "corp.fine")).toEqual({ status: "active" })
        expect(list.some((item) => item.id === "acme.bad" && item.state.status === "active")).toBe(false)
        expect(failedTargets(list)).toEqual([bad])
        // The module was imported, which is why blocking the target is what stops code from running at all.
        expect(yield* exists(path.join(tmp, "bad.top"))).toBe(true)
        expect(yield* exists(path.join(tmp, "bad.setup"))).toBe(false)
        expect(yield* exists(path.join(tmp, "fine.setup"))).toBe(true)
      }),
    )

    for (const [name, plugins] of [
      ["block everything", { block: ["*"] }],
      ["an empty allow list", { allow: [] }],
    ] as const) {
      it.live(`keeps the built-in and host plugins active under ${name}`, () =>
        Effect.gen(function* () {
          const tmp = (yield* tmpdirScoped()).path
          const external = yield* plugin(tmp, "external", "corp.external")
          const list = yield* inventory({ plugins }, [{ type: "add", target: external, options: {} }])
          expect(state(list, "orbit.config.policy")).toEqual({ status: "active" })
          expect(state(list, "host.plugin")).toEqual({ status: "active" })
          expect(yield* exists(path.join(tmp, "external.top"))).toBe(false)
          expect(failedTargets(list)).toEqual([external])
        }),
      )
    }

    it.live("holds a plugin the managed document names to the allow list too", () =>
      Effect.gen(function* () {
        // The operation is the same wherever the document came from, so a managed document gets no exemption.
        const tmp = (yield* tmpdirScoped()).path
        const named = yield* plugin(tmp, "named", "corp.named")
        const list = yield* inventory({ plugins: { allow: ["@other/pkg"] } }, [{ type: "add", target: named, options: {} }])
        expect(yield* exists(path.join(tmp, "named.top"))).toBe(false)
        expect(failedTargets(list)).toEqual([named])
      }),
    )

    it.live("does not keep a plugin running whose ID was blocked after it started, when its new revision fails", () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const kept = yield* plugin(tmp, "kept", "corp.kept")
        const policy = sharedPolicy
        yield* policy.set("file", { statements: [], restrictions: {} })
        source.operations = [{ type: "add", target: kept, options: {} }]
        const sdk = yield* SdkPlugins.Service
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          // The control: before the block, the same plugin is active.
          expect(state(yield* plugins.list(), "corp.kept")).toEqual({ status: "active" })
          yield* Effect.promise(() => Bun.write(path.join(kept, "index.ts"), "export default ("))
          yield* policy.set("file", { statements: [], restrictions: { plugins: { block: ["corp.kept"] } } })
          yield* sdk.register(greeter("trigger", "host.trigger"))
          const stopped = plugins.list().pipe(
            Effect.map((list) => list.every((item) => item.state.status !== "active" || item.id !== "corp.kept")),
            Effect.filterOrFail((ok) => ok),
            Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
          )
          yield* stopped
          expect(state(yield* plugins.list(), "corp.kept")?.status).not.toBe("active")
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(tmp) }))),
          Effect.ensuring(Effect.sync(() => (source.operations = []))),
        )
      }),
    )

    it.live("matches a target and a selector by real path, whichever of them is spelled through a link", () =>
      Effect.gen(function* () {
        const tmp = (yield* tmpdirScoped()).path
        const real = yield* plugin(tmp, "real", "corp.real")
        const link = path.join(tmp, "link")
        yield* Effect.promise(() => fs.symlink(real, link, "junction"))
        const add = (target: string) => ({ type: "add" as const, target, options: {} })
        for (const [name, restrictions, target] of [
          ["a real selector and a link target", { plugins: { block: [real] } }, link],
          ["a link selector and a real target", { plugins: { block: [link] } }, real],
        ] as const) {
          const blocked = yield* inventory(restrictions, [add(target)])
          expect(failedTargets(blocked), name).toEqual([target])
          expect(yield* exists(path.join(tmp, "real.top")), name).toBe(false)
        }
        // The controls: an allow list written through the link admits the real path, and the other way around.
        for (const [allow, target] of [
          [link, real],
          [real, link],
        ] as const) {
          const list = yield* inventory({ plugins: { allow: [allow] } }, [add(target)])
          expect(state(list, "corp.real")).toEqual({ status: "active" })
        }
      }),
    )

    // Classes 3 and 4: the same folder spelled with its Windows 8.3 short name. The TUI resolves with the native realpath, which
    // expands it, so the server must too. (UNC admin-share spellings keep their form under realpath; docs/upgrading.md says
    // that a path block matches the real path only, and that only an allow list holds against another spelling.)
    it.live("matches a target spelled with its 8.3 short name by the real path", () =>
      Effect.gen(function* () {
        if (process.platform !== "win32") return
        const tmp = (yield* tmpdirScoped()).path
        const long = yield* plugin(tmp, "longpluginname", "corp.long")
        const short = shortName(long)
        // The volume may not create short names; the row then has nothing to spell.
        if (short === undefined || short.toLowerCase() === long.toLowerCase()) return
        const add = { type: "add" as const, target: short, options: {} }
        const blocked = yield* inventory({ plugins: { block: [long] } }, [add])
        expect(failedTargets(blocked)).toEqual([short])
        expect(yield* exists(path.join(tmp, "longpluginname.top"))).toBe(false)
        // The controls: an allow list on the long path admits the short spelling, and nothing blocks it without the block.
        const allowed = yield* inventory({ plugins: { allow: [long] } }, [add])
        expect(state(allowed, "corp.long")).toEqual({ status: "active" })
      }),
    )

    // A path realpath cannot resolve is one entry's problem: the built-in, host and allowed plugins stay active.
    for (const row of [
      { name: "a target under a file (ENOTDIR)", only: "posix", restrictions: "none" },
      { name: "a symlink loop (ELOOP)", only: "posix", restrictions: "none" },
      { name: "a managed block selector under a file", only: "posix", restrictions: "bad selector" },
      { name: "an allow list and a target under a file", only: "posix", restrictions: "allow" },
      { name: "an unreachable UNC target", only: "win32", restrictions: "none" },
      { name: "an unreachable UNC target under an allow list", only: "win32", restrictions: "allow" },
    ] as const) {
      if ((row.only === "win32") !== (process.platform === "win32")) continue
      it.live(`keeps every other plugin active when it meets ${row.name}`, () =>
        Effect.gen(function* () {
          const tmp = (yield* tmpdirScoped()).path
          const good = yield* plugin(tmp, "good", "corp.good")
          const underFile = path.join(tmp, "good", "index.ts", "x")
          const bad =
            row.only === "win32"
              ? "\\\\nonexistent-host-xyz\\share\\x"
              : row.name.includes("loop")
                ? path.join(tmp, "loop-a")
                : underFile
          if (row.name.includes("loop")) {
            yield* Effect.promise(async () => {
              await fs.symlink(path.join(tmp, "loop-b"), path.join(tmp, "loop-a"))
              await fs.symlink(path.join(tmp, "loop-a"), path.join(tmp, "loop-b"))
            })
          }
          const restrictions =
            row.restrictions === "allow"
              ? { plugins: { allow: [good] } }
              : row.restrictions === "bad selector"
                ? { plugins: { block: [underFile] } }
                : {}
          const add = (target: string) => ({ type: "add" as const, target, options: {} })
          const list = yield* inventory(restrictions, [add(good), add(bad)])
          expect(state(list, "orbit.config.policy")).toEqual({ status: "active" })
          expect(state(list, "host.plugin")).toEqual({ status: "active" })
          expect(state(list, "corp.good")).toEqual({ status: "active" })
          expect(failedTargets(list)).toEqual([bad])
        }),
      )
    }

    it.live("never installs a package that is blocked or off the allow list", () =>
      Effect.gen(function* () {
        // A registry package would be installed by modules.load; it is reported as failed without that.
        const list = yield* inventory({ plugins: { allow: ["@corp/ok"], block: ["@corp/bad"] } }, [
          { type: "add", target: "@corp/bad@^1", options: {} },
          { type: "add", target: "@elsewhere/x", options: {} },
          { type: "add", target: "foo@npm:bar", options: {} },
        ])
        const failed = list.flatMap((item) =>
          item.state.status === "failed" && item.source?.type === "package" ? [item.source.target] : [],
        )
        expect(failed.toSorted()).toEqual(["@corp/bad@^1", "@elsewhere/x", "foo@npm:bar"])
        for (const item of list)
          if (item.source?.type === "package" && item.state.status === "failed")
            expect(item.state.error).toBe("Blocked by managed settings")
      }),
    )
  })
})
