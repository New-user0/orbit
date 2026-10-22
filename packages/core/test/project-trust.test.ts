import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Logger, Schedule, Stream } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Event } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { LinkShare } from "@orbit/util/link-share"
import { ConfigAgentPlugin } from "@orbit/core/config/plugin/agent"
import { ConfigSkillPlugin } from "@orbit/core/config/plugin/skill"
import { Credential } from "@orbit/core/credential"
import { ManagedPolicy } from "@orbit/core/managed-policy"
import { ManagedSettings } from "@orbit/core/managed-settings"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { Skill } from "@orbit/core/skill"
import { SkillDiscovery } from "@orbit/core/skill/discovery"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { grantWithRecords } from "./fixture/grant"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { agentHost, host } from "./plugin/host"

const it = testEffect(Layer.empty)

interface Folders {
  readonly root: string
  readonly home: string
  readonly globalConfig: string
  /** The folder above the project, which discovery walks through. */
  readonly work: string
  readonly repo: string
}

// The real configuration loader and ProjectTrust over a project in a home of its own, in a folder that nothing trusts
// on its own. The watcher is the test one, so that a test can say that a file changed.
// With `canonical`, the project is a linked worktree of a main checkout kept there.
function loader(folders: Folders, canonical?: string, directory?: string, filesystem?: Layer.Layer<FSUtil.Service>) {
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]),
      replacements(folders, canonical, directory, filesystem),
    ),
    Watcher.testLayer,
  )
}

// The same, with the registries that the config plugins write to, and what they read the files with. `extra` replaces more
// nodes, such as the config with a flag document or the managed settings folder.
function pluginLoader(folders: Folders, extra: LayerNode.Replacements = []) {
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([
        Config.node,
        Bus.node,
        WorkspaceTrust.node,
        ProjectTrust.node,
        Agent.node,
        Skill.node,
        FSUtil.node,
        Global.node,
        Location.node,
        ManagedPolicy.node,
      ]),
      [...replacements(folders), ...extra],
    ),
    Watcher.testLayer,
  )
}

function replacements(folders: Folders, canonical?: string, directory?: string, filesystem?: Layer.Layer<FSUtil.Service>) {
  const here = location(
    { directory: AbsolutePath.make(directory ?? folders.repo) },
    directory === undefined ? {} : { projectDirectory: AbsolutePath.make(folders.repo) },
  )
  const placed =
    canonical === undefined ? here : { ...here, project: { ...here.project, canonical: AbsolutePath.make(canonical) } }
  return [
    Config.node.replace(Config.configured()),
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
    Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(placed))),
    Global.node.replace(Global.layerWith({ config: folders.globalConfig, home: folders.home })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
    ...(filesystem ? [FSUtil.node.replace(filesystem)] : []),
  ] satisfies LayerNode.Replacements
}

const write = (file: string, contents: unknown) =>
  Bun.write(file, typeof contents === "string" ? contents : JSON.stringify(contents))

const plugin = `export default { id: "greeter", async setup() {} }`
const allowsEverything = `---
permissions:
  - action: shell
    resource: "*"
    effect: allow
---
Run anything.`

// The folders of a project in a home of its own, with the user's own config directory holding all that a config
// directory can hold: nothing in it is ever held back.
const bare = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  const folders = {
    root,
    home: path.join(root, "home"),
    globalConfig: path.join(root, "home", ".config", "orbit"),
    work: path.join(root, "work"),
    repo: path.join(root, "work", "repo"),
  } satisfies Folders
  yield* Effect.promise(() =>
    Promise.all([
      write(path.join(folders.globalConfig, "plugins", "mine.ts"), plugin),
      write(path.join(folders.globalConfig, "commands", "mine.md"), "Mine: !`date`"),
      write(path.join(folders.globalConfig, "agents", "mine.md"), allowsEverything),
    ]),
  )
  return folders
})

// A repository that asks for what trust holds back in every way it can: settings that start hooks and servers, a
// plugin, a command that runs a shell snippet, and an agent that allows everything and changes where requests go.
const layout = Effect.gen(function* () {
  const folders = yield* bare
  yield* Effect.promise(() =>
    Promise.all([
      write(path.join(folders.repo, "orbit.json"), {
        model: "project/model",
        hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "echo project" }] }] },
        mcp: { servers: { docs: { type: "local", command: ["docs-server"] } } },
      }),
      write(path.join(folders.repo, CompatNames.mcp), { mcpServers: { files: { command: "files-server" } } }),
      write(path.join(folders.repo, ".orbit", "plugins", "greeter.ts"), plugin),
      write(path.join(folders.repo, ".orbit", "commands", "deploy.md"), "Deploy: !`./deploy.sh`"),
      write(path.join(folders.repo, ".orbit", "commands", "plain.md"), "Plain $ARGUMENTS"),
      write(
        path.join(folders.repo, ".orbit", "agents", "ops.md"),
        `---\nrequest:\n  headers:\n    x-ops: "1"\npermissions:\n  - action: shell\n    resource: "*"\n    effect: allow\n---\nOperate.`,
      ),
      write(path.join(folders.repo, ".orbit", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nDemo."),
    ]),
  )
  return folders
})

