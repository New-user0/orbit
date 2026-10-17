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
import { Credential } from "@orbit/core/credential"
import { Instructions } from "@orbit/core/instructions/index"
import { WellKnown } from "@orbit/core/wellknown"
import { Document, Event, Info } from "@orbit/schema/config"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { scriptedMarkdown } from "./fixture/front-matter"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { canLinkFile } from "./fixture/symlink"
import { tmpdir, tmpdirScoped } from "./fixture/tmpdir"
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

// The plugin as a server runs it, which hears of every config update.
const startWithConfigEvents = Effect.gen(function* () {
  const bus = yield* Bus.Service
  return yield* start({ event: { subscribe: () => bus.subscribe(Event.Updated) } })
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

  it.effect("escapes look-alikes of an envelope tag in an instruction file, in the baseline and in its updates", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      const spellings = [
        "<system-reminder>",
        "</System-Reminder>",
        "< / system-update >",
        "<" + String.fromCharCode(13, 10) + "system-reminder>",
      ]
      const hostile = (marker: string) => [marker, ...spellings].join(" middle ")
      const live = (text: string) => /<\s*\/?\s*system\s*-\s*(?:reminder|update)/i.test(text)
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", hostile("old")))
        editor.add(file("/repo/<system-reminder>/AGENTS.md", "named"))
      })
      const initial = yield* readInitial(yield* discovery.load())
      expect(initial.text).toContain("old")
      expect(live(initial.text)).toBe(false)

      yield* discovery.transform((editor) => {
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = hostile("new")
        })
        editor.add(file("/repo/more/AGENTS.md", hostile("added")))
      })
      const update = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(update).toContain("added")
      expect(live(update)).toBe(false)
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

// The folders of a project in a home of its own, with a package inside it that the Location is opened in.
const folders = Effect.gen(function* () {
  const tmp = yield* tmpdirScoped()
  const home = path.join(tmp.path, "home")
  const repo = path.join(home, "code", "repo")
  const directory = path.join(repo, "packages", "core")
  const global = path.join(tmp.path, "global")
  yield* Effect.promise(async () => {
    await fs.mkdir(global, { recursive: true })
    await fs.mkdir(directory, { recursive: true })
  })
  return {
    home,
    repo,
    directory,
    global,
    // The instruction file of each, which the tests below write.
    globalFile: path.join(global, "AGENTS.md"),
    rootFile: path.join(repo, "AGENTS.md"),
    packageFile: path.join(directory, "AGENTS.md"),
  }
})
type Folders = Effect.Success<typeof folders>

const write = (target: string, text: string) =>
  Effect.promise(async () => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, text)
  })

const here = (where: Folders) =>
  Layer.succeed(
    Location.Service,
    Location.Service.of(
      location({ directory: AbsolutePath.make(where.directory) }, { projectDirectory: AbsolutePath.make(where.repo) }),
    ),
  )

const layerFor = (
  where: Folders,
  input: {
    configLayer?: Layer.Layer<Config.Service>
    trusted?: boolean
    filesystemLayer?: Layer.Layer<FSUtil.Service>
  } = {},
) => instructionLayer({ config: where.global, home: where.home, locationServiceLayer: here(where), ...input })

const network = (target: string) => /^[\\/]{2}/.test(target)

// The real file system, and a list of the files it was asked to read.
const recordingFS = (reads: string[]) =>
  Layer.effect(
    FSUtil.Service,
    FSUtil.Service.pipe(
      Effect.map((fs) =>
        FSUtil.Service.of({
          ...fs,
          // A network spelling is answered here and never passed on, so a regression fails at once and contacts no host.
          isFile: (target) => (network(target) ? Effect.succeed(false) : fs.isFile(target)),
          readFileStringSafe: (target) => (
            reads.push(target),
            network(target) ? Effect.succeed(undefined) : fs.readFileStringSafe(target)
          ),
        }),
      ),
    ),
  ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

const slashed = (value: string) => value.replaceAll("\\", "/")

// A document of settings that excludes instruction files, as it is for a scope that no trust decision holds back.
const excluding = (patterns: string[], scope: "user" | "project" | "local" | "flag" = "user") =>
  new Document({ type: "document", scope, info: new Info({ instructions_exclude: patterns }) })

const placesOf = (files: readonly InstructionDiscovery.File[] | Instructions.Unavailable) =>
  Array.isArray(files) ? files.map((item) => item.path) : files

// Waits, on the real clock, until a read is what it should become: a rescan that a config reload causes cannot be waited
// for as an event, because the rescan that a grant causes comes first.
const eventually = <A, E, R>(read: Effect.Effect<A, E, R>, done: (value: A) => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* read
      if (done(value)) return value
      yield* Effect.sleep("25 millis")
    }
    return yield* read
  })

