import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { requireTrust } from "../../../util/trust"
import { connect, directory } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.approve,
  Effect.fn("cli.flow.approve")(function* (input) {
    // The run store is a file that a clone can ship with any run in it, and finding it reads the folder's `.git`, so the
    // folder has to be trusted before the store is opened (classes 1, 5 and 12; FU-M4-202).
    const client = yield* connect(input)
    yield* requireTrust(client, directory(), { grant: input.trust, strict: "recorded" })
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