const nextUpdate = Effect.gen(function* () {
  const bus = yield* Bus.Service
  return yield* bus
    .subscribe(Event.Updated)
    .pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("10 seconds"),
      Effect.forkScoped({ startImmediately: true }),
    )
})

// The paths of a status relative to the folder, so that a test does not spell a temporary one.
const held = (folder: string, status: { readonly withheld: readonly { path: string; kinds: readonly string[] }[] }) =>
  status.withheld.map((item) => [path.relative(folder, item.path), item.kinds])

describe("ProjectTrust.status", () => {
  // trust-first: nothing of an untrusted folder is read, whatever it holds, so its status lists nothing as held back. A
  // client asks about the folder because it is not trusted, not because of what it holds.
  it.live("lists nothing for an untrusted project, whatever it holds, and nothing once it is trusted", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect(yield* project.status()).toMatchObject({ directory: folders.repo, trusted: false, withheld: [], changed: [] })
        // The control: once trusted, the folder is read, and what it holds is what was trusted, so nothing is held back.
        expect(yield* project.grant({ persist: false, via: "test" })).toMatchObject({ trusted: true, withheld: [], changed: [] })
      }).pipe(Effect.provide(loader(folders)))
    }),
  )


  it.live("lists nothing for a config directory that holds only what an untrusted project may use", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      yield* Effect.promise(() =>
        Promise.all([
          write(
            path.join(folders.repo, ".orbit", "commands", "plain.md"),
            "Plain $ARGUMENTS and `code` and !not-a-span",
          ),
          // A file that is not a command is not loaded, so a snippet in it holds nothing back.
          write(path.join(folders.repo, ".orbit", "commands", "broken.md"), "---\nsubagent: maybe\n---\n!`rm -rf /`"),
          write(path.join(folders.repo, ".orbit", "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nDemo."),
          write(path.join(folders.repo, ".orbit", "themes", "dark.json"), {}),
        ]),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect(yield* project.status()).toMatchObject({ trusted: false, withheld: [] })
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("does not read a file that a link leads out of the project to say what a config directory holds back", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside")
      yield* Effect.promise(async () => {
        // An agent that allows everything, which would be listed if it were read.
        await write(path.join(outside, "ops.md"), allowsEverything)
        await write(path.join(folders.repo, ".orbit", "commands", "plain.md"), "Plain")
        await fs.symlink(outside, path.join(folders.repo, ".orbit", "agents"), "junction")
      })
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect((yield* project.status()).withheld).toEqual([])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("holds nothing back once the project is trusted, and reads nothing again as soon as the grant ends", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect((yield* project.grant({ persist: false, via: "test" })).withheld).toEqual([])
        expect((yield* project.status()).withheld).toEqual([])
        const revoked = yield* project.revoke()
        expect(revoked).toMatchObject({ trusted: false, withheld: [], changed: [] })
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})


describe("ProjectTrust.allows", () => {
  it.live("refuses a file under an untrusted project's config directory and allows one under the user's own", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const own = {
          agent: path.join(folders.repo, ".orbit", "agents", "ops.md"),
          skill: path.join(folders.repo, ".orbit", "skills", "demo", "SKILL.md"),
          command: path.join(folders.repo, ".orbit", "commands", "deploy.md"),
          plugin: path.join(folders.repo, ".orbit", "plugins", "greeter.ts"),
          settings: path.join(folders.repo, "orbit.json"),
          // A file that no entry speaks for, in a project that has not been trusted, is the project's too.
          source: path.join(folders.repo, "src", "tool.md"),
        }
        const mine = {
          agent: path.join(folders.globalConfig, "agents", "mine.md"),
          command: path.join(folders.globalConfig, "commands", "mine.md"),
          plugin: path.join(folders.globalConfig, "plugins", "mine.ts"),
        }
        expect(yield* Effect.forEach(Object.values(own), (file) => project.allows(file))).toEqual(
          Object.values(own).map(() => false),
        )
        expect(yield* Effect.forEach(Object.values(mine), (file) => project.allows(file))).toEqual(
          Object.values(mine).map(() => true),
        )

        // Trusting the project allows its files once the config has reloaded, which stamps its entries trusted. A file
        // is not allowed on a stamp that is out of date, so a revoke refuses at once.
        const granted = yield* nextUpdate
        yield* project.grant({ persist: false, via: "test" })
        yield* Fiber.join(granted)
        expect(yield* Effect.forEach(Object.values(own), (file) => project.allows(file))).toEqual(
          Object.values(own).map(() => true),
        )
        yield* project.revoke()
        expect(yield* Effect.forEach(Object.values(own), (file) => project.allows(file))).toEqual(
          Object.values(own).map(() => false),
        )
        expect(yield* Effect.forEach(Object.values(mine), (file) => project.allows(file))).toEqual(
          Object.values(mine).map(() => true),
        )
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})

describe("ProjectTrust.status, plugins planted after the grant", () => {
  it.live("lists a plugin that shows up in a trusted folder at once, before the config has reloaded", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const config = path.join(folders.repo, ".orbit")
      yield* Effect.promise(() =>
        write(path.join(config, "skills", "x", "SKILL.md"), "---\nname: x\ndescription: d\n---\nText."),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const next = yield* nextUpdate
        yield* grantWithRecords(folders.repo, { persist: false, via: "test" })
        yield* Fiber.join(next)
        expect((yield* project.status()).changed).toEqual([])

        // A client that imports plugins on a file event asks before the debounced reload has run.
        yield* Effect.promise(() => write(path.join(config, "plugins", "late.ts"), plugin))
        const status = yield* project.status()
        expect<unknown>(status.changed?.map((item) => [item.path, item.kinds])).toEqual([[config, ["plugins"]]])
        expect(held(folders.root, status)).toEqual([[path.join("work", "repo", ".orbit"), ["plugins"]]])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})

describe("ProjectTrust.allows, nested config", () => {
  // A config directory in a folder of the project that is neither the location nor the project's root: the nearest
  // cover of its files is the directory's own entry, whose stamp is the verdict of the last load.
  const nested = Effect.gen(function* () {
    const folders = yield* bare
    const sub = path.join(folders.repo, "pkg", "sub")
    const skill = path.join(folders.repo, "pkg", ".orbit", "skills", "x", "SKILL.md")
    yield* Effect.promise(() =>
      Promise.all([write(skill, "---\nname: x\ndescription: d\n---\nText."), write(path.join(sub, ".keep"), "")]),
    )
    return { folders, sub, skill }
  })

  it.live("answers a revoke at once and a grant at once, before the config has reloaded", () =>
    Effect.gen(function* () {
      const { folders, sub, skill } = yield* nested
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect(yield* project.allows(skill)).toBe(false)

        // A grant is in force the moment it is made, not when the stamp catches up with it.
        const granted = yield* nextUpdate
        yield* grantWithRecords(folders.repo, { persist: false, via: "test" })
        expect(yield* project.allows(skill)).toBe(true)
        yield* Fiber.join(granted)
        expect(yield* project.allows(skill)).toBe(true)

        // A revoke must not leave the file allowed on a stamp that still says trusted.
        yield* project.revoke()
        expect(yield* project.allows(skill)).toBe(false)
      }).pipe(Effect.provide(loader(folders, undefined, sub)))
    }),
  )

  it.live("refuses the hooks of a skill file in a directory whose hooks changed, until the grant is renewed", () =>
    Effect.gen(function* () {
      const { folders, skill } = yield* nested
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const next = yield* nextUpdate
        yield* grantWithRecords(folders.repo, { persist: false, via: "test" })
        yield* Fiber.join(next)
        expect(yield* project.allows(skill, "hooks")).toBe(true)

        yield* Effect.promise(() =>
          write(skill, "---\nname: x\ndescription: d\nhooks:\n  Stop:\n    - command: echo hi\n---\nText."),
        )
        // Read now, from the disk: no reload has run.
        expect(yield* project.allows(skill, "hooks")).toBe(false)
        expect(yield* project.allows(skill)).toBe(true)
        expect(yield* project.allows(path.join(folders.repo, "pkg", "readme.md"), "hooks")).toBe(true)
      }).pipe(Effect.provide(loader(folders, undefined, path.join(folders.repo, "pkg", "sub"))))
    }),
  )
})

describe("ProjectTrust.reachable", () => {
  it.live("reads only what is inside an untrusted project, for real, until the project is trusted", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const secret = path.join(folders.root, "outside", "secret.txt")
      yield* Effect.promise(() =>
        Promise.all([
          write(path.join(folders.repo, "notes.md"), "notes"),
          write(path.join(folders.work, "AGENTS.md"), "shared"),
          write(secret, "secret"),
          // A junction reads as a symlink to a directory, and needs no privilege on Windows.
        ]).then(() => fs.symlink(path.dirname(secret), path.join(folders.repo, "linked"), "junction")),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const answers = () =>
          Effect.forEach(
            [
              path.join(folders.repo, "notes.md"),
              // A file that is not there yet is inside by its name, and so it is by where it would be.
              path.join(folders.repo, "later.md"),
              // Inside by its name, and outside for real.
              path.join(folders.repo, "linked", "secret.txt"),
              secret,
              // A folder above the project is not the repository's, so it waits for the project to be trusted too.
              path.join(folders.work, "AGENTS.md"),
              path.join(folders.home, "AGENTS.md"),
            ],
            project.reachable,
          )

        expect(yield* answers()).toEqual([true, true, false, false, false, false])
        yield* project.grant({ persist: false, via: "test" })
        expect(yield* answers()).toEqual([true, true, true, true, true, true])
        yield* project.revoke()
        expect(yield* answers()).toEqual([true, true, false, false, false, false])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("counts the main checkout of a linked worktree as inside, since one decision covers both", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const main = path.join(folders.root, "main")
      yield* Effect.promise(() =>
        Promise.all([write(path.join(main, "AGENTS.md"), "main"), write(path.join(folders.root, "AGENTS.md"), "root")]),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect(yield* project.reachable(path.join(main, "AGENTS.md"))).toBe(true)
        expect(yield* project.reachable(path.join(folders.root, "AGENTS.md"))).toBe(false)
      }).pipe(Effect.provide(loader(folders, main)))
    }),
  )

  it.live("counts a file that is not there yet by where a link in its path would put it", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside")
      yield* Effect.promise(async () => {
        await write(path.join(outside, "keep.txt"), "x")
        await fs.mkdir(folders.repo, { recursive: true })
        await fs.symlink(outside, path.join(folders.repo, "linked"), "junction")
      })
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        expect(
          yield* Effect.forEach(
            [path.join(folders.repo, "later.md"), path.join(folders.repo, "linked", "later.md")],
            project.reachable,
          ),
        ).toEqual([true, false])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})

// What the file tools ask before they count a path as inside the project: a link that the repository ships can lead
// anywhere, and a write through one creates the file there.
describe("ProjectTrust.escapes", () => {
  it.live("says where a link in an untrusted project leads, for a file that is there and for one that is not yet", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside")
      const inside = path.join(folders.repo, "docs")
      yield* Effect.promise(async () => {
        await write(path.join(folders.repo, "notes.md"), "notes")
        await write(path.join(inside, "guide.md"), "guide")
        await write(path.join(outside, "secret.txt"), "secret")
        // A junction reads as a symlink to a directory, and needs no privilege on Windows.
        await fs.symlink(outside, path.join(folders.repo, "linked"), "junction")
        await fs.symlink(inside, path.join(folders.repo, "shortcut"), "junction")
        // A link that points nowhere leads where it points, which is where a write through it would land.
        await fs.symlink(path.join(outside, "missing"), path.join(folders.repo, "dangling"), "junction")
      })
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const answers = () =>
          Effect.forEach(
            [
              path.join(folders.repo, "notes.md"),
              // Not there yet, in a folder that is.
              path.join(folders.repo, "later.md"),
              path.join(folders.repo, "docs", "later.md"),
              // A link that stays inside the project.
              path.join(folders.repo, "shortcut", "guide.md"),
              // Leaves the project, for a file that is there, one that is not and one whose folder is not either.
              path.join(folders.repo, "linked", "secret.txt"),
              path.join(folders.repo, "linked", "later.txt"),
              path.join(folders.repo, "linked", "deeper", "later.txt"),
              path.join(folders.repo, "dangling", "later.txt"),
              // Outside by its name.
              path.join(folders.work, "AGENTS.md"),
            ],
            project.escapes,
          )
        const leaving = [
          undefined,
          undefined,
          undefined,
          undefined,
          path.join(outside, "secret.txt"),
          path.join(outside, "later.txt"),
          path.join(outside, "deeper", "later.txt"),
          path.join(outside, "missing", "later.txt"),
          path.join(folders.work, "AGENTS.md"),
        ]

        expect(yield* answers()).toEqual(leaving)
        // Trusting the project follows links as before, and ending the trust holds them again.
        yield* project.grant({ persist: false, via: "test" })
        expect(yield* answers()).toEqual(leaving.map(() => undefined))
        yield* project.revoke()
        expect(yield* answers()).toEqual(leaving)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("ends in a loop of links that points nowhere, and answers it as unresolved, not as the name it reached", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const first = path.join(folders.repo, "first")
      const second = path.join(folders.repo, "second")
      yield* Effect.promise(async () => {
        await fs.mkdir(folders.repo, { recursive: true })
        await fs.symlink(second, first, "junction")
        await fs.symlink(first, second, "junction")
      })
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        // Nothing can be opened through such a loop, but the walk gave up on it and did not find where it leads, so it is
        // not counted as a file of the project: callers refuse it as they refuse a share.
        const escaped = yield* project.escapes(path.join(first, "later.txt"))
        expect(escaped !== undefined && LinkShare.isUnresolved(escaped)).toBe(true)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})

// What the plugins that read agents, commands, skills and output styles ask: a repository's config directory holds
// files, and a link among them must not carry a file of the user's into the prompt.
describe("ProjectTrust.supplies", () => {
  const skippedNotices = () => {
    const skipped: Array<{ path: unknown; reason: unknown }> = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      if (!Array.isArray(entry.message) || entry.message[0] !== "config file skipped") return
      skipped.push(entry.message[1])
    })
    return { skipped, logger: Logger.layer([logger]) }
  }

  it.live(
    "reads from an untrusted project's config directory only what stays inside it, and follows the decision",
    () => {
      const { skipped, logger } = skippedNotices()
      return Effect.gen(function* () {
        const folders = yield* bare
        const outside = path.join(folders.root, "outside")
        const orbit = path.join(folders.repo, ".orbit")
        yield* Effect.promise(async () => {
          await write(path.join(orbit, "agents", "own.md"), "own")
          await write(path.join(folders.repo, "shared", "kept.md"), "kept")
          await write(path.join(outside, "stolen.md"), "stolen")
          await fs.symlink(path.join(folders.repo, "shared"), path.join(orbit, "skills"), "junction")
          await fs.symlink(outside, path.join(orbit, "commands"), "junction")
        })
        const own = path.join(orbit, "agents", "own.md")
        const kept = path.join(orbit, "skills", "kept.md")
        const stolen = path.join(orbit, "commands", "stolen.md")
        // The stamp of the config that was loaded before the decision, as the plugins see it.
        const source = { path: orbit, scope: "project", trusted: false } as const

        yield* Effect.gen(function* () {
          const project = yield* ProjectTrust.Service
          const answers = () => Effect.forEach([own, kept, stolen], (file) => project.supplies(source, file))

          expect(yield* answers()).toEqual([true, true, false])
          expect(yield* answers()).toEqual([true, true, false])
          // The file is reported once, however often it is asked for.
          expect(skipped).toMatchObject([{ path: stolen, reason: expect.stringContaining("not trusted") }])

          // The project's own decision counts at once, before the config has reloaded and dropped the stamp.
          yield* project.grant({ persist: false, via: "test" })
          expect(yield* answers()).toEqual([true, true, true])
          yield* project.revoke()
          expect(yield* answers()).toEqual([true, true, false])
          expect(skipped).toHaveLength(1)
        }).pipe(Effect.provide(loader(folders)))
      }).pipe(Effect.provide(logger))
    },
  )

  it.live("does not hold what the user owns, or what its folder has been trusted for", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside")
      yield* Effect.promise(async () => {
        await write(path.join(outside, "elsewhere.md"), "elsewhere")
        await fs.mkdir(folders.repo, { recursive: true })
        await fs.symlink(outside, path.join(folders.globalConfig, "skills"), "junction")
        await fs.symlink(outside, path.join(folders.repo, ".orbit"), "junction")
      })
      const file = (...parts: string[]) => path.join(...parts, "elsewhere.md")
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        // The user's own config directory may be a link to wherever they keep it. So may a project's, once its folder is
        // trusted, which is a stamp that says so, and a directory that no scope speaks for.
        expect(
          yield* Effect.forEach(
            [
              [{ path: folders.globalConfig, scope: "user" as const }, file(folders.globalConfig, "skills")],
              [{ path: path.join(folders.repo, ".orbit"), scope: "project" as const }, file(folders.repo, ".orbit")],
              [{ path: path.join(folders.repo, ".orbit") }, file(folders.repo, ".orbit")],
            ] as const,
            ([source, target]) => project.supplies(source, target),
          ),
        ).toEqual([true, false, true])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  // Class 4: a project that is the home folder contains everything below it, so a link in a config directory of a folder
  // below it may not carry a file of the user's out of that folder, whatever the decision for the project. Each row is a
  // way a repository can lead a definition (an agent, a command, a skill, an output style) to a file elsewhere under home.
  for (const granted of [false, true])
    it.live(`holds a config directory below a project at home to its own folder, ${granted ? "trusted for the session" : "not trusted"}`, () =>
      Effect.gen(function* () {
        const bareFolders = yield* bare
        const folders = { ...bareFolders, repo: bareFolders.home }
        const started = path.join(folders.home, "Downloads", "x")
        const orbit = path.join(started, ".orbit")
        const notes = path.join(folders.home, "Documents", "notes")
        yield* Effect.promise(async () => {
          await write(path.join(orbit, "skills", "own", "SKILL.md"), "own")
          await write(path.join(notes, "diary.md"), "private")
          await write(path.join(folders.home, ".aws", "credentials"), "secret")
          await fs.symlink(notes, path.join(orbit, "agents"), "junction")
          await fs.symlink(notes, path.join(orbit, "skills", "linked"), "junction")
          await fs.symlink(path.join(folders.home, ".aws"), path.join(orbit, "commands"), "junction")
        })
        const rows = [
          ["a plain file of the folder", path.join(orbit, "skills", "own", "SKILL.md"), true],
          ["a file under a linked config folder", path.join(orbit, "agents", "diary.md"), false],
          ["a file under a linked skill folder", path.join(orbit, "skills", "linked", "diary.md"), false],
          ["a credentials file under a linked commands folder", path.join(orbit, "commands", "credentials"), false],
        ] as const
        yield* Effect.gen(function* () {
          const project = yield* ProjectTrust.Service
          if (granted) yield* project.grant({ persist: false, via: "test" })
          const source = { path: orbit, scope: "project", trusted: false } as const
          expect(yield* Effect.forEach(rows, ([, file]) => project.supplies(source, file))).toEqual([true, false, false, false])
        }).pipe(Effect.provide(loader(folders, undefined, started)))
      }),
    )

  // The person's own sources are theirs wherever the session starts: a session at home, or below a home repository,
  // puts the global config folder and a vendor's user root inside the project's folders, and a link from them to the
  // person's dotfiles must still be read.
  for (const startedAtHome of [true, false])
    for (const granted of [false, true])
      it.live(`does not hold the person's own sources when the project is home, started ${startedAtHome ? "at home" : "below it"}, ${granted ? "trusted for the session" : "not trusted"}`, () =>
        Effect.gen(function* () {
          const bareFolders = yield* bare
          const folders = { ...bareFolders, repo: bareFolders.home }
          const started = startedAtHome ? folders.home : path.join(folders.home, "Downloads", "x")
          const dotfiles = path.join(folders.home, "dotfiles")
          const vendor = path.join(folders.home, ".vendorx")
          yield* Effect.promise(async () => {
            await fs.mkdir(started, { recursive: true })
            await write(path.join(dotfiles, "skills", "s", "SKILL.md"), "mine")
            await write(path.join(dotfiles, "agents", "mine.md"), "mine")
            await fs.mkdir(vendor, { recursive: true })
            await fs.symlink(path.join(dotfiles, "skills"), path.join(folders.globalConfig, "skills"), "junction")
            await fs.symlink(path.join(dotfiles, "agents"), path.join(vendor, "agents"), "junction")
          })
          yield* Effect.gen(function* () {
            const project = yield* ProjectTrust.Service
            if (granted) yield* project.grant({ persist: false, via: "test" })
            expect(
              yield* Effect.forEach(
                [
                  [{ path: folders.globalConfig, scope: "user" as const }, path.join(folders.globalConfig, "skills", "s", "SKILL.md")],
                  [{ path: vendor, scope: "user" as const }, path.join(vendor, "agents", "mine.md")],
                  [{ path: vendor, scope: "user" as const }, path.join(vendor, "agents")],
                ] as const,
                ([source, file]) => project.supplies(source, file),
              ),
            ).toEqual([true, true, true])
          }).pipe(Effect.provide(loader(folders, undefined, started)))
        }),
      )

  // A config folder that is itself a link leads to wherever its target is, and the folders of a project at home reach
  // everything under home, so its real path is not one of the folders a file may come from. An ordinary project that is
  // trusted for the session holds nothing back, which is the control.
  for (const wide of [true, false])
    for (const granted of [false, true])
      it.live(`holds a config folder that is a link out to the folder it points at, ${wide ? "project at home" : "ordinary project"}, ${granted ? "trusted for the session" : "not trusted"}`, () =>
        Effect.gen(function* () {
          const bareFolders = yield* bare
          const folders = wide ? { ...bareFolders, repo: bareFolders.home } : bareFolders
          const started = wide ? path.join(folders.home, "Downloads", "x") : folders.repo
          const target = path.join(folders.home, "work", "secret", ".orbit")
          yield* Effect.promise(async () => {
            await fs.mkdir(started, { recursive: true })
            await write(path.join(target, "agents", "private.md"), "private agent")
            await write(path.join(target, "skills", "s", "SKILL.md"), "private skill")
            await fs.symlink(target, path.join(started, ".orbit"), "junction")
          })
          yield* Effect.gen(function* () {
            const project = yield* ProjectTrust.Service
            if (granted) yield* project.grant({ persist: false, via: "test" })
            const orbit = path.join(started, ".orbit")
            const source = { path: orbit, scope: "project", trusted: false } as const
            expect(
              yield* Effect.forEach(
                [path.join(orbit, "agents", "private.md"), path.join(orbit, "skills", "s", "SKILL.md")],
                (file) => project.supplies(source, file),
              ),
            ).toEqual(granted && !wide ? [true, true] : [false, false])
          }).pipe(Effect.provide(loader(folders, undefined, started)))
        }),
      )

  it.live("holds a folder above the project to that folder, and to its own decision rather than the project's", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside")
      const above = path.join(folders.work, ".orbit")
      yield* Effect.promise(async () => {
        await write(path.join(above, "agents", "shared.md"), "shared")
        await write(path.join(folders.repo, "notes.md"), "notes")
        await write(path.join(outside, "stolen.md"), "stolen")
        // A link that goes down into the project stays inside the folder around it. One that goes out of it does not.
        await fs.symlink(folders.repo, path.join(above, "skills"), "junction")
        await fs.symlink(outside, path.join(above, "commands"), "junction")
      })
      const files = [
        path.join(above, "agents", "shared.md"),
        path.join(above, "skills", "notes.md"),
        path.join(above, "commands", "stolen.md"),
      ]
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const untrusted = { path: above, scope: "project", trusted: false } as const
        const answers = (source: Parameters<typeof project.supplies>[0]) =>
          Effect.forEach(files, (file) => project.supplies(source, file))

        expect(yield* answers(untrusted)).toEqual([true, true, false])
        // Trusting the project does not trust the folder around it, whose stamp is what decides.
        yield* project.grant({ persist: false, via: "test" })
        expect(yield* answers(untrusted)).toEqual([true, true, false])
        // Once the folder is trusted, its stamp says so.
        expect(yield* answers({ path: above, scope: "project" })).toEqual([true, true, true])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})

// What `supplies` asks first, said on its own for what a source's text may speak for: the output style plugin changes the
// prompt's opening line only for a style whose folder is trusted. One row for each kind of source, before a grant, after
// one and after a revoke.
describe("ProjectTrust.trustedSource", () => {
  it.live("answers for the folder that holds a source, as supplies does, and follows the decision at once", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const orbit = path.join(folders.repo, ".orbit")
      const above = path.join(folders.work, ".orbit")
      // [what the source is, whether it is trusted before a grant, after a grant and after a revoke]
      const rows = [
        // The person's own sources, and a directory that no scope speaks for.
        ...(["user", "remote", "flag", "managed"] as const).map(
          (scope) => [`a ${scope} directory`, { path: folders.globalConfig, scope }, [true, true, true]] as const,
        ),
        ["a directory with no scope", { path: orbit }, [true, true, true]] as const,
        // Where the person's own source is, and what its stamp says, does not matter.
        ["a user directory inside the project", { path: orbit, scope: "user" }, [true, true, true]] as const,
        [
          "a user directory stamped untrusted",
          { path: above, scope: "user", trusted: false },
          [true, true, true],
        ] as const,
        // The project's own folders follow the decision just made, whatever the stamp says.
        ["a project directory", { path: orbit, scope: "project", trusted: false }, [false, true, false]] as const,
        ["a project directory with no stamp", { path: orbit, scope: "project" }, [false, true, false]] as const,
        ["a local directory", { path: orbit, scope: "local", trusted: false }, [false, true, false]] as const,
        [
          "a project directory whose stamp trails",
          { path: orbit, scope: "project", trusted: true },
          [false, true, false],
        ] as const,
        // A folder above the project follows its own stamp, which trusting the project does not change.
        [
          "a directory above, stamped untrusted",
          { path: above, scope: "project", trusted: false },
          [false, false, false],
        ] as const,
        [
          "a directory above, stamped trusted",
          { path: above, scope: "project", trusted: true },
          [true, true, true],
        ] as const,
        ["a directory above, with no stamp", { path: above, scope: "project" }, [true, true, true]] as const,
      ]

      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const asked = () =>
          Effect.forEach(rows, ([name, source]) =>
            project.trustedSource(source).pipe(Effect.map((answer) => [name, answer] as const)),
          )
        const expected = (when: 0 | 1 | 2) => rows.map(([name, , answers]) => [name, answers[when]] as const)

        expect(yield* asked()).toEqual(expected(0))
        yield* project.grant({ persist: false, via: "test" })
        expect(yield* asked()).toEqual(expected(1))
        yield* project.revoke()
        expect(yield* asked()).toEqual(expected(2))
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})

// The plugins that read a config directory take part in the decision through the config that stamps it: a grant reloads
// the config, which publishes `config.updated`, and they read the files again. Nothing here says that the config has
// reloaded, so this is the whole path, from a junction in a project that nothing trusts to the agent and the skill it
// leads to.
describe("the config plugins over the real configuration loader", () => {
  it.live("pick up what a link leads to as soon as the project is trusted, without a restart", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "outside")
      yield* Effect.promise(async () => {
        await write(path.join(outside, "agents", "linked.md"), "Prompt from outside.")
        await write(path.join(outside, "skills", "far", "SKILL.md"), "---\nname: far\n---\nSkill from outside.")
        await write(path.join(folders.repo, ".orbit", "agents", "near.md"), "Prompt from inside.")
        await fs.symlink(path.join(outside, "agents"), path.join(folders.repo, ".orbit", "agents", "out"), "junction")
        await fs.symlink(path.join(outside, "skills"), path.join(folders.repo, ".orbit", "skills"), "junction")
      })
      yield* Effect.gen(function* () {
        const agents = yield* Agent.Service
        const bus = yield* Bus.Service
        const project = yield* ProjectTrust.Service
        const skills = yield* Skill.Service
        const events = { subscribe: () => bus.subscribe(Event.Updated) }
        yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents), event: events }))
        yield* ConfigSkillPlugin.Plugin.effect(
          host({
            skill: { list: () => Effect.die("unused skill.list"), transform: skills.transform, reload: skills.reload },
            event: events,
          }),
        ).pipe(
          Effect.provideService(SkillDiscovery.Service, SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) })),
        )
        const what = Effect.gen(function* () {
          return [
            (yield* agents.get(Agent.ID.make("near")))?.system,
            (yield* agents.get(Agent.ID.make("out/linked")))?.system,
            (yield* skills.list()).map((skill) => skill.id),
          ]
        })

        // Nothing of the untrusted project is read, its own files included (trust-first).
        expect(yield* what).toEqual([undefined, undefined, []])
        yield* project.grant({ persist: false, via: "test" })
        yield* what.pipe(
          Effect.filterOrFail(
            (found) => found[1] !== undefined && found[2]?.length === 1,
            () => "the plugins have not read the files again",
          ),
          Effect.retry({ times: 100, schedule: Schedule.spaced("50 millis") }),
        )
        expect(yield* what).toEqual(["Prompt from inside.", "Prompt from outside.", [Skill.ID.make("far")]])
      }).pipe(Effect.provide(pluginLoader(folders)))
    }),
  )
})

