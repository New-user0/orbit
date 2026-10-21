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
import { traced } from "./fixture/git-trace"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Class 1 (register FU-M1-022, M4 verification round 7): a session in a folder that nobody has decided about takes no undo
// snapshot, because every git command a snapshot runs applies the folder's config, which can name a program. The oracle is
// a program named by each key, as in `project-git-trust.test.ts`, with the plain git command of the key as the control that
// it is live, and git's trace, which must show no process at all.
// Mutation: letting `Snapshot.capture` go on while the folder is not trusted fails every row.
const it = testEffect(Layer.empty)
const SLOW = 90_000

describe("Snapshot in a folder that is not trusted", () => {
  for (const key of keys)
    it.live(
      `takes no snapshot, starts no git and runs no program that the project's config names for ${key.name}`,
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

          const run = yield* traced(
            Effect.gen(function* () {
              const snapshot = yield* Snapshot.Service
              const before = yield* snapshot.capture()
              yield* Effect.promise(() => fs.writeFile(path.join(found.root, "a.txt"), "three\n"))
              return [before, yield* snapshot.capture()]
            }).pipe(Effect.provide(layer)),
          )

          expect(run.value).toEqual([undefined, undefined])
          expect(run.git).toEqual([])
          expect(yield* found.ran()).toEqual([])
        }),
      SLOW,
    )
})
