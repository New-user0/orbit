import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.approve,
  Effect.fn("cli.flow.approve")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const error = store.decide(input.run, input.gate, !input.reject, Option.getOrUndefined(input.note))
    store.close()
    if (error) return yield* Effect.fail(new Error(error))
    process.stdout.write(
      `${input.reject ? "Rejected" : "Approved"} ${input.gate}. Continue with \`orb flow resume ${input.run}\`.${EOL}`,
    )
  }),
)
