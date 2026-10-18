import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Logger, Schema, Stream } from "effect"
import { FastCheck } from "effect/testing"
import { CompatNames } from "@orbit/compat/names"
import { Config } from "@orbit/core/config"
import { Directory, Document, Event, Info, type Entry } from "@orbit/schema/config"
import { ConfigModel } from "@orbit/schema/config/model"
import { ConfigProvider } from "@orbit/schema/config/provider"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Credential } from "@orbit/core/credential"
import { ConfigMigrateV1 } from "@orbit/core/v1/config/migrate"
import { ConfigV1 } from "@orbit/core/v1/config/config"
import { ConfigNormalize } from "@orbit/core/config/normalize"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Bus } from "@orbit/core/bus"
import { Global } from "@orbit/util/global"
import { Location } from "@orbit/core/location"
import { Project } from "@orbit/core/project"
import { Provider } from "@orbit/core/provider"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { Integration } from "@orbit/schema/integration"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { withEnv } from "../fixture/env"
import { location } from "../fixture/location"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const selection = Schema.decodeUnknownSync(ConfigModel.Selection)

function inFixture(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

// The directory names that other agent products keep config roots under, and the names a directory watch lists for
// them beside Orbit's own, in the sorted order a watch plan reports.
const compatNames = [CompatNames.vendor.directory, CompatNames.agents]
const watchedNames = (...names: string[]) => [...compatNames, ...names].toSorted()

// The compatibility roots inside the fixture, which the machine running the test may also keep roots above.
const compatRoots = (root: string) =>
  Config.Service.use((config) => config.compat()).pipe(
    Effect.map((compat) => compat.roots.filter((item) => inFixture(root, item.path))),
  )

function testLayer(
  directory: string,
  globalDirectory = path.join(directory, "global"),
  projectDirectory = directory,
  vcs?: Project.Vcs,
  watcher: Layer.Layer<Watcher.Service | Watcher.Test> = Watcher.testLayer,
  credentialNode = emptyCredentialNode,
  wellknownNode = emptyWellknownNode,
  options?: Config.Options,
  home = path.join(globalDirectory, "home"),
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(
      location(
        { directory: AbsolutePath.make(directory) },
        { projectDirectory: AbsolutePath.make(projectDirectory), vcs },
      ),
    ),
  )
  const built = AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(locationLayer),
    Global.node.replace(Global.layerWith({ config: globalDirectory, home })),
    Credential.node.replace(credentialNode),
    WellKnown.node.replace(wellknownNode),
    Watcher.node.replace(watcher),
  ])
  // Merge the watcher layer by reference so Watcher.Test resolves to the same
  // memoized instance the built graph uses.
  return Layer.mergeAll(built, watcher)
}

const provider = {
  package: "native",
  settings: {},
  headers: {},
  body: {},
  models: {},
}

