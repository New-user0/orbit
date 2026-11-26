import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Duration, Effect, Fiber, Layer, LayerMap, Schedule, Stream } from "effect"
import { TestClock } from "effect/testing"
import { define } from "@orbit/plugin/effect/plugin"
import { Event } from "@orbit/schema/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Npm } from "@orbit/util/npm"
import { Bus } from "@orbit/core/bus"
import { Command } from "@orbit/core/command"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Database } from "@orbit/core/database/database"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Instance } from "@orbit/core/instance"
import { LocationServiceMap } from "@orbit/core/location-services"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Rpc } from "@orbit/core/rpc"
import { SdkPlugins } from "@orbit/core/plugin/sdk"
import { PluginUpdate } from "@orbit/core/plugin/update"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { tempGlobalLayer } from "../fixture/global"
import { offlineModels } from "../fixture/models"
import { tmpdirScoped } from "../fixture/tmpdir"
import { advance } from "../lib/clock"
import { testEffect } from "../lib/effect"

// Real Location boot with plugin-directory discovery, so local plugin files are loaded and reloaded.
setDefaultTimeout(15_000)

// Package resolution can be held open so overlapping activations become observable.
const npm = {
  directory: "",
  gate: undefined as Deferred.Deferred<void> | undefined,
  inflight: 0,
  peak: 0,
  // When set, the package is not on the machine until `add` installs it, and `add` waits for `gate` to install it. A
  // stopped `add` sets `ending` and, when `release` is set, takes until `release` to end, as a package manager's process
  // takes a while to exit.
  install: undefined as
    | {
        readonly gate: Deferred.Deferred<void>
        readonly release?: Deferred.Deferred<void>
        adds: number
        stopped: number
        ending?: boolean
        done: boolean
      }
    | undefined,
}

const npmLayer = Layer.succeed(
  Npm.Service,
  Npm.Service.of({
    add: (name) =>
      Effect.gen(function* () {
        const install = npm.install
        if (install) {
          install.adds++
          yield* Deferred.await(install.gate).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                install.ending = true
                if (install.release) yield* Deferred.await(install.release)
                install.stopped++
              }),
            ),
          )
          install.done = true
        }
        return { directory: npm.directory, name }
      }),
    resolve: (name) =>
      Effect.gen(function* () {
        npm.inflight++
        npm.peak = Math.max(npm.peak, npm.inflight)
        if (npm.gate) yield* Deferred.await(npm.gate)
        npm.inflight--
        const missing = npm.install !== undefined && !npm.install.done
        // Beside the package, not in it: inside, the package would resolve by its own name.
        return { directory: missing ? path.join(path.dirname(npm.directory), "not-installed") : npm.directory, name }
      }),
    check: () => Effect.succeed(false),
    update: (name) => Effect.succeed({ directory: npm.directory, name }),
    which: () => Effect.undefined,
  }),
)

// The locations the tests boot, with the replacements that decide what a test is about. The default workspace trust
// follows ORBIT_TRUST_PROJECT, which the test bootstrap sets, so every folder is trusted unless a test says otherwise.
const instancesWith = (replacements: LayerNode.Replacements = []) =>
  Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const watcher = yield* Watcher.Test
      const map = yield* LayerMap.make((ref: Location.Ref) => Instance.layer(ref, { replacements: bindings }), {
        idleTimeToLive: Duration.infinity,
      })
      const bindings: LayerNode.Replacements = [
        Global.node.replace(tempGlobalLayer),
        offlineModels,
        Npm.node.replace(npmLayer),
        Watcher.node.replace(Layer.succeed(Watcher.Service, watcher)),
        LocationServiceMap.node.replace(Layer.succeed(LocationServiceMap.Service, map)),
        Instance.node.replace(
          Layer.succeed(Instance.Service, {
            provide: (session) => Effect.provide(map.get(session.location)),
          }),
        ),
        ...replacements,
      ]
      return map
    }),
  ).pipe(Layer.provide(Watcher.testLayer))