// Every file that the model reads is processed first (`ConfigInstructionFile`).
describe("ConfigInstructionPlugin.Plugin processes the files it loads", () => {
  it.live("loads what is left of a file once its front matter and comments are off", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* write(
        where.rootFile,
        "---\ntitle: x\n---\n\n<!-- note to self -->\n\n# Rules\n\nUse tabs.\n<!-- tail -->\n",
      )
      yield* write(where.globalFile, "<!-- private -->\n\nBe brief.\n")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(yield* discovery.list()).toEqual([
          file(where.globalFile, "Be brief.\n"),
          file(where.rootFile, "# Rules\n\nUse tabs.\n"),
        ])
        expect((yield* readInitial(yield* discovery.load())).text).toBe(
          [
            `Instructions from: ${where.globalFile}\nBe brief.\n`,
            `Instructions from: ${where.rootFile}\n# Rules\n\nUse tabs.\n`,
          ].join("\n\n"),
        )
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("removes the front matter of a file that an editor saved with a byte order mark", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* write(where.rootFile, "﻿---\ntitle: x\n---\n<!-- note -->\nRules.\n")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(yield* discovery.list()).toEqual([file(where.rootFile, "Rules.\n")])
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  const empty: ReadonlyArray<readonly [string, string]> = [
    ["empty", ""],
    ["only whitespace", "  \n\n\t\n"],
    ["only comments", "<!-- one -->\n\n<!--\ntwo\n-->\n"],
    ["only front matter", "---\ntitle: x\n---\n"],
    ["only front matter and a comment", "---\ntitle: x\n---\n<!-- c -->\n"],
  ]
  for (const [name, text] of empty)
    it.live(`adds nothing for a file that is ${name}, so that the source reads as removed`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        yield* write(where.rootFile, text)
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          expect(yield* discovery.list()).toEqual([])
          expect(yield* discovery.warnings()).toEqual([])
          expect(
            (yield* readUpdate(
              yield* discovery.load(),
              state({ "core/instructions": [{ path: where.rootFile, content: "old" }] }),
            )).text,
          ).toBe("Previously loaded instructions no longer apply.")
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

  it.live("keeps the first name of a directory, so that a file with nothing left does not hand it to the next", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const first = path.join(where.repo, "ORBIT.md")
      yield* write(first, "<!-- nothing to say yet -->\n")
      yield* write(where.rootFile, "agents rules")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(yield* discovery.list()).toEqual([])
        // The control: the same directory, with text in the first name, loads that name and not the other.
        yield* write(first, "orbit rules")
        yield* emitAndWait({ type: "update", path: first })
        expect(yield* discovery.list()).toEqual([file(first, "orbit rules")])
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  // The front matter of an instruction file is a reader of the kind that gray-matter evaluates. These spellings run as
  // code in an unprotected parser (the test of `ConfigInstructionFile` proves it), and here they write no marker.
  for (const language of ["js", "javascript", "JS", "JavaScript", " js", "coffee"])
    it.live(`reads front matter that opens with ---${language} as text, and runs nothing`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        const marker = path.join(where.home, "ran")
        const text = scriptedMarkdown(marker, language)
        yield* write(where.rootFile, text)
        yield* write(where.globalFile, text)
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          expect(yield* discovery.list()).toEqual([file(where.globalFile, text), file(where.rootFile, text)])
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }).pipe(Effect.provide(layerFor(where)))
      }),
    )

  it.live("removes a bare block that a script fills, with CRLF line endings, and runs nothing", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const marker = path.join(where.home, "ran")
      const script = `{ description: (require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"), "x") }`
      yield* write(where.rootFile, `---\r\n${script}\r\n---\r\nRules.\r\n`)
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(yield* discovery.list()).toEqual([file(where.rootFile, "Rules.\r\n")])
        expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("starts no instruction update when only a comment, or only the front matter, of a loaded file changes", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* write(where.rootFile, "---\nversion: 1\n---\nRules.\n<!-- first -->\n")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        const initial = yield* readInitial(yield* discovery.load())
        expect(initial.text).toBe(`Instructions from: ${where.rootFile}\nRules.\n`)

        yield* write(where.rootFile, "---\nversion: 1\n---\nRules.\n<!-- second, and longer -->\n")
        yield* emitAndWait({ type: "update", path: where.rootFile })
        expect((yield* readUpdate(yield* discovery.load(), initial)).changed).toBe(false)

        yield* write(where.rootFile, "---\nversion: 2\nmore: keys\n---\nRules.\n")
        yield* emitAndWait({ type: "update", path: where.rootFile })
        expect((yield* readUpdate(yield* discovery.load(), initial)).changed).toBe(false)

        // The control: a change of the text that the model reads is an update.
        yield* write(where.rootFile, "---\nversion: 2\n---\nRules, changed.\n")
        yield* emitAndWait({ type: "update", path: where.rootFile })
        const changed = yield* readUpdate(yield* discovery.load(), initial)
        expect(changed.changed).toBe(true)
        expect(changed.text).toBe(`The instructions changed:\nInstructions from: ${where.rootFile}\nRules, changed.\n`)
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )
})

describe("ConfigInstructionPlugin.Plugin applies instructions_exclude", () => {
  const everywhere = (where: Folders) =>
    Effect.all([write(where.globalFile, "global"), write(where.rootFile, "root"), write(where.packageFile, "package")])

  // What loads, for each list of patterns that the user's own settings hold, from the three files of `everywhere`.
  const rows: ReadonlyArray<readonly [string, (where: Folders) => string[], (where: Folders) => string[]]> = [
    ["nothing", () => [], (w) => [w.globalFile, w.packageFile, w.rootFile]],
    [
      "a nested file, by a pattern that works wherever the project is",
      () => ["**/packages/**/AGENTS.md"],
      (w) => [w.globalFile, w.rootFile],
    ],
    ["a nested file, by its absolute path", (w) => [slashed(w.packageFile)], (w) => [w.globalFile, w.rootFile]],
    [
      "the file of the user's own config, by its absolute path",
      (w) => [slashed(w.globalFile)],
      (w) => [w.packageFile, w.rootFile],
    ],
    ["every file, by a pattern for the name", () => ["**/AGENTS.md"], () => []],
    [
      "files by braces, and not the one they do not name",
      (w) => [`{${slashed(w.globalFile)},${slashed(w.rootFile)}}`],
      (w) => [w.packageFile],
    ],
    [
      "nothing, by a bare name, a relative path or a path with `~`",
      () => ["AGENTS.md", "packages/core/AGENTS.md", "./AGENTS.md", "~/AGENTS.md", "*.md", ""],
      (w) => [w.globalFile, w.packageFile, w.rootFile],
    ],
    [
      "nothing, by a pattern that is too long for the matcher, and the others still apply",
      (w) => [`/${"x".repeat(70_000)}`, slashed(w.rootFile)],
      (w) => [w.globalFile, w.packageFile],
    ],
  ]
  for (const [name, patterns, loads] of rows)
    it.live(`loads what is left of three files when the list excludes ${name}`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        yield* everywhere(where)
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          expect(placesOf(yield* discovery.list())).toEqual(loads(where))
        }).pipe(Effect.provide(layerFor(where, { configLayer: Config.testLayer([excluding(patterns(where))]) })))
      }),
    )

  it.live("never opens a file that a pattern excludes", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* everywhere(where)
      const reads: string[] = []
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(placesOf(yield* discovery.list())).toEqual([where.globalFile, where.rootFile])
        // The control: the files that are not excluded are opened.
        expect(reads).toContain(where.rootFile)
        expect(reads).toContain(where.globalFile)
        expect(reads).not.toContain(where.packageFile)
      }).pipe(
        Effect.provide(
          layerFor(where, {
            filesystemLayer: recordingFS(reads),
            configLayer: Config.testLayer([excluding(["**/packages/core/AGENTS.md"])]),
          }),
        ),
      )
    }),
  )

  it.live("sees one update, and then none, when what is stored is the file as it was before comments came off", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* write(where.rootFile, "---\ntitle: x\n---\n# Rules\n<!-- note -->\nUse tabs.\n")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        const stored = state({
          "core/instructions": [
            { path: where.rootFile, content: "---\ntitle: x\n---\n# Rules\n<!-- note -->\nUse tabs.\n" },
          ],
        })
        const first = yield* readUpdate(yield* discovery.load(), stored)
        expect(first.changed).toBe(true)
        expect(first.values["core/instructions"]).toEqual([{ path: where.rootFile, content: "# Rules\nUse tabs.\n" }])
        expect((yield* readUpdate(yield* discovery.load(), first)).changed).toBe(false)
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  const firstNames: ReadonlyArray<readonly [string, string[], string, string]> = [
    ["nothing is excluded", [], "ORBIT.md", "orbit rules"],
    ["the first name is excluded", ["**/ORBIT.md"], "AGENTS.md", "agents rules"],
  ]
  for (const [name, patterns, loaded, text] of firstNames)
    it.live(`loads the one name that a directory gives when ${name}`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        yield* write(path.join(where.repo, "ORBIT.md"), "orbit rules")
        yield* write(where.rootFile, "agents rules")
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          expect(yield* discovery.list()).toEqual([file(path.join(where.repo, loaded), text)])
        }).pipe(Effect.provide(layerFor(where, { configLayer: Config.testLayer([excluding(patterns)]) })))
      }),
    )

  it.live("adds up the lists of every scope", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* everywhere(where)
      const configLayer = Config.testLayer([
        excluding(["**/packages/core/AGENTS.md"], "user"),
        excluding([slashed(where.rootFile)], "project"),
        excluding(["**/never/**"], "local"),
      ])
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(placesOf(yield* discovery.list())).toEqual([where.globalFile])
      }).pipe(Effect.provide(layerFor(where, { configLayer })))
    }),
  )

  // A file that is a link is matched by the name that the walk built, and by the file that the link leads to.
  const linked = canLinkFile ? it.live : it.live.skip
  for (const pattern of [undefined, "**/packages/core/AGENTS.md", "**/shared/rules.md"])
    linked(
      `leaves out a link ${pattern === undefined ? "to nothing that a pattern names" : `that the pattern ${pattern} names`}`,
      () =>
        Effect.gen(function* () {
          const where = yield* folders
          const target = path.join(where.repo, "shared", "rules.md")
          yield* write(target, "shared rules")
          yield* write(where.rootFile, "root")
          yield* Effect.promise(() => fs.symlink(target, where.packageFile))
          yield* Effect.gen(function* () {
            const discovery = yield* start()
            expect(placesOf(yield* discovery.list())).toEqual(
              pattern === undefined ? [target, where.rootFile] : [where.rootFile],
            )
          }).pipe(
            Effect.provide(
              layerFor(where, { configLayer: Config.testLayer(pattern === undefined ? [] : [excluding([pattern])]) }),
            ),
          )
        }),
    )

  it.live("applies a changed list at once, and the file leaves the baseline as one that no longer applies", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* everywhere(where)
      const config = Config.testLayer()
      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service
        const settings = yield* Config.Test
        const discovery = yield* start({ event: { subscribe: () => bus.subscribe(Event.Updated) } })
        const initial = yield* readInitial(yield* discovery.load())
        expect(initial.text).toContain(`Instructions from: ${where.rootFile}\nroot`)

        const change = (entries: Parameters<typeof settings.setEntries>[0]) =>
          rescanAfter(settings.setEntries(entries).pipe(Effect.andThen(bus.publish(Event.Updated, {}))))
        yield* change([excluding([slashed(where.rootFile)])])
        const update = yield* readUpdate(yield* discovery.load(), initial)
        expect(update.text).toBe(`The instructions from ${where.rootFile} no longer apply.`)
        expect(placesOf(yield* discovery.list())).toEqual([where.globalFile, where.packageFile])

        yield* change([])
        expect(placesOf(yield* discovery.list())).toEqual([where.globalFile, where.packageFile, where.rootFile])
      }).pipe(Effect.provide(Layer.mergeAll(layerFor(where, { configLayer: config }), config)))
    }),
  )

  // Exclusion only takes files out. The gate for a project that is not trusted is asked of what is left, and a file that a
  // pattern took out is not reported as one that the gate refused.
  const skippedNotices = () => {
    const skipped: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (Array.isArray(entry.message) && entry.message[0] === "instruction file skipped")
        skipped.push(entry.message[1])
    })
    return { skipped, logger: Logger.layer([logger]) }
  }
  for (const [name, patterns, reported] of [
    ["no pattern", [], true],
    ["a pattern for another file", ["**/packages/**"], true],
    ["a pattern for that file", ["**/code/AGENTS.md"], false],
  ] as const)
    it.live(`reports a file above a project that is not trusted unless a pattern takes it out: ${name}`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        const above = path.join(where.home, "code", "AGENTS.md")
        yield* write(above, "above the project")
        yield* write(where.rootFile, "root")
        const { skipped, logger } = skippedNotices()
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          // Whatever the patterns say, the file above the project is not loaded, and the project's own file is.
          expect(placesOf(yield* discovery.list())).toEqual([where.rootFile])
          expect(skipped).toMatchObject(reported ? [{ path: above }] : [])
          expect(skipped).toHaveLength(reported ? 1 : 0)
        }).pipe(
          Effect.provide(
            layerFor(where, { trusted: false, configLayer: Config.testLayer([excluding([...patterns])]) }),
          ),
          Effect.provide(logger),
        )
      }),
    )
})

