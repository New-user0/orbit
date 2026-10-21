import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schedule } from "effect"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Credential } from "@orbit/core/credential"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { WellKnown } from "@orbit/core/wellknown"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { emptyCredentialNode, emptyWellknownNode } from "../fixture/config-nodes"
import { location } from "../fixture/location"
import { tmpdirScoped } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)

// trust-first, D7: Orbit walks `orbit.json` and `.orbit` up the parents of a project, so config can sit in a folder above
// it. Such a source is read only when a grant covers its own folder: trusting a repository says nothing about the folder
// around it, which can carry plugins and hooks of its own. A grant for that folder covers the project below it as well.
const folders = Effect.gen(function* () {
  const tmp = (yield* tmpdirScoped()).path
  const real = yield* Effect.promise(() => fs.realpath(tmp))
  const work = path.join(real, "work")
  const repo = path.join(work, "repo")
  yield* Effect.promise(async () => {
    await fs.mkdir(path.join(work, ".orbit", "plugins"), { recursive: true })
    await fs.mkdir(repo, { recursive: true })
    await Bun.write(path.join(work, "orbit.json"), JSON.stringify({ username: "ABOVE-USER" }))
    await Bun.write(path.join(work, ".orbit", "plugins", "above.ts"), `export default { id: "above", async setup() {} }\n`)
    await Bun.write(path.join(repo, "orbit.json"), JSON.stringify({ username: "REPO-USER" }))
  })
  return { home: path.join(real, "home"), globalConfig: path.join(real, "home", "config"), work, repo }
})

function loader(input: { readonly home: string; readonly globalConfig: string; readonly repo: string }) {
  return AppNodeBuilder.build(LayerNode.group([Config.node, Bus.node, WorkspaceTrust.node]), [
    WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
    Location.node.replace(
      Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(input.repo) }))),
    ),
    Global.node.replace(Global.layerWith({ config: input.globalConfig, home: input.home })),
    Credential.node.replace(emptyCredentialNode),
    WellKnown.node.replace(emptyWellknownNode),
    Watcher.node.replace(Watcher.testLayer),
  ])
}

describe("config above the project", () => {
  it.live("is not read while only the project is trusted, and is read once a grant covers its own folder", () =>
    Effect.gen(function* () {
      const layout = yield* folders
      const above = [path.join(layout.work, "orbit.json"), path.join(layout.work, ".orbit")]
      yield* Effect.gen(function* () {
        const config = yield* Config.Service
        const trust = yield* WorkspaceTrust.Service
        const paths = config.entries().pipe(Effect.map((entries) => entries.flatMap((entry): string[] => (entry.path === undefined ? [] : [entry.path]))))
        // Until a reload has seen the latest grant, the entries can still be the last load's.
        const settle = (check: (listed: readonly string[]) => boolean) =>
          paths.pipe(
            Effect.flatMap((listed) => (check(listed) ? Effect.succeed(listed) : Effect.fail("not yet"))),
            Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 100 }),
          )

        // Nothing is trusted: neither the project nor the folder above it is read.
        const none = yield* paths
        expect(none.filter((item) => item.startsWith(layout.work))).toEqual([])

        // The project alone: its own document is read, and the folder above it is still not.
        yield* trust.grant(layout.repo, { persist: true, via: "test" })
        const project = yield* settle((listed) => listed.includes(path.join(layout.repo, "orbit.json")))
        expect(project.filter((item) => above.includes(item))).toEqual([])

        // The control: a grant for the folder above reads its sources too, and covers the project below it.
        yield* trust.grant(layout.work, { persist: true, via: "test" })
        const both = yield* settle((listed) => above.every((item) => listed.includes(item)))
        expect(both).toContain(path.join(layout.repo, "orbit.json"))
      }).pipe(Effect.provide(loader(layout)))
    }),
  )
})
