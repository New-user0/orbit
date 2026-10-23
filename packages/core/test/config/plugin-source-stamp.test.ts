import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Directory, type Entry } from "@orbit/schema/config"
import { Config } from "@orbit/core/config"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { ConfigTrust } from "@orbit/core/config/trust"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

// A plugin runs in the server process, so the plugins a config directory keeps are offered only while the folder that
// holds it is trusted. The loader reads no directory of an untrusted folder at all; this pins the second gate, in the
// plugin source itself, for a directory entry that is stamped untrusted (an entry from a load that a revoke overtook).
const it = testEffect(Layer.empty)

const source = (repo: string, entries: Entry[]) =>
  AppNodeBuilder.build(LayerNode.group([ConfigPluginSource.node]), [
    Config.node.replace(Config.testLayer(entries)),
    Watcher.node.replace(Watcher.testLayer),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(repo) }))),
    ),
  ])

const offered = (repo: string, entries: Entry[]) =>
  Effect.gen(function* () {
    const plugins = yield* ConfigPluginSource.Service
    return (yield* plugins.operations()).flatMap((item) => (item.type === "add" ? [path.basename(item.target)] : []))
  }).pipe(Effect.provide(source(repo, entries)))

describe("the config plugin source", () => {
  it.live("offers no plugin of a directory stamped untrusted, and the same directory's plugins unstamped", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const repo = path.join(root, "repo")
      const directory = path.join(repo, ".orbit")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(directory, "plugins"), { recursive: true })
        await fs.writeFile(path.join(directory, "plugins", "clone-plugin.ts"), "export default 1;")
      })
      const entry = new Directory({ type: "directory", path: AbsolutePath.make(directory), scope: "project" })

      expect(yield* offered(repo, [ConfigTrust.stamp(entry, { roots: [repo], directory })])).toEqual([])
      // The control: the directory as a trusted folder's load reports it.
      expect(yield* offered(repo, [entry])).toEqual(["clone-plugin.ts"])
    }),
  )
})