// The real configuration loader, over a project in a home of its own: the document of a project that is not trusted has
// lost its list, because the lists of every scope are added up and a repository's could hide the user's own files.
describe("ConfigInstructionPlugin.Plugin reads the list of the documents that the config stamped", () => {
  const stamped = (where: Folders, trusted: boolean) => {
    const watcher = Watcher.testLayer
    return Layer.mergeAll(
      AppNodeBuilder.build(
        LayerNode.group([
          Config.node,
          InstructionDiscovery.node,
          Bus.node,
          FSUtil.node,
          Global.node,
          Location.node,
          ProjectTrust.node,
          Watcher.node,
        ]),
        [
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: trusted })),
          Global.node.replace(Global.layerWith({ config: where.global, home: where.home })),
          Location.node.replace(here(where)),
          Watcher.node.replace(watcher),
          Credential.node.replace(emptyCredentialNode),
          WellKnown.node.replace(emptyWellknownNode),
        ],
      ),
      watcher,
    )
  }

  for (const document of ["orbit.json", "orbit.local.json"]) {
    it.live(`applies the list of ${document} in a project that is trusted`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        yield* write(where.rootFile, "project rules")
        yield* write(path.join(where.repo, document), JSON.stringify({ instructions_exclude: ["**/AGENTS.md"] }))
        yield* Effect.gen(function* () {
          const discovery = yield* startWithConfigEvents
          expect(yield* discovery.list()).toEqual([])
        }).pipe(Effect.provide(stamped(where, true)))
      }),
    )

    it.live(
      `withholds the list of ${document} while the project is not trusted, and applies it once it is`,
      () =>
        Effect.gen(function* () {
          const where = yield* folders
          yield* write(where.rootFile, "project rules")
          yield* write(path.join(where.repo, document), JSON.stringify({ instructions_exclude: ["**/AGENTS.md"] }))
          yield* Effect.gen(function* () {
            const discovery = yield* startWithConfigEvents
            const trust = yield* ProjectTrust.Service
            expect(placesOf(yield* discovery.list())).toEqual([where.rootFile])

            yield* trust.grant({ persist: false, via: "test" })
            const granted = yield* eventually(discovery.list(), (files) => Array.isArray(files) && files.length === 0)
            expect(placesOf(granted)).toEqual([])

            yield* trust.revoke()
            const revoked = yield* eventually(discovery.list(), (files) => Array.isArray(files) && files.length > 0)
            expect(placesOf(revoked)).toEqual([where.rootFile])
          }).pipe(Effect.provide(stamped(where, false)))
        }),
      // Each wait ends on the first read that has changed, and gives up after five seconds.
      30_000,
    )
  }

  for (const trusted of [false, true])
    it.live(`keeps the list of the user's own config in a project that ${trusted ? "is" : "is not"} trusted`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        yield* write(where.rootFile, "project rules")
        yield* write(path.join(where.global, "orbit.json"), JSON.stringify({ instructions_exclude: ["**/AGENTS.md"] }))
        yield* Effect.gen(function* () {
          const discovery = yield* startWithConfigEvents
          expect(yield* discovery.list()).toEqual([])
        }).pipe(Effect.provide(stamped(where, trusted)))
      }),
    )
})