describe("Config", () => {
  it.live("writes the reply language to the user's own file and removes it again with null", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const file = path.join(global, "orbit.jsonc")
        return Effect.promise(() =>
          Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(global, { recursive: true })]),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              yield* config.update!({ language: "Japanese" })
              expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8"))).language).toBe("Japanese")
              yield* config.update!({ language: null })
              expect(JSON.parse(yield* Effect.promise(() => fs.readFile(file, "utf8")))).not.toHaveProperty("language")
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
        )
      }),
    ),
  )

  it.live("excludes the home directory's compatibility roots when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(global, "home")
        const project = path.join(home, "project")
        return Effect.promise(() =>
          Promise.all([
            fs.mkdir(project, { recursive: true }),
            ...compatNames.map((name) => fs.mkdir(path.join(home, name), { recursive: true })),
          ]),
        ).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              // The fixture is real: with global enabled the walk finds both.
              expect(yield* compatRoots(tmp.path)).toHaveLength(2)
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            // Home-level directories are global config however the walk
            // reaches them, so global: false excludes them even with the
            // project walk enabled.
            Effect.gen(function* () {
              expect(yield* compatRoots(tmp.path)).toEqual([])
              const watcher = yield* Watcher.Test
              expect(
                (yield* watcher.subscriptions()).filter((watch) => watch.type === "entries" && watch.path === home),
              ).toEqual([])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("excludes global config reached through the project walk when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        // The location sits BENEATH the global config dir, so the upward walk
        // reaches the global orbit.json as a direct file.
        const global = path.join(tmp.path, "global")
        const project = path.join(global, "plugins", "demo")
        return Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "orbit.json"), JSON.stringify({ shell: "global-sentinel" }))
        }).pipe(
          Effect.andThen(
            // Fixture control: with global enabled the file loads.
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global-sentinel")
            }).pipe(Effect.provide(testLayer(project, global))),
          ),
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("discovers the global config directory once when the project walk reaches it", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        // The global config dir is the project's own .orbit (as isolated
        // hosts pin ORBIT_CONFIG_DIR), and the location is the project under
        // a symlinked spelling, so the walk reaches the same directory under a
        // different string than the global root.
        const real = path.join(tmp.path, "real")
        const link = path.join(tmp.path, "link")
        const global = AbsolutePath.make(path.join(real, ".orbit"))
        const once = Effect.gen(function* () {
          const config = yield* Config.Service
          const watcher = yield* Watcher.Test
          const entries = yield* config.entries()
          expect(entries.flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))).toEqual([global])
          expect(entries.flatMap((entry) => (entry.type === "document" ? [entry.info.shell] : []))).toEqual(["global"])
          expect(
            (yield* watcher.subscriptions())
              .filter((subscription) => subscription.type === "directory")
              .map((subscription) => subscription.path),
          ).toEqual([global])
          expect(
            (yield* watcher.subscriptions()).filter((subscription) =>
              subscription.path.includes(`${path.sep}.orbit${path.sep}`),
            ),
          ).toEqual([])
        })
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.writeFile(path.join(global, "orbit.json"), JSON.stringify({ shell: "global" }))
          await fs.symlink(real, link, process.platform === "win32" ? "junction" : undefined)
        }).pipe(
          Effect.andThen(once.pipe(Effect.provide(testLayer(link, global, real)))),
          // Same spelling on both sides: still exactly once.
          Effect.andThen(once.pipe(Effect.provide(testLayer(real, global, real)))),
        )
      }),
    ),
  )

  it.live("loads explicit file and content overrides above project files in priority order", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const explicit = path.join(tmp.path, "custom.json")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "orbit.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(explicit, JSON.stringify({ shell: "explicit" }))
          await fs.writeFile(path.join(project, "orbit.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const entries = yield* config.entries()
              expect(
                entries.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
              ).toEqual(["global", "project", "explicit", "content"])
              expect(Config.latest(entries, "shell")).toBe("content")
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  file: explicit,
                  content: JSON.stringify({ shell: "content" }),
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("skips project configuration when project discovery is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        return Effect.promise(async () => {
          await fs.mkdir(global, { recursive: true })
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(path.join(global, "orbit.json"), JSON.stringify({ shell: "global" }))
          await fs.writeFile(path.join(project, "orbit.json"), JSON.stringify({ shell: "project" }))
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              expect(Config.latest(yield* config.entries(), "shell")).toBe("global")
              const watcher = yield* Watcher.Test
              expect((yield* watcher.subscriptions()).map((subscription) => subscription.path)).toEqual([global])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, emptyCredentialNode, emptyWellknownNode, {
                  project: false,
                }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("reloads file substitutions when their source changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(global, "orbit.json")
          const source = path.join(global, "shell.txt")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(source, "first")
            await fs.writeFile(file, JSON.stringify({ shell: "{file:shell.txt}" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const watcher = yield* Watcher.Test
            const changed = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.sleep("10 millis")

            yield* Effect.promise(() => fs.writeFile(source, "second"))
            yield* watcher.emit({ type: "update", path: source })

            expect(yield* Fiber.join(changed)).toHaveLength(1)
            expect(Config.latest(yield* config.entries(), "shell")).toBe("second")
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  it.live("excludes missing files under symlinked global roots when global is disabled", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const link = path.join(tmp.path, "link")
        const project = path.join(link, "plugins", "demo")
        return Effect.promise(async () => {
          await fs.mkdir(path.join(global, "plugins", "demo"), { recursive: true })
          await fs.symlink(global, link, process.platform === "win32" ? "junction" : undefined)
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const watcher = yield* Watcher.Test
              const subscriptions = yield* watcher.subscriptions()
              expect(subscriptions.length).toBeGreaterThan(0)
              expect(
                subscriptions.filter((item) => inFixture(global, item.path) || inFixture(link, item.path)),
              ).toEqual([])
            }).pipe(
              Effect.provide(
                testLayer(project, global, project, undefined, undefined, undefined, undefined, { global: false }),
              ),
            ),
          ),
        )
      }),
    ),
  )

  it.live("exposes filesystem updates under config roots through changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(global, "commands"), { recursive: true })
            await fs.mkdir(project, { recursive: true })
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            const received = yield* config
              .changes()
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.sleep("10 millis")

            const file = path.join(global, "commands", "review.md")
            yield* watcher.emit({ type: "update", path: file })

            const collected = yield* Fiber.join(received).pipe(Effect.timeout("1 second"))
            expect(Array.from(collected)).toEqual([{ type: "update", path: file }])
          }).pipe(Effect.provide(testLayer(project, global, project, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  // Real watcher on purpose: the regression this pins (a deleted config file's
  // watch being torn down, making recreation invisible) only reproduces with
  // path-faithful event delivery.
  it.live("keeps watching a deleted config file so recreating it reloads", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const file = path.join(project, "orbit.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(file, JSON.stringify({ shell: "one" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            expect(Config.latest(yield* config.entries(), "shell")).toBe("one")
            yield* Effect.sleep("10 millis")

            const removed = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.rm(file))
            yield* Fiber.join(removed).pipe(Effect.timeout("5 seconds"))
            expect(Config.latest(yield* config.entries(), "shell")).toBeUndefined()

            const recreated = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
            yield* Effect.promise(() => fs.writeFile(file, JSON.stringify({ shell: "two" })))
            yield* Fiber.join(recreated).pipe(Effect.timeout("5 seconds"))
            expect(Config.latest(yield* config.entries(), "shell")).toBe("two")
          }).pipe(
            Effect.provide(
              AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
                Location.node.replace(
                  Layer.succeed(
                    Location.Service,
                    Location.Service.of(location({ directory: AbsolutePath.make(project) })),
                  ),
                ),
                Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
                Credential.node.replace(emptyCredentialNode),
                WellKnown.node.replace(emptyWellknownNode),
              ]),
            ),
          )
        }),
      ),
    ),
  )

  it.effect("backs Config.Service and Config.Test with one shared test implementation", () =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      const test = yield* Config.Test
      expect(yield* config.entries()).toEqual([])

      const entry = new Document({ type: "document", info: new Info({}) })
      yield* test.setEntries([entry])
      expect(yield* config.entries()).toEqual([entry])

      const received = yield* config
        .changes()
        .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped({ startImmediately: true }))
      yield* Effect.yieldNow
      yield* test.emitChange({ type: "create", path: "/root/commands/review.md" })
      expect(Array.from(yield* Fiber.join(received))).toEqual([{ type: "create", path: "/root/commands/review.md" }])
    }).pipe(Effect.provide(Config.testLayer())),
  )

  test("returns the latest defined scalar from priority-ordered documents", () => {
    const entries = [
      new Document({
        type: "document",
        info: new Info({ model: selection("openrouter/openai/gpt-5") }),
      }),
      new Directory({ type: "directory", path: AbsolutePath.make("/skills") }),
      new Document({ type: "document", info: new Info({}) }),
      new Document({
        type: "document",
        info: new Info({ model: selection("openrouter/openai/gpt-5.5") }),
      }),
    ]

    expect(Config.latest(entries, "model")).toEqual(selection("openrouter/openai/gpt-5.5"))
    expect(Config.latest(entries, "default_agent")).toBeUndefined()
  })

  it.live("tolerates unavailable authenticated wellknown config and reloads it later", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, "orbit.json"), JSON.stringify({ shell: "global" }))
            await fs.writeFile(path.join(project, "orbit.json"), JSON.stringify({ shell: "project" }))
          })

          const integrationID = Integration.ID.make("https://example.com")
          let available = false
          let key = "secret"
          const credentialNode = makeGlobalNode({
            service: Credential.Service,
            layer: Layer.succeed(
              Credential.Service,
              Credential.Service.of({
                all: () => Effect.die("unused Credential.all"),
                list: () =>
                  Effect.succeed([
                    new Credential.Info({
                      id: Credential.ID.create(),
                      integrationID,
                      label: "default",
                      value: Credential.Key.make({ type: "key", key }),
                    }),
                  ]),
                get: () => Effect.die("unused Credential.get"),
                create: () => Effect.die("unused Credential.create"),
                activate: () => Effect.die("unused Credential.activate"),
                update: () => Effect.die("unused Credential.update"),
                remove: () => Effect.die("unused Credential.remove"),
              }),
            ),
            deps: [],
          })
          const entry: WellKnown.Entry = {
            origin: "https://example.com",
            integrationID,
            manifest: { auth: { command: ["login"], env: "TOKEN" } },
          }
          const wellknownNode = makeGlobalNode({
            service: WellKnown.Service,
            layer: Layer.succeed(
              WellKnown.Service,
              WellKnown.Service.of({
                entries: () => Effect.succeed([entry]),
                snapshot: () => [entry],
                refresh: () => Effect.succeed(false),
                add: () => Effect.die("unused Wellknown.add"),
                remove: () => Effect.die("unused Wellknown.remove"),
                resolve: (_entry, variables) =>
                  available
                    ? Effect.succeed([{ shell: variables.TOKEN }])
                    : Effect.fail(new Error("expired credential")),
              }),
            ),
            deps: [],
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const initial = yield* config.entries()
            expect(Config.latest(initial, "shell")).toBe("project")
            expect(
              initial.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
            ).toEqual(["global", "project"])
            const updated = yield* bus
              .subscribe(Event.Updated)
              .pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
            yield* Effect.yieldNow
            available = true
            key = "next"
            yield* bus.publish(
              Credential.Event.Switched,
              { credentialID: Credential.ID.create(), integrationID },
              { global: true },
            )
            expect(yield* Fiber.join(updated)).toHaveLength(1)
            const refreshed = yield* config.entries()
            expect(Config.latest(refreshed, "shell")).toBe("project")
            expect(
              refreshed.flatMap((entry) => (entry.type === "document" && entry.info.shell ? [entry.info.shell] : [])),
            ).toEqual(["next", "global", "project"])
          }).pipe(
            Effect.provide(testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode)),
          )
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ),
  )

  it.live("logs redacted source-aware diagnostics for every config source", () => {
    const output: Array<Record<string, unknown>> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "configuration normalization diagnostic") return
      const details = entry.message[1]
      if (typeof details === "object" && details !== null) output.push(details as Record<string, unknown>)
    })
    return Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const malformed = path.join(tmp.path, "malformed.json")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(path.join(global, "orbit.json"), "null")
            await fs.writeFile(path.join(project, "orbit.json"), "")
            await fs.writeFile(malformed, '{ "credential": "file-secret"')
          })
          const integrationID = Integration.ID.make("https://invalid.example.com")
          const entry: WellKnown.Entry = {
            origin: "https://invalid.example.com",
            integrationID,
            manifest: { auth: { command: ["login"], env: "TOKEN" } },
          }
          const credentialNode = makeGlobalNode({
            service: Credential.Service,
            layer: Layer.succeed(
              Credential.Service,
              Credential.Service.of({
                all: () => Effect.die("unused Credential.all"),
                list: () =>
                  Effect.succeed([
                    new Credential.Info({
                      id: Credential.ID.create(),
                      integrationID,
                      label: "default",
                      value: Credential.Key.make({ type: "key", key: "wellknown-secret" }),
                    }),
                  ]),
                get: () => Effect.die("unused Credential.get"),
                create: () => Effect.die("unused Credential.create"),
                activate: () => Effect.die("unused Credential.activate"),
                update: () => Effect.die("unused Credential.update"),
                remove: () => Effect.die("unused Credential.remove"),
              }),
            ),
            deps: [],
          })
          const wellknownNode = makeGlobalNode({
            service: WellKnown.Service,
            layer: Layer.succeed(
              WellKnown.Service,
              WellKnown.Service.of({
                entries: () => Effect.succeed([entry]),
                snapshot: () => [entry],
                refresh: () => Effect.succeed(false),
                add: () => Effect.die("unused Wellknown.add"),
                remove: () => Effect.die("unused Wellknown.remove"),
                // Exercise the loader boundary against a malformed implementation response.
                resolve: () => Effect.succeed([null as unknown as WellKnown.Config]),
              }),
            ),
            deps: [],
          })

          yield* Config.Service.use((config) => config.entries()).pipe(
            Effect.provide(
              testLayer(project, global, project, undefined, undefined, credentialNode, wellknownNode, {
                file: malformed,
                content: "",
              }),
            ),
          )

          expect(output.map((item) => `${item.source}:${item.path}:${item.kind}`).toSorted()).toEqual(
            [
              `${path.join(global, "orbit.json")}:$:invalid`,
              `${path.join(project, "orbit.json")}:$:invalid`,
              `${malformed}:$:invalid`,
              "https://invalid.example.com:$:invalid",
              "ORBIT_CONFIG_CONTENT:$:invalid",
            ].toSorted(),
          )
          expect(JSON.stringify(output)).not.toContain("secret")
        }),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("keeps the valid hooks of a document and logs each skipped one at its exact path", () => {
    const output: Array<Record<string, unknown>> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "configuration normalization diagnostic") return
      const details = entry.message[1]
      if (typeof details === "object" && details !== null) output.push(details as Record<string, unknown>)
    })
    return Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        const project = path.join(tmp.path, "project")
        return Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.writeFile(
            path.join(project, "orbit.json"),
            JSON.stringify({
              hooks: {
                PreToolUse: [
                  {
                    matcher: "shell",
                    hooks: [
                      { type: "command", command: "./guard.sh" },
                      { type: "http", url: 42 },
                    ],
                  },
                ],
                SessionStart: [{ hooks: [{ type: "prompt", prompt: "Is this safe?" }] }],
                OnEveryThing: [],
              },
            }),
          )
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const config = yield* Config.Service
              const hooks = Config.latest(yield* config.entries(), "hooks")
              expect(hooks?.PreToolUse).toEqual([
                { matcher: "shell", hooks: [{ type: "command", command: "./guard.sh" }] },
              ])
              expect(hooks?.SessionStart).toEqual([{ hooks: [] }])
              expect(output.map((item) => `${item.kind}:${item.path}`)).toEqual([
                "invalid:$.hooks.PreToolUse.0.hooks.1",
                "unsupported:$.hooks.SessionStart.0.hooks.0",
                "unsupported:$.hooks.OnEveryThing",
              ])
            }).pipe(Effect.provide(testLayer(project))),
          ),
        )
      },
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(Effect.provide(Logger.layer([logger])))
  })

  test("migrates arbitrary v1 configuration into valid v2 configuration", () => {
    FastCheck.assert(
      FastCheck.property(Schema.toArbitrary(ConfigV1.Info)(FastCheck), (info) => {
        const parsed = Schema.decodeUnknownSync(ConfigV1.Info)(
          Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(
            Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(info),
          ),
        )
        Schema.decodeUnknownSync(Info)(ConfigMigrateV1.migrate(parsed), { errors: "all" })
      }),
      { numRuns: 100 },
    )
  }, 30_000)

  test("migrates the v1 experimental subagent depth", () => {
    expect(ConfigMigrateV1.migrate({ experimental: { subagent_depth: 2 } }).experimental?.subagent_depth).toBe(2)
  })

  test("migrates the v1 small model to the title agent", () => {
    expect(
      ConfigMigrateV1.migrate({
        small_model: "anthropic/claude-haiku-4-5",
        agent: { title: { prompt: "Custom title prompt" } },
      }).agents?.title,
    ).toEqual({
      model: { providerID: "anthropic", model: "claude-haiku-4-5" },
      system: "Custom title prompt",
    })
  })

  test("migrates the v1 update policy", () => {
    expect(ConfigMigrateV1.migrate({ autoupdate: false }).update).toBe("disable")
    expect(ConfigMigrateV1.migrate({ autoupdate: "notify" }).update).toBe("notify")
    expect(ConfigMigrateV1.migrate({ autoupdate: true }).update).toBe("auto")
    expect(ConfigMigrateV1.migrate({}).update).toBeUndefined()
  })

  test("normalizes the native auto update policy", () => {
    expect(ConfigNormalize.normalize({ update: "auto" })).toEqual({
      type: "normalized",
      encoded: { update: "auto" },
      diagnostics: [],
    })
  })

  test("migrates v1 provider lists to policies", () => {
    expect(
      ConfigMigrateV1.migrate({
        enabled_providers: ["anthropic", "openai"],
        disabled_providers: ["openai"],
      }).experimental?.policies,
    ).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "anthropic", effect: "allow" },
      { action: "provider.use", resource: "openai", effect: "allow" },
      { action: "provider.use", resource: "openai", effect: "deny" },
    ])
    expect(ConfigMigrateV1.migrate({ enabled_providers: [] }).experimental?.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
    ])
  })

  test("migrates v1 provider setup options into AISDK settings", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        bedrock: {
          npm: "@ai-sdk/amazon-bedrock",
          models: { claude: { provider: { npm: "@ai-sdk/anthropic" } } },
          options: {
            headers: { "x-test": "1" },
            body: { trace: true },
            region: "us-east-1",
            profile: "dev",
          },
        },
      },
    })

    expect(migrated.providers?.bedrock).toMatchObject({
      package: Provider.aisdk("@ai-sdk/amazon-bedrock"),
      models: { claude: { package: Provider.aisdk("@ai-sdk/anthropic") } },
      settings: { region: "us-east-1", profile: "dev" },
      headers: { "x-test": "1" },
      body: { trace: true },
    })
  })

  test("renames old provider IDs while migrating v1 configuration", () => {
    const migrated = ConfigMigrateV1.migrate({
      model: "azure-cognitive-services/deployment",
      enabled_providers: ["google-vertex-anthropic"],
      disabled_providers: ["azure-cognitive-services"],
      agent: {
        reviewer: { model: "google-vertex-anthropic/claude-sonnet" },
      },
      command: {
        review: { template: "Review", model: "azure-cognitive-services/deployment" },
      },
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/azure",
          env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
          models: { deployment: {} },
        },
        "google-vertex-anthropic": {
          npm: "@ai-sdk/google-vertex/anthropic",
          options: { project: "test-project", location: "us-central1" },
          models: { "claude-sonnet": {} },
        },
      },
    })

    expect(migrated.model).toEqual({ providerID: "azure", model: "deployment" })
    expect(migrated.agents?.reviewer?.model).toEqual({ providerID: "google-vertex", model: "claude-sonnet" })
    expect(migrated.commands?.review?.model).toEqual({ providerID: "azure", model: "deployment" })
    expect(migrated.experimental?.policies).toEqual([
      { action: "provider.use", resource: "*", effect: "deny" },
      { action: "provider.use", resource: "google-vertex", effect: "allow" },
      { action: "provider.use", resource: "azure", effect: "deny" },
    ])
    expect(migrated.providers?.azure).toMatchObject({
      env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
      package: Provider.aisdk("@ai-sdk/azure"),
      models: { deployment: {} },
    })
    expect(migrated.providers?.["azure-cognitive-services"]).toBeUndefined()
    expect(migrated.providers?.["google-vertex"]).toMatchObject({
      settings: { project: "test-project", location: "us-central1" },
      models: {
        "claude-sonnet": { package: Provider.aisdk("@ai-sdk/google-vertex/anthropic") },
      },
    })
    expect(migrated.providers?.["google-vertex"]).not.toHaveProperty("package")
    expect(migrated.providers?.["google-vertex-anthropic"]).toBeUndefined()
  })

  test("preserves the generated base URL for v1 Azure OpenAI-compatible providers", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        "azure-cognitive-services": {
          npm: "@ai-sdk/openai-compatible",
          env: ["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME", "AZURE_COGNITIVE_SERVICES_API_KEY"],
        },
      },
    })

    expect(migrated.providers?.azure).toMatchObject({
      env: ["AZURE_COGNITIVE_SERVICES_API_KEY"],
      package: Provider.aisdk("@ai-sdk/openai-compatible"),
      settings: {
        baseURL: "https://${AZURE_COGNITIVE_SERVICES_RESOURCE_NAME}.cognitiveservices.azure.com/openai",
      },
    })
  })

  test("ignores old provider IDs when the current provider ID is configured", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        azure: { models: { current: {} } },
        "azure-cognitive-services": { models: { legacy: {} } },
        "google-vertex": { models: { gemini: {} } },
        "google-vertex-anthropic": { models: { claude: {} } },
      },
    })

    expect(migrated.providers?.azure?.models).toEqual({ current: expect.anything() })
    expect(migrated.providers?.["google-vertex"]?.models).toEqual({ gemini: expect.anything() })
  })

  test("preserves the built-in package for v1 Vertex Anthropic custom models", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        "google-vertex-anthropic": {
          models: { claude: {} },
        },
      },
    })

    expect(migrated.providers?.["google-vertex"]?.package).toBeUndefined()
    expect(migrated.providers?.["google-vertex"]?.models?.claude?.package).toBe(
      Provider.aisdk("@ai-sdk/google-vertex/anthropic"),
    )
  })

  test("migrates v1 interleaved fields to compatibility", () => {
    const migrated = ConfigMigrateV1.migrate({
      provider: {
        custom: {
          models: {
            object: { interleaved: { field: "vendor_reasoning" } },
            string: { interleaved: "reasoning_text" },
            boolean: { interleaved: true },
          },
        },
      },
    })

    expect(migrated.providers?.custom?.models?.object?.compatibility).toEqual({
      reasoningField: "vendor_reasoning",
    })
    expect(migrated.providers?.custom?.models?.string?.compatibility).toEqual({ reasoningField: "reasoning_text" })
    expect(migrated.providers?.custom?.models?.boolean?.compatibility).toBeUndefined()
  })

  for (const subtask of [true, false]) {
    test(`migrates v1 command configuration with subtask: ${subtask}`, () => {
      expect(
        ConfigMigrateV1.migrate({
          command: {
            review: {
              template: "Review changes",
              description: "Review code",
              agent: "reviewer",
              model: "anthropic/claude",
              variant: "high",
              subtask,
            },
          },
        }).commands,
      ).toEqual({
        review: {
          template: "Review changes",
          description: "Review code",
          agent: "reviewer",
          model: { providerID: "anthropic", model: "claude", variant: "high" },
          subagent: subtask,
        },
      })
    })
  }

  test("normalizes renamed permission actions when migrating v1 permissions", () => {
    expect(
      ConfigMigrateV1.migrate({
        permission: {
          task: "ask",
          bash: { "git status": "allow", "*": "deny" },
          write: "deny",
          read: "allow",
        },
      }).permissions,
    ).toEqual([
      { action: "subagent", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "read", resource: "*", effect: "allow" },
    ])
  })

  it.live("returns an empty configuration when directory files do not exist", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const config = yield* Config.Service
          const entries = (yield* config.entries()).filter((entry) => !entry.path || inFixture(tmp.path, entry.path))

          expect(entries).toEqual([
            new Directory({ type: "directory", path: AbsolutePath.make(path.join(tmp.path, "global")), scope: "user" }),
          ])
        }).pipe(Effect.provide(testLayer(tmp.path))),
      ),
    ),
  )

  it.live("does not recursively watch ecosystem config roots", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(tmp.path, CompatNames.vendor.directory, "skills"), { recursive: true }),
              fs.mkdir(path.join(tmp.path, CompatNames.agents), { recursive: true }),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            yield* config.entries()

            expect((yield* watcher.subscriptions()).filter((item) => inFixture(tmp.path, item.path))).toEqual([
              {
                type: "directory",
                path: AbsolutePath.make(path.join(tmp.path, "global")),
                ignore: ["**/{node_modules,.git}/**", ".git", "node_modules"],
              },
              {
                type: "entries",
                path: tmp.path,
                names: watchedNames(
                  CompatNames.mcp,
                  ".orbit",
                  "orbit.json",
                  "orbit.jsonc",
                  "orbit.local.json",
                  "orbit.local.jsonc",
                ),
              },
              // The vendor root exists, so its settings files are watched for their own edits, and the .agents root,
              // which has none, is only watched through its parent.
              {
                type: "entries",
                path: path.join(tmp.path, CompatNames.vendor.directory),
                names: [CompatNames.vendor.settings.shared, CompatNames.vendor.settings.local].toSorted(),
              },
            ])
          }).pipe(Effect.provide(testLayer(tmp.path, undefined, undefined, undefined, Watcher.testLayer)))
        }),
      ),
    ),
  )

  it.live("loads orbit JSON and JSONC files from lowest to highest priority", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(
                path.join(tmp.path, "orbit.json"),
                JSON.stringify({ $schema: "base", providers: { base: provider } }),
              ),
              fs.writeFile(
                path.join(tmp.path, "orbit.jsonc"),
                `{
                  // Later global files override scalar fields while retaining providers.
                  "$schema": "last",
                  "providers": { "last": ${JSON.stringify(provider)} },
                }`,
              ),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(2)
            expect(documents.map((document) => document.type)).toEqual(["document", "document"])
            expect(documents.map((document) => document.info.$schema)).toEqual(["base", "last"])
            expect(documents[0]).toBeInstanceOf(Document)
            expect(documents[0]?.path).toBe(AbsolutePath.make(path.join(tmp.path, "orbit.json")))
            expect(documents[1]?.info.providers?.last).toBeInstanceOf(ConfigProvider.Info)

            yield* Effect.promise(() =>
              fs.writeFile(path.join(tmp.path, "orbit.jsonc"), JSON.stringify({ $schema: "changed" })),
            )
            expect(
              (yield* config.entries())
                .filter((entry) => entry.type === "document")
                .map((document) => document.info.$schema),
            ).toEqual(["base", "last"])
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("substitutes environment variables and relative file contents", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          token: process.env.ORBIT_TEST_MCP_TOKEN,
          missing: process.env.ORBIT_TEST_MISSING,
        }
        process.env.ORBIT_TEST_MCP_TOKEN = "secret"
        delete process.env.ORBIT_TEST_MISSING
        return previous
      }),
      () =>
        Effect.acquireUseRelease(
          Effect.promise(() => tmpdir()),
          (tmp) =>
            Effect.gen(function* () {
              yield* Effect.promise(() =>
                Promise.all([
                  fs.writeFile(path.join(tmp.path, "token.txt"), 'file\n"token"\n'),
                  fs.writeFile(
                    path.join(tmp.path, "orbit.jsonc"),
                    `{
                      // Ignored reference: {file:missing.txt}
                      "username": "user-{env:ORBIT_TEST_MISSING}",
                      "mcp": {
                        "servers": {
                          "remote": {
                            "type": "remote",
                            "url": "https://example.com/mcp",
                            "headers": {
                              "Authorization": "Bearer {env:ORBIT_TEST_MCP_TOKEN}",
                              "X-Token": "{file:token.txt}"
                            }
                          }
                        }
                      }
                    }`,
                  ),
                ]),
              )

              return yield* Effect.gen(function* () {
                const config = yield* Config.Service
                const document = (yield* config.entries()).find((entry) => entry.type === "document")
                expect(document?.info.username).toBe("user-")
                const remote = document?.info.mcp?.servers?.remote
                expect(remote?.type).toBe("remote")
                if (remote?.type !== "remote") return
                expect(remote.headers).toEqual({
                  Authorization: "Bearer secret",
                  "X-Token": 'file\n"token"',
                })
              }).pipe(Effect.provide(testLayer(tmp.path)))
            }),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ),
      (previous) =>
        Effect.sync(() => {
          if (previous.token === undefined) delete process.env.ORBIT_TEST_MCP_TOKEN
          else process.env.ORBIT_TEST_MCP_TOKEN = previous.token
          if (previous.missing === undefined) delete process.env.ORBIT_TEST_MISSING
          else process.env.ORBIT_TEST_MISSING = previous.missing
        }),
    ),
  )

  it.live("does not load legacy config.json files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(path.join(tmp.path, "config.json"), JSON.stringify({ $schema: "legacy" })),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(0)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("accepts $schema metadata without writing it into config files", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "orbit.json")
          const contents = JSON.stringify({
            shell: "/bin/zsh",
            providers: { local: provider },
          })
          yield* Effect.promise(() => fs.writeFile(file, contents))

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents[0]?.info.$schema).toBeUndefined()
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(yield* Effect.promise(() => fs.readFile(file, "utf8"))).toBe(contents)
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads supported scalar and resource configuration", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "orbit.json"),
              JSON.stringify({
                shell: "/bin/bash",
                model: "anthropic/claude",
                default_agent: "reviewer",
                update: "notify",
                share: "disabled",
                enterprise: { url: "https://share.example.com" },
                username: "test-user",
                permissions: [
                  { action: "bash", resource: "*", effect: "ask" },
                  { action: "bash", resource: "git status", effect: "allow" },
                ],
                agents: {
                  reviewer: {
                    model: "openrouter/openai/gpt-5#high",
                    request: {
                      headers: { "x-agent": "reviewer" },
                      body: { reasoningEffort: "high" },
                    },
                    description: "Review changes for correctness",
                    system: "Find regressions.",
                    mode: "subagent",
                    hidden: false,
                    color: "#ff6b6b",
                    steps: 12,
                    disabled: false,
                    permissions: [{ action: "edit", resource: "*", effect: "deny" }],
                  },
                },
                snapshots: false,
                watcher: { ignore: ["node_modules/**", "dist/**", ".git"] },
                formatter: {
                  prettier: { disabled: true },
                  custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
                },
                lsp: { typescript: { disabled: true }, custom: { command: ["custom-lsp"], extensions: [".foo"] } },
                media: {
                  image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
                },
                tool_output: { max_lines: 1000, max_bytes: 32768 },
                tool_execution: { max_concurrency: 4 },
                mcp: {
                  timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
                  servers: {
                    local: {
                      type: "local",
                      command: ["node", "./mcp/server.js"],
                      environment: { API_KEY: "secret" },
                      disabled: false,
                      codemode: false,
                      timeout: { catalog: 10000 },
                      protocol: "legacy",
                    },
                    remote: {
                      type: "remote",
                      url: "https://mcp.example.com/mcp",
                      headers: { Authorization: "Bearer token" },
                      oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                      disabled: true,
                      codemode: false,
                      timeout: { startup: 15000 },
                      protocol: "2026-07-28",
                    },
                  },
                },
                compaction: {
                  auto: true,
                  prune: false,
                  keep: { tokens: 2000 },
                  buffer: 10000,
                },
                skills: ["./skills", "~/shared-skills", "https://example.com/.well-known/skills/"],
                instructions: ["CONTRIBUTING.md", "docs/rules/*.md", "https://example.com/shared-rules.md"],
                references: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.shell).toBe("/bin/bash")
            expect(documents[0]?.info.model).toEqual(selection("anthropic/claude"))
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.update).toBe("notify")
            expect(documents[0]?.info.share).toBe("disabled")
            expect(documents[0]?.info.enterprise).toEqual({ url: "https://share.example.com" })
            expect(documents[0]?.info.username).toBe("test-user")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "bash", resource: "*", effect: "ask" },
              { action: "bash", resource: "git status", effect: "allow" },
            ])
            const reviewer = documents[0]?.info.agents?.reviewer
            expect(reviewer?.model).toEqual(selection("openrouter/openai/gpt-5#high"))
            expect(reviewer?.request).toEqual({
              headers: { "x-agent": "reviewer" },
              body: { reasoningEffort: "high" },
            })
            expect(reviewer?.description).toBe("Review changes for correctness")
            expect(reviewer?.system).toBe("Find regressions.")
            expect(reviewer?.mode).toBe("subagent")
            expect(reviewer?.hidden).toBe(false)
            expect(reviewer?.color).toBe("#ff6b6b")
            expect(reviewer?.steps).toBe(12)
            expect(reviewer?.disabled).toBe(false)
            expect(reviewer?.permissions).toEqual([{ action: "edit", resource: "*", effect: "deny" }])
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.watcher).toEqual({ ignore: ["node_modules/**", "dist/**", ".git"] })
            expect(documents[0]?.info.formatter).toEqual({
              prettier: { disabled: true },
              custom: { command: ["custom-fmt", "$FILE"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.lsp).toEqual({
              typescript: { disabled: true },
              custom: { command: ["custom-lsp"], extensions: [".foo"] },
            })
            expect(documents[0]?.info.media).toEqual({
              image: { auto_resize: false, max_width: 1200, max_height: 900, max_base64_bytes: 1048576 },
            })
            expect(documents[0]?.info.tool_output).toEqual({ max_lines: 1000, max_bytes: 32768 })
            expect(documents[0]?.info.tool_execution).toEqual({ max_concurrency: 4 })
            expect(documents[0]?.info.mcp).toEqual({
              timeout: { startup: 5000, catalog: 60000, execution: 43200000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "./mcp/server.js"],
                  environment: { API_KEY: "secret" },
                  disabled: false,
                  codemode: false,
                  timeout: { catalog: 10000 },
                  protocol: "legacy",
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com/mcp",
                  headers: { Authorization: "Bearer token" },
                  oauth: { client_id: "client", scope: "read write", callback_port: 19876 },
                  disabled: true,
                  codemode: false,
                  timeout: { startup: 15000 },
                  protocol: "2026-07-28",
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.skills).toEqual([
              "./skills",
              "~/shared-skills",
              "https://example.com/.well-known/skills/",
            ])
            expect(documents[0]?.info.instructions).toEqual([
              "CONTRIBUTING.md",
              "docs/rules/*.md",
              "https://example.com/shared-rules.md",
            ])
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates the deprecated reference key into references", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "orbit.json"),
              JSON.stringify({
                reference: {
                  local: { path: "../library" },
                  sdk: { repository: "github.com/example/sdk", branch: "main" },
                  shorthand: "github.com/example/docs",
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info.references).toEqual({
              local: { path: "../library" },
              sdk: { repository: "github.com/example/sdk", branch: "main" },
              shorthand: "github.com/example/docs",
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("migrates v1 configuration when a v1-only key is present", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            fs.writeFile(
              path.join(tmp.path, "orbit.json"),
              JSON.stringify({
                shell: "/bin/zsh",
                default_agent: "reviewer",
                autoupdate: false,
                snapshot: false,
                autoshare: true,
                permission: {
                  bash: "ask",
                  edit: { "*.md": "allow", "*": "deny" },
                  question: "deny",
                  webfetch: { "*": "ask", "https://en.wikipedia.org/*": "allow" },
                },
                agent: {
                  reviewer: {
                    prompt: "Review changes.",
                    disable: true,
                    temperature: 0.2,
                    permission: { read: "allow" },
                  },
                },
                skills: { paths: ["./skills"], urls: ["https://example.com/.well-known/skills/"] },
                references: {
                  docs: { path: "../docs", description: "Use for product documentation", hidden: true },
                },
                attachment: { image: { auto_resize: false, max_width: 1200 } },
                provider: {
                  custom: {
                    options: { apiKey: "secret" },
                    models: {
                      model: {
                        options: { reasoningEffort: "high" },
                        variants: { fast: { temperature: 0.2 } },
                      },
                    },
                  },
                  openai: {
                    npm: "@ai-sdk/openai",
                    options: { apiKey: "secret", organization: "org" },
                    models: {
                      model: {
                        options: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                        variants: { high: { reasoningEffort: "high", reasoningSummary: "auto" } },
                      },
                    },
                  },
                  anthropic: {
                    npm: "@ai-sdk/anthropic",
                    models: {
                      model: {
                        options: {
                          effort: "high",
                          taskBudget: 4096,
                          metadata: { userId: "user-1" },
                        },
                      },
                    },
                  },
                },
                compaction: { auto: true, tail_turns: 3, preserve_recent_tokens: 2000, reserved: 10000 },
                experimental: { mcp_timeout: 5000 },
                mcp: {
                  local: { type: "local", command: ["node", "server.js"], enabled: false, timeout: 10000 },
                  remote: {
                    type: "remote",
                    url: "https://mcp.example.com",
                    oauth: { clientId: "client", callbackPort: 19876 },
                    timeout: 20000,
                  },
                },
              }),
            ),
          )

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents).toHaveLength(1)
            expect(documents[0]?.info).toBeInstanceOf(Info)
            expect(documents[0]?.info.shell).toBe("/bin/zsh")
            expect(documents[0]?.info.default_agent).toBe("reviewer")
            expect(documents[0]?.info.update).toBe("disable")
            expect(documents[0]?.info.snapshots).toBe(false)
            expect(documents[0]?.info.share).toBe("auto")
            expect(documents[0]?.info.permissions).toEqual([
              { action: "shell", resource: "*", effect: "ask" },
              { action: "edit", resource: "*.md", effect: "allow" },
              { action: "edit", resource: "*", effect: "deny" },
              { action: "question", resource: "*", effect: "deny" },
              { action: "webfetch", resource: "*", effect: "ask" },
              { action: "webfetch", resource: "https://en.wikipedia.org/*", effect: "allow" },
            ])
            expect(documents[0]?.info.agents?.reviewer).toMatchObject({
              system: "Review changes.",
              disabled: true,
              request: { body: { temperature: 0.2 } },
              permissions: [{ action: "read", resource: "*", effect: "allow" }],
            })
            expect(documents[0]?.info.skills).toEqual(["./skills", "https://example.com/.well-known/skills/"])
            expect(documents[0]?.info.references).toEqual({
              docs: { path: "../docs", description: "Use for product documentation", hidden: true },
            })
            expect(documents[0]?.info.media).toEqual({ image: { auto_resize: false, max_width: 1200 } })
            expect(documents[0]?.info.providers?.custom).toMatchObject({
              settings: { apiKey: "secret" },
              models: {
                model: {
                  settings: { reasoningEffort: "high" },
                  variants: [{ id: "fast", settings: { temperature: 0.2 } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.openai).toMatchObject({
              package: Provider.aisdk("@ai-sdk/openai"),
              settings: { apiKey: "secret", organization: "org" },
              models: {
                model: {
                  settings: { temperature: 0.3, reasoningEffort: "high", serviceTier: "priority" },
                  variants: [{ id: "high", settings: { reasoningEffort: "high", reasoningSummary: "auto" } }],
                },
              },
            })
            expect(documents[0]?.info.providers?.anthropic).toMatchObject({
              package: Provider.aisdk("@ai-sdk/anthropic"),
              models: {
                model: {
                  settings: {
                    effort: "high",
                    taskBudget: 4096,
                    metadata: { userId: "user-1" },
                  },
                },
              },
            })
            expect(documents[0]?.info.compaction).toEqual({
              auto: true,
              keep: { tokens: 2000 },
              buffer: 10000,
            })
            expect(documents[0]?.info.mcp).toMatchObject({
              timeout: { catalog: 5000, execution: 5000 },
              servers: {
                local: {
                  type: "local",
                  command: ["node", "server.js"],
                  disabled: true,
                  timeout: { catalog: 10000, execution: 10000 },
                },
                remote: {
                  type: "remote",
                  url: "https://mcp.example.com",
                  oauth: { client_id: "client", callback_port: 19876 },
                  timeout: { catalog: 20000, execution: 20000 },
                },
              },
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("ignores an invalid file while loading valid config values", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(tmp.path, "orbit.json"), JSON.stringify({ $schema: "base" })),
              fs.writeFile(path.join(tmp.path, "orbit.jsonc"), "{ invalid"),
            ]),
          )
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            const documents = (yield* config.entries()).filter((entry) => entry.type === "document")

            expect(documents.map((document) => document.info.$schema)).toEqual(["base"])
            expect(yield* watcher.subscriptions()).toContainEqual({
              path: tmp.path,
              type: "entries",
              names: watchedNames(
                CompatNames.mcp,
                ".orbit",
                "orbit.json",
                "orbit.jsonc",
                "orbit.local.json",
                "orbit.local.jsonc",
              ),
            })
          }).pipe(Effect.provide(testLayer(tmp.path)))
        }),
      ),
    ),
  )

  it.live("loads global and ancestor configuration across the project boundary", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const root = path.join(tmp.path, "repo")
        const parent = path.join(root, "packages")
        const directory = path.join(parent, "app")
        const home = path.join(global, "home")
        // Every compatibility root this fixture creates, lowest priority first: vendor roots before .agents roots,
        // and within a kind the user's own, then the outermost project root.
        const expectedRoots = (
          [
            { kind: "vendor", name: CompatNames.vendor.directory },
            { kind: "agents", name: CompatNames.agents },
          ] as const
        ).flatMap(({ kind, name }) => [
          { path: AbsolutePath.make(path.join(home, name)), kind, scope: "user" as const },
          { path: AbsolutePath.make(path.join(root, name)), kind, scope: "project" as const },
          { path: AbsolutePath.make(path.join(directory, name)), kind, scope: "project" as const },
        ])
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.mkdir(path.join(root, ".orbit"), { recursive: true })
            await fs.mkdir(path.join(directory, ".orbit"), { recursive: true })
            await Promise.all(expectedRoots.map((expected) => fs.mkdir(expected.path, { recursive: true })))
            await Promise.all([
              fs.writeFile(path.join(tmp.path, "orbit.json"), JSON.stringify({ $schema: "outside" })),
              fs.writeFile(path.join(global, "orbit.json"), JSON.stringify({ $schema: "global" })),
              fs.writeFile(path.join(root, "orbit.json"), JSON.stringify({ $schema: "root" })),
              fs.writeFile(path.join(parent, "orbit.jsonc"), JSON.stringify({ $schema: "parent" })),
              fs.writeFile(path.join(directory, "orbit.json"), JSON.stringify({ $schema: "directory" })),
              fs.writeFile(path.join(root, ".orbit", "orbit.json"), JSON.stringify({ $schema: "root-dot" })),
              fs.writeFile(
                path.join(directory, ".orbit", "orbit.jsonc"),
                JSON.stringify({ $schema: "directory-dot" }),
              ),
            ])
          })

          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const entries = (yield* config.entries()).filter((entry) => !entry.path || inFixture(tmp.path, entry.path))
            const documents = entries.filter((entry) => entry.type === "document")

            expect(entries.filter((entry) => entry.type === "directory").map((entry) => entry.path)).toEqual([
              AbsolutePath.make(global),
              AbsolutePath.make(path.join(root, ".orbit")),
              AbsolutePath.make(path.join(directory, ".orbit")),
            ])
            expect(yield* compatRoots(tmp.path)).toEqual(expectedRoots)
            expect(documents.map((document) => document.info.$schema)).toEqual([
              "global",
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              "directory-dot",
            ])
            expect(entries.map((entry) => (entry.type === "document" ? entry.info.$schema : entry.path))).toEqual([
              "global",
              AbsolutePath.make(global),
              "outside",
              "root",
              "parent",
              "directory",
              "root-dot",
              AbsolutePath.make(path.join(root, ".orbit")),
              "directory-dot",
              AbsolutePath.make(path.join(directory, ".orbit")),
            ])
          }).pipe(
            Effect.provide(
              testLayer(directory, global, root, {
                type: "git",
                store: AbsolutePath.make(path.join(root, ".git")),
              }),
            ),
          )
        })
      }),
    ),
  )
})

