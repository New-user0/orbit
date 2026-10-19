import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { AbsolutePath, RelativePath } from "@orbit/core/schema"
import { Snapshot } from "@orbit/core/snapshot"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { repository } from "./fixture/git"
import { traced } from "./fixture/git-trace"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Review of #118, M4 verification round 7: trust is usually granted in the middle of a session. The steps before the grant
// get no snapshot and start no git; the first step after it captures, and undo works from there on, without a reload.
// Mutation: letting `Snapshot.capture` go on while the folder is not trusted fails the first half of the row; asking the
// trust store once when the service starts, instead of at every capture, fails the second.
const it = testEffect(Layer.empty)
const SLOW = 90_000

describe("a folder trusted partway through a session", () => {
  it.live(
    "gets no snapshot before the grant and starts no git, then captures, compares and restores after it",
    () =>
      Effect.gen(function* () {
        const root = path.join((yield* tmpdirScoped()).path, "clone")
        yield* repository(root)
        yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "one\n"))
        const data = (yield* tmpdirScoped()).path
        const layer = AppNodeBuilder.build(LayerNode.group([Snapshot.node, WorkspaceTrust.node]), [
          WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
          Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
          Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
        ])

        yield* Effect.gen(function* () {
          const snapshot = yield* Snapshot.Service
          const trust = yield* WorkspaceTrust.Service
          const untrusted = yield* traced(snapshot.capture())
          yield* trust.grant(root, { persist: false, via: "test" })
          const before = yield* snapshot.capture()
          yield* Effect.promise(() => fs.writeFile(path.join(root, "a.txt"), "two\n"))
          const after = yield* snapshot.capture()

          expect(untrusted.value).toBeUndefined()
          expect(untrusted.git).toEqual([])
          if (!before || !after) return expect.unreachable("capture is disabled after the grant")
          expect((yield* snapshot.files({ from: before, to: after })).map(String)).toEqual(["a.txt"])
          yield* snapshot.restore({ files: new Map([[RelativePath.make("a.txt"), before]]) })
          expect(yield* Effect.promise(() => fs.readFile(path.join(root, "a.txt"), "utf8"))).toBe("one\n")
        }).pipe(Effect.provide(layer))
      }),
    SLOW,
  )
})