describe("ConfigInstructionPlugin.Plugin warns about the size of a file", () => {
  const warning = (target: string, characters: number) =>
    new InstructionDiscovery.Warning({ path: AbsolutePath.make(target), kind: "size", characters, limit: 40_000 })

  it.live("flags a file over 40,000 characters, loads it whole and keeps the warning out of the value", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const large = `# Rules\n${"x".repeat(39_992)}\n`
      const exact = "y".repeat(40_000)
      expect(large.length).toBe(40_001)
      yield* write(where.globalFile, large)
      yield* write(where.rootFile, exact)
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        // The file is not cut, and the warning is neither a field of it nor in the text.
        const files = yield* discovery.list()
        expect(files).toEqual([file(where.globalFile, large), file(where.rootFile, exact)])
        expect(Array.isArray(files) && files.map((item) => Object.keys(item))).toEqual([
          ["path", "content"],
          ["path", "content"],
        ])
        expect(yield* discovery.warnings()).toEqual([warning(where.globalFile, 40_001)])
        expect((yield* readInitial(yield* discovery.load())).text).toBe(
          `Instructions from: ${where.globalFile}\n${large}\n\nInstructions from: ${where.rootFile}\n${exact}`,
        )
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("changes no hash and starts no update when a warning appears or goes", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const large = "z".repeat(40_001)
      yield* write(where.rootFile, large)
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        const initial = yield* readInitial(yield* discovery.load())
        // What is stored is the file as it is, and nothing else: the value that a file with no warning has.
        expect(initial.values["core/instructions"]).toEqual([{ path: where.rootFile, content: large }])
        const hash = Instructions.hash(initial.values["core/instructions"]!)
        expect(hash).toBe(Instructions.hash([{ path: where.rootFile, content: large }]))

        yield* discovery.transform((editor) => editor.warn(warning(where.rootFile, 41_000)))
        expect(yield* discovery.warnings()).toHaveLength(2)
        const after = yield* readUpdate(yield* discovery.load(), initial)
        expect(after.changed).toBe(false)
        expect(Instructions.hash(after.values["core/instructions"]!)).toBe(hash)
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("measures the text that is left, so that comments and front matter do not count", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const raw = `---\n${"k: v\n".repeat(2_000)}---\n<!--\n${"c".repeat(20_000)}\n-->\n\n${"x".repeat(30_000)}\n`
      expect(raw.length).toBeGreaterThan(50_000)
      yield* write(where.rootFile, raw)
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(yield* discovery.list()).toEqual([file(where.rootFile, `${"x".repeat(30_000)}\n`)])
        expect(yield* discovery.warnings()).toEqual([])
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.live("drops the warning when the file is rescanned and is short enough, and makes it again", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* write(where.rootFile, "x".repeat(40_001))
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(yield* discovery.warnings()).toEqual([warning(where.rootFile, 40_001)])
        yield* write(where.rootFile, "short")
        yield* emitAndWait({ type: "update", path: where.rootFile })
        expect(yield* discovery.warnings()).toEqual([])
        yield* write(where.rootFile, "x".repeat(40_002))
        yield* emitAndWait({ type: "update", path: where.rootFile })
        expect(yield* discovery.warnings()).toEqual([warning(where.rootFile, 40_002)])
      }).pipe(Effect.provide(layerFor(where)))
    }),
  )

  it.effect("drops the warning of a file that is removed", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "x"))
        editor.add(file("/repo/other/AGENTS.md", "y"))
        editor.warn(warning("/repo/AGENTS.md", 50_000))
        editor.warn(warning("/repo/other/AGENTS.md", 60_000))
        editor.remove("/repo/AGENTS.md")
      })
      expect(yield* discovery.warnings()).toEqual([warning("/repo/other/AGENTS.md", 60_000)])
    }).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([InstructionDiscovery.node, Bus.node])))),
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