// Every fixture file carries its name as both $schema and shell: labels() tells documents apart, and
// Config.latest(entries, "shell") names the document that wins.
const marker = (name: string) => ({ $schema: name, shell: name })

const write = (files: Record<string, unknown>) =>
  Effect.promise(() =>
    Promise.all(
      Object.entries(files).map(async ([file, contents]) => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, JSON.stringify(contents))
      }),
    ),
  )

// One label per entry inside root: "scope:name" for a marked document, "scope:dir(relative path)" for a directory.
const labels = (root: string, entries: readonly Entry[]) =>
  entries
    .filter((entry) => !entry.path || inFixture(root, entry.path))
    .map((entry) =>
      entry.type === "document"
        ? `${entry.scope}:${entry.info.$schema}`
        : `${entry.scope}:dir(${path.relative(root, entry.path).split(path.sep).join("/")})`,
    )

function remoteNodes(config: WellKnown.Config) {
  const integrationID = Integration.ID.make("https://example.com")
  const entry: WellKnown.Entry = {
    origin: "https://example.com",
    integrationID,
    manifest: { auth: { command: ["login"], env: "TOKEN" } },
  }
  return {
    credential: makeGlobalNode({
      service: Credential.Service,
      layer: Layer.succeed(
        Credential.Service,
        Credential.Service.of({
          all: () => Effect.die("unused Credential.all"),
          list: () =>
            Effect.succeed([
              new Credential.Info({
                id: Credential.ID.create(),
                integrationID,
                label: "default",
                value: Credential.Key.make({ type: "key", key: "secret" }),
              }),
            ]),
          get: () => Effect.die("unused Credential.get"),
          create: () => Effect.die("unused Credential.create"),
          activate: () => Effect.die("unused Credential.activate"),
          update: () => Effect.die("unused Credential.update"),
          remove: () => Effect.die("unused Credential.remove"),
        }),
      ),
      deps: [],
    }),
    wellknown: makeGlobalNode({
      service: WellKnown.Service,
      layer: Layer.succeed(
        WellKnown.Service,
        WellKnown.Service.of({
          entries: () => Effect.succeed([entry]),
          snapshot: () => [entry],
          refresh: () => Effect.succeed(false),
          add: () => Effect.die("unused Wellknown.add"),
          remove: () => Effect.die("unused Wellknown.remove"),
          resolve: () => Effect.succeed([config]),
        }),
      ),
      deps: [],
    }),
  }
}