const app = (instances: ReturnType<typeof instancesWith>) =>
  testEffect(
    AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
      Global.node.replace(tempGlobalLayer),
      offlineModels,
      LocationServiceMap.node.replace(instances),
    ]).pipe(Layer.provideMerge(Watcher.testLayer)),
  )

const it = app(instancesWith())
// Locations whose plugin sources can be read once, at startup: every later activation fails before it applies anything.
const sourced = { reads: 0 }
const failing = app(
  instancesWith([
    ConfigPluginSource.node.replace(
      Layer.succeed(
        ConfigPluginSource.Service,
        ConfigPluginSource.Service.of({
          operations: () => (sourced.reads++ === 0 ? Effect.succeed([]) : Effect.die(new Error("sources unreadable"))),
          changes: () => Stream.never,
        }),
      ),
    ),
  ]),
)
// Locations whose folder nothing trusts until a test grants it.
const untrusted = app(instancesWith([WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false }))]))
// Locations whose update checks find a newer version of every package and announce nothing.
const updatable = app(
  instancesWith([
    PluginUpdate.node.replace(
      Layer.succeed(
        PluginUpdate.Service,
        PluginUpdate.Service.of({
          check: () => Effect.succeed(true),
          update: () => Effect.void,
          changes: () => Stream.never,
        }),
      ),
    ),
  ]),
)

const greeter = (command: string) => `export default {
  id: "greeter",
  async setup(ctx) {
    await ctx.command.transform((editor) => editor.add({ name: "${command}", execute: async () => {} }))
  },
}`

// Real-time polling: reloads do filesystem work that the TestClock cannot advance.
const settle = (predicate: () => boolean, attempts = 200): Effect.Effect<void, string> =>
  Effect.suspend(() => {
    if (predicate()) return Effect.void
    if (attempts === 0) return Effect.fail("not settled")
    return Effect.promise(() => Bun.sleep(10)).pipe(Effect.andThen(settle(predicate, attempts - 1)))
  })

const failed = (plugins: Plugin.Interface) =>
  plugins.list().pipe(
    Effect.flatMap((inventory) => {
      const failure = inventory.find((plugin) => plugin.state.status === "failed" && plugin.source.type === "local")
      return failure ? Effect.succeed(failure) : Effect.fail("activation pending")
    }),
    Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
  )

