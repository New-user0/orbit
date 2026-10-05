import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Schedule, Stream } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { Event } from "@orbit/schema/config"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "./fixture/config-nodes"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

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
  const here = location({ directory: AbsolutePath.make(folders.repo) })
  const placed =
    canonical === undefined ? here : { ...here, project: { ...here.project, canonical: AbsolutePath.make(canonical) } }
  return Layer.mergeAll(
    AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]), [
      Config.node.replace(Config.configured()),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
      Location.node.replace(Layer.succeed(Location.Service, Location.Service.of(placed))),
      Global.node.replace(Global.layerWith({ config: folders.globalConfig, home: folders.home })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ]),
    Watcher.testLayer,
  )
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