// The global config directory sits inside home, as it does on a real machine. The default test layer nests home
// inside the global directory instead, and global: false would then exclude every project under it.
function scopeLayer(
  home: string,
  directory: string,
  options?: Config.Options,
  remote?: ReturnType<typeof remoteNodes>,
  globalDirectory = path.join(home, ".config", "orbit"),
) {
  return testLayer(
    directory,
    globalDirectory,
    directory,
    undefined,
    undefined,
    remote?.credential,
    remote?.wellknown,
    options,
    home,
  )
}

describe("Config scopes", () => {
  it.live("ranks orbit.local.json and orbit.local.jsonc above the shared file beside them", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const project = path.join(tmp.path, "project")
      yield* write({
        [path.join(project, "orbit.json")]: { ...marker("shared"), username: "shared-user" },
        [path.join(project, "orbit.local.json")]: marker("local-json"),
        [path.join(project, "orbit.local.jsonc")]: marker("local-jsonc"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(path.join(tmp.path, "home"), project)),
      )

      expect(labels(project, entries)).toEqual(["project:shared", "local:local-json", "local:local-jsonc"])
      expect(Config.latest(entries, "shell")).toBe("local-jsonc")
      // A key the local files leave out still comes from the shared file.
      expect(Config.latest(entries, "username")).toBe("shared-user")
    }),
  )

  it.live("loads orbit.local.jsonc from .orbit roots as local, after every project entry", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const repo = path.join(tmp.path, "repo")
      const app = path.join(repo, "app")
      yield* write({
        [path.join(repo, "orbit.json")]: marker("root"),
        [path.join(app, "orbit.json")]: marker("app"),
        [path.join(repo, ".orbit", "orbit.json")]: marker("root-dot"),
        [path.join(app, ".orbit", "orbit.json")]: marker("app-dot"),
        [path.join(repo, "orbit.local.json")]: marker("root-local"),
        [path.join(app, "orbit.local.json")]: marker("app-local"),
        [path.join(repo, ".orbit", "orbit.local.jsonc")]: marker("root-dot-local"),
        [path.join(app, ".orbit", "orbit.local.jsonc")]: marker("app-dot-local"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(path.join(tmp.path, "home"), app)),
      )

      // The .orbit directories stay project entries; only their local documents move up to the local scope.
      expect(labels(repo, entries)).toEqual([
        "project:root",
        "project:app",
        "project:root-dot",
        "project:dir(.orbit)",
        "project:app-dot",
        "project:dir(app/.orbit)",
        "local:root-local",
        "local:app-local",
        "local:root-dot-local",
        "local:app-dot-local",
      ])
    }),
  )

  it.live("ranks flag entries above local ones, with the content above the explicit file", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const project = path.join(tmp.path, "project")
      const explicit = path.join(project, "custom.json")
      yield* write({
        [path.join(project, "orbit.json")]: marker("project"),
        [path.join(project, "orbit.local.json")]: marker("local"),
        [explicit]: marker("explicit"),
      })
      const load = (options: Config.Options) =>
        Config.Service.use((config) => config.entries()).pipe(Effect.provide(scopeLayer(home, project, options)))

      const both = yield* load({ file: explicit, content: JSON.stringify(marker("content")) })
      expect(labels(project, both)).toEqual(["project:project", "local:local", "flag:explicit", "flag:content"])
      expect(Config.latest(both, "shell")).toBe("content")

      const fileOnly = yield* load({ file: explicit })
      expect(labels(project, fileOnly)).toEqual(["project:project", "local:local", "flag:explicit"])
      expect(Config.latest(fileOnly, "shell")).toBe("explicit")
    }),
  )

  it.live("stamps every entry with the scope it was loaded from", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const project = path.join(home, "project")
      const explicit = path.join(project, "custom.json")
      yield* write({
        [path.join(home, ".config", "orbit", "orbit.json")]: marker("global"),
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(home, ".orbit", "orbit.json")]: marker("home-dot"),
        [path.join(project, "orbit.json")]: marker("project"),
        [path.join(project, ".orbit", "orbit.json")]: marker("project-dot"),
        [path.join(project, "orbit.local.json")]: marker("local"),
        [explicit]: marker("explicit"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(
          scopeLayer(
            home,
            project,
            { file: explicit, content: JSON.stringify(marker("content")) },
            remoteNodes(marker("remote")),
          ),
        ),
      )

      // Includes any config the machine running the test keeps above the fixture.
      expect(entries.filter((entry) => entry.scope === undefined)).toEqual([])
      expect(labels(tmp.path, entries)).toEqual([
        "remote:remote",
        "user:global",
        "user:dir(home/.config/orbit)",
        "user:home",
        "user:home-dot",
        "user:dir(home/.orbit)",
        "project:project",
        "project:project-dot",
        "project:dir(home/project/.orbit)",
        "local:local",
        "flag:explicit",
        "flag:content",
      ])
    }),
  )

  it.live("treats the home directory's orbit files as user config that ranks below project files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const project = path.join(home, "project")
      yield* write({
        [path.join(home, ".config", "orbit", "orbit.json")]: marker("global"),
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(home, "orbit.local.json")]: marker("home-local"),
        [path.join(home, ".orbit", "orbit.json")]: marker("home-dot"),
        [path.join(home, ".orbit", "orbit.local.jsonc")]: marker("home-dot-local"),
        [path.join(project, "orbit.json")]: marker("project"),
      })

      const loaded = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const watcher = yield* Watcher.Test
        return { entries: yield* config.entries(), watches: yield* watcher.subscriptions() }
      }).pipe(Effect.provide(scopeLayer(home, project)))

      // Home's own files load once as user config, local files after the shared ones, and every project file
      // outranks them even though the walk passes through home on the way up.
      expect(labels(tmp.path, loaded.entries)).toEqual([
        "user:global",
        "user:dir(home/.config/orbit)",
        "user:home",
        "user:home-dot",
        "user:dir(home/.orbit)",
        "user:home-local",
        "user:home-dot-local",
        "project:project",
      ])
      expect(Config.latest(loaded.entries, "shell")).toBe("project")
      expect(loaded.watches).toContainEqual({
        type: "entries",
        path: home,
        names: watchedNames(".orbit", "orbit.json", "orbit.jsonc", "orbit.local.json", "orbit.local.jsonc"),
      })
    }),
  )

  it.live("reloads when an orbit.local.json file appears in the project or in home", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const project = path.join(home, "project")
      yield* write({ [path.join(project, "orbit.json")]: marker("project") })

      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const appear = Effect.fnUntraced(function* (file: string, name: string) {
          const changed = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Effect.sleep("10 millis")
          yield* write({ [file]: marker(name) })
          yield* watcher.emit({ type: "create", path: file })
          expect(yield* Fiber.join(changed)).toHaveLength(1)
        })

        yield* appear(path.join(project, "orbit.local.json"), "local")
        expect(labels(tmp.path, yield* config.entries())).toEqual([
          "user:dir(home/.config/orbit)",
          "project:project",
          "local:local",
        ])

        yield* appear(path.join(home, "orbit.local.json"), "home-local")
        expect(labels(tmp.path, yield* config.entries())).toEqual([
          "user:dir(home/.config/orbit)",
          "user:home-local",
          "project:project",
          "local:local",
        ])
      }).pipe(Effect.provide(scopeLayer(home, project)))
    }),
  )

  it.live("loads orbit.local.json from the global config directory once, as user config", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const global = path.join(home, ".config", "orbit")
      const nested = path.join(global, "plugins", "demo")
      yield* write({
        [path.join(global, "orbit.json")]: marker("global"),
        [path.join(global, "orbit.local.json")]: marker("global-local"),
        [path.join(nested, "orbit.json")]: marker("demo"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(home, nested)),
      )

      // The walk passes through the global directory but must not report its files a second time.
      expect(labels(tmp.path, entries)).toEqual([
        "user:global",
        "user:dir(home/.config/orbit)",
        "user:global-local",
        "project:demo",
      ])
    }),
  )

  it.live("loads a global config directory that is ~/.orbit once, beside the other home files", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const global = path.join(home, ".orbit")
      yield* write({
        [path.join(global, "orbit.json")]: marker("global"),
        [path.join(global, "orbit.local.json")]: marker("global-local"),
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(home, "project", "orbit.json")]: marker("project"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(home, path.join(home, "project"), undefined, undefined, global)),
      )

      // Hosts that pin ORBIT_CONFIG_DIR to ~/.orbit make the home source's .orbit the global directory too: it loads
      // once, with the global documents, and the rest of home's files follow it.
      expect(labels(tmp.path, entries)).toEqual([
        "user:global",
        "user:dir(home/.orbit)",
        "user:global-local",
        "user:home",
        "project:project",
      ])
    }),
  )

  it.live("loads the home directory's orbit files for a project outside home", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const app = path.join(tmp.path, "outside", "repo", "app")
      yield* write({
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(tmp.path, "orbit.json")]: marker("above"),
        [path.join(tmp.path, "outside", "orbit.json")]: marker("outside"),
        [path.join(tmp.path, "outside", "repo", "orbit.json")]: marker("repo"),
        [path.join(app, "orbit.json")]: marker("app"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(home, app)),
      )

      // Ancestors above a repository outside home are project config like any other.
      expect(labels(tmp.path, entries)).toEqual([
        "user:dir(home/.config/orbit)",
        "user:home",
        "project:above",
        "project:outside",
        "project:repo",
        "project:app",
      ])
    }),
  )

  it.live("keeps ancestors between the home directory and a repository in project scope", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const app = path.join(home, "work", "repo", "packages", "app")
      yield* write({
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(home, "work", "orbit.json")]: marker("work"),
        [path.join(home, "work", "repo", "orbit.json")]: marker("repo"),
        [path.join(app, "orbit.json")]: marker("app"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(home, app)),
      )

      expect(labels(tmp.path, entries)).toEqual([
        "user:dir(home/.config/orbit)",
        "user:home",
        "project:work",
        "project:repo",
        "project:app",
      ])
    }),
  )

  it.live("loads home orbit files once when the location is the home directory", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      yield* write({
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(home, ".orbit", "orbit.json")]: marker("home-dot"),
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(home, home)),
      )

      expect(labels(tmp.path, entries)).toEqual([
        "user:dir(home/.config/orbit)",
        "user:home",
        "user:home-dot",
        "user:dir(home/.orbit)",
      ])
    }),
  )

  it.live("recognizes the home directory when the project walk reaches it through a symlink", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const home = path.join(tmp.path, "home")
      const link = path.join(tmp.path, "link")
      yield* write({
        [path.join(home, "orbit.json")]: marker("home"),
        [path.join(home, "project", "orbit.json")]: marker("project"),
      })
      yield* Effect.promise(() => fs.symlink(home, link, process.platform === "win32" ? "junction" : undefined))

      // The walk spells home as the link; its orbit.json must still load once, as user config.
      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(scopeLayer(home, path.join(link, "project"))),
      )

      expect(labels(tmp.path, entries)).toEqual(["user:dir(home/.config/orbit)", "user:home", "project:project"])
    }),
  )

  it.live(
    "drops the home directory's orbit files when global is disabled but keeps them when project is disabled",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const home = path.join(tmp.path, "home")
        const project = path.join(home, "work", "project")
        yield* write({
          [path.join(home, ".config", "orbit", "orbit.json")]: marker("global"),
          [path.join(home, "orbit.json")]: marker("home"),
          [path.join(home, "orbit.local.json")]: marker("home-local"),
          [path.join(home, ".orbit", "orbit.json")]: marker("home-dot"),
          [path.join(home, "work", "orbit.json")]: marker("work"),
          [path.join(project, "orbit.json")]: marker("project"),
        })
        const load = (options: Config.Options) =>
          Effect.gen(function* () {
            const config = yield* Config.Service
            const watcher = yield* Watcher.Test
            return { entries: yield* config.entries(), watches: yield* watcher.subscriptions() }
          }).pipe(Effect.provide(scopeLayer(home, project, options)))
        const user = [
          "user:global",
          "user:dir(home/.config/orbit)",
          "user:home",
          "user:home-dot",
          "user:dir(home/.orbit)",
          "user:home-local",
        ]

        expect(labels(tmp.path, (yield* load({})).entries)).toEqual([...user, "project:work", "project:project"])

        // --bare skips the project walk but still loads the user's own config, home files included.
        expect(labels(tmp.path, (yield* load({ project: false })).entries)).toEqual(user)

        // Home's files are skipped exactly like the global config directory, even though the walk passes through home.
        const withoutGlobal = yield* load({ global: false })
        expect(labels(tmp.path, withoutGlobal.entries)).toEqual(["project:work", "project:project"])
        expect(
          withoutGlobal.watches.filter(
            (watch) => watch.path === home || inFixture(path.join(home, ".orbit"), watch.path),
          ),
        ).toEqual([])
      }),
  )
})

