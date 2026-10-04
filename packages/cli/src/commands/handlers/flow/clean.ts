import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.clean,
  Effect.fn("cli.flow.clean")(function* (input) {
    const { Git, openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const repository = yield* Effect.promise(() => Git.root(directory()))
    if (!repository) return yield* Effect.fail(new Error("orb flow clean works inside a git repository"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const runs = store.runs(1000)
    store.close()
    const target = Option.getOrUndefined(input.run)
    const selected = target
      ? runs.filter((run) => run.id === target)
      : runs.filter((run) => run.status !== "running" && run.status !== "waiting")
    if (target && selected.length === 0) return yield* Effect.fail(new Error(`No run ${target} in this repository`))
    // One at a time: git commands on the same repository take its lock.
    const removed = yield* Effect.promise(async () => {
      const total = { worktrees: 0, branches: 0 }
      for (const run of selected) {
        const item = await Git.clean(repository, run.id)
        total.worktrees += item.worktrees
        total.branches += item.branches
      }
      return total
    })
    process.stdout.write(
      `Removed ${removed.worktrees} worktree(s) and ${removed.branches} branch(es) from ${selected.length} run(s). The run history stays in .orbit/runs.db.${EOL}`,
    )
  }),
)
