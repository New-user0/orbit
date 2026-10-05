import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { trustRefusal } from "../../util/trust"
import { directory } from "./flow/execute"

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const { reportRunError, runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    const separator = process.argv.indexOf("--", 2)
    const schemaFile = Option.getOrUndefined(input.jsonSchema)
    const jsonSchema = schemaFile ? yield* Effect.promise(() => Bun.file(schemaFile).json()) : undefined
    const format = jsonSchema === undefined ? input.format : "result"
    // The private server inherits this process's environment, which is how --bare reaches it.
    if (input.bare) {
      process.env.ORBIT_DISABLE_PROJECT_CONFIG = "1"
      process.env.ORBIT_DISABLE_INSTRUCTIONS = "1"
    }
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone || input.bare,
      trust: input.trust,
    })
    // Checks the folder the run happens in, which is the folder of the session when --session names one that exists.
    // A refusal, and a request that fails, go out the way any error before a session exists does, so a script that asked
    // for JSON gets JSON.
    const stopped = yield* trustRefusal(
      Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) }),
      directory(),
      { grant: input.trust, session: Option.getOrUndefined(input.session) },
    ).pipe(Effect.catch((error) => Effect.succeed(errorMessage(error))))
    if (stopped !== undefined) return reportRunError({ format }, stopped)
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        message: [...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))],
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format,
        jsonSchema,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    )
  }),
)
