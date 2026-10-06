import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { plain, progress } from "../../../util/plain"
import { requireTrust } from "../../../util/trust"
import { directory, load } from "./execute"

export default Runtime.handler(
  Commands.commands.flow.commands.replay,
  Effect.fn("cli.flow.replay")(function* (input) {
    const { importsModule, openStore, run } = yield* Effect.promise(() => import("@orbit/flow"))
    const store = yield* Effect.promise(() => openStore(directory()))
    const recorded = store.run(input.run)
    store.close()
    if (!recorded) return yield* Effect.fail(new Error(`No run ${input.run} in this repository`))
    const file = Option.match(input.file, {
      onNone: () => recorded.file,
      onSome: (value) => path.resolve(directory(), value),
    })
    // A replay runs on no server, but a module workflow is code that runs here as it does for `orb flow run`, and the
    // file is the one the repository's run store names unless --file says otherwise. So before it is loaded the folder
    // has to be trusted, which only a server can say. A YAML workflow is only read, and connects to nothing: a replay
    // answers every check from the recording, so the shell commands that the workflow defines never run here. It answers
    // every agent from the recording as well, which opens no session, so the agents that the workflow names, and the
    // approvals it sets, choose nothing.
    if (importsModule(file)) {
      const server = yield* ServerConnection.resolve({
        server: Option.getOrUndefined(input.server),
        standalone: input.standalone,
        trust: input.trust,
      })
      const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
      yield* requireTrust(client, directory(), { grant: input.trust, imports: file })
    }
    const workflow = yield* Effect.tryPromise({ try: () => load(file), catch: (cause) => cause })
    // No server: a replay answers every node from the recording.
    const result = yield* Effect.promise(() =>
      run({
        workflow,
        file,
        directory: directory(),
        replay: recorded.id,
        log: (line) => process.stderr.write(`${progress(line)}${EOL}`),
      }),
    )
    if (result.output !== undefined) process.stdout.write(`${JSON.stringify(result.output, null, 2)}${EOL}`)
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
