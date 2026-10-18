import path from "path"
import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Config } from "@orbit/core/config"
import { Bus } from "@orbit/core/bus"
import { Reference } from "@orbit/core/reference"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { Credential } from "@orbit/core/credential"
import { WellKnown } from "@orbit/core/wellknown"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { AbsolutePath } from "@orbit/core/schema"
import { Event } from "@orbit/schema/config"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect, Layer, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"

const it = testEffect(Layer.empty)

function liveConfig(directory: string) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, Reference.node, Global.node, Location.node]), [
    Config.node.replace(Config.configured({ global: false })),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
    ),
    Global.node.replace(Global.layerWith({ config: path.join(directory, "global"), home: path.join(directory, "home") })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    // No watcher: nothing but a report can tell the config that a file changed.
    Watcher.node.replace(Watcher.configured({ enabled: false })),
  ])
}

describe("Config.notify", () => {
  it.live("tells the subscribers of changes() and neither reloads nor announces a reload", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(project, "home"), { recursive: true })
            await fs.mkdir(path.join(project, "global"))
            await Bun.write(path.join(project, "orbit.json"), JSON.stringify({ shell: "initial" }))
          })
          return yield* Effect.gen(function* () {
            const config = yield* Config.Service
            const bus = yield* Bus.Service
            const before = yield* config.entries()
            const heard: string[] = []
            yield* config.changes().pipe(
              Stream.runForEach((update) => Effect.sync(() => heard.push(`${update.type}:${update.path}`))),
              Effect.forkScoped({ startImmediately: true }),
            )
            const announced: string[] = []
            yield* bus.subscribe().pipe(
              Stream.runForEach((event) => Effect.sync(() => announced.push(event.type))),
              Effect.forkScoped({ startImmediately: true }),
            )

            // A change on disk that only a reload would pick up.
            yield* Effect.promise(() => Bun.write(path.join(project, "orbit.json"), JSON.stringify({ shell: "changed" })))
            const file = path.join(project, ".orbit", "agents", "x.md")
            yield* config.notify([file, path.join(project, "other.md")])
            yield* Effect.sleep("400 millis")

            expect(heard).toEqual([`update:${file}`, `update:${path.join(project, "other.md")}`])
            // A reload makes new entries and announces `config.updated`; a report does neither.
            expect(yield* config.entries()).toBe(before)
            expect(Config.latest(yield* config.entries(), "shell")).toBe("initial")
            expect(announced).not.toContain(Event.Updated.type)
          }).pipe(Effect.scoped, Effect.provide(liveConfig(project)))
        }),
      ),
    ),
  )
})
