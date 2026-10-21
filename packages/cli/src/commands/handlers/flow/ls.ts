import { json, plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { requireTrust } from "../../../util/trust"
import { connect, directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.ls,
  Effect.fn("cli.flow.ls")(function* (input) {
    // The run store is a file that a clone can ship with any run in it, and finding it reads the folder's `.git`, so the
    // folder has to be trusted before the store is opened (classes 1, 5 and 12; FU-M4-202).
    const client = yield* connect(input)
    yield* requireTrust(client, directory(), { grant: input.trust, strict: "recorded" })
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const runs = store.runs()
    store.close()
    // What the run store says is text from a file in the repository, which a clone brings along, so it goes through
    // `plain`, or `json` for programs: a workflow named with an escape sequence must not act on the terminal.
    if (input.format === "json") return process.stdout.write(json(runs) + EOL)
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
