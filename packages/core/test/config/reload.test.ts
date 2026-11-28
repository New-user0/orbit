import path from "path"
import fs from "fs/promises"
import { writeFileSync } from "node:fs"
import { describe, expect, setDefaultTimeout } from "bun:test"
import { CompatNames } from "@orbit/compat/names"
import { Document, Event, Info } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Command } from "@orbit/core/command"
import { Config } from "@orbit/core/config"
import { ConfigAgentPlugin } from "@orbit/core/config/plugin/agent"
import { ConfigCommandPlugin } from "@orbit/core/config/plugin/command"
import { ConfigProviderPlugin } from "@orbit/core/config/plugin/provider"
import { ConfigReferencePlugin } from "@orbit/core/config/plugin/reference"
import { ConfigCompatibilityPlugin } from "@orbit/core/config/plugin/compatibility"
import { ConfigSkillPlugin } from "@orbit/core/config/plugin/skill"
import { Bus } from "@orbit/core/bus"
import { Integration } from "@orbit/core/integration"
import { Plugin } from "@orbit/core/plugin"
import { PluginHost } from "@orbit/core/plugin/host"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Provider } from "@orbit/core/provider"
import { Reference } from "@orbit/core/reference"
import { Skill } from "@orbit/core/skill"
import { ShellSelect } from "@orbit/core/shell/select"
import { Job } from "@orbit/core/job"
import { Global } from "@orbit/util/global"
import { Location } from "@orbit/core/location"
import { Credential } from "@orbit/core/credential"
import { WellKnown } from "@orbit/core/wellknown"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { AppProcess } from "@orbit/util/process"
import { Deferred, Effect, Layer, Schema } from "effect"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { AbsolutePath } from "@orbit/core/schema"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { processNative } from "../fixture/native-watcher"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(
  Layer.merge(PluginTestLayer, AppNodeBuilder.build(LayerNode.group([AppProcess.node, ShellSelect.node, Job.node]))),
)
const decode = Schema.decodeUnknownSync(Info)
const document = path.join(import.meta.dir, "orbit.json")

const probeSkill = (description: string) => `---\nname: probe\ndescription: ${description}\n---\nTest skill`

// Most rows here wait for the operating system to report a file change through the native watcher. On a machine with
// more busy processes than cores that report took longer than bun's 5 s default in about 30 of 100 runs, and the same
// runs passed with a 60 s limit (the rows end in about a second when the machine is not loaded), so the wait is latency
// and not a lost event; the limit bounds a wait that has no count of its own.
setDefaultTimeout(30_000)

