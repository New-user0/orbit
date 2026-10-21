import { MessageTooLargeError, ndJsonStream } from "@agentclientprotocol/sdk"
import { Orbit } from "@orbit/client/promise"
import { Service } from "@orbit/client/effect/service"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { Effect } from "effect"
import { Writable } from "node:stream"
import { ACP } from "../../acp/agent"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { Standalone } from "../../services/standalone"

export default Runtime.handler(
  Commands.commands.acp,
  Effect.fn("cli.acp")(function* () {
    process.env.ORBIT_CLIENT = "acp"
    const endpoint = yield* Standalone.start()
    const client = Orbit.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    // The editor picks the folder of each session, so the folder is checked when a session opens: session/new,
    // session/load and session/resume refuse one that is not trusted (`ACPService`).
    const connection = yield* ACP.connect(client, ndJsonStream(Writable.toWeb(process.stdout), Bun.stdin.stream()))
    const failure = yield* Effect.raceFirst(
      Effect.promise(() => connection.closed).pipe(
        Effect.map(() =>
          connection.signal.reason instanceof MessageTooLargeError
            ? `incoming message exceeded the ${connection.signal.reason.maxMessageBytes / 1024 / 1024} MiB limit`
            : undefined,
        ),
      ),
      endpoint.exited.pipe(
        Effect.match({
          onSuccess: (code) => `code ${code}`,
          onFailure: (error) =>
            error.cause instanceof CrossSpawnSpawner.KilledBySignal ? `signal ${error.cause.signal}` : error.message,
        }),
        Effect.map((reason) => `server exited unexpectedly (${reason})`),
      ),
    )
    // Closing the handler scope would wait for the private server's graceful shutdown; its lease pipe already
    // ends the server once this process exits.
    yield* Effect.sync(() => {
      // stdout carries ACP, so the diagnostic goes to stderr.
      if (failure) process.stderr.write(`orb acp: ${failure}\n`)
      process.exit(failure ? 1 : 0)
    })
  }),
)
