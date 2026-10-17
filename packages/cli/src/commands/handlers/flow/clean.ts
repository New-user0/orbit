import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { requireTrust } from "../../../util/trust"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.clean,
  Effect.fn("cli.flow.clean")(function* (input) {
    // The version control of a folder applies the config the folder ships, and removing a worktree or a branch runs the
    // hooks that config names, so nothing starts it here until the folder is trusted (class 1, class 12).
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      trust: input.trust,
    })
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    yield* requireTrust(client, directory(), { grant: input.trust, strict: true })
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
