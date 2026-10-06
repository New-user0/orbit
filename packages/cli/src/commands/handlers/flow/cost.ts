import { Effect } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { plain } from "../../../util/plain"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.cost,
  Effect.fn("cli.flow.cost")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const run = store.run(input.run)
    const spend = store.spend(input.run)
    store.close()
    if (!run) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    const rows = [
      ...Map.groupBy(spend, (item) => `${item.node}\u0000${item.model}`)
        .values()
        .map((items) => ({
          node: items[0].node,
          model: items[0].model,
          attempts: items.length,
          input: items.reduce((total, item) => total + item.input, 0),
          output: items.reduce((total, item) => total + item.output, 0),
          cost: items.reduce((total, item) => total + item.cost, 0),
        })),
    ]
    const total = {
      attempts: spend.length,
      input: rows.reduce((sum, row) => sum + row.input, 0),
      output: rows.reduce((sum, row) => sum + row.output, 0),
      cost: rows.reduce((sum, row) => sum + row.cost, 0),
    }
    if (input.format === "json") return process.stdout.write(JSON.stringify({ rows, total }, null, 2) + EOL)
    const table = [
      ["node", "model", "attempts", "input", "output", "cost"],
      // The names are text from the run store, a file in the repository that a clone brings along.
      ...rows.map((row) => [
        plain(row.node),
        plain(row.model),
        String(row.attempts),
        String(row.input),
        String(row.output),
        `$${row.cost.toFixed(4)}`,
      ]),
      ["total", "", String(total.attempts), String(total.input), String(total.output), `$${total.cost.toFixed(4)}`],
    ]
    const widths = table[0].map((_, column) => Math.max(...table.map((line) => line[column].length)))
    process.stdout.write(
      table
        .map((line) =>
          line
            .map((cell, column) => cell.padEnd(widths[column]))
            .join("  ")
            .trimEnd(),
        )
        .join(EOL) + EOL,
    )
  }),
)