describe("PluginSupervisor reload", () => {
  ;(
    [
      { name: "on a helper-only save", helper: "nested/helper.ts", touchEntry: false },
      { name: "when the entrypoint also changes", helper: "nested/helper.ts", touchEntry: true },
      { name: "outside the configured plugin directory", helper: "../shared/helper.ts", touchEntry: false },
    ] as const
  ).forEach((scenario) => {
    it.live(`reloads helper-defined RPC methods ${scenario.name}`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const root = path.join(directory.path, "external/greeter")
        const file = path.join(root, "index.ts")
        const helper = path.join(root, scenario.helper)
        const entry = `export { default } from ${JSON.stringify("./" + scenario.helper)}`
        const source = (version: number) => `import { Schema } from ${JSON.stringify(import.meta.resolve("effect"))}
          export default {
            id: "greeter",
            async setup(ctx) {
              await ctx.rpc.register({ id: "greeter", methods: {
                status: { input: Schema.Unknown, output: Schema.Number },
                ${version > 1 ? "info: { input: Schema.Unknown, output: Schema.Number }," : ""}
              }, events: {} }, {
                status: async () => ${version},
                ${version > 1 ? `info: async () => ${version},` : ""}
              })
              await ctx.command.transform(editor => editor.add({ name: "greet-v${version}", execute: async () => {} }))
            }
          }`
        yield* Effect.promise(async () => {
          await Bun.write(file, entry)
          await Bun.write(helper, source(1))
          await Bun.write(path.join(directory.path, ".orbit/orbit.json"), JSON.stringify({ plugins: [root] }))
        })
        const watcher = yield* Watcher.Test
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const rpc = yield* Rpc.Service
          const commands = yield* Command.Service
          yield* plugins.awaitActivation
          expect(yield* rpc.call("greeter", "status", {})).toBe(1)
          expect(yield* rpc.call("greeter", "info", {}).pipe(Effect.flip)).toMatchObject({
            type: "rpc.method_not_found",
          })

          yield* Effect.promise(async () => {
            await Bun.write(helper, source(2))
            if (scenario.touchEntry) {
              await Bun.write(file, entry + "; // updated entry")
              await fs.utimes(file, new Date(), new Date(Date.now() + 1000))
            }
          })
          yield* watcher.emit({ path: scenario.touchEntry ? file : helper, type: "update" })
          yield* rpc
            .call("greeter", "info", {})
            .pipe(Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }))
          expect(yield* rpc.call("greeter", "info", {})).toBe(2)
          expect(yield* commands.get("greet-v1")).toBeUndefined()
          expect(yield* commands.get("greet-v2")).toBeDefined()

          // Failed helper evaluations retain the active registration and recover on the next save.
          yield* Effect.promise(() => Bun.write(helper, 'throw new Error("broken helper"); export default {}'))
          yield* watcher.emit({ path: helper, type: "update" })
          yield* failed(plugins)
          expect(yield* rpc.call("greeter", "info", {})).toBe(2)
          yield* Effect.promise(() => Bun.write(helper, source(3)))
          yield* watcher.emit({ path: helper, type: "update" })
          yield* commands.get("greet-v3").pipe(
            Effect.flatMap((command) => (command ? Effect.void : Effect.fail("activation pending"))),
            Effect.retry({ times: 80, schedule: Schedule.spaced("25 millis") }),
          )
          expect(yield* rpc.call("greeter", "info", {})).toBe(3)
          expect(yield* commands.get("greet-v2")).toBeUndefined()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
      }),
    )
  })
  ;(["discovered", "configured"] as const).forEach((mode) => {
    it.effect(`retains a ${mode} plugin change during initial activation`, () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const file = path.join(
          directory.path,
          mode === "discovered" ? ".orbit/plugins/greeter.ts" : "external/greeter/index.ts",
        )
        yield* Effect.promise(async () => {
          await Bun.write(file, greeter("greet-v1"))
          await fs.utimes(file, new Date(0), new Date(0))
          if (mode === "configured") {
            await Bun.write(
              path.join(directory.path, ".orbit/orbit.json"),
              JSON.stringify({ plugins: [path.dirname(file)] }),
            )
          }
        })
        const entered = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        const sdk = yield* SdkPlugins.Service
        yield* sdk.register(
          define({
            id: "gated",
            effect: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(gate))),
          }),
        )
        const watcher = yield* Watcher.Test
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const commands = yield* Command.Service
          yield* Deferred.await(entered)
          // The real ConfigPluginSource merges config-root changes and configured-path watches.
          // Emit while setup is blocked, without a bus event that could mask a lost source trigger.
          yield* Effect.promise(async () => {
            await Bun.write(file, greeter("greet-v2"))
            await fs.utimes(file, new Date(), new Date())
          })
          yield* watcher.emit({ path: file, type: "update" })
          const ready = yield* plugins.awaitActivation.pipe(Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.succeed(gate, undefined)
          yield* advance(() => ready.pollUnsafe() !== undefined)
          yield* Fiber.join(ready)

          expect(yield* commands.get("greet-v1")).toBeUndefined()
          expect(yield* commands.get("greet-v2")).toBeDefined()
        }).pipe(
          Effect.scoped,
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        )
      }),
    )
  })

  it.live("keeps the running generation when an updated local plugin fails to import", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const file = path.join(directory.path, ".orbit/plugins/greeter.ts")
      // Local plugin revisions key on mtime, so give each rewrite a distinct timestamp.
      const write = (content: string, mtime: Date) =>
        Effect.promise(async () => {
          await Bun.write(file, content)
          await fs.utimes(file, mtime, mtime)
        })
      yield* write(greeter("greet-v1"), new Date(Date.now() - 60_000))
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-v1")).toBeDefined()

        yield* write("export default {", new Date())
        yield* bus.publish(Event.Updated, {})
        const failure = yield* failed(plugins)

        expect(failure).toMatchObject({ source: { type: "local", path: file }, state: { status: "failed" } })
        // The broken revision never produced a generation, so the previous one keeps running.
        expect(yield* commands.get("greet-v1")).toBeDefined()
        expect(yield* plugins.list()).toContainEqual(
          expect.objectContaining({
            id: "greeter",
            source: { type: "local", path: file },
            state: { status: "active" },
          }),
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  it.effect("serializes the periodic refresh behind an in-flight reload", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      npm.directory = path.join(directory.path, "fixture-pkg")
      npm.gate = undefined
      npm.peak = 0
      yield* Effect.promise(() =>
        Bun.write(
          path.join(npm.directory, "package.json"),
          JSON.stringify({ name: "fixture-pkg", exports: { "./server": "./server.ts" } }),
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(npm.directory, "server.ts"), greeter("greet-pkg")))
      yield* Effect.promise(() =>
        Bun.write(path.join(directory.path, ".orbit/orbit.json"), JSON.stringify({ plugins: ["fixture-pkg"] })),
      )
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* TestClock.adjust("100 millis")
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-pkg")).toBeDefined()
        expect(npm.peak).toBe(1)

        // Hold the next resolve open, then let the 24 hour refresh fire while it is blocked.
        const gate = yield* Deferred.make<void>()
        npm.gate = gate
        npm.inflight = 0
        npm.peak = 0
        yield* bus.publish(Event.Updated, {})
        yield* TestClock.adjust("100 millis")
        yield* settle(() => npm.inflight === 1)
        yield* TestClock.adjust("24 hours")
        // Without serialization the refresh resolves concurrently with the held reload and the peak reaches 2.
        yield* settle(() => npm.peak > 1, 50).pipe(Effect.ignore)
        const peak = npm.peak
        yield* Deferred.succeed(gate, undefined)
        npm.gate = undefined
        yield* TestClock.adjust("100 millis")
        yield* plugins.awaitActivation

        expect(peak).toBe(1)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  // An install runs beside the activations, so a change that follows it is answered while it waits (a trust grant,
  // then a revoke: server/test/trust-grant-install.test.ts). A later activation that still lacks the package starts
  // no second install. Once the first one ends, what it installed applies, through an activation that reads the
  // sources as they are then: the local plugin removed meanwhile does not come back.
  it.live("a package install that a later activation finds under way runs once, and what it installs applies", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* installable(directory.path, "install-pkg", "greet-installed")
      const extra = path.join(directory.path, ".orbit/plugins/extra.ts")
      yield* Effect.promise(() => Bun.write(extra, greeter("greet-extra").replace("greeter", "extra")))
      const gate = yield* Deferred.make<void>()
      npm.install = { gate, adds: 0, stopped: 0, done: false }
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitApplied
        expect(yield* commands.get("greet-extra")).toBeDefined()
        yield* settle(() => npm.install?.adds === 1)
        yield* Effect.promise(() => fs.rm(extra))
        yield* plugins.refresh()
        expect(yield* commands.get("greet-extra")).toBeUndefined()
        expect(yield* commands.get("greet-installed")).toBeUndefined()
        // Give a second install the time to start, if one would.
        yield* settle(() => (npm.install?.adds ?? 0) > 1, 20).pipe(Effect.ignore)
        expect(npm.install?.adds).toBe(1)

        yield* Deferred.succeed(gate, undefined)
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-installed")).toBeDefined()
        expect(npm.install?.adds).toBe(1)
        expect(yield* commands.get("greet-extra")).toBeUndefined()
        const inventory = yield* plugins.list()
        expect(inventory.filter((plugin) => plugin.source.type === "local").map((plugin) => plugin.id)).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        Effect.ensuring(
          Effect.sync(() => {
            npm.install = undefined
          }),
        ),
      )
    }),
  )

  // The update check runs after the activation applied, so what it finds shows on the package's entry once it ends.
  updatable.live("marks a package plugin outdated once its update check finds a newer version", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* installable(directory.path, "outdated-pkg", "greet-outdated")
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitApplied
        expect(yield* commands.get("greet-outdated")).toBeDefined()
        const entry = plugins.list().pipe(
          Effect.map((inventory) => inventory.find((plugin) => plugin.source.type === "package")?.source),
          Effect.filterOrFail(
            (source) => source !== undefined && "outdated" in source,
            () => "update check pending",
          ),
          Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
        )
        expect(yield* entry).toMatchObject({ type: "package", outdated: true })
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )
})

