import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Fingerprint } from "@orbit/core/config/fingerprint"
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

// Class 6: the plugins digest runs before a folder is trusted, and the runtime's resolver and `fs.resolve` follow links,
// so a plugin folder's files are listed by the walk that asks about each link first. Each row links one name of a plugin
// folder to a share and has its own TEST-NET-1 address, because Windows remembers a host that failed, which would let a
// later row pass its timing check without being tested. Symlinks to a share need Developer Mode or elevation: a row
// ends there when refused.

const it = testEffect(Layer.empty)

const rows = [
  { name: "tui.ts", host: "192.0.2.11", type: "file" },
  { name: "server.ts", host: "192.0.2.12", type: "file" },
  { name: "package.json", host: "192.0.2.13", type: "file" },
  { name: "server", host: "192.0.2.14", type: "dir" },
] as const

const link = (target: string, at: string, type: "file" | "dir") =>
  fs
    .mkdir(path.dirname(at), { recursive: true })
    .then(() => fs.symlink(target, at, type))
    .then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "EPERM" || error.code === "UNKNOWN") return false
        throw error
      },
    )

/** A file system that records every path that is handed to it. */
const watched = (files: FSUtil.Interface) => {
  const seen: string[] = []
  const note = <A extends (path: string, ...rest: never[]) => unknown>(fn: A) =>
    ((target: string, ...rest: never[]) => {
      seen.push(target)
      return fn(target, ...rest)
    }) as A
  const view: FSUtil.Interface = {
    ...files,
    exists: note(files.exists),
    isDir: note(files.isDir),
    isFile: note(files.isFile),
    readFile: note(files.readFile),
    readFileString: note(files.readFileString),
    readDirectoryEntries: note(files.readDirectoryEntries),
    readLink: note(files.readLink),
    resolve: note(files.resolve),
    stat: note(files.stat),
  }
  return { view, seen }
}

const fsNode = AppNodeBuilder.build(LayerNode.group([FSUtil.node]))

describe.skipIf(process.platform !== "win32")("a plugin folder with a name that links to a share", () => {
  for (const row of rows) {
    it.live(`${row.name}: the digest hands nothing below the link to the file system`, () =>
      Effect.gen(function* () {
        const files = yield* FSUtil.Service
        const base = (yield* tmpdirScoped()).path
        const project = path.join(base, "project")
        const folder = path.join(project, ".orbit")
        const at = path.join(folder, "plugins", "p", row.name)
        if (!(yield* Effect.promise(() => link(`\\\\${row.host}\\share\\${row.name}`, at, row.type)))) return
        const recording = watched(files)
        const started = Date.now()
        const found = yield* Fingerprint.directory(recording.view, folder, [project])
        expect(found.plugins).toMatch(/^[0-9a-f]{64}$/)
        expect(recording.seen.filter((item) => path.resolve(item).startsWith(at + path.sep))).toEqual([])
        expect(Date.now() - started).toBeLessThan(5000)
      }).pipe(Effect.provide(fsNode)),
    )
  }

  it.live("an untrusted Config load and status do not connect to the share", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const at = path.join(repo, ".orbit", "plugins", "p", "tui.ts")
      if (!(yield* Effect.promise(() => link("\\\\192.0.2.15\\share\\tui.ts", at, "file")))) return
      const build = AppNodeBuilder.build(
        LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node]),
        [
          Config.node.replace(Config.configured({ content: "{}" })),
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(repo) }))),
          ),
          Global.node.replace(
            Global.layerWith({ config: path.join(root, "home", ".config", "orbit"), home: path.join(root, "home") }),
          ),
          Credential.node.replace(emptyCredentialNode),
          WellKnown.node.replace(emptyWellknownNode),
          Watcher.node.replace(Watcher.testLayer),
        ],
      )
      const started = Date.now()
      const status = yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const project = yield* ProjectTrust.Service
        const prints = yield* config.fingerprints()
        yield* project.status()
        return prints
      }).pipe(Effect.provide(build))
      expect(JSON.stringify(status)).not.toContain("unreadable")
      expect(Date.now() - started).toBeLessThan(5000)
    }),
    30_000,
  )
})

describe("a plugin folder of regular files", () => {
  it.live("control: every file counts, node_modules is only named", () =>
    Effect.gen(function* () {
      const files = yield* FSUtil.Service
      const base = (yield* tmpdirScoped()).path
      const project = path.join(base, "project")
      const folder = path.join(project, ".orbit")
      const plugin = path.join(folder, "plugins", "p")
      const digest = Fingerprint.directory(files, folder, [project]).pipe(Effect.map((found) => found.plugins))
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugin, "node_modules", "dep"), { recursive: true })
        await fs.writeFile(path.join(plugin, "tui.ts"), "export default 1\n")
        await fs.writeFile(path.join(plugin, "helper.ts"), "export default 1\n")
      })
      const first = yield* digest
      yield* Effect.promise(() => fs.writeFile(path.join(plugin, "node_modules", "dep", "index.js"), "1\n"))
      expect(yield* digest).toBe(first)
      yield* Effect.promise(() => fs.writeFile(path.join(plugin, "helper.ts"), "export default 2\n"))
      const second = yield* digest
      expect(second).not.toBe(first)
      yield* Effect.promise(() => fs.writeFile(path.join(plugin, "package.json"), "{}\n"))
      expect(yield* digest).not.toBe(second)
    }).pipe(Effect.provide(fsNode)),
  )
})