const scoped = (where: Folders, trusted = true) => Effect.provide(layerFor(where, { trusted }))

describe("ConfigInstructionPlugin.Plugin follows @imports", () => {
  const blocks = (where: Folders, ...entries: Array<readonly [string, string]>) =>
    entries.map(([name, content]) => `Instructions from: ${path.join(where.repo, name)}\n${content}`).join("\n\n")

  for (const trusted of [true, false])
    it.live(`renders an import as a block of its own right after its importer, in a project that ${trusted ? "is" : "is not"} trusted`, () =>
      Effect.gen(function* () {
        const where = yield* folders
        yield* write(where.rootFile, "root @./docs/a.md\n")
        yield* write(path.join(where.repo, "docs", "a.md"), "A @./b.md")
        yield* write(path.join(where.repo, "docs", "b.md"), "B")
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          const initial = yield* readInitial(yield* discovery.load())
          // The importer's own text keeps its token, and the model is not told which file imported which.
          expect(initial.text).toBe(
            blocks(where, ["AGENTS.md", "root @./docs/a.md\n"], ["docs/a.md", "A @./b.md"], ["docs/b.md", "B"]),
          )
          expect(initial.text).not.toContain("imported")
          expect(yield* discovery.imports()).toEqual([
            new InstructionDiscovery.Import({
              path: AbsolutePath.make(path.join(where.repo, "docs", "a.md")),
              importedBy: AbsolutePath.make(where.rootFile),
            }),
            new InstructionDiscovery.Import({
              path: AbsolutePath.make(path.join(where.repo, "docs", "b.md")),
              importedBy: AbsolutePath.make(path.join(where.repo, "docs", "a.md")),
            }),
          ])
          // What is stored is the files and nothing about which one imported which, so no hash depends on it.
          expect(initial.values["core/instructions"]).toEqual([
            { path: where.rootFile, content: "root @./docs/a.md\n" },
            { path: path.join(where.repo, "docs", "a.md"), content: "A @./b.md" },
            { path: path.join(where.repo, "docs", "b.md"), content: "B" },
          ])
        }).pipe(scoped(where, trusted))
      }),
    )

  it.live("loads a file that is both imported and found by the walk once, where it comes first", () =>
    Effect.gen(function* () {
      const where = yield* folders
      yield* write(where.globalFile, `global @${where.rootFile.replaceAll("\\", "/")}`)
      yield* write(where.rootFile, "root")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(placesOf(yield* discovery.list())).toEqual([where.globalFile, where.rootFile])
        expect(yield* discovery.imports()).toHaveLength(1)
      }).pipe(scoped(where))
    }),
  )

  it.live("starts a watch on an import, rescans when it changes, and sends only that file's change", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const imported = path.join(where.repo, "docs", "a.md")
      yield* write(where.rootFile, "root @./docs/a.md")
      yield* write(imported, "first")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        const watcher = yield* Watcher.Test
        expect(yield* watcher.subscriptions()).toContainEqual({ path: imported, type: "file" })
        const initial = yield* readInitial(yield* discovery.load())
        yield* write(imported, "second")
        yield* emitAndWait({ type: "update", path: imported })
        const update = yield* readUpdate(yield* discovery.load(), initial)
        expect(update.text).toContain(`Instructions from: ${imported}\nsecond`)
        expect(update.text).not.toContain(where.rootFile)
      }).pipe(scoped(where))
    }),
  )

  it.live("watches an import that a saved importer newly names, and stops watching one it no longer names", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const first = path.join(where.repo, "docs", "first.md")
      const second = path.join(where.repo, "docs", "second.md")
      yield* write(where.rootFile, "root @./docs/first.md")
      yield* write(first, "first")
      yield* write(second, "second")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        const watcher = yield* Watcher.Test
        const bus = yield* Bus.Service
        const subscribed = (target: string) =>
          watcher.subscriptions().pipe(Effect.map((all) => all.filter((item) => item.path === target).length))
        expect(yield* subscribed(first)).toBe(1)
        expect(yield* subscribed(second)).toBe(0)

        yield* write(where.rootFile, "root @./docs/second.md")
        yield* emitAndWait({ type: "update", path: where.rootFile })
        expect(placesOf(yield* discovery.list())).toEqual([where.rootFile, second])
        expect(yield* subscribed(second)).toBe(1)

        // The old import is not watched any more: a change to it starts no rescan.
        let rescans = 0
        yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
          Stream.runForEach(() => Effect.sync(() => void rescans++)),
          Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const watcherTest = yield* Watcher.Test
        yield* watcherTest.emit({ type: "update", path: first })
        yield* Effect.sleep("500 millis")
        expect(rescans).toBe(0)
        // The control: the one it names now still is.
        yield* emitAndWait({ type: "update", path: second })
      }).pipe(scoped(where))
    }),
  )

  it.live("does not watch a target that is missing, a folder, or one that was refused", () =>
    Effect.gen(function* () {
      const where = yield* folders
      const outside = path.join(where.home, "outside.md")
      yield* write(where.rootFile, "root @./missing.md @./docs @../../outside.md @//server/share/x.md")
      yield* write(path.join(where.repo, "docs", "x.md"), "X")
      yield* write(outside, "OUTSIDE")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        const watcher = yield* Watcher.Test
        expect(placesOf(yield* discovery.list())).toEqual([where.rootFile])
        const subscribed = (yield* watcher.subscriptions()).map((item) => item.path.replaceAll("\\", "/"))
        for (const wanted of [path.join(where.repo, "missing.md"), path.join(where.repo, "docs"), outside])
          expect(subscribed).not.toContain(wanted.replaceAll("\\", "/"))
        expect(subscribed.some((item) => item.includes("server"))).toBe(false)
      }).pipe(scoped(where))
    }),
  )
})

