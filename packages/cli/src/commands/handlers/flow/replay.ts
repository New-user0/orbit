import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { directory, load } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.replay,
  Effect.fn("cli.flow.replay")(function* (input) {
    const { openStore, run } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const recorded = store.run(input.run)
    store.close()
    if (!recorded) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    const file = Option.match(input.file, {
      onNone: () => recorded.file,
      onSome: (value) => path.resolve(directory(), value),
    })
    const workflow = yield* Effect.tryPromise({ try: () => load(file), catch: (cause) => cause })
    // No server: a replay answers every node from the recording.
    const result = yield* Effect.promise(() =>
      run({
        workflow,
        file,
        directory: directory(),
        replay: recorded.id,
        log: (line) => process.stderr.write(`${line}${EOL}`),
      }),
    )
    if (result.output !== undefined) process.stdout.write(`${JSON.stringify(result.output, null, 2)}${EOL}`)
    if (result.status !== "succeeded") {
      process.exitCode = 1
      return yield* Effect.fail(new Error(`Replay ${result.id} ${result.status}: ${result.error ?? ""}`))
    }
    const changed = result.replay?.divergences ?? []
    if (changed.length > 0)
      process.stderr.write(`Nodes whose inputs changed since the recording: ${changed.join(", ")}${EOL}`)
    if (!result.replay?.identical) process.exitCode = 1
  }),
)
