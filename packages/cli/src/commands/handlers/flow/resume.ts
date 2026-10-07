import { plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { directory, execute } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.resume,
  Effect.fn("cli.flow.resume")(function* (input) {
    const { openStore } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const recorded = store.run(input.run)
    store.close()
    if (!recorded) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    // The file is text from the run store, a file in the repository that a clone brings along.
    if (recorded.workflow.startsWith("eval:"))
      return yield* Effect.fail(
        new Error(`${input.run} is an eval; resume it with \`orb eval ${plain(recorded.file)} --resume ${input.run}\``),
      )
    yield* execute({ ...input, file: recorded.file, resume: recorded.id })
  }),
)