describe("Config compatibility", () => {
  // A project below home, with a root of every kind in home and in the project.
  const writeRoots = Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const home = path.join(tmp.path, "home")
    const project = path.join(home, "work", "project")
    yield* Effect.promise(() =>
      Promise.all(
        compatNames.flatMap((name) =>
          [home, project].map((directory) => fs.mkdir(path.join(directory, name), { recursive: true })),
        ),
      ),
    )
    return { root: tmp.path, home, project, user: path.join(home, ".config", "orbit", "orbit.json") }
  })
  // The roots that exist, lowest priority first: each kind's root in home, then its root in the project.
  const reportedRoots = (fixture: { readonly home: string; readonly project: string }) =>
    compatNames.flatMap((name) => [path.join(fixture.home, name), path.join(fixture.project, name)])

  // Every name the directory watches list for entries, whatever directory they are in.
  const watchedEntryNames = Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    return (yield* watcher.subscriptions()).flatMap((watch) => (watch.type === "entries" ? watch.names : []))
  })

  it.live("reports compatibility as on, with the roots that exist", () =>
    Effect.gen(function* () {
      const fixture = yield* writeRoots

      const loaded = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        return {
          enabled: yield* config.compatEnabled(),
          reported: (yield* config.compat()).enabled,
          roots: yield* compatRoots(fixture.root),
        }
      }).pipe(Effect.provide(scopeLayer(fixture.home, fixture.project)))

      // Both ways of asking agree.
      expect([loaded.enabled, loaded.reported]).toEqual([true, true])
      expect(loaded.roots.map((item) => item.path.toString())).toEqual(reportedRoots(fixture))
      expect(loaded.roots.map((item) => [item.kind, item.scope])).toEqual([
        ["vendor", "user"],
        ["vendor", "project"],
        ["agents", "user"],
        ["agents", "project"],
      ])
    }),
  )

  it.live("reports no roots, and watches none, once user config turns compatibility off", () =>
    Effect.gen(function* () {
      const fixture = yield* writeRoots
      yield* write({ [fixture.user]: { compatibility: { enabled: false } } })

      const loaded = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        return {
          enabled: yield* config.compatEnabled(),
          compat: yield* config.compat(),
          names: yield* watchedEntryNames,
        }
      }).pipe(Effect.provide(scopeLayer(fixture.home, fixture.project)))

      expect(loaded.enabled).toBe(false)
      expect(loaded.compat).toEqual({ enabled: false, roots: [] })
      expect(loaded.names).toContain("orbit.json")
      for (const name of compatNames) expect(loaded.names).not.toContain(name)
    }),
  )

  it.live("takes the switch from flag content, not from project files", () =>
    Effect.gen(function* () {
      const fixture = yield* writeRoots
      const off = { compatibility: { enabled: false } }
      const on = { compatibility: { enabled: true } }
      const enabled = (options: Config.Options) =>
        Config.Service.use((config) => config.compatEnabled()).pipe(
          Effect.provide(scopeLayer(fixture.home, fixture.project, options)),
        )

      // A repository's own files, shared or local, cannot turn it off...
      yield* write({
        [path.join(fixture.project, "orbit.json")]: off,
        [path.join(fixture.project, "orbit.local.json")]: off,
      })
      expect(yield* enabled({})).toBe(true)

      // ...and cannot turn it back on after the user did.
      yield* write({
        [path.join(fixture.project, "orbit.json")]: on,
        [path.join(fixture.project, "orbit.local.json")]: on,
        [fixture.user]: off,
      })
      expect(yield* enabled({})).toBe(false)

      // ORBIT_CONFIG_CONTENT is flag scope, which ranks above the user's own config.
      expect(yield* enabled({ content: JSON.stringify(on) })).toBe(true)
      yield* write({ [fixture.user]: on })
      expect(yield* enabled({ content: JSON.stringify(off) })).toBe(false)
    }),
  )

  // The switch reads the environment of the process that hosts Config, so this goes through a real Config rather
  // than the CompatSwitch unit tests: it fails if either place that asks the switch stops passing the environment.
  it.live("is forced off by ORBIT_DISABLE_COMPAT whatever the documents say, and watches no roots", () =>
    Effect.gen(function* () {
      const fixture = yield* writeRoots
      const on = { compatibility: { enabled: true } }
      // The user's config and the flag content both ask for compatibility, so only the environment can turn it off.
      yield* write({ [fixture.user]: on })
      const load = (variable: string | undefined) =>
        withEnv({ ORBIT_DISABLE_COMPAT: variable }, () =>
          Effect.gen(function* () {
            const config = yield* Config.Service
            return {
              enabled: yield* config.compatEnabled(),
              compat: yield* config.compat(),
              names: yield* watchedEntryNames,
            }
          }).pipe(Effect.provide(scopeLayer(fixture.home, fixture.project, { content: JSON.stringify(on) }))),
        )

      for (const variable of ["1", "true", "TRUE"]) {
        const forced = yield* load(variable)
        expect(forced.enabled).toBe(false)
        expect(forced.compat).toEqual({ enabled: false, roots: [] })
        for (const name of compatNames) expect(forced.names).not.toContain(name)
      }

      // Anything else leaves the documents in charge.
      for (const variable of [undefined, "0", "false"]) {
        const loaded = yield* load(variable)
        expect(loaded.enabled).toBe(true)
        expect(loaded.compat.roots.length).toBeGreaterThan(0)
        for (const name of compatNames) expect(loaded.names).toContain(name)
      }
    }),
  )

  it.live("follows the switch when user config changes, and reports the change", () =>
    Effect.gen(function* () {
      const fixture = yield* writeRoots

      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const turn = Effect.fnUntraced(function* (enabled: boolean) {
          const changed = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Effect.sleep("10 millis")
          yield* write({ [fixture.user]: { compatibility: { enabled } } })
          yield* watcher.emit({ type: "create", path: fixture.user })
          expect(yield* Fiber.join(changed)).toHaveLength(1)
          expect(yield* config.compatEnabled()).toBe(enabled)
          return yield* config.compat()
        })

        expect((yield* config.compat()).roots.length).toBeGreaterThan(0)
        expect(yield* turn(false)).toEqual({ enabled: false, roots: [] })
        const back = yield* turn(true)
        expect(back.enabled).toBe(true)
        expect(back.roots.filter((item) => inFixture(fixture.root, item.path))).toHaveLength(4)
      }).pipe(Effect.provide(scopeLayer(fixture.home, fixture.project)))
    }),
  )
})

