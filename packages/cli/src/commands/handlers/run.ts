import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { trustRefusal } from "../../util/trust"
import { directory } from "./flow/execute"

type Format = "default" | "json" | "stream-json" | "result"

type HeadlessInput = {
  readonly server: Option.Option<string>
  readonly standalone: boolean
  readonly trust: boolean
  readonly bare: boolean
  readonly message: ReadonlyArray<string>
  readonly continue: boolean
  readonly session: Option.Option<string>
  readonly fork: boolean
  readonly model: Option.Option<string>
  readonly agent: Option.Option<string>
  readonly format: Format
  readonly jsonSchema: Option.Option<string>
  readonly file: ReadonlyArray<string>
  readonly title: Option.Option<string>
  readonly thinking: boolean
  readonly auto: boolean
  readonly yolo: boolean
  readonly dangerouslySkipPermissions: boolean
}

/**
 * Sends one message and prints the answer, for `orb run` and `orb -p`: both are a door that starts work, so both settle
 * trust for the folder before the first prompt and report a refusal in the format that was asked for.
 */
export function headlessInput(input: HeadlessInput) {
  return Effect.gen(function* () {
    const { reportRunError, runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
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
        // The parser already appends the operands after a literal -- to the message.
        message: [...input.message],
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
  })
}

export default Runtime.handler(Commands.commands.run, headlessInput)
