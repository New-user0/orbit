import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Event } from "@orbit/schema/config"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Fingerprint } from "@orbit/core/config/fingerprint"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { ProjectTrust } from "@orbit/core/project-trust"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Class 1 and 4: the fingerprints and the loaders bound a read by the same folders. A link whose real path is inside the
// project is followed, whichever side of the config directory it sits on, so editing its target or adding to it after
// the grant is a change. A link that leads out of the project is named with where it points and never read, and a plugin
// behind one is not loaded. Each row has a control: the same change is accepted by a new grant.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node])))
const live = testEffect(Layer.empty)

const write = (file: string, contents: string) =>
  fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, contents))

// A directory link needs no elevation on Windows (a junction); a file link does, and the row ends there if refused.
const dirLink = (target: string, link: string) =>
  fs.mkdir(path.dirname(link), { recursive: true }).then(() => fs.symlink(target, link, "junction"))
const fileLink = (target: string, link: string) =>
  fs.mkdir(path.dirname(link), { recursive: true }).then(() =>
    fs.symlink(target, link, "file").then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EPERM" || error.code === "UNKNOWN") return false
        throw error
      },
    ),
  )

describe("Fingerprint follows links that stay inside the project", () => {
  it.live("A: .orbit/plugins is a link to a project folder; a plugin added there moves the digest", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const project = (yield* tmpdirScoped()).path
      const shared = path.join(project, "tools", "plugins")
      yield* Effect.promise(async () => {
        await write(path.join(shared, "one.ts"), "export default 1\n")
        await dirLink(shared, path.join(project, ".orbit", "plugins"))
      })
      const folder = path.join(project, ".orbit")
      const before = yield* Fingerprint.pluginsOf(files, folder, [project])
      expect(before).toBeDefined()
      expect(yield* Fingerprint.pluginsOf(files, folder, [project])).toBe(before)
      yield* Effect.promise(() => write(path.join(shared, "evil.ts"), "export default 666\n"))
      expect(yield* Fingerprint.pluginsOf(files, folder, [project])).not.toBe(before)
      // The control: under the folder alone the link counts as outside, so adding to its target is not a change.
      const bounded = yield* Fingerprint.pluginsOf(files, folder, [folder])
      yield* Effect.promise(() => write(path.join(shared, "evil2.ts"), "export default 667\n"))
      expect(yield* Fingerprint.pluginsOf(files, folder, [folder])).toBe(bounded)
    }),
  )

  it.live("B: a plugin file that is a link to a project file; editing the target moves the digest", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const project = (yield* tmpdirScoped()).path
      const real = path.join(project, "scripts", "tool.ts")
      yield* Effect.promise(() => write(real, "export default 1\n"))
      const linked = yield* Effect.promise(() => fileLink(real, path.join(project, ".orbit", "plugins", "tool.ts")))
      if (!linked) return
      const folder = path.join(project, ".orbit")
      const before = yield* Fingerprint.pluginsOf(files, folder, [project])
      yield* Effect.promise(() => write(real, "export default 666\n"))
      expect(yield* Fingerprint.pluginsOf(files, folder, [project])).not.toBe(before)
    }),
  )

  it.live("C: a plugin folder that is a link to a project folder; editing its entry moves the digest", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const project = (yield* tmpdirScoped()).path
      const real = path.join(project, "tools", "myplugin")
      yield* Effect.promise(async () => {
        await write(path.join(real, "package.json"), JSON.stringify({ name: "p", exports: { "./server": "./server.ts" } }))
        await write(path.join(real, "server.ts"), "export default 1\n")
        await dirLink(real, path.join(project, ".orbit", "plugins", "myplugin"))
      })
      const folder = path.join(project, ".orbit")
      const before = yield* Fingerprint.pluginsOf(files, folder, [project])
      yield* Effect.promise(() => write(path.join(real, "server.ts"), "export default 666\n"))
      expect(yield* Fingerprint.pluginsOf(files, folder, [project])).not.toBe(before)
    }),
  )

  it.live("hooks: agents/ is a link to a project folder; editing a definition there moves the digest", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const project = (yield* tmpdirScoped()).path
      const agent = (command: string) => `---\ndescription: a\nhooks:\n  Stop:\n    - command: ${command}\n---\nbody\n`
      yield* Effect.promise(async () => {
        await write(path.join(project, "team", "a.md"), agent("echo one"))
        await dirLink(path.join(project, "team"), path.join(project, ".orbit", "agents"))
      })
      const folder = path.join(project, ".orbit")
      const before = yield* Fingerprint.directory(files, folder, [project])
      expect(before.hooks).toBeDefined()
      yield* Effect.promise(() => write(path.join(project, "team", "a.md"), agent("echo two")))
      expect((yield* Fingerprint.directory(files, folder, [project])).hooks).not.toBe(before.hooks)
    }),
  )
})

