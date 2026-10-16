import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { Snapshot } from "@orbit/core/snapshot"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { Global } from "@orbit/util/global"
import { keys, live, planted } from "./fixture/git-keys"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Class 1 (register FU-M1-022): a session in a folder that nobody has decided about still takes snapshots, so undo works.
// Snapshot starts git in the project's folder to find its repository and to ask which paths are ignored, and everything
// else in a git directory of Orbit's own, whose config is Orbit's. None of it may run a program that the project's config
// names. The oracle is a program named by each key, as in `project-git-trust.test.ts`, with the plain git command of the key
// as the control that it is live.
const it = testEffect(Layer.empty)
const SLOW = 90_000

describe("Snapshot in a folder that is not trusted", () => {
  for (const key of keys)
    it.live(
      `runs no program that the project's config names for ${key.name}`,
      () =>
        Effect.gen(function* () {
          if (key.trigger) expect(yield* live(key)).not.toEqual([])
          const found = yield* planted(key)
          const data = (yield* tmpdirScoped()).path
          const layer = AppNodeBuilder.build(Snapshot.node, [
            WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit: false })),
            Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(found.root) }))),
            Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
          ])

          yield* Effect.gen(function* () {
            const snapshot = yield* Snapshot.Service
            const before = yield* snapshot.capture()
            yield* Effect.promise(() => fs.writeFile(path.join(found.root, "a.txt"), "three\n"))
            const after = yield* snapshot.capture()

            // Snapshots were taken, and compared, so what ran is what a session in this folder runs.
            expect(before).toBeDefined()
            expect(after).toBeDefined()
            expect((yield* snapshot.files({ from: before!, to: after! })).map(String)).toEqual(["a.txt"])
            expect((yield* snapshot.diff({ from: before!, to: after! })).map((item) => item.file)).toEqual(["a.txt"])
          }).pipe(Effect.provide(layer))

          expect(yield* found.ran()).toEqual([])
        }),
      SLOW,
    )
})
