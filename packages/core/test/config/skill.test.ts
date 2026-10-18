import fs from "fs/promises"
import path from "path"
import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Config } from "@orbit/core/config"
import { Directory, Document, type Entry, Event, Info } from "@orbit/schema/config"
import { ConfigSkillPlugin } from "@orbit/core/config/plugin/skill"
import { ConfigCompatibilityPlugin } from "@orbit/core/config/plugin/compatibility"
import { SkillFile } from "@orbit/core/config/plugin/skill-file"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Bus } from "@orbit/core/bus"
import { Credential } from "@orbit/core/credential"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Skill } from "@orbit/core/skill"
import { SkillDiscovery } from "@orbit/core/skill/discovery"
import { WellKnown } from "@orbit/core/wellknown"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { trustedProject, untrustedProject } from "../fixture/project-trust"
import { tmpdir, tmpdirScoped } from "../fixture/tmpdir"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const emptyDiscovery = SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) })
const watcherLayer = Watcher.testLayer
const it = testEffect(
  Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Skill.node, Bus.node, FSUtil.node])),
    watcherLayer,
    trustedProject,
  ),
)
const decode = Schema.decodeUnknownSync(Info)

function write(directory: string, name: string, description: string) {
  return fs.writeFile(
    path.join(directory, name, "SKILL.md"),
    `---
name: ${name}
description: ${description}
---
# ${name}`,
  )
}

const startEntries = Effect.fnUntraced(function* (
  entries: Entry[],
  directory: string,
  home = directory,
  discovery = emptyDiscovery,
  compat: Config.Compat = Config.defaultCompat,
  event?: NonNullable<Parameters<typeof host>[0]>["event"],
) {
  const service = yield* Skill.Service
  const pluginHost = host({
    skill: {
      list: () => Effect.die("unused skill.list"),
      transform: service.transform,
      reload: service.reload,
    },
    ...(event === undefined ? {} : { event }),
  })
  yield* ConfigCompatibilityPlugin.Plugin.effect(pluginHost).pipe(Effect.provide(Config.testLayer(entries, compat)))
  yield* ConfigSkillPlugin.Plugin.effect(
    pluginHost,
  ).pipe(
    Effect.provide(Config.testLayer(entries, compat)),
    Effect.provideService(SkillDiscovery.Service, discovery),
    Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home })),
    Effect.provideService(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
  )
  return service
})

const start = (skills: string[], directory: string, discovery = emptyDiscovery) =>
  startEntries(
    [
      new Document({
        type: "document",
        info: decode({ skills }),
      }),
    ],
    directory,
    directory,
    discovery,
  )

