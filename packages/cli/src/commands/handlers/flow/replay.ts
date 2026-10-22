import { json, plain, progress } from "@orbit/flow/plain"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { requireTrust } from "../../../util/trust"
import { connect, directory, load, runStore } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.replay,
  Effect.fn("cli.flow.replay")(function* (input) {
    // A replay runs on no server, but it goes on from a run that the folder's run store records, and the store is a file
    // that a clone ships, so the folder has to be trusted before the store is opened, which only a server can say.
    const client = yield* connect(input)
    yield* requireTrust(client, directory(), { grant: input.trust, strict: "recorded" })
    const { importsModule, run } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* runStore(client)
    const recorded = store.run(input.run)
    store.close()
    if (!recorded) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    const file = path.resolve(
      directory(),
      Option.getOrElse(input.file, () => recorded.file),
    )
    // A module workflow is code that runs here as it does for `orb flow run`, and the file is the one the repository's
    // run store names unless --file says otherwise. That file can belong to another project, so before it is loaded the
    // folder that holds it has to be trusted as well, as for `orb flow run`. A YAML workflow is only read: a replay
    // answers every check from the recording, so the shell commands that the workflow defines never run here. It answers
    // every agent from the recording as well, which opens no session, so the agents that the workflow names, and the
    // approvals it sets, choose nothing.
    if (importsModule(file)) yield* requireTrust(client, directory(), { grant: input.trust, imports: file })
    const workflow = yield* Effect.tryPromise({ try: () => load(file), catch: (cause) => cause })
    // No server: a replay answers every node from the recording.
    const result = yield* Effect.promise(() =>
      run({
        workflow,
        file,
        directory: directory(),
        // A replay creates no worktrees and answers from the recording, so it needs no version control.
        trusted: false,
        replay: recorded.id,
        log: (line) => process.stderr.write(`${progress(line)}${EOL}`),
      }),
    )
    // The node results of a replay come from the run store, which a clone brings, and are keyed by the IDs of the nodes.
    if (result.output !== undefined) process.stdout.write(`${json(result.output)}${EOL}`)
    // What a failure and the changed nodes name is text from the workflow file, which a replay takes from the run store
    // unless it is given one.
    if (result.status !== "succeeded") {
      process.exitCode = 1
      return yield* Effect.fail(new Error(`Replay ${result.id} ${result.status}: ${plain(result.error ?? "")}`))
    }
    const changed = result.replay?.divergences ?? []
    if (changed.length > 0)
      process.stderr.write(`Nodes whose inputs changed since the recording: ${plain(changed.join(", "))}${EOL}`)
    if (!result.replay?.identical) process.exitCode = 1
  }),
)