describe("Fingerprint names a link that leads out of the project and does not read it", () => {
  it.live("D: a re-pointed link moves the digest and an edit of its target does not", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const base = (yield* tmpdirScoped()).path
      const project = path.join(base, "project")
      const outside = path.join(base, "outside")
      yield* Effect.promise(async () => {
        await fs.mkdir(project, { recursive: true })
        await write(path.join(outside, "one", "server.ts"), "export default 1\n")
        await write(path.join(outside, "two", "server.ts"), "export default 1\n")
        await dirLink(path.join(outside, "one"), path.join(project, ".orbit", "plugins", "linked"))
      })
      const folder = path.join(project, ".orbit")
      const before = yield* Fingerprint.pluginsOf(files, folder, [project])
      yield* Effect.promise(() => write(path.join(outside, "one", "server.ts"), "export default 666\n"))
      expect(yield* Fingerprint.pluginsOf(files, folder, [project])).toBe(before)
      yield* Effect.promise(async () => {
        await fs.rm(path.join(project, ".orbit", "plugins", "linked"), { recursive: true })
        await dirLink(path.join(outside, "two"), path.join(project, ".orbit", "plugins", "linked"))
      })
      expect(yield* Fingerprint.pluginsOf(files, folder, [project])).not.toBe(before)
    }),
  )

  it.live("E: .orbit is itself a link out of the project; the outside content is not followed", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const base = (yield* tmpdirScoped()).path
      const project = path.join(base, "project")
      const outside = path.join(base, "elsewhere")
      const agent = (command: string) => `---\ndescription: a\nhooks:\n  Stop:\n    - command: ${command}\n---\nbody\n`
      yield* Effect.promise(async () => {
        await write(path.join(outside, "agents", "a.md"), agent("echo one"))
        await write(path.join(outside, "plugins", "p.ts"), "export default 1\n")
        await dirLink(outside, path.join(project, ".orbit"))
      })
      const folder = path.join(project, ".orbit")
      const before = yield* Fingerprint.directory(files, folder, [project])
      yield* Effect.promise(async () => {
        await write(path.join(outside, "agents", "a.md"), agent("echo two"))
        await write(path.join(outside, "plugins", "p.ts"), "export default 2\n")
      })
      expect(yield* Fingerprint.directory(files, folder, [project])).toEqual(before)
      // Pointing the container somewhere else is a change.
      const other = path.join(base, "other")
      yield* Effect.promise(async () => {
        await write(path.join(other, "agents", "a.md"), agent("echo one"))
        await fs.rm(folder, { recursive: true })
        await dirLink(other, folder)
      })
      expect((yield* Fingerprint.directory(files, folder, [project])).hooks).not.toBe(before.hooks)
      // The control: the same container is read when the bound includes where it points.
      const widened = yield* Fingerprint.directory(files, folder, [project, other])
      yield* Effect.promise(() => write(path.join(other, "agents", "a.md"), agent("echo three")))
      expect((yield* Fingerprint.directory(files, folder, [project, other])).hooks).not.toBe(widened.hooks)
    }),
  )
})

const bare = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  return {
    root,
    home: path.join(root, "home"),
    globalConfig: path.join(root, "home", ".config", "orbit"),
    repo: path.join(root, "work", "repo"),
  }
})
type Folders = Effect.Success<typeof bare>

function loader(folders: Folders) {
  return AppNodeBuilder.build(
    LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node, ConfigPluginSource.node]),
    [
      Config.node.replace(Config.configured({ content: "{}" })),
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(folders.repo) }))),
      ),
      Global.node.replace(Global.layerWith({ config: folders.globalConfig, home: folders.home })),
      Credential.node.replace(emptyCredentialNode),
      WellKnown.node.replace(emptyWellknownNode),
      Watcher.node.replace(Watcher.testLayer),
    ],
  )
}

