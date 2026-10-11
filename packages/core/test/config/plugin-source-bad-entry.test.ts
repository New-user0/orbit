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
})