describe("config plugin reloads", () => {
  for (const input of [
    { root: CompatNames.agents, global: false },
    { root: `../${CompatNames.vendor.directory}`, global: false },
    { root: `home/${CompatNames.agents}`, global: true },
    { root: `home/${CompatNames.vendor.directory}`, global: true },
  ]) {
    it.live(`loads skills when ${input.root} appears after startup`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const root = path.resolve(project, input.root)
            const file = path.join(project, "orbit.json")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(project, "home"), { recursive: true })
              await fs.mkdir(path.join(project, "global"))
              await Bun.write(file, JSON.stringify({ shell: "initial" }))
            })
            return yield* Effect.gen(function* () {
              const config = yield* Config.Service
              const plugins = yield* Plugin.Service
              const skills = yield* Skill.Service
              const host = yield* PluginHost.make(plugins)
              // The machine running the test may keep skills of its own in roots above the fixture.
              const probes = skills.list().pipe(Effect.map((items) => items.filter((item) => item.id === "probe")))
              yield* ConfigCompatibilityPlugin.Plugin.effect(host)
              expect(yield* probes).toEqual([])

              // Finish startup by observing an ordinary config reload before creating the root.
              yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "ready" })))
              yield* waitUntil(
                config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "ready")),
              )
              const skill = path.join(root, "skills", "probe", "SKILL.md")
              yield* Effect.promise(() => Bun.write(skill, probeSkill("Hot reload")))
              yield* waitUntil(probes.pipe(Effect.map((items) => items.length === 1)))
              expect((yield* probes)[0]?.path).toBe(AbsolutePath.make(skill))
              yield* Effect.promise(() => fs.rm(root, { recursive: true }))
              yield* waitUntil(probes.pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(() => Bun.write(skill, probeSkill("Recreated")))
              yield* waitUntil(probes.pipe(Effect.map((items) => items[0]?.description === "Recreated")))
            }).pipe(
              Effect.provide(
                // A root in the folder above is read only when that folder is the project's root (D7).
                liveConfig(
                  project,
                  undefined,
                  { global: input.global },
                  input.root.startsWith("../") ? tmp.path : project,
                ),
              ),
            )
          }),
        ),
      ),
    )

    // The config watches only the root's own entry, so this skills folder, made in a root that was there all along, is
    // seen only through the plugin's watch of the root. The row above met the same case when the root was made a moment
    // before its skills folder and the plugin looked in between (Linux core, run 45964175972).
    it.live(`loads skills when ${input.root} is there at startup and its skills folder comes later`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const root = path.resolve(project, input.root)
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(project, "home"), { recursive: true })
              await fs.mkdir(path.join(project, "global"))
              await fs.mkdir(root, { recursive: true })
              await Bun.write(path.join(project, "orbit.json"), JSON.stringify({ shell: "initial" }))
            })
            return yield* Effect.gen(function* () {
              const plugins = yield* Plugin.Service
              const skills = yield* Skill.Service
              const probes = skills.list().pipe(Effect.map((items) => items.filter((item) => item.id === "probe")))
              yield* ConfigCompatibilityPlugin.Plugin.effect(yield* PluginHost.make(plugins))
              expect(yield* probes).toEqual([])
              const skill = path.join(root, "skills", "probe", "SKILL.md")
              yield* Effect.promise(() => Bun.write(skill, probeSkill("Later")))
              yield* waitUntil(probes.pipe(Effect.map((items) => items[0]?.description === "Later")))
              expect((yield* probes)[0]?.path).toBe(AbsolutePath.make(skill))
            }).pipe(
              Effect.provide(
                liveConfig(
                  project,
                  undefined,
                  { global: input.global },
                  input.root.startsWith("../") ? tmp.path : project,
                ),
              ),
            )
          }),
        ),
      ),
    )
  }

  // The plugin looks into a folder only once its watch of that folder is in place, so what is written while the watch is
  // still being made is found by that look, since the watch will not report it. Each watch here writes the skill before
  // it subscribes, which is where a slow native subscription leaves such a write: into a skills folder that is there
  // (the directory watch), and into a root that has none yet (the root's watch for its skills folder).
  for (const row of [
    { name: "lists a compatibility skills folder after its watch is in place", type: "directory", made: "probe" },
    { name: "looks again for a skills folder made while the root's watch is made", type: "file", made: "root" },
  ] as const) {
    it.live(row.name, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const root = path.join(project, CompatNames.agents)
            const skill = path.join(root, "skills", "probe", "SKILL.md")
            yield* Effect.promise(async () => {
              await fs.mkdir(path.join(project, "home"), { recursive: true })
              await fs.mkdir(path.join(project, "global"))
              await fs.mkdir(row.made === "probe" ? path.dirname(skill) : root, { recursive: true })
              await Bun.write(path.join(project, "orbit.json"), JSON.stringify({ shell: "initial" }))
            })
            const real = processNative(Watcher.binding, Watcher.backend())
            const native = Watcher.Native.of({
              subscribe: (input) =>
                input.type === row.type && path.basename(input.target) === "skills"
                  ? Effect.sleep("100 millis").pipe(
                      Effect.andThen(Effect.promise(() => Bun.write(skill, probeSkill("During the watch")))),
                      Effect.andThen(real.subscribe(input)),
                    )
                  : real.subscribe(input),
            })
            return yield* Effect.gen(function* () {
              const plugins = yield* Plugin.Service
              const skills = yield* Skill.Service
              const probes = skills.list().pipe(Effect.map((items) => items.filter((item) => item.id === "probe")))
              yield* ConfigCompatibilityPlugin.Plugin.effect(yield* PluginHost.make(plugins))
              yield* waitUntil(probes.pipe(Effect.map((items) => items[0]?.description === "During the watch")))
            }).pipe(
              Effect.provide(
                // The plugin's own watches go through `native` too, not only the config's.
                Layer.merge(
                  liveConfig(project, native),
                  Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))),
                ),
              ),
            )
          }),
        ),
      ),
    )
  }

  it.live("loads no compatibility skills and watches no compatibility roots when compatibility is off", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const file = path.join(project, "orbit.json")
          const skill = path.join(project, CompatNames.agents, "skills", "probe", "SKILL.md")
          const watched: Parameters<Watcher.NativeInterface["subscribe"]>[0][] = []
          const native = Watcher.Native.of({
            subscribe: (input) => Effect.sync(() => (watched.push(input), { unsubscribe: () => Promise.resolve() })),
          })
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(project, "home"), { recursive: true })
            await fs.mkdir(path.join(project, "global"))
            // The root and its skill exist before startup, so only the switch can keep them out.
            await Bun.write(skill, probeSkill("Switched off"))
            await Bun.write(file, JSON.stringify({ shell: "initial" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const plugins = yield* Plugin.Service
            const skills = yield* Skill.Service
            yield* ConfigCompatibilityPlugin.Plugin.effect(yield* PluginHost.make(plugins))

            // Observe an ordinary reload, then give a rescan time to run, before concluding nothing loads.
            yield* Effect.promise(() => Bun.write(file, JSON.stringify({ shell: "ready" })))
            yield* waitUntil(
              config.entries().pipe(Effect.map((entries) => Config.latest(entries, "shell") === "ready")),
            )
            yield* Effect.sleep("300 millis")

            expect((yield* skills.list()).filter((item) => item.id === "probe")).toEqual([])
            expect(yield* config.compat()).toEqual({ enabled: false, roots: [] })
            const names = watched.flatMap((input) => (input.type === "entries" ? input.names : []))
            expect(names).toContain("orbit.json")
            for (const name of [CompatNames.agents, CompatNames.vendor.directory]) expect(names).not.toContain(name)
            expect(watched.filter((input) => input.target.includes(`${path.sep}skills`))).toEqual([])
          }).pipe(
            Effect.provide(
              liveConfig(project, native, {
                global: false,
                content: JSON.stringify({ compatibility: { enabled: false } }),
              }),
            ),
          )
        }),
      ),
    ),
  )

  it.live("drops and restores compatibility skills as the switch in user config changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          const user = path.join(project, "global", "orbit.json")
          const skill = path.join(project, CompatNames.agents, "skills", "probe", "SKILL.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(project, "home"), { recursive: true })
            await Bun.write(skill, probeSkill("Switch"))
            await Bun.write(user, JSON.stringify({ shell: "initial" }))
          })
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const skills = yield* Skill.Service
            const probes = skills.list().pipe(Effect.map((items) => items.filter((item) => item.id === "probe")))
            yield* ConfigCompatibilityPlugin.Plugin.effect(yield* PluginHost.make(plugins))
            expect(yield* probes).toHaveLength(1)

            yield* Effect.promise(() => Bun.write(user, JSON.stringify({ compatibility: { enabled: false } })))
            yield* waitUntil(probes.pipe(Effect.map((items) => items.length === 0)))

            yield* Effect.promise(() => Bun.write(user, JSON.stringify({ compatibility: { enabled: true } })))
            yield* waitUntil(probes.pipe(Effect.map((items) => items.length === 1)))
          }).pipe(Effect.provide(liveConfig(project, undefined, { global: true })))
        }),
      ),
    ),
  )

  it.live("retains readiness signalled synchronously during initial config startup", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) => {
        const native = Watcher.Native.of({
          subscribe: (input) =>
            Effect.sync(() => {
              if (input.type === "entries" && input.target === tmp.path) {
                // No event is emitted: only synchronous readiness can trigger the reload.
                writeFileSync(path.join(tmp.path, "orbit.json"), JSON.stringify({ references: { docs: "./docs" } }))
              }
              return { unsubscribe: () => Promise.resolve() }
            }),
        })
        return Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          const references = yield* Reference.Service
          const host = yield* PluginHost.make(plugins)
          yield* ConfigReferencePlugin.Plugin.effect(host)
          yield* waitUntil(references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))))
          expect((yield* references.list())[0]?.path).toBe(AbsolutePath.make(path.join(tmp.path, "docs")))
        }).pipe(Effect.provide(liveConfig(tmp.path, native)))
      }),
    ),
  )

  it.live("loads the first config written while a new directory watch is starting", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, ".orbit")
          const parent = yield* Deferred.make<(update: Watcher.Update) => void>()
          const starting = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const native = Watcher.Native.of({
            subscribe: (input) =>
              Effect.gen(function* () {
                if (input.type === "entries" && input.target === tmp.path) {
                  yield* Deferred.succeed(parent, input.publish)
                }
                if (input.type === "directory" && input.target === root) {
                  yield* Deferred.succeed(starting, undefined)
                  yield* Deferred.await(release)
                }
                return { unsubscribe: () => Promise.resolve() }
              }),
          })
          return yield* Effect.gen(function* () {
            const plugins = yield* Plugin.Service
            const references = yield* Reference.Service
            const host = yield* PluginHost.make(plugins)
            yield* ConfigReferencePlugin.Plugin.effect(host)
            const publish = yield* Deferred.await(parent)
            yield* Effect.promise(() => fs.mkdir(root))
            publish({ path: root, type: "create" })
            yield* Deferred.await(starting)
            // No file event: the recursive native watch has not been acquired yet.
            yield* Effect.promise(() =>
              fs.writeFile(path.join(root, "orbit.json"), JSON.stringify({ references: { docs: "./docs" } })),
            )
            yield* Deferred.succeed(release, undefined)
            yield* waitUntil(references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))))
            expect((yield* references.list())[0]?.path).toBe(AbsolutePath.make(path.join(root, "docs")))
          }).pipe(Effect.provide(liveConfig(tmp.path, native)))
        }),
      ),
    ),
  )

  for (const input of [
    { file: "orbit.json", empty: false },
    { file: "../orbit.jsonc", empty: false },
    { file: ".orbit/orbit.json", empty: false },
    { file: "../.orbit/orbit.jsonc", empty: true },
  ]) {
    it.live(`loads references when ${input.file} is first created and keeps watching it`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const project = path.join(tmp.path, "project")
            const target = path.resolve(project, input.file)
            yield* Effect.promise(() => fs.mkdir(project))
            return yield* Effect.gen(function* () {
              const plugins = yield* Plugin.Service
              const references = yield* Reference.Service
              const host = yield* PluginHost.make(plugins)
              yield* ConfigReferencePlugin.Plugin.effect(host)
              expect(yield* references.list()).toEqual([])

              if (input.empty) {
                yield* Effect.promise(() => fs.mkdir(path.dirname(target)))
                const config = yield* Config.Service
                yield* waitUntil(
                  config
                    .entries()
                    .pipe(
                      Effect.map((entries) =>
                        entries.some((entry) => entry.type === "directory" && entry.path === path.dirname(target)),
                      ),
                    ),
                )
              }
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.some((item) => item.name === "docs"))),
              )
              expect((yield* references.list())[0]?.path).toBe(
                AbsolutePath.make(path.join(path.dirname(target), "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )

              yield* Effect.promise(() =>
                fs.rm(input.file.includes(".orbit/") ? path.dirname(target) : target, { recursive: true }),
              )
              yield* waitUntil(references.list().pipe(Effect.map((items) => items.length === 0)))
              yield* Effect.promise(async () => {
                await fs.mkdir(path.dirname(target), { recursive: true })
                await fs.writeFile(target, JSON.stringify({ references: { docs: "./docs" } }))
              })
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "docs")),
              )
              yield* Effect.promise(() => fs.writeFile(target, JSON.stringify({ references: { next: "./next" } })))
              yield* waitUntil(
                references.list().pipe(Effect.map((items) => items.length === 1 && items[0]?.name === "next")),
              )
            }).pipe(
              Effect.provide(
                // A file in the folder above is read only when that folder is the project's root (D7).
                liveConfig(project, undefined, undefined, input.file.startsWith("../") ? tmp.path : project),
              ),
            )
          }),
        ),
      ),
    )
  }

  it.effect("preserves reference precedence and insertion order across documents", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const references = yield* Reference.Service
      const host = yield* PluginHost.make(plugins)
      yield* references.transform((editor) =>
        editor.add(
          "external",
          Reference.LocalSource.make({ type: "local", path: AbsolutePath.make("/references/external") }),
        ),
      )
      yield* ConfigReferencePlugin.Plugin.effect(host)

      const result = yield* references.list()
      expect(result.map((reference) => reference.name)).toEqual(["external", "shared", "first", "second"])
      expect(result.find((reference) => reference.name === "shared")?.path).toBe(
        AbsolutePath.make(path.resolve("/config/second/shared")),
      )
    }).pipe(
      Effect.provide(
        Config.testLayer([
          referenceConfig("/config/first/orbit.json", {
            shared: "./shared",
            first: "./first",
          }),
          referenceConfig("/config/second/orbit.json", {
            shared: "./shared",
            second: "./second",
          }),
        ]),
      ),
      Effect.provideService(Global.Service, Global.Service.of(Global.make())),
    ),
  )

  // The skill folders are copies in the row's own folder: the config's skill watch outlives the row on Windows
  // (test/fixture/native-watcher.ts), and a folder of the checkout would keep it live, where the row's folder ends it
  // when the row removes it.
  it.live("reloads config-backed domains without reloading external plugins", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.tap((tmp) =>
        Effect.promise(() => fs.cp(path.join(import.meta.dir, "fixture", "skills"), tmp.path, { recursive: true })),
      ),
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const agents = yield* Agent.Service
          const providers = yield* Provider.Service
          const commands = yield* Command.Service
          const integrations = yield* Integration.Service
          const bus = yield* Bus.Service
          const plugins = yield* Plugin.Service
          const references = yield* Reference.Service
          const skills = yield* Skill.Service
          const host = yield* PluginHost.make(plugins)
          const test = yield* Config.Test

          yield* ConfigAgentPlugin.Plugin.effect(host)
          yield* ConfigCommandPlugin.Plugin.effect(host)
          yield* ConfigSkillPlugin.Plugin.effect(host)
          yield* ConfigReferencePlugin.Plugin.effect(host)
          yield* ConfigProviderPlugin.Plugin.effect(host)

          expect((yield* agents.get(Agent.ID.make("first")))?.description).toBe("First agent")
          expect((yield* commands.get("first"))?.description).toBe("First command")
          expect(yield* integrations.get(Integration.ID.make("first"))).toBeDefined()
          expect((yield* skills.list()).some((skill) => skill.id === "first")).toBe(true)
          expect((yield* references.list()).map((reference) => reference.name)).toEqual(["first"])
          expect(yield* providers.get(Provider.ID.make("first"))).toBeDefined()

          yield* test.setEntries([config("second", tmp.path)])
          yield* Effect.yieldNow
          yield* bus.publish(Event.Updated, {})
          yield* waitUntil(
            Effect.gen(function* () {
              return (
                (yield* agents.get(Agent.ID.make("first"))) === undefined &&
                (yield* agents.get(Agent.ID.make("second")))?.description === "Second agent" &&
                (yield* commands.get("first")) === undefined &&
                (yield* commands.get("second"))?.description === "Second command" &&
                (yield* integrations.get(Integration.ID.make("first"))) === undefined &&
                (yield* integrations.get(Integration.ID.make("second"))) !== undefined &&
                (yield* references.list()).some((reference) => reference.name === "second") &&
                (yield* providers.get(Provider.ID.make("first"))) === undefined &&
                (yield* providers.get(Provider.ID.make("second"))) !== undefined &&
                // Skills are read from disk, so they finish after the domains above; waiting for them is what makes the two
                // checks below read the state after the reload, not a state it has not reached yet.
                (yield* skills.list()).every((skill) => skill.id !== "first") &&
                (yield* skills.list()).some((skill) => skill.id === "second")
              )
            }),
          )

          expect((yield* skills.list()).some((skill) => skill.id === "first")).toBe(false)
          expect((yield* skills.list()).some((skill) => skill.id === "second")).toBe(true)
        }).pipe(
          Effect.provide(Config.testLayer([config("first", tmp.path)])),
          Effect.provideService(Global.Service, Global.Service.of(Global.make())),
        ),
      ),
    ),
  )
})

