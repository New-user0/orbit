import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { connect, execute, parseInput } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.run,
  Effect.fn("cli.flow.run")(function* (input) {
    const values = yield* Effect.try({ try: () => parseInput(input.input), catch: (cause) => cause })
    const client = yield* connect(input)
    yield* execute(client, { ...input, input: values })
  }),
)