const nextUpdate = Effect.gen(function* () {
  const bus = yield* Bus.Service
  return yield* bus
    .subscribe(Event.Updated)
    .pipe(Stream.take(1), Stream.runCollect, Effect.timeout("10 seconds"), Effect.forkScoped({ startImmediately: true }))
})
const grantAndWait = Effect.gen(function* () {
  const project = yield* ProjectTrust.Service
  const next = yield* nextUpdate
  yield* project.grant({ persist: true, via: "test" })
  yield* Fiber.join(next)
})
const reloaded = Effect.gen(function* () {
  const config = yield* Config.Service
  const next = yield* nextUpdate
  yield* config.update?.({ output_style: `style-${Math.random()}` }) ?? Effect.void
  yield* Fiber.join(next)
})
const offered = Effect.gen(function* () {
  const source = yield* ConfigPluginSource.Service
  return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
})

describe("a plugin behind a link after a grant", () => {
  live.live("A: a plugin added to a linked plugins folder waits for a new grant", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const shared = path.join(folders.repo, "tools", "plugins")
      yield* Effect.promise(async () => {
        await write(path.join(shared, "one.ts"), "export default 1\n")
        await dirLink(shared, path.join(folders.repo, ".orbit", "plugins"))
      })
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        yield* grantAndWait
        expect(yield* offered).toEqual(["one.ts"])
        yield* Effect.promise(() => write(path.join(shared, "evil.ts"), "export default 666\n"))
        yield* reloaded
        expect((yield* project.status()).changed?.flatMap((item) => item.kinds)).toContain("plugins")
        expect(yield* offered).toEqual([])
        yield* grantAndWait
        expect((yield* offered).toSorted()).toEqual(["evil.ts", "one.ts"])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  live.live("E: editing the tui entry of a folder with no server entry waits for a new grant", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const entry = path.join(folders.repo, ".orbit", "plugins", "p", "tui.ts")
      yield* Effect.promise(() => write(entry, "export default 1\n"))
      yield* Effect.gen(function* () {
        const project = yield* ProjectTrust.Service
        yield* grantAndWait
        expect((yield* project.status()).changed ?? []).toEqual([])
        yield* Effect.promise(() => write(entry, "export default 666\n"))
        yield* reloaded
        expect((yield* project.status()).changed?.flatMap((item) => item.kinds)).toContain("plugins")
        yield* grantAndWait
        expect((yield* project.status()).changed ?? []).toEqual([])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  live.live("B: editing the project file that a plugin file links to waits for a new grant", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const real = path.join(folders.repo, "scripts", "tool.ts")
      yield* Effect.promise(() => write(real, "export default 1\n"))
      if (!(yield* Effect.promise(() => fileLink(real, path.join(folders.repo, ".orbit", "plugins", "tool.ts"))))) return
      yield* Effect.gen(function* () {
        yield* grantAndWait
        expect(yield* offered).toEqual(["tool.ts"])
        yield* Effect.promise(() => write(real, "export default 666\n"))
        yield* reloaded
        expect(yield* offered).toEqual([])
        yield* grantAndWait
        expect(yield* offered).toEqual(["tool.ts"])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  live.live("C: editing the entry of a plugin folder that links into the project waits for a new grant", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const real = path.join(folders.repo, "tools", "myplugin")
      yield* Effect.promise(async () => {
        await write(path.join(real, "package.json"), JSON.stringify({ name: "p", exports: { "./server": "./server.ts" } }))
        await write(path.join(real, "server.ts"), "export default 1\n")
        await dirLink(real, path.join(folders.repo, ".orbit", "plugins", "myplugin"))
      })
      yield* Effect.gen(function* () {
        yield* grantAndWait
        expect(yield* offered).toEqual(["myplugin"])
        yield* Effect.promise(() => write(path.join(real, "server.ts"), "export default 666\n"))
        yield* reloaded
        expect(yield* offered).toEqual([])
        yield* grantAndWait
        expect(yield* offered).toEqual(["myplugin"])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )

  live.live("D: a plugin that a link leads out of the project is never offered, granted or not", () =>
    Effect.gen(function* () {
      const folders = yield* bare
      const outside = path.join(folders.root, "elsewhere", "myplugin")
      yield* Effect.promise(async () => {
        await write(path.join(outside, "package.json"), JSON.stringify({ name: "p", exports: { "./server": "./server.ts" } }))
        await write(path.join(outside, "server.ts"), "export default 1\n")
        await write(path.join(folders.repo, ".orbit", "plugins", "own.ts"), "export default 1\n")
        await dirLink(outside, path.join(folders.repo, ".orbit", "plugins", "myplugin"))
      })
      yield* Effect.gen(function* () {
        yield* grantAndWait
        // The plugin that stays in the project is the control: only the one behind the link is refused.
        expect(yield* offered).toEqual(["own.ts"])
      }).pipe(Effect.provide(loader(folders)))
    }),
  )
})
