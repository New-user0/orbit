import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Logger, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import { CompatNames } from "@orbit/compat/names"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigInstructionPlugin } from "@orbit/core/config/plugin/instruction"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Event } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdir } from "./fixture/tmpdir"
import { readInitial, readUpdate, state } from "./lib/instructions"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

// The names looked for in every directory, in priority order: the native files, then the reference vendor's.
const nativeNames = ["ORBIT.md", "AGENTS.md"]
const allNames = [...nativeNames, CompatNames.vendor.instructions]

const instructionLayer = (input: {
  config?: string
  home?: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
  project?: boolean
  // Compatibility is on, with no roots, unless a test supplies its own config.
  configLayer?: Layer.Layer<Config.Service>
  // Every folder is trusted, as the core tests run, unless a test says otherwise.
  trusted?: boolean
}) => {
  const watcher = Watcher.testLayer
  const config = input.configLayer ?? Config.testLayer()
  return Layer.mergeAll(
    config,
    AppNodeBuilder.build(
      LayerNode.group([
        InstructionDiscovery.node,
        Bus.node,
        FSUtil.node,
        Global.node,
        Location.node,
        ProjectTrust.node,
        Watcher.node,
      ]),
      [
        Config.node.replace(config),
        WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: input.trusted ?? true })),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: input.project })),
        Global.node.replace(
          input.config || input.home
            ? Global.layerWith({
                ...(input.config ? { config: input.config } : {}),
                ...(input.home ? { home: input.home } : {}),
              })
            : tempGlobalLayer,
        ),
        Location.node.replace(input.locationServiceLayer),
        Watcher.node.replace(watcher),
        ...(input.filesystemLayer ? [FSUtil.node.replace(input.filesystemLayer)] : []),
      ],
    ),
    watcher,
  )
}

const start = Effect.fnUntraced(function* (overrides?: Parameters<typeof host>[0]) {
  yield* ConfigInstructionPlugin.Plugin.effect(host(overrides))
  return yield* InstructionDiscovery.Service
})

const file = (path: string, content: string) =>
  new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })

// Runs `trigger` and waits for the instruction files to be scanned again because of it.
function rescanAfter<A, E, R>(trigger: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const updated = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* trigger
    yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

function emitAndWait(update: Watcher.Update) {
  return Effect.flatMap(Watcher.Test, (watcher) => rescanAfter(watcher.emit(update)))
}

describe("InstructionDiscovery", () => {
  it.effect("stores ordered values with last-write-wins precedence", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "first"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
        editor.add(file("/repo/AGENTS.md", "last"))
        editor.update("/repo/packages/AGENTS.md", (current) => {
          current.content = "updated"
          current.path = AbsolutePath.make("/ignored")
        })
        editor.remove("/missing")
      })

      expect(yield* discovery.list()).toEqual([
        file("/repo/AGENTS.md", "last"),
        file("/repo/packages/AGENTS.md", "updated"),
      ])
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )

  it.effect("preserves admitted values while the source is unavailable", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => editor.unavailable())
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )

  it.effect("renders granular instruction updates", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/global/AGENTS.md", "global"))
        editor.add(
          file("/repo/AGENTS.md", ["old", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")),
        )
      })
      const initial = yield* readInitial(yield* discovery.load())

      yield* discovery.transform((editor) => {
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = ["new", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")
        })
      })
      const modified = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(modified).toContain("The instructions from /repo/AGENTS.md changed. Here's the diff:")
      expect(modified).toContain("-old\n+new")
      expect(modified).not.toContain("global")

      const rewritten = state({
        "core/instructions": [{ path: "/repo/AGENTS.md", content: "old one\nold two\nold three\nold four" }],
      })
      yield* discovery.transform((editor) => {
        editor.remove("/global/AGENTS.md")
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = "new"
        })
      })
      expect((yield* readUpdate(yield* discovery.load(), rewritten)).text).toBe(
        "The instructions changed:\nInstructions from: /repo/AGENTS.md\nnew",
      )

      yield* discovery.transform((editor) => {
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      const structural = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(structural).toContain("The instructions from /global/AGENTS.md no longer apply.")
      expect(structural).toContain("New instructions apply from:\nInstructions from: /repo/packages/AGENTS.md\npackage")
      expect(structural).not.toContain("Instructions from: /global/AGENTS.md\nglobal")
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
  )
})