const discover = (directory: string, global: string) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    return { entries: yield* config.entries(), compat: yield* config.compat() }
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node]), [
        Location.node.replace(
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ),
        Global.node.replace(Global.layerWith({ config: global, home: path.join(global, "home") })),
        Credential.node.replace(emptyCredentialNode),
        WellKnown.node.replace(emptyWellknownNode),
        Watcher.node.replace(Watcher.testLayer),
      ]),
    ),
  )

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const deferred = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(Skill.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(deferred, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(deferred).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

describe("SkillFile.parse", () => {
  test("parses root and nested skill ids and metadata flags", () => {
    const directory = "/repo/skills"
    expect(
      SkillFile.parse(
        directory,
        "/repo/skills/manual/SKILL.md",
        `---
name: Manual
description: Manual only
metadata:
  orbit/autoinvoke: false
---
# manual`,
      ),
    ).toEqual({
      _tag: "Parsed",
      skill: {
        id: Skill.ID.make("manual"),
        name: Skill.Name.make("Manual"),
        description: "Manual only",
        autoinvoke: false,
        path: AbsolutePath.make("/repo/skills/manual/SKILL.md"),
        content: "# manual",
      },
    })
    expect(SkillFile.parse(directory, "/repo/skills/foo.md", "# foo")).toMatchObject({
      _tag: "Parsed",
      skill: { id: Skill.ID.make("foo") },
    })
    expect(SkillFile.parse("/repo/skills/manual", "/repo/skills/manual/SKILL.md", "# manual")).toMatchObject({
      _tag: "Parsed",
      skill: { id: Skill.ID.make("manual"), name: Skill.Name.make("manual") },
    })
    expect(
      SkillFile.parse(directory, "/repo/skills/broken.md", "---\ndescription: foo: bar\nmetadata: [\n---\n# broken"),
    ).toEqual({ _tag: "Skipped", reason: "markdown" })
  })
})

describe("ConfigCompatibilityPlugin.Plugin", () => {
  it.live("reloads its skills when a config update flips the compatibility switch", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const vendor = path.join(tmp.path, "vendor")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(vendor, "skills", "probe"), { recursive: true })
            await write(path.join(vendor, "skills"), "probe", "Switchable")
          })
          // The raw file feed stays silent: only the config.updated event the switch arrives with can reload.
          const state = { enabled: true }
          const config = Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([]),
              changes: () => Stream.never,
              fingerprints: () => Effect.succeed([]),
              pluginsChanged: () => Effect.succeed(false),
              notify: () => Effect.void,
              compatEnabled: () => Effect.sync(() => state.enabled),
              compat: () =>
                Effect.sync(() =>
                  state.enabled
                    ? { enabled: true, roots: [{ path: AbsolutePath.make(vendor), kind: "vendor", scope: "project" }] }
                    : { enabled: false, roots: [] },
                ),
            }),
          )
          const bus = yield* Bus.Service
          const skills = yield* Skill.Service
          yield* ConfigCompatibilityPlugin.Plugin.effect(
            host({
              skill: {
                list: () => Effect.die("unused skill.list"),
                transform: skills.transform,
                reload: skills.reload,
              },
              event: { subscribe: () => bus.subscribe(Event.Updated) },
            }),
          ).pipe(Effect.provide(config))
          const turn = (enabled: boolean) =>
            Effect.gen(function* () {
              const updated = yield* Deferred.make<void>()
              const fiber = yield* bus.subscribe(Skill.Event.Updated).pipe(
                Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
                Effect.forkScoped,
              )
              yield* Effect.yieldNow
              state.enabled = enabled
              yield* bus.publish(Event.Updated, {})
              yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
              yield* Fiber.interrupt(fiber)
              return (yield* skills.list()).map((item) => item.id)
            })

          expect((yield* skills.list()).map((item) => item.id)).toEqual([Skill.ID.make("probe")])
          expect(yield* turn(false)).toEqual([])
          expect(yield* turn(true)).toEqual([Skill.ID.make("probe")])
        }),
      ),
    ),
  )
})