describe("ConfigInstructionPlugin.Plugin keeps a project's imports inside the project", () => {
  const linked = canLinkFile
  // The folders above the project, the user's secret and the files a repository imports on its way out.
  const layout = Effect.gen(function* () {
    const where = yield* folders
    const secret = path.join(path.dirname(where.home), "secret.txt")
    const above = path.join(where.home, "above.md")
    const inside = path.join(where.repo, "docs", "inside.md")
    const back = path.join(where.repo, "docs", "back.md")
    yield* write(secret, "TOP SECRET MARKER")
    yield* write(above, "ABOVE MARKER")
    yield* write(inside, "INSIDE MARKER")
    yield* write(back, "BACK MARKER")
    return { where, secret, above, inside, back }
  })
  const slashed = (value: string) => value.replaceAll("\\", "/")
  const import_ = (value: string) => `@${slashed(value)}`

  for (const trusted of [true, false]) {
    it.live(`skips an import that leaves the project, with one warning for each, in a project that ${trusted ? "is" : "is not"} trusted`, () =>
      Effect.gen(function* () {
        const { where, secret, above, inside, back } = yield* layout
        yield* write(
          where.rootFile,
          [
            "@./docs/inside.md",
            "@../../above.md",
            "@~/above.md",
            import_(above),
            import_(secret),
            // Out of the project and back into it: the path that results is inside.
            "@../repo/docs/back.md",
          ].join("\n"),
        )
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          expect(placesOf(yield* discovery.list())).toEqual([where.rootFile, inside, back])
          const warned = (yield* discovery.warnings()).filter((item) => item.kind === "import")
          expect(warned.map((item) => [String(item.path), "target" in item ? String(item.target) : undefined])).toEqual([
            [where.rootFile, above],
            [where.rootFile, secret],
          ])
          const text = (yield* readInitial(yield* discovery.load())).text
          expect(text).toContain("INSIDE MARKER")
          expect(text).not.toContain("ABOVE MARKER")
          expect(text).not.toContain("TOP SECRET MARKER")
        }).pipe(scoped(where, trusted))
      }),
    )

    for (const mode of [
      { how: "a link", real: true, dangling: false },
      { how: "a dangling link", real: true, dangling: true },
      { how: "a file that resolves like a link", real: false, dangling: false },
    ])
      (mode.real && !linked ? it.live.skip : it.live)(
        `sends nothing of a file that ${mode.how} in the project leads to outside it, in a project that ${trusted ? "is" : "is not"} trusted`,
        () =>
          Effect.gen(function* () {
            const { where, secret } = yield* layout
            const target = mode.dangling ? path.join(path.dirname(secret), "not-there.txt") : secret
            const notes = path.join(where.repo, "notes.md")
            yield* mode.real ? Effect.promise(() => fs.symlink(target, notes)) : write(notes, "stand-in")
            yield* write(where.rootFile, "@./notes.md\n@./docs/inside.md")
            // A stand-in is a plain file that the file system resolves to the secret, as a link would be.
            const filesystemLayer = mode.real
              ? undefined
              : Layer.effect(
                  FSUtil.Service,
                  FSUtil.Service.pipe(
                    Effect.map((base) =>
                      FSUtil.Service.of({
                        ...base,
                        resolve: (input) => base.resolve(path.resolve(input) === notes ? secret : input),
                      }),
                    ),
                  ),
                ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
            yield* Effect.gen(function* () {
              const discovery = yield* start()
              const text = (yield* readInitial(yield* discovery.load())).text
              // The control: the import inside the project is sent.
              expect(text).toContain("INSIDE MARKER")
              expect(text).not.toContain("TOP SECRET MARKER")
              expect(placesOf(yield* discovery.list())).not.toContain(secret)
              const watcher = yield* Watcher.Test
              expect((yield* watcher.subscriptions()).map((item) => item.path)).not.toContain(target)
              expect((yield* discovery.warnings()).some((item) => item.kind === "import")).toBe(!mode.dangling)
            }).pipe(Effect.provide(layerFor(where, { trusted, filesystemLayer })))
          }),
      )
  }

  it.live("counts an import with the drive or the folder in another case as inside on Windows", () =>
    Effect.gen(function* () {
      if (process.platform !== "win32") return
      const { where, inside } = yield* layout
      // The drive in lower case, and a folder of the project in upper case, which Windows reads as the same folder.
      const spelled = slashed(inside)
        .replace(/^[A-Za-z]/, (drive) => drive.toLowerCase())
        .replace("/docs/", "/DOCS/")
      expect(spelled).not.toBe(slashed(inside))
      yield* write(where.rootFile, `@${spelled}`)
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect((placesOf(yield* discovery.list()) as string[]).map((item) => item.toLowerCase())).toEqual(
          [where.rootFile, inside].map((item) => item.toLowerCase()),
        )
      }).pipe(scoped(where, false))
    }),
  )

  it.live("lets the user's own file import outside every project, which is the control for the gate", () =>
    Effect.gen(function* () {
      const { where, above, secret } = yield* layout
      yield* write(where.globalFile, `${import_(above)}\n${import_(secret)}`)
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(placesOf(yield* discovery.list())).toEqual([where.globalFile, above, secret])
        expect(yield* discovery.warnings()).toEqual([])
      }).pipe(scoped(where, false))
    }),
  )

  for (const scope of ["global", "project"] as const)
    it.live(`refuses a network path in the ${scope} file without reading or watching it`, () =>
      Effect.gen(function* () {
        const { where } = yield* layout
        const reads: string[] = []
        yield* write(scope === "global" ? where.globalFile : where.rootFile, "@//server/share/x.md\n@\\\\server\\share\\y.md")
        yield* Effect.gen(function* () {
          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          expect(placesOf(yield* discovery.list())).toHaveLength(1)
          expect(reads.filter((item) => item.includes("server"))).toEqual([])
          expect((yield* watcher.subscriptions()).filter((item) => item.path.includes("server"))).toEqual([])
        }).pipe(Effect.provide(layerFor(where, { filesystemLayer: recordingFS(reads) })))
      }),
    )

  it.live("never opens an import that instructions_exclude names", () =>
    Effect.gen(function* () {
      const { where, inside } = yield* layout
      const reads: string[] = []
      yield* write(where.rootFile, "@./docs/inside.md @./docs/back.md")
      yield* Effect.gen(function* () {
        const discovery = yield* start()
        expect(placesOf(yield* discovery.list())).toEqual([where.rootFile, path.join(where.repo, "docs", "back.md")])
        expect(reads).not.toContain(inside)
      }).pipe(
        Effect.provide(
          layerFor(where, {
            filesystemLayer: recordingFS(reads),
            configLayer: Config.testLayer([excluding([`${slashed(inside)}`])]),
          }),
        ),
      )
    }),
  )
})