// A package plugin in `<root>/package` that adds the command `command`, named by the folder's own config.
const installable = (root: string, name: string, command: string) =>
  Effect.promise(async () => {
    npm.directory = path.join(root, "package")
    npm.gate = undefined
    await Bun.write(
      path.join(npm.directory, "package.json"),
      JSON.stringify({ name, exports: { "./server": "./server.ts" } }),
    )
    await Bun.write(path.join(npm.directory, "server.ts"), greeter(command))
    await Bun.write(path.join(root, ".orbit/orbit.json"), JSON.stringify({ plugins: [name] }))
  })

describe("PluginSupervisor under workspace trust", () => {
  // The supervisor follows a trust change through the config, which reloads and then reactivates the plugins.
  const commandPresent = (commands: Command.Interface, name: string, expected: boolean) =>
    commands.get(name).pipe(
      Effect.filterOrFail(
        (command) => (command !== undefined) === expected,
        () => "activation pending",
      ),
      Effect.retry({ times: 200, schedule: Schedule.spaced("25 millis") }),
    )

  // D8 (owner, 2026-10-21: "match refrence"): a trusted folder's plugins load as they are now, so one planted after the
  // grant activates beside the one already there, with no new grant.
  untrusted.live("activates a plugin planted after the grant beside the ones already there", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const first = path.join(directory.path, ".orbit/plugins/greeter.ts")
      const late = path.join(directory.path, ".orbit/plugins/late.ts")
      yield* Effect.promise(() => Bun.write(first, greeter("greet-project")))
      const locations = yield* LocationServiceMap.Service
      const watcher = yield* Watcher.Test
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        const project = yield* ProjectTrust.Service

        yield* plugins.awaitActivation
        yield* project.grant({ persist: false, via: "test" })
        yield* commandPresent(commands, "greet-project", true)

        yield* Effect.promise(() => Bun.write(late, greeter("greet-late").replace("greeter", "late")))
        yield* watcher.emit({ path: late, type: "create" })
        yield* commandPresent(commands, "greet-late", true)
        yield* commandPresent(commands, "greet-project", true)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  // A trust grant changes what the plugins read and then answers; the change reaches the supervisor through an event it
  // reads later, so the grant asks for the activation itself (server/test/trust-grant-models.test.ts). Here nothing
  // announces the new plugin at all: only `refresh` can make it active, and it is active when `refresh` returns.
  it.live("refresh activates again and returns once that activation settled", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* Effect.promise(() =>
        Bun.write(path.join(directory.path, ".orbit/plugins/greeter.ts"), greeter("greet-first")),
      )
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-first")).toBeDefined()

        const late = path.join(directory.path, ".orbit/plugins/late.ts")
        yield* Effect.promise(() => Bun.write(late, greeter("greet-late").replace("greeter", "late")))
        yield* plugins.awaitActivation
        expect(yield* commands.get("greet-late")).toBeUndefined()
        yield* plugins.refresh()
        expect(yield* commands.get("greet-late")).toBeDefined()
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  // A caller of `refresh` (a trust grant) must get its answer even when the activation it asked for fails: it then
  // reads what is still running, as every other reader does.
  failing.live("refresh returns when the activation it asked for fails", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        yield* plugins.awaitActivation
        expect(sourced.reads).toBe(1)
        const refreshed = yield* plugins.refresh().pipe(Effect.timeoutOption("5 seconds"))
        expect(refreshed._tag).toBe("Some")
        expect(sourced.reads).toBe(2)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )

  // The grant names a package that has to be installed, and the registry never answers. The revoke that follows leaves
  // nothing to install, so the install stops and readiness no longer waits for it.
  untrusted.live("a revoke stops the package install that the grant started", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* installable(directory.path, "revoked-pkg", "greet-revoked")
      npm.install = { gate: yield* Deferred.make<void>(), adds: 0, stopped: 0, done: false }
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const project = yield* ProjectTrust.Service
        yield* plugins.awaitActivation
        expect(npm.install?.adds).toBe(0)
        yield* project.grant({ persist: false, via: "test" })
        yield* plugins.refresh()
        yield* settle(() => npm.install?.adds === 1)

        yield* project.revoke()
        yield* plugins.refresh()
        const settled = yield* plugins.awaitActivation.pipe(Effect.timeoutOption("5 seconds"))
        expect(settled._tag).toBe("Some")
        expect(npm.install?.stopped).toBe(1)
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        Effect.ensuring(
          Effect.sync(() => {
            npm.install = undefined
          }),
        ),
      )
    }),
  )

  // A stopped install can take a while to end: a real one waits for its package manager's process to exit. What is
  // available locally has applied before the activation stops it, so a caller waiting for the revoke's activation is
  // answered while the install is still ending, and only readiness waits for its end.
  untrusted.live("the activation after a revoke is applied while the install it stopped is still ending", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      yield* installable(directory.path, "ending-pkg", "greet-ending")
      const release = yield* Deferred.make<void>()
      npm.install = { gate: yield* Deferred.make<void>(), release, adds: 0, stopped: 0, done: false }
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const project = yield* ProjectTrust.Service
        yield* plugins.awaitActivation
        yield* project.grant({ persist: false, via: "test" })
        yield* plugins.refresh()
        yield* settle(() => npm.install?.adds === 1)

        yield* project.revoke()
        // The revoke's activation is stopping the install, which does not end until `release`.
        yield* settle(() => npm.install?.ending === true)
        const applied = yield* plugins.awaitApplied.pipe(Effect.timeoutOption("5 seconds"))
        expect(applied._tag).toBe("Some")
        expect(npm.install?.stopped).toBe(0)

        yield* Deferred.succeed(release, undefined)
        const settled = yield* plugins.awaitActivation.pipe(Effect.timeoutOption("5 seconds"))
        expect(settled._tag).toBe("Some")
        expect(npm.install?.stopped).toBe(1)
      }).pipe(
        Effect.ensuring(Deferred.succeed(release, undefined)),
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
        Effect.ensuring(
          Effect.sync(() => {
            npm.install = undefined
          }),
        ),
      )
    }),
  )

  untrusted.live("keeps the plugins a project ships off until its folder is trusted, with no restart", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const file = path.join(directory.path, ".orbit/plugins/greeter.ts")
      yield* Effect.promise(() => Bun.write(file, greeter("greet-project")))
      const locations = yield* LocationServiceMap.Service
      yield* Effect.gen(function* () {
        const plugins = yield* Plugin.Service
        const commands = yield* Command.Service
        const project = yield* ProjectTrust.Service
        const local = plugins
          .list()
          .pipe(Effect.map((inventory) => inventory.filter((item) => item.source.type === "local")))

        // The plugin is neither activated nor reported as a failure: it is not loaded at all.
        yield* plugins.awaitActivation
        expect(yield* project.trusted()).toBe(false)
        expect(yield* commands.get("greet-project")).toBeUndefined()
        expect(yield* local).toEqual([])

        yield* project.grant({ persist: false, via: "test" })
        yield* commandPresent(commands, "greet-project", true)
        yield* plugins.awaitActivation
        expect(yield* local).toEqual([
          expect.objectContaining({
            id: "greeter",
            source: { type: "local", path: file },
            state: { status: "active" },
          }),
        ])

        // Taking the trust away stops the plugin the same way.
        yield* project.revoke()
        yield* commandPresent(commands, "greet-project", false)
        yield* plugins.awaitActivation
        expect(yield* local).toEqual([])
      }).pipe(
        Effect.scoped,
        Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory.path) }))),
      )
    }),
  )
})