describe("Config compatibility documents", () => {
  const vendor = CompatNames.vendor.directory
  const shared = CompatNames.vendor.settings.shared
  const local = CompatNames.vendor.settings.local
  const hook = (command: string) => ({ PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] })

  // One label per document inside the fixture: its scope, its file relative to the fixture, and for a vendor settings
  // file the command of its hook, or for an MCP file the servers it declares.
  const described = (root: string, entries: readonly Entry[]) =>
    entries.flatMap((entry) => {
      if (entry.type !== "document" || entry.path === undefined || !inFixture(root, entry.path)) return []
      const file = path.relative(root, entry.path).split(path.sep).join("/")
      const hooks = (entry.info.hooks?.PreToolUse ?? []).flatMap((group) =>
        group.hooks.flatMap((item) => (item.type === "command" ? [item.command] : [])),
      )
      const servers = Object.keys(entry.info.mcp?.servers ?? {})
      return [[`${entry.scope}:${file}`, ...hooks, ...servers].join(" ")]
    })

  // A home with its own native config and settings files, and a repository with every kind of file one project keeps,
  // with the location in a directory of it: the project's directory is the repository's, as when it is a checkout.
  const repository = Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const home = path.join(tmp.path, "home")
    const global = path.join(home, ".config", "orbit")
    const repo = path.join(home, "work", "repo")
    const app = path.join(repo, "app")
    yield* write({
      [path.join(global, "orbit.json")]: marker("global"),
      [path.join(home, vendor, shared)]: { hooks: hook("user-shared") },
      [path.join(home, vendor, local)]: { hooks: hook("user-local") },
      [path.join(repo, vendor, shared)]: { hooks: hook("repo-shared") },
      [path.join(repo, vendor, local)]: { hooks: hook("repo-local") },
      [path.join(app, vendor, shared)]: { hooks: hook("app-shared") },
      [path.join(repo, CompatNames.mcp)]: { mcpServers: { files: { command: "serve" } } },
      [path.join(repo, "orbit.json")]: marker("repo"),
      [path.join(repo, "orbit.local.json")]: marker("repo-local"),
    })
    return { root: tmp.path, home, global, repo, app }
  })
  const layerFor = (fixture: Effect.Success<typeof repository>, options?: Config.Options) =>
    testLayer(
      fixture.app,
      fixture.global,
      fixture.repo,
      undefined,
      undefined,
      undefined,
      undefined,
      options,
      fixture.home,
    )

  it.live("ranks them below the native documents of their own scope, in the block they belong to", () =>
    Effect.gen(function* () {
      const fixture = yield* repository

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(Effect.provide(layerFor(fixture)))

      // The user's settings open the user block, the project's open the project block with the MCP file after them,
      // and the local settings file opens the local block, so each native document of a scope outranks them.
      expect(described(fixture.root, entries)).toEqual([
        `user:home/${vendor}/${shared} user-shared`,
        `user:home/${vendor}/${local} user-local`,
        "user:home/.config/orbit/orbit.json",
        `project:home/work/repo/${vendor}/${shared} repo-shared`,
        `project:home/work/repo/app/${vendor}/${shared} app-shared`,
        `project:home/work/repo/${CompatNames.mcp} files`,
        "project:home/work/repo/orbit.json",
        `local:home/work/repo/${vendor}/${local} repo-local`,
        "local:home/work/repo/orbit.local.json",
      ])
    }),
  )

  it.live("loads none of them once compatibility is off, and watches none of them", () =>
    Effect.gen(function* () {
      const fixture = yield* repository
      yield* write({
        [path.join(fixture.global, "orbit.json")]: { ...marker("global"), compatibility: { enabled: false } },
      })

      const loaded = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const watcher = yield* Watcher.Test
        return { entries: yield* config.entries(), watches: yield* watcher.subscriptions() }
      }).pipe(Effect.provide(layerFor(fixture)))

      expect(described(fixture.root, loaded.entries)).toEqual([
        "user:home/.config/orbit/orbit.json",
        "project:home/work/repo/orbit.json",
        "local:home/work/repo/orbit.local.json",
      ])
      const watched = loaded.watches.flatMap((watch) => (watch.type === "entries" ? watch.names : []))
      for (const name of [CompatNames.mcp, vendor, shared, local]) expect(watched).not.toContain(name)
    }),
  )

  it.live("follows ORBIT_DISABLE_COMPAT, and loads them again once it is unset", () =>
    Effect.gen(function* () {
      const fixture = yield* repository
      const load = (variable: string | undefined) =>
        withEnv({ ORBIT_DISABLE_COMPAT: variable }, () =>
          Config.Service.use((config) => config.entries()).pipe(Effect.provide(layerFor(fixture))),
        ).pipe(Effect.map((entries) => described(fixture.root, entries).length))

      expect(yield* load("1")).toBe(3)
      expect(yield* load(undefined)).toBe(9)
    }),
  )

  it.live("leaves the project's MCP file and the project's settings out when project discovery is off", () =>
    Effect.gen(function* () {
      const fixture = yield* repository

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(layerFor(fixture, { project: false })),
      )

      // What is the user's own stays: their settings and their native config.
      expect(described(fixture.root, entries)).toEqual([
        `user:home/${vendor}/${shared} user-shared`,
        `user:home/${vendor}/${local} user-local`,
        "user:home/.config/orbit/orbit.json",
      ])
    }),
  )

  it.live("leaves the user's settings out when global config is off, and keeps the project's", () =>
    Effect.gen(function* () {
      const fixture = yield* repository

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(
        Effect.provide(layerFor(fixture, { global: false })),
      )

      expect(described(fixture.root, entries)).toEqual([
        `project:home/work/repo/${vendor}/${shared} repo-shared`,
        `project:home/work/repo/app/${vendor}/${shared} app-shared`,
        `project:home/work/repo/${CompatNames.mcp} files`,
        "project:home/work/repo/orbit.json",
        `local:home/work/repo/${vendor}/${local} repo-local`,
        "local:home/work/repo/orbit.local.json",
      ])
    }),
  )

  it.live("expands variable references in the MCP file from the environment of the process", () =>
    Effect.gen(function* () {
      const fixture = yield* repository
      yield* write({
        [path.join(fixture.repo, CompatNames.mcp)]: {
          mcpServers: {
            docs: {
              type: "http",
              url: "https://${ORBIT_TEST_MCP_HOST}/mcp",
              headers: { "X-Mode": "${ORBIT_TEST_MODE:-dev}" },
            },
            gap: { command: "serve", args: ["${ORBIT_TEST_MCP_MISSING}"] },
          },
        },
      })

      const entries = yield* withEnv({ ORBIT_TEST_MCP_HOST: "mcp.example.com", ORBIT_TEST_MODE: undefined }, () =>
        Config.Service.use((config) => config.entries()).pipe(Effect.provide(layerFor(fixture))),
      )

      const servers = Config.latest(entries, "mcp")?.servers
      expect(Object.keys(servers ?? {})).toEqual(["docs"])
      expect(servers?.docs).toMatchObject({
        type: "remote",
        url: "https://mcp.example.com/mcp",
        headers: { "X-Mode": "dev" },
      })
    }),
  )

  it.live("reports what cannot be used in a file at its path, in the shape of a native document's own problems", () => {
    const output: Array<Record<string, unknown>> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "configuration normalization diagnostic") return
      const details = entry.message[1]
      if (typeof details === "object" && details !== null) output.push(details as Record<string, unknown>)
    })
    return Effect.gen(function* () {
      const fixture = yield* repository
      yield* write({
        [path.join(fixture.repo, vendor, shared)]: {
          hooks: { ...hook("guard"), SubagentStop: [{ hooks: [{ type: "prompt", prompt: "Done?", model: "fast" }] }] },
        },
        [path.join(fixture.repo, vendor, local)]: { hooks: "off" },
        [path.join(fixture.repo, CompatNames.mcp)]: {
          mcpServers: { files: { command: "serve" }, broken: { args: [] } },
        },
      })

      const entries = yield* Config.Service.use((config) => config.entries()).pipe(Effect.provide(layerFor(fixture)))

      // A hook that cannot be read costs only itself, and a server that cannot be mapped costs only itself.
      expect(described(fixture.root, entries)).toContain(`project:home/work/repo/${vendor}/${shared} guard`)
      expect(described(fixture.root, entries)).toContain(`project:home/work/repo/${CompatNames.mcp} files`)
      const reported: Array<Record<string, unknown>> = output
        .filter((details) => typeof details.source === "string" && inFixture(fixture.repo, details.source))
        .map((details) => ({ ...details, source: path.relative(fixture.repo, String(details.source)) }))
      expect(reported).toEqual([
        {
          source: path.join(vendor, shared),
          path: "$.hooks.SubagentStop.0.hooks.0",
          kind: "invalid",
          action: "skipped malformed recognized value",
        },
        {
          source: path.join(vendor, local),
          path: "$.hooks",
          kind: "invalid",
          action: "skipped malformed recognized value",
        },
        {
          source: CompatNames.mcp,
          path: "$.mcpServers.broken",
          kind: "invalid",
          action: "skipped server without a command",
        },
      ])
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.live("reloads when a settings file is edited, and when the MCP file appears", () =>
    Effect.gen(function* () {
      const fixture = yield* repository
      const settings = path.join(fixture.repo, vendor, shared)
      yield* Effect.promise(() => fs.rm(path.join(fixture.repo, CompatNames.mcp)))

      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const changes = Effect.fnUntraced(function* (update: Effect.Effect<void>) {
          const changed = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
          yield* Effect.sleep("10 millis")
          yield* update
          expect(yield* Fiber.join(changed)).toHaveLength(1)
          return described(fixture.root, yield* config.entries())
        })
        const mcp = path.join(fixture.repo, CompatNames.mcp)

        expect(
          yield* changes(
            write({ [settings]: { hooks: hook("repo-edited") } }).pipe(
              Effect.andThen(watcher.emit({ type: "update", path: settings })),
            ),
          ),
        ).toContain(`project:home/work/repo/${vendor}/${shared} repo-edited`)
        expect(
          yield* changes(
            write({ [mcp]: { mcpServers: { files: { command: "serve" } } } }).pipe(
              Effect.andThen(watcher.emit({ type: "create", path: mcp })),
            ),
          ),
        ).toContain(`project:home/work/repo/${CompatNames.mcp} files`)
        // Both files are watched by name, in the directory that holds each.
        expect(yield* watcher.subscriptions()).toContainEqual({
          type: "entries",
          path: path.join(fixture.repo, vendor),
          names: [shared, local].toSorted(),
        })
      }).pipe(Effect.provide(layerFor(fixture)))
    }),
  )

  it.live("starts watching the settings files of a root that appears after the config loaded", () =>
    Effect.gen(function* () {
      const fixture = yield* repository
      const lateRoot = path.join(fixture.app, vendor)
      yield* Effect.promise(() => fs.rm(lateRoot, { recursive: true, force: true }))

      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const bus = yield* Bus.Service
        const watcher = yield* Watcher.Test
        const watchesRoot = Effect.map(watcher.subscriptions(), (watches) =>
          watches.some((watch) => watch.type === "entries" && watch.path === lateRoot),
        )

        // A root that is missing has nothing to watch for its files, and its parent watch will see it appear.
        expect(yield* watchesRoot).toBe(false)
        const changed = yield* bus.subscribe(Event.Updated).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
        yield* Effect.sleep("10 millis")
        yield* write({ [path.join(lateRoot, shared)]: { hooks: hook("app-late") } })
        yield* watcher.emit({ type: "create", path: lateRoot })
        expect(yield* Fiber.join(changed)).toHaveLength(1)

        expect(described(fixture.root, yield* config.entries())).toContain(
          `project:home/work/repo/app/${vendor}/${shared} app-late`,
        )
        expect(yield* watchesRoot).toBe(true)
      }).pipe(Effect.provide(layerFor(fixture)))
    }),
  )
})

