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
import { keys, planted } from "./fixture/git-keys"
import { traced } from "./fixture/git-trace"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Class 1 and class 6 (review of #118): git opens whatever the repository it runs in names, such as `include.path` (a file
// or a share), `core.worktree`, `core.excludesFile` and the chain of `objects/info/alternates`. While a folder is not
// trusted a snapshot therefore starts no git in the folder's own repository: every process it starts works in Orbit's own
// git directory. The oracle is git's trace of the processes it starts, and a trusted folder is the control that the same
// calls do start git in the folder's repository.
const it = testEffect(Layer.empty)
const SLOW = 90_000

const run = (implicit: boolean) =>
  Effect.gen(function* () {
    const found = yield* planted(keys[0]!)
    // What git would open for the folder if it ran there: an include and an alternate object directory.
    yield* Effect.promise(async () => {
      await fs.appendFile(
        path.join(found.root, ".git", "config"),
        `[include]\n\tpath = ${path.join(found.folder, "shared.cfg").replaceAll("\\", "/")}\n`,
      )
      await fs.mkdir(path.join(found.root, ".git", "objects", "info"), { recursive: true })
      await fs.writeFile(
        path.join(found.root, ".git", "objects", "info", "alternates"),
        path.join(found.folder, "elsewhere").replaceAll("\\", "/") + "\n",
      )
      await fs.writeFile(path.join(found.root, ".gitignore"), "*.log\n")
    })
    const data = (yield* tmpdirScoped()).path
    const layer = AppNodeBuilder.build(Snapshot.node, [
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
      Location.node.replace(Location.boundNode(Location.Ref.make({ directory: AbsolutePath.make(found.root) }))),
      Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
    ])
    return yield* traced(
      Effect.gen(function* () {
        const snapshot = yield* Snapshot.Service
        const before = yield* snapshot.capture()
        yield* Effect.promise(async () => {
          await fs.writeFile(path.join(found.root, "a.txt"), "three\n")
          await fs.writeFile(path.join(found.root, "debug.log"), "noise\n")
        })
        const after = yield* snapshot.capture()
        return {
          before,
          after,
          files: before && after ? (yield* snapshot.files({ from: before, to: after })).map(String) : [],
        }
      }).pipe(Effect.provide(layer)),
    )
  })

// Git's trace names the work tree of the repository a process works in; Orbit's own is under its data folder.
const own = (command: string) => command.replaceAll("\\", "/").includes("/snapshot/")

describe("Snapshot starts no git in the folder's own repository while it is not trusted", () => {
  it.live(
    "works from Orbit's own git directory, and still leaves out what .gitignore names",
    () =>
      Effect.gen(function* () {
        const { value, git } = yield* run(false)

        expect(value.before).toBeDefined()
        expect(value.after).toBeDefined()
        expect(value.files).toEqual(["a.txt"])
        expect(git.length).toBeGreaterThan(0)
        expect(git.filter((command) => !own(command))).toEqual([])
      }),
    SLOW,
  )

  it.live(
    "starts git in the folder's repository when it is trusted (control)",
    () =>
      Effect.gen(function* () {
        const { git } = yield* run(true)

        expect(git.filter((command) => !own(command)).length).toBeGreaterThan(0)
      }),
    SLOW,
  )
})
