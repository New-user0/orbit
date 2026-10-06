import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { plain } from "../../../util/plain"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.ls,
  Effect.fn("cli.flow.ls")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const runs = store.runs()
    store.close()
    if (input.format === "json") return process.stdout.write(JSON.stringify(runs, null, 2) + EOL)
    // What the run store says is text from a file in the repository, which a clone brings along, so it goes through
    // `plain`: a workflow named with an escape sequence must not act on the terminal.
    process.stdout.write(
      runs
        .map((run) =>
          [
            plain(run.id),
            plain(run.status).padEnd(9),
            plain(run.workflow),
            new Date(run.updated).toLocaleString(),
          ].join("  "),
        )
        .join(EOL) + (runs.length > 0 ? EOL : ""),
    )
  }),
)
