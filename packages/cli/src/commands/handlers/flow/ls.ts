import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.ls,
  Effect.fn("cli.flow.ls")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const runs = store.runs()
    store.close()
    if (input.format === "json") return process.stdout.write(JSON.stringify(runs, null, 2) + EOL)
    process.stdout.write(
      runs
        .map((run) => [run.id, run.status.padEnd(9), run.workflow, new Date(run.updated).toLocaleString()].join("  "))
        .join(EOL) + (runs.length > 0 ? EOL : ""),
    )
  }),
)
