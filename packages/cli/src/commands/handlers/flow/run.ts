import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { execute, parseInput } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.run,
  Effect.fn("cli.flow.run")(function* (input) {
    const values = yield* Effect.try({ try: () => parseInput(input.input), catch: (cause) => cause })
    yield* execute({ ...input, input: values })
  }),
)