describe("ConfigInstructionPlugin.Plugin", () => {
  it.live("loads global and upward project files and rescans them on change", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(tmp.path, "home")
        const shared = path.join(home, "code")
        const project = path.join(shared, "repo")
        const directory = path.join(project, "packages", "core")
        const outside = path.join(tmp.path, "AGENTS.md")
        const globalFile = path.join(global, "AGENTS.md")
        const sharedFile = path.join(shared, "AGENTS.md")
        const projectFile = path.join(project, "AGENTS.md")
        const packageFile = path.join(directory, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(sharedFile, "shared")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual(
            [
              path.dirname(globalFile),
              path.dirname(packageFile),
              path.join(project, "packages"),
              project,
              path.dirname(sharedFile),
              home,
            ].flatMap(watched),
          )
          expect(yield* watcher.subscriptions()).not.toContainEqual({
            path: path.join(tmp.path, "AGENTS.md"),
            type: "file",
          })
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
              `Instructions from: ${sharedFile}\nshared`,
            ].join("\n\n"),
          )
          expect(initialized.text).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          yield* emitAndWait({ type: "update", path: packageFile })
          const changed = (yield* readUpdate(yield* discovery.load(), initialized)).text
          expect(changed).toContain(`The instructions changed:\nInstructions from: ${packageFile}\nchanged`)
          expect(changed).not.toContain(`Instructions from: ${globalFile}\nglobal`)

          yield* Effect.promise(() => fs.rm(packageFile))
          yield* emitAndWait({ type: "delete", path: packageFile })
          const removed = (yield* readUpdate(yield* discovery.load(), initialized)).text
          expect(removed).toContain(`The instructions from ${packageFile} no longer apply.`)
          expect(removed).not.toContain(`Instructions from: ${globalFile}\nglobal`)

          yield* Effect.promise(() => fs.rm(globalFile))
          yield* emitAndWait({ type: "delete", path: globalFile })
          yield* Effect.promise(() => fs.rm(projectFile))
          yield* emitAndWait({ type: "delete", path: projectFile })
          yield* Effect.promise(() => fs.rm(sharedFile))
          yield* emitAndWait({ type: "delete", path: sharedFile })
          expect((yield* readUpdate(yield* discovery.load(), initialized)).text).toBe(
            "Previously loaded instructions no longer apply.",
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${file}\n`)
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        ),
      ),
    ),
  )

  it.live("discovers a newly created instruction file above the project root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const home = path.join(tmp.path, "home")
        const shared = path.join(home, "code")
        const project = path.join(shared, "repo")
        const intermediate = path.join(shared, "AGENTS.md")
        const directory = path.join(project, "core")
        const projectFile = path.join(project, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(projectFile, "project"))
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${projectFile}\nproject`)

          yield* Effect.promise(() => fs.writeFile(intermediate, "intermediate"))
          yield* emitAndWait({ type: "create", path: intermediate })

          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [`Instructions from: ${projectFile}\nproject`, `Instructions from: ${intermediate}\nintermediate`].join(
              "\n\n",
            ),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("stops instruction candidates at the project root outside home", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(tmp.path, "home")
        const project = path.join(tmp.path, "scratch", "repo")
        const directory = path.join(project, "packages", "core")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* start()
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual(
            [global, directory, path.join(project, "packages"), project].flatMap(watched),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  // A global directory, a project and a package inside it, each keeping some of the instruction files.
  const writeEachDirectory = (tmp: { readonly path: string }) => {
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "scratch", "repo")
    const directory = path.join(project, "packages", "core")
    return {
      global,
      project,
      directory,
      write: Effect.promise(async () => {
        await fs.mkdir(directory, { recursive: true })
        await fs.mkdir(global, { recursive: true })
        await fs.writeFile(path.join(global, CompatNames.vendor.instructions), "global vendor")
        await fs.writeFile(path.join(directory, "ORBIT.md"), "package orbit")
        await fs.writeFile(path.join(directory, "AGENTS.md"), "package agents")
        await fs.writeFile(path.join(project, "AGENTS.md"), "project agents")
        await fs.writeFile(path.join(project, CompatNames.vendor.instructions), "project vendor")
      }),
    }
  }

  it.live("loads the first of the native files and the reference vendor's file in each directory", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const fixture = writeEachDirectory(tmp)
        return Effect.gen(function* () {
          yield* fixture.write
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [
              `Instructions from: ${path.join(fixture.global, CompatNames.vendor.instructions)}\nglobal vendor`,
              `Instructions from: ${path.join(fixture.directory, "ORBIT.md")}\npackage orbit`,
              `Instructions from: ${path.join(fixture.project, "AGENTS.md")}\nproject agents`,
            ].join("\n\n"),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: fixture.global,
              home: path.join(tmp.path, "home"),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(fixture.directory) },
                    { projectDirectory: AbsolutePath.make(fixture.project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("skips the reference vendor's file, and does not watch it, when compatibility is off", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const fixture = writeEachDirectory(tmp)
        return Effect.gen(function* () {
          yield* fixture.write
          const discovery = yield* start()
          const watcher = yield* Watcher.Test

          // The global directory keeps only the vendor's file, so nothing loads from it.
          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [
              `Instructions from: ${path.join(fixture.directory, "ORBIT.md")}\npackage orbit`,
              `Instructions from: ${path.join(fixture.project, "AGENTS.md")}\nproject agents`,
            ].join("\n\n"),
          )
          expect(yield* watcher.subscriptions()).toEqual(
            [fixture.global, fixture.directory, path.join(fixture.project, "packages"), fixture.project].flatMap(
              watchedNames(nativeNames),
            ),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: fixture.global,
              home: path.join(tmp.path, "home"),
              configLayer: Config.testLayer([], { enabled: false, roots: [] }),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(fixture.directory) },
                    { projectDirectory: AbsolutePath.make(fixture.project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("rescans, and starts watching the reference vendor's file, when a config update turns compatibility on", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const project = path.join(tmp.path, "repo")
        const vendorFile = path.join(project, CompatNames.vendor.instructions)
        const state = { enabled: false }
        const config = Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () => Effect.succeed([]),
            changes: () => Stream.never,
            fingerprints: () => Effect.succeed([]),
            pluginsChanged: () => Effect.succeed(false),
            compatEnabled: () => Effect.sync(() => state.enabled),
            compat: () => Effect.sync(() => ({ enabled: state.enabled, roots: [] })),
          }),
        )
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(project, { recursive: true })
            await fs.writeFile(vendorFile, "vendor notes")
          })
          const bus = yield* Bus.Service
          const watcher = yield* Watcher.Test
          const discovery = yield* start({ event: { subscribe: () => bus.subscribe(Event.Updated) } })
          // Flips the switch and publishes the config update it arrives with, then waits for the rescan it causes.
          const turn = (enabled: boolean) =>
            Effect.gen(function* () {
              const updated = yield* Deferred.make<void>()
              const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
                Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
                Effect.forkScoped,
              )
              yield* Effect.yieldNow
              state.enabled = enabled
              yield* bus.publish(Event.Updated, {})
              yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
              yield* Fiber.interrupt(fiber)
              return yield* discovery.list()
            })

          expect(yield* discovery.list()).toEqual([])
          expect(yield* watcher.subscriptions()).not.toContainEqual({ path: vendorFile, type: "file" })

          expect(yield* turn(true)).toEqual([file(vendorFile, "vendor notes")])
          expect(yield* watcher.subscriptions()).toContainEqual({ path: vendorFile, type: "file" })

          expect(yield* turn(false)).toEqual([])
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              home: path.join(tmp.path, "home"),
              configLayer: config,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(project) })),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.effect("isolates source failure without failing activation", () => {
    const failingFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: failingFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("marks a discovered file that disappears before read as unavailable", () => {
    const discovered = AbsolutePath.make("/repo/AGENTS.md")
    const racingFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({
            ...fs,
            up: () => Effect.succeed([discovered]),
            readFileStringSafe: () => Effect.undefined,
          }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: discovered, content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: racingFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("canonicalizes boundaries and honors project opt-out", () =>
    Effect.gen(function* () {
      const observed: { values: FSUtil.UpOptions[] } = { values: [] }
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) => Effect.sync(() => (observed.values.push(options), [])),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )
      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            project: false,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )
      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      const repo = path.resolve("/repo")
      expect(observed.values).toEqual([{ targets: allNames, start: repo, stop: repo, type: "file" }])
    }),
  )
})

// A project that is not trusted yet supplies only what is inside it. A clone recreates the links a repository ships, so a
// link named like an instruction file can lead to any file of the user's, such as a key, and the plugin would put it into
// the first request. Where this account cannot create a link to a file (Windows without a privilege), a regular file
// stands in for it and the file system answers for its real path as it would for the link, which is all the plugin
// sees of one.
describe("ConfigInstructionPlugin.Plugin in a project that is not trusted", () => {
  const linking = (links: Readonly<Record<string, string>>) =>
    Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({ ...fs, resolve: (input) => fs.resolve(links[path.resolve(input)] ?? input) }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

  const modes = [
    { how: "a symlink", real: true },
    { how: "a file that resolves like a symlink", real: false },
  ] as const

  for (const mode of modes)
    (mode.real && !canLinkFile ? it.live.skip : it.live)(
      `leaves out ${mode.how} that leaves the project and the files above it, until the project is trusted`,
      () =>
        Effect.acquireRelease(
          Effect.promise(() => tmpdir()),
          (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
        ).pipe(
          Effect.flatMap((tmp) => {
            const home = path.join(tmp.path, "home")
            const shared = path.join(home, "code")
            const project = path.join(shared, "repo")
            const directory = path.join(project, "packages", "core")
            const secret = path.join(tmp.path, "secret.txt")
            const notes = path.join(project, "docs", "notes.md")
            // The package links to a file of the project's own. The project folder has a link to the user's secret under
            // the first name, and a regular file under the second, which takes its place while the link is left out.
            const inside = path.join(directory, "AGENTS.md")
            const outside = path.join(project, "ORBIT.md")
            const projectFile = path.join(project, "AGENTS.md")
            const sharedFile = path.join(shared, "AGENTS.md")
            const skipped: Array<{ path: unknown; reason: unknown }> = []
            const logger = Logger.map(Logger.formatStructured, (entry) => {
              if (!Array.isArray(entry.message) || entry.message[0] !== "instruction file skipped") return
              skipped.push(entry.message[1])
            })
            return Effect.gen(function* () {
              yield* Effect.promise(async () => {
                await fs.mkdir(directory, { recursive: true })
                await fs.mkdir(path.dirname(notes), { recursive: true })
                await fs.writeFile(secret, "TOP SECRET")
                await fs.writeFile(notes, "notes")
                await fs.writeFile(projectFile, "project")
                await fs.writeFile(sharedFile, "shared")
                if (mode.real) {
                  await fs.symlink(notes, inside)
                  await fs.symlink(secret, outside)
                } else {
                  await fs.writeFile(inside, "stand-in")
                  await fs.writeFile(outside, "stand-in")
                }
              })
              const discovery = yield* start()
              const trust = yield* ProjectTrust.Service
              const loaded = discovery
                .list()
                .pipe(
                  Effect.map((files) =>
                    Array.isArray(files) ? files.map((item) => [item.path, item.content]) : files,
                  ),
                )

              // What is inside the project, for real, is read. The user's secret is not, nor is the file in the folder
              // above the project, and each of them is reported once.
              const untrusted = [
                [notes, "notes"],
                [projectFile, "project"],
              ]
              expect(yield* loaded).toEqual(untrusted)
              expect(skipped).toMatchObject([{ path: outside }, { path: sharedFile }])
              expect(skipped.map((item) => item.reason)).toEqual(Array(2).fill(expect.stringContaining("not trusted")))

              // Trusting the project reads them too, without a restart and without a config reload, which a project with
              // no config of its own does not have.
              yield* rescanAfter(trust.grant({ persist: false, via: "test" }))
              expect(yield* loaded).toEqual([
                [notes, "notes"],
                [secret, "TOP SECRET"],
                [projectFile, "project"],
                [sharedFile, "shared"],
              ])
              expect(skipped).toHaveLength(2)

              yield* rescanAfter(trust.revoke())
              expect(yield* loaded).toEqual(untrusted)
            }).pipe(
              Effect.provide(
                instructionLayer({
                  config: path.join(tmp.path, "global"),
                  home,
                  trusted: false,
                  filesystemLayer: mode.real ? undefined : linking({ [inside]: notes, [outside]: secret }),
                  locationServiceLayer: Layer.succeed(
                    Location.Service,
                    Location.Service.of(
                      location(
                        { directory: AbsolutePath.make(directory) },
                        { projectDirectory: AbsolutePath.make(project) },
                      ),
                    ),
                  ),
                }),
              ),
              Effect.provide(Logger.layer([logger])),
            )
          }),
        ),
    )
})

function watchedNames(names: readonly string[]) {
  return (directory: string) =>
    names.map((name) => ({
      path: path.join(directory, name),
      type: "file" as const,
    }))
}
const watched = watchedNames(allNames)
