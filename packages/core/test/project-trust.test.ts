import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Logger, Schedule, Stream } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Event } from "@orbit/schema/config"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigAgentPlugin } from "@orbit/core/config/plugin/agent"
import { ConfigSkillPlugin } from "@orbit/core/config/plugin/skill"
import { Credential } from "@orbit/core/credential"
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
function loader(folders: Folders, canonical?: string) {
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]),
      replacements(folders, canonical),
    ),
    Watcher.testLayer,
  )
}

// The same, with the registries that the config plugins write to, and what they read the files with.
function pluginLoader(folders: Folders) {
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
      ]),
      replacements(folders),
    ),
    Watcher.testLayer,
  )
}

function replacements(folders: Folders, canonical?: string) {
  const here = location({ directory: AbsolutePath.make(folders.repo) })
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
  it.live("lists what the settings, the plugins, the commands and the agents of an untrusted project hold back", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const status = yield* project.status()
        expect(status).toMatchObject({ directory: folders.repo, trusted: false })
        // In the order the entries rank. The user's own directory holds a plugin, a command with a span and an agent that
        // allows everything, and none of it is listed, and neither are the repository's plain command and its skill.
        expect<unknown>(held(folders.repo, status)).toEqual([
          [CompatNames.mcp, ["mcp"]],
          ["orbit.json", ["hooks", "mcp"]],
          [".orbit", ["plugins", "commands", "permissions", "providers"]],
        ])
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
          write(
            path.join(folders.repo, ".orbit", "agents", "careful.md"),
            `---\ndescription: Careful\npermissions:\n  - action: shell\n    resource: "rm *"\n    effect: deny\n---\nBe careful.`,
          ),
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

  it.live("lists a command that names an agent, and an agent that sets its mode, as held back", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      yield* Effect.promise(() =>
        Promise.all([
          write(path.join(folders.repo, ".orbit", "commands", "setup.md"), "---\nagent: autopilot\n---\nSet up."),
          write(path.join(folders.work, ".orbit", "agents", "autopilot.md"), "---\nmode: all\n---\nMine."),
        ]),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        // Which agent a command runs as, and which agents the model may spawn, are choices between sets of rules.
        expect<unknown>(held(folders.root, yield* project.status())).toEqual([
          [path.join("work", ".orbit"), ["permissions"]],
          [path.join("work", "repo", ".orbit"), ["permissions"]],
        ])
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

  it.live("holds nothing back once the project is trusted, and lists it again as soon as the grant ends", () =>
    Effect.gen(function* () {
      const folders = yield* layout
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const granted = yield* nextUpdate
        expect((yield* project.grant({ persist: false, via: "test" })).withheld).toEqual([])
        yield* Fiber.join(granted)
        expect((yield* project.status()).withheld).toEqual([])

        // The config has not reloaded yet, so no entry is stamped, and the directory is still read for what it holds.
        const reloaded = yield* nextUpdate
        const revoked = yield* project.revoke()
        expect<unknown>(held(folders.repo, revoked)).toEqual([
          [CompatNames.mcp, ["mcp"]],
          ["orbit.json", ["hooks", "mcp"]],
          [".orbit", ["plugins", "commands", "permissions", "providers"]],
        ])
        yield* Fiber.join(reloaded)
        expect(yield* project.status()).toEqual(revoked)
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("lists the directory of a folder above the project until that folder is trusted too", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      yield* Effect.promise(() =>
        Promise.all([
          write(path.join(folders.work, ".orbit", "plugins", "shared.ts"), plugin),
          write(path.join(folders.repo, ".orbit", "commands", "deploy.md"), "Deploy: !`./deploy.sh`"),
        ]),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const listed = yield* project.status()
        expect<unknown>(held(folders.root, listed)).toEqual([
          [path.join("work", ".orbit"), ["plugins"]],
          [path.join("work", "repo", ".orbit"), ["commands"]],
        ])
        // What sits above the project names the folder to trust for it. The project's own files do not, because trusting
        // the project lifts them.
        expect<unknown>(listed.withheld.map((item) => item.directory)).toEqual([folders.work, undefined])

        // Trusting the project does not trust the folder around it.
        const granted = yield* nextUpdate
        yield* project.grant({ persist: false, via: "test" })
        yield* Fiber.join(granted)
        const above = yield* project.status()
        expect(above.trusted).toBe(true)
        expect<unknown>(held(folders.root, above)).toEqual([[path.join("work", ".orbit"), ["plugins"]]])
        expect<unknown>(above.withheld.map((item) => item.directory)).toEqual([folders.work])

        const trust = yield* WorkspaceTrust.Service
        const grantedAbove = yield* nextUpdate
        yield* trust.grant(folders.work, { persist: false, via: "test" })
        yield* Fiber.join(grantedAbove)
        expect((yield* project.status()).withheld).toEqual([])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("names the folder around an Orbit file or a file in a `.orbit` directory above the project", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const settings = { hooks: { PreToolUse: [{ matcher: "shell", hooks: [{ type: "command", command: "echo" }] }] } }
      yield* Effect.promise(() =>
        Promise.all([
          write(path.join(folders.work, "orbit.json"), settings),
          write(path.join(folders.root, ".orbit", "orbit.json"), settings),
        ]),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const status = yield* project.status()

        // The file beside the project's folder and the one in a `.orbit` directory of a folder further up each name the
        // folder around them, which is the one whose trust decides them.
        expect(
          status.withheld.map((item) => [path.relative(folders.root, item.path), item.directory]).toSorted(),
        ).toEqual([
          [path.join(".orbit", "orbit.json"), folders.root],
          [path.join("work", "orbit.json"), folders.work],
        ])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  it.live("names no folder for the files of a linked worktree, whose own folder is not its canonical root", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      // The project is a worktree at `repo` of a main checkout kept elsewhere, so what it holds is not inside the
      // canonical root that the decision is made for, but trusting the project still lifts it.
      const main = path.join(folders.root, "main")
      yield* Effect.promise(() =>
        Promise.all([
          write(path.join(folders.repo, ".orbit", "plugins", "greeter.ts"), plugin),
          write(path.join(folders.work, ".orbit", "plugins", "shared.ts"), plugin),
        ]),
      )
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const status = yield* project.status()

        expect(status.directory).toBe(AbsolutePath.make(main))
        expect(status.withheld.map((item) => [path.relative(folders.root, item.path), item.directory])).toEqual([
          [path.join("work", ".orbit"), folders.work],
          [path.join("work", "repo", ".orbit"), undefined],
        ])
      }).pipe(Effect.provide(loader(folders, main)))
    }),
  )

  it.live("reads a config directory once, until a file under a config root changes", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const orbit = path.join(folders.repo, ".orbit")
      yield* Effect.promise(() => write(path.join(orbit, "commands", "plain.md"), "Plain"))
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        const watcher = yield* Watcher.Test
        expect((yield* project.status()).withheld).toEqual([])

        // A checkout adds a plugin. The answer is kept, so it still says nothing until the change is announced.
        const added = path.join(orbit, "plugins", "greeter.ts")
        yield* Effect.promise(() => write(added, plugin))
        expect((yield* project.status()).withheld).toEqual([])

        // The announcement reaches the service by way of the config's own watches, a moment after it is made.
        const announced = watcher.emit({ path: added, type: "create" }).pipe(
          Effect.andThen(Effect.sleep("20 millis")),
          Effect.andThen(project.status()),
          Effect.filterOrFail(
            (status) => status.withheld.length > 0,
            () => "the answer has not been read again",
          ),
          Effect.retry({ times: 100, schedule: Schedule.spaced("20 millis") }),
        )
        expect<unknown>(held(folders.repo, yield* announced)).toEqual([[".orbit", ["plugins"]]])
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
        expect(yield* Effect.forEach(Object.values(own), project.allows)).toEqual(Object.values(own).map(() => false))
        expect(yield* Effect.forEach(Object.values(mine), project.allows)).toEqual(Object.values(mine).map(() => true))

        // Trusting the project allows its files once the config has reloaded, which stamps its entries trusted. A file
        // is not allowed on a stamp that is out of date, so a revoke refuses at once.
        const granted = yield* nextUpdate
        yield* project.grant({ persist: false, via: "test" })
        yield* Fiber.join(granted)
        expect(yield* Effect.forEach(Object.values(own), project.allows)).toEqual(Object.values(own).map(() => true))
        yield* project.revoke()
        expect(yield* Effect.forEach(Object.values(own), project.allows)).toEqual(Object.values(own).map(() => false))
        expect(yield* Effect.forEach(Object.values(mine), project.allows)).toEqual(Object.values(mine).map(() => true))
      }).pipe(Effect.provide(loader(folders)))
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

  it.live("ends in a loop of links that points nowhere, and counts it as where it is", () =>
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
        // Nothing can be opened through such a loop, so there is nothing to ask about.
        expect(yield* project.escapes(path.join(first, "later.txt"))).toBeUndefined()
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

        expect(yield* what).toEqual(["Prompt from inside.", undefined, []])
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
