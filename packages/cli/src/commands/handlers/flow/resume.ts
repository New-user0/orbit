import { plain } from "@orbit/flow/plain"
import { Effect } from "effect"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { requireTrust } from "../../../util/trust"
import { connect, directory, execute, runStore } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.resume,
  Effect.fn("cli.flow.resume")(function* (input) {
    const client = yield* connect(input)
    // The run store is a file that a clone ships, and a resumed run goes on from the worktrees, sessions, model and
    // workflow file it records, so the folder has to be trusted before the store is opened (classes 1, 5 and 12).
    yield* requireTrust(client, directory(), { grant: input.trust, strict: "recorded" })
    const store = yield* runStore(client)
    const recorded = store.run(input.run)
    store.close()
    if (!recorded) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    // The file is text from the run store, a file in the repository that a clone brings along.
    if (recorded.workflow.startsWith("eval:"))
      return yield* Effect.fail(
        new Error(`${input.run} is an eval; resume it with \`orb eval ${plain(recorded.file)} --resume ${input.run}\``),
      )
    yield* execute(client, { ...input, file: recorded.file, resume: recorded.id })
  }),
)
