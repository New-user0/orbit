import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer, Schema, Stream } from "effect"
import { Document, Info } from "@orbit/schema/config"
import { Config } from "@orbit/core/config"
import { ConfigPluginSource } from "@orbit/core/config/plugin/source"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { location } from "./fixture/location"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { PluginModule } from "@orbit/core/plugin/module"
import { Global } from "@orbit/util/global"
import { Npm } from "@orbit/util/npm"
import { tempGlobalLayer } from "./fixture/global"
import { processNative } from "./fixture/native-watcher"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

setDefaultTimeout(30_000)

// A watch of a folder that went away ends (test/filesystem/watcher-overlap.test.ts), so every consumer that keeps a record
// of what it watches must forget it when its stream ends, or it never watches the folder again: an edit made after the
// folder was removed and made again is then heard by nothing. Each row removes and makes the folder again, then edits.
const watcher = Watcher.layer().pipe(
  Layer.provide(Layer.succeed(Watcher.Native, processNative(Watcher.binding, Watcher.backend()))),
)
const it = testEffect(Layer.merge(AppNodeBuilder.build(Npm.node, [Global.node.replace(tempGlobalLayer)]), watcher))

// A wait that has no count of its own: the test's time limit bounds it.
const until = Effect.fnUntraced(function* (condition: () => boolean) {
  while (!condition()) yield* Effect.sleep("20 millis")
})

describe("a consumer watches again after the watch of its folder ended", () => {
  it.live("a plugin module watches the helper again, for an edit after the helper's folder was made again", () =>
    Effect.gen(function* () {
      const directory = yield* tmpdirScoped()
      const entry = path.join(directory.path, "plugin/index.ts")
      const helper = path.join(directory.path, "shared/helper.ts")
      const source = (id: string) => `export default { id: "${id}", async setup() {} }`
      yield* Effect.promise(async () => {
        await Bun.write(entry, 'export { default } from "../shared/helper.ts"')
        await Bun.write(helper, source("one"))
      })
      const modules = yield* PluginModule.make()
      const operation = { type: "add" as const, target: path.dirname(entry), options: {} }
      expect(yield* modules.load(operation)).toMatchObject({ id: "one" })
      let changes = 0
      yield* modules.changes().pipe(
        Stream.runForEach(() => Effect.sync(() => changes++)),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* Effect.promise(async () => {
        await fs.rm(path.dirname(helper), { recursive: true })
        await Bun.write(helper, source("two"))
      })
      yield* until(() => changes > 0)
      // The load after a change watches what it imports again.
      expect(yield* modules.load(operation)).toMatchObject({ id: "two" })
      const before = changes
      yield* Effect.sleep("300 millis")
      yield* Effect.promise(() => Bun.write(helper, source("three")))
      yield* until(() => changes > before)
    }),
  )

  // The plugin source watches a configured plugin outside the config roots, once. The watch ends when its folder goes away, and
  // the scan that follows watches it again.
  it.live("the plugin source watches a configured plugin folder again after its watch ended", () =>
    Effect.gen(function* () {
      const root = (yield* tmpdirScoped()).path
      const plugin = path.join(root, "external", "plugin")
      yield* Effect.promise(() => Bun.write(path.join(plugin, "server.ts"), "export default 1;"))
      const entries = [
        new Document({
          type: "document",
          path: AbsolutePath.make(path.join(root, "orbit.json")),
          info: Schema.decodeUnknownSync(Info)({ plugins: [plugin] }),
        }),
      ]
      const test = Watcher.testLayer
      const layer = Layer.merge(
        AppNodeBuilder.build(LayerNode.group([ConfigPluginSource.node]), [
          Config.node.replace(Config.testLayer(entries)),
          Watcher.node.replace(test),
          Location.node.replace(
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(root) }))),
          ),
        ]),
        test,
      )
      yield* Effect.gen(function* () {
        const source = yield* ConfigPluginSource.Service
        const native = yield* Watcher.Test
        const watches = () =>
          Effect.map(native.subscriptions(), (items) => items.filter((item) => item.path === plugin).length)
        yield* source.operations()
        expect(yield* watches()).toBe(1)
        yield* native.end({ type: "update", path: plugin })
        // The watch is forgotten as its stream ends, so a scan after that watches the folder again. The time limit of the test bounds the wait.
        while ((yield* watches()) < 2) {
          yield* source.operations()
          yield* Effect.sleep("20 millis")
        }
        expect(yield* watches()).toBe(2)
      }).pipe(Effect.provide(layer))
    }),
  )
})
