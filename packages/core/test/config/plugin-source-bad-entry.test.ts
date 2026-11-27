import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
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
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// Class 7: one plugin folder that cannot be resolved costs only itself. A tui-only folder (no server entry) whose tui.ts
// is a link to itself must not stop the supervisor from offering the plugins next to it.

const it = testEffect(Layer.empty)

const loader = (root: string, repo: string) =>
  AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node, ProjectTrust.node, ConfigPluginSource.node]), [
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
  ])

describe("a plugin folder with a looping entry", () => {
  it.live("the other plugins are still offered", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "p"), { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
      })
      const linked = yield* Effect.promise(() =>
        fs.symlink(path.join(plugins, "p", "tui.ts"), path.join(plugins, "p", "tui.ts"), "file").then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "UNKNOWN") return false
            throw error
          },
        ),
      )
      if (!linked) return
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo)))
      expect(offered).toEqual(["good.ts"])
    }),
  )

  // The catchCause in `leaves`: a folder with a server entry still has its tui entry resolved, and a link that loops
  // there counts as leaving the folder for that plugin only.
  it.live("a server plugin folder whose tui entry loops costs only itself", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "p"), { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
        await fs.writeFile(path.join(plugins, "p", "server.ts"), "export default 1;")
      })
      const linked = yield* Effect.promise(() =>
        fs.symlink(path.join(plugins, "p", "tui.ts"), path.join(plugins, "p", "tui.ts"), "file").then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === "EPERM" || error.code === "UNKNOWN") return false
            throw error
          },
        ),
      )
      if (!linked) return
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo)))
      expect(offered).toEqual(["good.ts"])
    }),
  )

  // `entryLinks`: a link that could be an entry is checked even when the resolver took another file for that entry or
  // never asked for it (Bun 1.4.5's resolver passes over a link that loops). The `.mjs` link comes after `.ts` in the
  // resolver's order, so it is never what the resolver returns. A link whose name is not an entry name is not checked.
  for (const row of [
    { link: "server.mjs", files: ["server.ts"], offered: ["good.ts"] },
    { link: "index.mjs", files: ["server.ts"], offered: ["good.ts"] },
    { link: "tui.mjs", files: ["server.ts", "tui.ts"], offered: ["good.ts"] },
    { link: "rpc.mjs", files: ["server.ts", "rpc.ts"], offered: ["good.ts"] },
    { link: "other.mjs", files: ["server.ts"], offered: ["good.ts", "p"] },
  ]) {
    const name = `a server plugin folder with a looping ${row.link} beside ${row.files.join(" and ")}`
    it.live(`${name} offers ${row.offered.join(" and ")}`, () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        const repo = path.join(root, "work", "repo")
        const plugins = path.join(root, "home", ".config", "orbit", "plugins")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(plugins, "p"), { recursive: true })
          await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
          await Promise.all(row.files.map((file) => fs.writeFile(path.join(plugins, "p", file), "export default 1;")))
        })
        const linked = yield* Effect.promise(() =>
          fs.symlink(path.join(plugins, "p", row.link), path.join(plugins, "p", row.link), "file").then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "EPERM" || error.code === "UNKNOWN") return false
              throw error
            },
          ),
        )
        if (!linked) return
        const offered = yield* Effect.gen(function* () {
          const source = yield* ConfigPluginSource.Service
          return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
        }).pipe(Effect.provide(loader(root, repo)))
        expect(offered.toSorted()).toEqual(row.offered)
      }),
    )
  }

  // A folder named node_modules is never a plugin; the single-file plugin beside it still is.
  it.live("plugins/node_modules is not offered, and the plugin beside it is", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "work", "repo")
      const plugins = path.join(root, "home", ".config", "orbit", "plugins")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(plugins, "node_modules"), { recursive: true })
        await fs.writeFile(path.join(plugins, "good.ts"), "export default 1;")
        await fs.writeFile(path.join(plugins, "node_modules", "index.js"), "export default 1;")
        await fs.writeFile(path.join(plugins, "node_modules", "server.ts"), "export default 1;")
      })
      const offered = yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        return (yield* source.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
      }).pipe(Effect.provide(loader(root, repo)))
      expect(offered).toEqual(["good.ts"])
    }),
  )
})