function liveConfig(
  directory: string,
  native?: Watcher.NativeInterface,
  options: Config.Options = { global: false },
  projectDirectory = directory,
) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Reference.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured(options)),
    Location.node.replace(
      Layer.succeed(
        Location.Service,
        Location.Service.of(
          location(
            { directory: AbsolutePath.make(directory) },
            { projectDirectory: AbsolutePath.make(projectDirectory) },
          ),
        ),
      ),
    ),
    Global.node.replace(
      Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") }),
    ),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    ...(native
      ? [Watcher.node.replace(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))]
      : []),
  ])
}

function config(name: string, skills: string) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(document),
    info: decode({
      agents: { [name]: { description: `${title(name)} agent`, mode: "subagent" } },
      commands: { [name]: { template: `${title(name)} command`, description: `${title(name)} command` } },
      skills: [path.join(skills, `${name}-source`)],
      references: { [name]: `/references/${name}` },
      providers: { [name]: { models: { chat: { name: `${title(name)} model` } } } },
    }),
  })
}

function referenceConfig(file: string, references: Record<string, string>) {
  return new Document({
    type: "document",
    path: AbsolutePath.make(file),
    info: decode({ references }),
  })
}

function title(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

// A file watch has no promise of how soon it reports, so the wait has no count of its own, which reported a loaded
// machine as a wrong result: the test's time limit bounds it and reports a timeout as a timeout.
const waitUntil = Effect.fnUntraced(function* (condition: Effect.Effect<boolean>) {
  while (!(yield* condition)) yield* Effect.sleep("10 millis")
})
