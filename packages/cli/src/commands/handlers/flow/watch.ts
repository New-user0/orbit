import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { directory } from "./execute"
import { render } from "./show"

export default Runtime.handler(
  Commands.commands.flow.commands.watch,
  Effect.fn("cli.flow.watch")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const id = Option.getOrUndefined(input.run) ?? store.runs(1)[0]?.id
    if (!id) {
      store.close()
      return yield* Effect.fail(new Error("No runs in this repository yet"))
    }
    // Another process writes the run, so this reads the store again every second until the run stops.
    const frame = async (): Promise<void> => {
      const run = store.run(id)
      if (!run) throw new Error(`No run ${id} in this repository`)
      const view = render(run, [...store.nodes(id).values()], store.events(id))
      // A terminal is redrawn each second; piped output gets only the final state.
      if (process.stdout.isTTY) process.stdout.write(`\x1b[2J\x1b[H${view}${EOL}`)
      else if (run.status !== "running") process.stdout.write(`${view}${EOL}`)
      if (run.status !== "running") return
      await Bun.sleep(1000)
      return frame()
    }
    yield* Effect.tryPromise({ try: frame, catch: (cause) => cause }).pipe(
      Effect.ensuring(Effect.sync(() => store.close())),
    )
  }),
)
