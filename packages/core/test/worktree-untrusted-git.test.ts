import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { WorkspaceTrust } from "@orbit/core/workspace-trust"
import { type Strategy, WorktreeStrategies } from "@orbit/core/worktree/strategies"
import { Worktree } from "@orbit/schema/worktree"
import { Global } from "@orbit/util/global"
import { keys, planted } from "./fixture/git-keys"
import { traced } from "./fixture/git-trace"
import { location } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

// Class 1 and class 6 (review of #118): the worktree list that the open dialog asks for ran `git worktree list` in the
// folder, which applies the folder's config (hooks, `include.path`, `core.worktree`). A folder that is not trusted is
// answered from its files: its main checkout, and nothing is added or removed in it. The oracle is git's trace of the
// processes it starts, with a trusted folder as the control that the same call starts git.
const it = testEffect(Layer.empty)
const SLOW = 90_000

const within = <A, E>(root: string, implicit: boolean, body: (strategy: Strategy) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const data = (yield* tmpdirScoped()).path
    const layer = AppNodeBuilder.build(WorktreeStrategies.node, [
      WorkspaceTrust.node.replace(WorkspaceTrust.configured({ implicit })),
      Global.node.replace(Global.layerWith({ data, config: path.join(data, "config") })),
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(root) }))),
        ),
      ),
    ])
    return yield* WorktreeStrategies.Service.use((service) =>
      body(service.get().strategies.get(Worktree.StrategyID.make("git"))!),
    ).pipe(Effect.provide(layer))
  })

describe("the worktree strategy in a folder that is not trusted", () => {
  it.live(
    "lists the main checkout from the files and starts no git",
    () =>
      Effect.gen(function* () {
        const found = yield* planted(keys[0]!)
        yield* Effect.promise(() =>
          fs.appendFile(path.join(found.root, ".git", "config"), `[include]\n\tpath = //10.255.255.7/share/cfg\n`),
        )

        const { value, git } = yield* traced(
          within(found.root, false, (strategy) => strategy.list(AbsolutePath.make(found.root))),
        )

        expect(git).toEqual([])
        expect(value.map((entry) => entry.type)).toEqual(["root"])
        expect(path.relative(value[0]!.directory, found.root)).toBe("")
        expect(yield* found.ran()).toEqual([])
      }),
    SLOW,
  )

  it.live(
    "adds and removes no worktree, and starts no git",
    () =>
      Effect.gen(function* () {
        const found = yield* planted(keys[0]!)
        const target = AbsolutePath.make(path.join(found.folder, "linked"))

        const { value, git } = yield* traced(
          within(found.root, false, (strategy) =>
            Effect.all([
              Effect.flip(strategy.create({ sourceDirectory: AbsolutePath.make(found.root), directory: target })),
              Effect.flip(strategy.remove({ directory: AbsolutePath.make(found.root), force: true })),
            ]),
          ),
        )

        expect(git).toEqual([])
        expect(value.map((error) => (error as { _tag: string })._tag)).toEqual([
          "Worktree.DirectoryUnavailableError",
          "Worktree.DirectoryUnavailableError",
        ])
      }),
    SLOW,
  )

  it.live(
    "lists through git when the folder is trusted (control)",
    () =>
      Effect.gen(function* () {
        const found = yield* planted(keys[0]!)

        const { git } = yield* traced(
          within(found.root, true, (strategy) => strategy.list(AbsolutePath.make(found.root))),
        )

        expect(git.some((command) => command.includes("worktree"))).toBe(true)
      }),
    SLOW,
  )
})
