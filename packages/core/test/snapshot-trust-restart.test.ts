import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Snapshot } from "@orbit/core/snapshot"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { repository } from "./fixture/git"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// A Location keeps the project ID it was bound with, and a repository with no remote changes ID when trust is granted. A
// grant without a reload therefore files its snapshots under the old ID, and the next process looks under the new one.

const it = testEffect(Layer.empty)

describe("a snapshot taken after a grant, restored by a later process", () => {
  ;(["grant then capture", "capture, grant, capture"] as const).forEach((order) =>
    it.live(
      order,
      () =>
        Effect.gen(function* () {
          const root = path.join((yield* tmpdirScoped()).path, "clone")
          yield* repository(root)
          yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "one\n"))
          const data = (yield* tmpdirScoped()).path
          const build = (implicit: boolean) =>
            AppNodeBuilder.build(LayerNode.group([Snapshot.node, WorkspaceTrust.node, Location.node]), [
              WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
              Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
              Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
            ])

          const captured = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const trust = yield* WorkspaceTrust.Service
            if (order === "capture, grant, capture") yield* snapshot.capture()
            yield* trust.grant(root, { persist: false, via: "test" })
            return yield* snapshot.capture()
          }).pipe(Effect.provide(build(false)))

          yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))

          const restored = yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            return yield* Effect.exit(snapshot.restore({ files: new Map([[RelativePath.make("a.txt"), captured!]]) }))
          }).pipe(Effect.provide(build(true)))

          expect(Exit.isSuccess(restored)).toBe(true)
          expect(yield* Effect.promise(() => fs.readFile(path.join(root, "a.txt"), "utf8"))).toBe("one\n")
        }),
      90_000,
    ),
  )
})
