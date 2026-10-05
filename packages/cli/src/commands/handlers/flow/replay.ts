import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import path from "node:path"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
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
    // answers every check from the recording, so the shell commands that the workflow defines never run here.
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
