import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { findResumeSession } from "../../session-target"
import { bypassRefusal } from "../../util/managed-bypass"
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
  readonly resume: Option.Option<string>
  readonly fork: boolean
  readonly model: Option.Option<string>
  readonly agent: Option.Option<string>
  readonly format: Format
  readonly jsonSchema: Option.Option<string>
  readonly file: ReadonlyArray<string>
  readonly title: Option.Option<string>
  readonly thinking: boolean
  readonly envelope?: boolean
  readonly partial?: boolean
  readonly verbose?: boolean
  readonly maxSteps: Option.Option<number>
  readonly maxCost: Option.Option<number>
  readonly maxTokens: Option.Option<number>
  readonly fallbackModel: Option.Option<string>
  readonly auto: boolean
  readonly yolo: boolean
  readonly dangerouslySkipPermissions: boolean
  /** Stop in any untrusted folder, even one that holds nothing back (`orb -p`). */
  readonly strict?: boolean
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
    // Without the envelope a schema always prints the result object; with it the format picks what is printed.
    const format = jsonSchema === undefined || input.envelope ? input.format : "result"
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
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    // --resume names a session that must exist. It is resolved once, before the trust check, so the folder that is
    // checked and the folder the run happens in are the folder of that one session.
    const resume = Option.getOrUndefined(input.resume)
    if (resume !== undefined && (input.continue || Option.isSome(input.session)))
      return reportRunError(
        { format, envelope: input.envelope },
        "--resume cannot be combined with --continue or --session",
      )
    const resumed =
      resume === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => findResumeSession(client, resume, directory()),
            catch: (cause) => new Error(errorMessage(cause)),
          }).pipe(Effect.catch((error) => Effect.succeed(error)))
    if (resumed instanceof Error) return reportRunError({ format, envelope: input.envelope }, resumed.message)
    const session = resumed?.id ?? Option.getOrUndefined(input.session)
    // Checks the folder the run happens in, which is the folder of the session when --session or --resume names one
    // that exists. A refusal, and a request that fails, go out the way any error before a session exists does, so a
    // script that asked for JSON gets JSON.
    const stopped = yield* trustRefusal(client, directory(), {
      grant: input.trust,
      session,
      strict: input.strict,
    }).pipe(Effect.catch((error) => Effect.succeed(errorMessage(error))))
    if (stopped !== undefined) return reportRunError({ format, envelope: input.envelope }, stopped)
    // Before the first prompt, and in the format that was asked for, like the trust refusal above.
    const bypass = yield* bypassRefusal(
      client,
      directory(),
      input.auto || input.yolo || input.dangerouslySkipPermissions,
    )
    if (bypass !== undefined) return reportRunError({ format, envelope: input.envelope }, bypass)
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        // The parser already appends the operands after a literal -- to the message.
        message: [...input.message],
        continue: input.continue,
        session,
        mustExist: resumed !== undefined,
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format,
        jsonSchema,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        envelope: input.envelope,
        partial: input.partial,
        verbose: input.verbose,
        maxSteps: Option.getOrUndefined(input.maxSteps),
        maxCost: Option.getOrUndefined(input.maxCost),
        maxTokens: Option.getOrUndefined(input.maxTokens),
        fallbackModel: Option.getOrUndefined(input.fallbackModel),
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    )
  })
}

export default Runtime.handler(Commands.commands.run, headlessInput)