// A repository at the home folder is the project of every folder below it, and the home folder is never trusted for good.
// An import then reaches the folder the session started in and nothing above it.
describe("ConfigInstructionPlugin.Plugin keeps a project at the home folder from opening it to an import", () => {
  const layout = Effect.gen(function* () {
    const base = yield* folders
    const directory = path.join(base.home, "Downloads", "x")
    const where = {
      ...base,
      repo: base.home,
      directory,
      rootFile: path.join(base.home, "AGENTS.md"),
      packageFile: path.join(directory, "AGENTS.md"),
    }
    const key = path.join(base.home, ".ssh", "id_rsa")
    const notes = path.join(directory, "notes.md")
    yield* write(key, "PRIVATE KEY MARKER")
    yield* write(notes, "NOTES MARKER")
    return { where, key, notes }
  })

  // Home is never trusted implicitly, so a row that wants it trusted grants it for the session, and says so first.
  const settle = (granted: boolean) =>
    Effect.gen(function* () {
      const trust = yield* ProjectTrust.Service
      if (granted) yield* trust.grant({ persist: false, via: "test" })
      expect(yield* trust.trusted()).toBe(granted)
    })

  for (const trusted of [true, false]) {
    const name = trusted ? "trusted for the session" : "not trusted"
    it.live(`sends no home file named by ~, by .. or by an absolute path, and sends the one beside it, in a project that is ${name}`, () =>
      Effect.gen(function* () {
        const { where, key, notes } = yield* layout
        yield* write(
          where.packageFile,
          ["@~/.ssh/id_rsa", "@../../.ssh/id_rsa", `@${slashed(key)}`, "@./notes.md"].join("\n"),
        )
        yield* Effect.gen(function* () {
          yield* settle(trusted)
          const discovery = yield* start()
          expect(placesOf(yield* discovery.list())).toEqual([where.packageFile, notes])
          const text = (yield* readInitial(yield* discovery.load())).text
          expect(text).toContain("NOTES MARKER")
          expect(text).not.toContain("PRIVATE KEY MARKER")
          const watcher = yield* Watcher.Test
          expect((yield* watcher.subscriptions()).map((item) => slashed(item.path))).not.toContain(slashed(key))
        }).pipe(scoped(where, false))
      }),
    )

    ;(canLinkFile ? it.live : it.live.skip)(`sends no home file that a link names, in a project that is ${name}`, () =>
      Effect.gen(function* () {
        const { where, key, notes } = yield* layout
        yield* Effect.promise(() => fs.symlink(key, path.join(where.directory, "link")))
        yield* write(where.packageFile, "@./link\n@./notes.md")
        yield* Effect.gen(function* () {
          yield* settle(trusted)
          const discovery = yield* start()
          expect(placesOf(yield* discovery.list())).toEqual([where.packageFile, notes])
          const text = (yield* readInitial(yield* discovery.load())).text
          expect(text).not.toContain("PRIVATE KEY MARKER")
        }).pipe(scoped(where, false))
      }),
    )
    it.live(`with the session at the home folder, the file there imports a file beside it only in a project that is ${name}`, () =>
      Effect.gen(function* () {
        const { where, key, notes } = yield* layout
        const atHome = { ...where, directory: where.home, packageFile: where.rootFile }
        yield* write(path.join(where.home, "notes.md"), "HOME NOTES MARKER")
        yield* write(where.rootFile, ["@./notes.md", "@./.ssh/id_rsa"].join("\n"))
        yield* Effect.gen(function* () {
          yield* settle(trusted)
          const discovery = yield* start()
          const text = (yield* readInitial(yield* discovery.load())).text
          expect(text.includes("HOME NOTES MARKER")).toBe(trusted)
          expect(text.includes("PRIVATE KEY MARKER")).toBe(trusted)
          expect(notes).toBeDefined()
          expect(key).toBeDefined()
        }).pipe(scoped(atHome, false))
      }),
    )
  }
})