describe("ConfigSkillPlugin.Plugin", () => {
  // A skill is text that goes into the prompt, so a folder that is not trusted keeps it, in Orbit's directory and in the
  // roots of other products alike. What trust holds back from such a folder is what can run code.
  it.live("loads the skills of a folder that is not trusted", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const orbit = path.join(tmp.path, "project", ".orbit")
          const vendor = path.join(tmp.path, "project", "vendor")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(orbit, "skills", "native"), { recursive: true })
            await fs.mkdir(path.join(vendor, "skills", "foreign"), { recursive: true })
            await write(path.join(orbit, "skills"), "native", "Shipped by the project")
            await write(path.join(vendor, "skills"), "foreign", "Shipped for another product")
          })
          const skills = yield* startEntries(
            [new Directory({ type: "directory", path: AbsolutePath.make(orbit), scope: "project", trusted: false })],
            path.join(tmp.path, "project"),
            tmp.path,
            emptyDiscovery,
            {
              enabled: true,
              roots: [{ path: AbsolutePath.make(vendor), kind: "vendor", scope: "project", trusted: false }],
            },
          )
          expect((yield* skills.list()).map((item) => item.id).toSorted()).toEqual([
            Skill.ID.make("foreign"),
            Skill.ID.make("native"),
          ])
        }),
      ),
    ),
  )

  // The repository ships its links, and a clone recreates them. A skill's text goes to the model when it loads the skill,
  // which the repository's own instructions can ask for, so a file that a link in an untrusted folder leads to must not
  // become one. A junction stands for the link, since it needs no privilege on Windows.
  it.live("leaves out a skill that a link leads out of an untrusted folder, until the folder is trusted", () =>
    Effect.gen(function* () {
      const tmp = (yield* tmpdirScoped()).path
      const project = path.join(tmp, "project")
      const orbit = path.join(project, ".orbit")
      const vendor = path.join(project, CompatNames.vendor.directory)
      const agents = path.join(project, CompatNames.agents)
      const outside = path.join(tmp, "outside")
      yield* Effect.promise(async () => {
        // What the project holds itself, in Orbit's directory and in the roots of other products.
        await fs.mkdir(path.join(orbit, "skills", "native"), { recursive: true })
        await fs.mkdir(path.join(vendor, "skills", "foreign"), { recursive: true })
        await write(path.join(orbit, "skills"), "native", "Shipped by the project")
        await write(path.join(vendor, "skills"), "foreign", "Shipped for another product")
        // What links lead to: a skill folder, a whole folder of skills, and the skills folder of a root.
        await fs.mkdir(path.join(outside, "one"), { recursive: true })
        await fs.mkdir(path.join(outside, "two"), { recursive: true })
        await fs.mkdir(path.join(outside, "three", "abducted"), { recursive: true })
        await fs.writeFile(path.join(outside, "one", "SKILL.md"), "---\nname: linked\n---\nSTOLEN ONE")
        await fs.writeFile(path.join(outside, "two", "loose.md"), "---\nname: loose\n---\nSTOLEN TWO")
        await write(path.join(outside, "three"), "abducted", "Taken from outside")
        await fs.symlink(path.join(outside, "one"), path.join(orbit, "skills", "linked"), "junction")
        await fs.symlink(path.join(outside, "two"), path.join(orbit, "skill"), "junction")
        await fs.mkdir(agents, { recursive: true })
        await fs.symlink(path.join(outside, "three"), path.join(agents, "skills"), "junction")
      })
      yield* Effect.gen(function* () {
        const bus = yield* Bus.Service
        const trust = yield* ProjectTrust.Service
        const skills = yield* startEntries(
          [new Directory({ type: "directory", path: AbsolutePath.make(orbit), scope: "project", trusted: false })],
          project,
          tmp,
          emptyDiscovery,
          {
            enabled: true,
            roots: [
              { path: AbsolutePath.make(vendor), kind: "vendor", scope: "project", trusted: false },
              { path: AbsolutePath.make(agents), kind: "agents", scope: "project", trusted: false },
            ],
          },
          { subscribe: () => bus.subscribe(Event.Updated) },
        )
        const ids = () => skills.list().pipe(Effect.map((list) => list.map((item) => item.id).toSorted()))
        const own = [Skill.ID.make("foreign"), Skill.ID.make("native")]
        expect(yield* ids()).toEqual(own)

        // Trusting the folder tells the plugin of the config and the one of the other products' roots, and the linked files
        // supply skills as before.
        yield* trust.grant({ persist: false, via: "test" })
        yield* bus.publish(Event.Updated, {})
        for (let attempt = 0; attempt < 100 && (yield* ids()).length < 5; attempt++) yield* Effect.sleep("20 millis")
        expect(yield* ids()).toEqual(
          [...own, ...["abducted", "linked", "loose"].map((id) => Skill.ID.make(id))].toSorted(),
        )
      }).pipe(Effect.provide(untrustedProject({ directory: project })))
    }),
  )

  it.live("maps config entry types to skill directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const vendor = path.join(tmp.path, "vendor")
          const agents = path.join(tmp.path, "agents")
          const orbit = path.join(tmp.path, "orbit")
          const home = path.join(tmp.path, "home")
          const directory = path.join(tmp.path, "project")
          const expected = [
            path.join(vendor, "skills"),
            path.join(agents, "skills"),
            path.join(orbit, "skill"),
            path.join(orbit, "skills"),
            path.join(home, "shared"),
            path.join(directory, "relative"),
          ]
          yield* Effect.promise(() => Promise.all(expected.map((item) => fs.mkdir(item, { recursive: true }))))

          yield* startEntries(
            [
              new Directory({ type: "directory", path: AbsolutePath.make(orbit) }),
              new Document({ type: "document", info: decode({ skills: ["~/shared", "./relative"] }) }),
            ],
            directory,
            home,
            emptyDiscovery,
            {
              enabled: true,
              roots: [
                { path: AbsolutePath.make(vendor), kind: "vendor", scope: "project" },
                { path: AbsolutePath.make(agents), kind: "agents", scope: "project" },
              ],
            },
          )
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual(expected.map((item) => ({ path: item, type: "directory" })))
        }),
      ),
    ),
  )

  it.live("loads directory and individual downloaded skill roots with later-source precedence", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "review"), { recursive: true })
            await fs.mkdir(path.join(second, "deploy"), { recursive: true })
            await fs.mkdir(path.join(second, "review"), { recursive: true })
            await write(first, "review", "First")
            await write(second, "deploy", "Deploy")
            await write(second, "review", "Second")
          })
          const pulls: string[] = []
          const discovery = SkillDiscovery.Service.of({
            pull: (url) => {
              pulls.push(url)
              return Effect.succeed([
                AbsolutePath.make(path.join(second, "deploy")),
                AbsolutePath.make(path.join(second, "review")),
              ])
            },
          })

          const skill = yield* start([first, "https://example.test/skills/"], tmp.path, discovery)
          expect((yield* skill.list()).map((item) => item.id).toSorted()).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Deploy")
          expect((yield* skill.list()).find((item) => item.id === "review")?.description).toBe("Second")
          expect(pulls).toEqual(["https://example.test/skills/"])
        }),
      ),
    ),
  )

  it.live("prefers a worktree skill over the parent checkout copy", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const checkout = path.join(tmp.path, "repo")
          const worktree = path.join(checkout, ".worktrees", "feature")
          const parentSkills = path.join(checkout, CompatNames.agents, "skills")
          const worktreeSkills = path.join(worktree, CompatNames.agents, "skills")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(checkout, ".git"), { recursive: true })
            await fs.mkdir(path.join(parentSkills, "review"), { recursive: true })
            await fs.mkdir(path.join(worktreeSkills, "review"), { recursive: true })
            await fs.writeFile(path.join(worktree, ".git"), "gitdir: ../../../.git/worktrees/feature\n")
            await write(parentSkills, "review", "Parent checkout")
            await write(worktreeSkills, "review", "Worktree")
          })

          const discovered = yield* discover(worktree, path.join(tmp.path, "global"))
          const skill = yield* startEntries(discovered.entries, worktree, worktree, emptyDiscovery, discovered.compat)
          const review = (yield* skill.list()).find((item) => item.id === "review")

          expect(review?.description).toBe("Worktree")
          expect(review?.path).toBe(AbsolutePath.make(path.join(worktreeSkills, "review", "SKILL.md")))
        }),
      ),
    ),
  )

  it.live("keeps directory skills when a URL source fails", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Available")
          })
          const url = "https://unreachable.example.test/skills/"
          const discovery = SkillDiscovery.Service.of({ pull: () => Effect.die(`failed to pull ${url}`) })

          const skill = yield* start([tmp.path, url], tmp.path, discovery)
          expect((yield* skill.list()).find((item) => item.id === "review")?.description).toBe("Available")
        }),
      ),
    ),
  )

  it.live("rescans directory sources when watched files change", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "deploy"), { recursive: true })
            await write(tmp.path, "deploy", "Initial")
          })
          const skill = yield* start([tmp.path], tmp.path)
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Initial")

          const deploy = path.join(tmp.path, "deploy", "SKILL.md")
          yield* Effect.promise(() => write(tmp.path, "deploy", "Updated"))
          yield* emitAndWait({ type: "update", path: deploy })
          expect((yield* skill.list()).find((item) => item.id === "deploy")?.description).toBe("Updated")

          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "review"), { recursive: true })
            await write(tmp.path, "review", "Review")
          })
          yield* emitAndWait({ type: "create", path: path.join(tmp.path, "review", "SKILL.md") })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([
            Skill.ID.make("deploy"),
            Skill.ID.make("review"),
          ])

          yield* Effect.promise(() => fs.rm(path.join(tmp.path, "review"), { recursive: true }))
          yield* emitAndWait({ type: "delete", path: path.join(tmp.path, "review", "SKILL.md") })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
        }),
      ),
    ),
  )

  it.live("watches canonical directories behind symlinked skills", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const target = path.join(tmp.path, "target", "bro")
          const file = path.join(target, "SKILL.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(source, { recursive: true })
            await fs.mkdir(target, { recursive: true })
            await fs.writeFile(file, "---\nname: bro\ndescription: Initial\n---\n# bro")
            await fs.symlink(target, path.join(source, "bro"), process.platform === "win32" ? "junction" : undefined)
          })

          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Initial")
          expect(yield* watcher.subscriptions()).toContainEqual({ path: target, type: "directory" })

          yield* Effect.promise(() => fs.writeFile(file, "---\nname: bro\ndescription: Updated\n---\n# bro"))
          yield* emitAndWait({ type: "update", path: file })
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Updated")
        }),
      ),
    ),
  )

  it.live("reloads symlinked sources when their target changes", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "source")
          const first = path.join(tmp.path, "first")
          const second = path.join(tmp.path, "second")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(first, "bro"), { recursive: true })
            await fs.mkdir(path.join(second, "bro"), { recursive: true })
            await write(first, "bro", "First")
            await write(second, "bro", "Second")
            await fs.symlink(first, source, process.platform === "win32" ? "junction" : undefined)
          })

          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("First")
          expect(yield* watcher.subscriptions()).toEqual([
            { path: first, type: "directory" },
            { path: source, type: "file" },
          ])

          yield* Effect.promise(async () => {
            await fs.unlink(source)
            await fs.symlink(second, source, process.platform === "win32" ? "junction" : undefined)
          })
          yield* emitAndWait({ type: "update", path: source })

          expect((yield* skill.list()).find((item) => item.id === "bro")?.description).toBe("Second")
          expect(yield* watcher.subscriptions()).toEqual([
            { path: first, type: "directory" },
            { path: source, type: "file" },
            { path: second, type: "directory" },
            { path: source, type: "file" },
          ])
        }),
      ),
    ),
  )

  it.live("follows missing source directories as their parents appear", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const source = path.join(tmp.path, "generated", "skills")
          const skill = yield* start([source], tmp.path)
          const watcher = yield* Watcher.Test
          expect(yield* skill.list()).toEqual([])
          expect(yield* watcher.subscriptions()).toEqual([{ path: path.join(tmp.path, "generated"), type: "file" }])

          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "generated")))
          yield* emitAndWait({ type: "create", path: path.join(tmp.path, "generated") })
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(source, "deploy"), { recursive: true })
            await write(source, "deploy", "Deploy")
          })
          yield* emitAndWait({ type: "create", path: source })
          expect((yield* skill.list()).map((item) => item.id)).toEqual([Skill.ID.make("deploy")])
        }),
      ),
    ),
  )
})