// Class 8 by scope order, over the real loader: the person's agent comes from `ORBIT_CONFIG_CONTENT` (the flag scope, as
// `--agents` and `--settings` do) or from the managed settings folder, both of which rank after the project, so the agent
// does not exist yet when the repository's entry or file comes up.
// Mutation: build `named` in ConfigAgentPlugin from `editor.list()` alone and every row fails before the grant.
describe("an agent the person defines in a scope above the project, over the real configuration loader", () => {
  const MARKER = "RANK-MARKER the person allows every command"
  const own = JSON.stringify({ agents: { helper: { mode: "subagent" } } })
  const doors = [
    ["orbit.json", { agents: { helper: { system: MARKER, description: MARKER, initial_prompt: MARKER } } }],
    [
      path.join(".orbit", "agents", "helper.md"),
      ["---", `description: ${MARKER}`, `initial_prompt: ${MARKER}`, "---", MARKER].join("\n"),
    ],
  ] as const

  for (const scope of ["flag", "managed"] as const) {
    for (const [door, contents] of doors) {
      it.live(`${scope}: ${door} of an untrusted project writes none of the agent's text until the project is trusted`, () =>
        Effect.gen(function* () {
          const folders = yield* bare
          const managed = path.join(folders.root, "managed")
          yield* Effect.promise(() =>
            Promise.all([
              write(path.join(folders.repo, door), contents),
              ...(scope === "managed" ? [write(path.join(managed, "managed-settings.json"), own)] : []),
            ]),
          )
          const extra =
            scope === "flag"
              ? [Config.node.replace(Config.configured({ content: own }))]
              : [ManagedSettings.node.replace(ManagedSettings.configured({ directory: managed }))]
          yield* Effect.gen(function* () {
            const agents = yield* Agent.Service
            const bus = yield* Bus.Service
            const project = yield* ProjectTrust.Service
            yield* ConfigAgentPlugin.Plugin.effect(
              host({ agent: agentHost(agents), event: { subscribe: () => bus.subscribe(Event.Updated) } }),
            )
            const helper = Effect.suspend(() => agents.get(Agent.ID.make("helper")))
            const agent = yield* helper
            expect([agent?.system, agent?.description, agent?.initialPrompt, agent?.source?.scope, agent?.mode]).toEqual([
              undefined,
              undefined,
              undefined,
              scope,
              "subagent",
            ])
            expect(JSON.stringify(agent)).not.toContain("RANK-MARKER")
            // Control: the same files write the text once the project is trusted.
            yield* project.grant({ persist: false, via: "test" })
            const trusted = yield* helper.pipe(
              Effect.filterOrFail(
                (found) => found?.system === MARKER,
                () => "the agents have not been read again",
              ),
              Effect.retry({ times: 200, schedule: Schedule.spaced("50 millis") }),
            )
            expect([trusted?.description, trusted?.initialPrompt, trusted?.source?.scope]).toEqual([
              MARKER,
              MARKER,
              "project",
            ])
          }).pipe(Effect.provide(pluginLoader(folders, extra)))
        }),
        30_000,
      )
    }
  }
})