// Windows ignores path case, but realpath keeps the spelling it is given: a child started with a lowercase cwd walks
// c:\users\om while Global.home says C:\Users\Om. Both spellings must still be recognized as the same home directory.
describe.skipIf(process.platform !== "win32")("Config scopes with differently cased paths", () => {
  const writeHome = Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    yield* write({
      [path.join(tmp.path, "home", "orbit.json")]: marker("home"),
      [path.join(tmp.path, "home", ".orbit", "orbit.json")]: marker("home-dot"),
      ...Object.fromEntries(compatNames.map((name) => [path.join(tmp.path, "home", name, "settings.json"), {}])),
      [path.join(tmp.path, "home", "project", "orbit.json")]: marker("project"),
    })
    return tmp.path
  })

  // The entries and the compatibility root paths inside the fixture; the machine running the test may keep its own
  // roots above it.
  const load = (root: string, home: string, location: string, options: Config.Options) =>
    Effect.gen(function* () {
      const config = yield* Config.Service
      return {
        entries: labels(root, yield* config.entries()),
        compat: (yield* compatRoots(root)).map((item) => item.path),
      }
    }).pipe(Effect.provide(scopeLayer(home, location, options)))

  it.live("recognizes the home directory when the location spells it differently", () =>
    Effect.gen(function* () {
      const root = yield* writeHome
      const home = path.join(root, "home")
      const location = path.join(root, "HOME", "project")

      // Home's files and compatibility roots load once, as user config, and never again as project config.
      expect(yield* load(root, home, location, {})).toEqual({
        entries: [
          "user:dir(home/.config/orbit)",
          "user:home",
          "user:home-dot",
          "user:dir(home/.orbit)",
          "project:project",
        ],
        compat: compatNames.map((name) => AbsolutePath.make(path.join(home, name))),
      })
      expect(yield* load(root, home, location, { global: false })).toEqual({
        entries: ["project:project"],
        compat: [],
      })
    }),
  )

  it.live("recognizes the home directory when Global.home spells it differently", () =>
    Effect.gen(function* () {
      const root = yield* writeHome
      const home = path.join(root, "HOME")
      const location = path.join(root, "home", "project")

      expect(yield* load(root, home, location, {})).toEqual({
        entries: [
          "user:dir(HOME/.config/orbit)",
          "user:home",
          "user:home-dot",
          "user:dir(HOME/.orbit)",
          "project:project",
        ],
        compat: compatNames.map((name) => AbsolutePath.make(path.join(home, name))),
      })
      expect(yield* load(root, home, location, { global: false })).toEqual({
        entries: ["project:project"],
        compat: [],
      })
    }),
  )
})
