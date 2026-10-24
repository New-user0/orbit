import { Orbit } from "@orbit/client"
import type { OrbitClient } from "@orbit/client/promise"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { errorMessage } from "../../util/error"
import { findResumeSession, latestSessionOf } from "../../session-target"
import { ConfigOverlay } from "../../config-overlay"
import { bypassDecision, printBypassNotice } from "../../util/managed-bypass"
import { mcpConfigRefusal } from "../../util/managed-mcp"
import { trustRefusal } from "../../util/trust"
import { directory } from "./flow/execute"

type Format = "default" | "json" | "stream-json" | "result"

type HeadlessInput = {
  readonly server: Option.Option<string>
  readonly standalone: boolean
  readonly trust: boolean
  readonly bare: boolean
  readonly settings: ReadonlyArray<string>
  readonly mcpConfig: ReadonlyArray<string>
  readonly agents: Option.Option<string>
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
  readonly inputFormat: Option.Option<"text" | "stream-json">
  readonly title: Option.Option<string>
  readonly thinking: boolean
  readonly envelope?: boolean
  readonly partial?: boolean
  readonly verbose?: boolean
  readonly maxSteps: Option.Option<number>
  readonly maxCost: Option.Option<number>
  readonly maxTokens: Option.Option<number>
  readonly fallbackModel: Option.Option<string>
  readonly toolLabels: boolean
  readonly promptSuggestions: boolean
  readonly auto: boolean
  readonly yolo: boolean
  readonly dangerouslySkipPermissions: boolean
  readonly rewindFiles: Option.Option<string>
  /** Stop in any untrusted folder, even one that holds nothing back (`orb -p`). */
  readonly strict?: boolean
}

/**
 * Sends one message and prints the answer, for `orb run` and `orb -p`: both are a door that starts work, so both settle
 * trust for the folder before the first prompt and report a refusal in the format that was asked for.
 */
export function headlessInput(input: HeadlessInput) {
  // Standard input is a stream of JSON inputs, and the output is the envelope of lines, whichever door was used.
  const stream = Option.getOrUndefined(input.inputFormat) === "stream-json"
  if (stream && input.format !== "stream-json")
    return Effect.fail(new Error("--input-format stream-json requires --format stream-json"))
  // Labels and suggestions are lines of the stream-json envelope that the driver of stream input writes, and each asks
  // the model, so a run that could not print them refuses them before any server starts.
  if (input.toolLabels && input.format !== "stream-json")
    return Effect.fail(new Error("--tool-labels requires --format stream-json"))
  if (input.toolLabels && !stream) return Effect.fail(new Error("--tool-labels requires --input-format stream-json"))
  if (input.promptSuggestions && !stream)
    return Effect.fail(new Error("--prompt-suggestions requires --input-format stream-json"))
  if (stream && input.file.length > 0 && input.message.length === 0)
    return Effect.fail(new Error("--file needs a message when --input-format is stream-json"))
  const envelope = input.envelope || stream
  return Effect.gen(function* () {
    const { reportRunError, runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    const schemaValue = Option.getOrUndefined(input.jsonSchema)
    // Without the envelope a schema always prints the result object; with it the format picks what is printed.
    const format = schemaValue === undefined || envelope ? input.format : "result"
    // A schema that cannot be read, or an attempts override that is not 1 to 20, is a usage error: it is reported in the
    // requested format before any session exists.
    const output =
      schemaValue === undefined
        ? undefined
        : yield* Effect.promise(async () => {
            const { readAttempts, readOutputSchema } = await import("../../run/output-schema")
            const schema = await readOutputSchema(schemaValue)
            if ("error" in schema) return schema
            const attempts = readAttempts(process.env)
            return "error" in attempts ? attempts : { schema: schema.schema, attempts: attempts.attempts }
          })
    if (output && "error" in output) return reportRunError({ format, envelope }, output.error)
    // A rewind names a prompt of a session that exists and sends nothing, so it is refused before a server starts when
    // it names no session or comes with a prompt of its own.
    const rewind = Option.getOrUndefined(input.rewindFiles)
    if (rewind !== undefined && !input.continue && Option.isNone(input.session) && Option.isNone(input.resume))
      return reportRunError(
        { format, envelope },
        "--rewind-files needs the session named with --session, --continue or --resume",
      )
    if (rewind !== undefined && (input.message.length > 0 || input.file.length > 0))
      return reportRunError({ format, envelope }, "--rewind-files takes no prompt: it only puts files back")
    const jsonSchema = output?.schema
    const attempts = output?.attempts
    // The private server inherits this process's environment, which is how --bare reaches it.
    if (input.bare) {
      process.env.ORBIT_DISABLE_PROJECT_CONFIG = "1"
      process.env.ORBIT_DISABLE_INSTRUCTIONS = "1"
    }
    // --settings, --mcp-config and --agents reach the private server through ORBIT_CONFIG_CONTENT_FILE, set here for the
    // same reason.
    const applied = yield* ConfigOverlay.applyNamed({
      settings: input.settings,
      mcpConfig: input.mcpConfig,
      agents: Option.getOrUndefined(input.agents),
      server: Option.getOrUndefined(input.server),
    }).pipe(Effect.catch((error) => Effect.succeed(error)))
    // Like every refusal before a session exists, in the format that was asked for.
    if (applied instanceof Error) return reportRunError({ format, envelope }, applied.message)
    const overlay = applied.overlay
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone || input.bare || overlay,
      trust: input.trust,
    })
    // The private server has read its file by now; nothing the run starts should inherit the variable.
    yield* Effect.promise(() => ConfigOverlay.release())
    const client = Orbit.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    // --resume names a session that must exist. It is resolved once, before the trust check, so the folder that is
    // checked and the folder the run happens in are the folder of that one session.
    const resume = Option.getOrUndefined(input.resume)
    if (resume !== undefined && (input.continue || Option.isSome(input.session)))
      return reportRunError({ format, envelope }, "--resume cannot be combined with --continue or --session")
    const resumed =
      resume === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => findResumeSession(client, resume, directory()),
            catch: (cause) => new Error(errorMessage(cause)),
          }).pipe(Effect.catch((error) => Effect.succeed(error)))
    if (resumed instanceof Error) return reportRunError({ format, envelope }, resumed.message)
    const named = resumed?.id ?? Option.getOrUndefined(input.session)
    // The session that --continue would pick is settled here, once, in the folder the run works in (the run moves
    // there itself, which settles a link or a trailing separator in PWD), and the run takes that ID as its target,
    // so the session that was checked is the session that runs.
    const checked = overlay
      ? yield* Effect.try({
          try: () => {
            process.chdir(directory())
            return process.cwd()
          },
          catch: () => new Error(`Failed to change directory to ${directory()}`),
        }).pipe(
          Effect.flatMap((folder) =>
            ConfigOverlay.refuseActive({
              client,
              session: named,
              continue: input.continue,
              fork: input.fork,
              directory: folder,
            }),
          ),
          Effect.catch((error) => Effect.succeed(error)),
        )
      : named
    if (checked instanceof Error) return reportRunError({ format, envelope }, checked.message)
    const session = checked ?? named
    const continues = input.continue && session === undefined
    // Checks the folder the run happens in, which is the folder of the session when --session or --resume names one
    // that exists. A refusal, and a request that fails, go out the way any error before a session exists does, so a
    // script that asked for JSON gets JSON.
    const stopped = yield* trustRefusal(client, directory(), {
      grant: input.trust,
      session,
      // Stream input starts work as `orb -p` does, so it is just as strict.
      strict: input.strict || stream,
    }).pipe(Effect.catch((error) => Effect.succeed(errorMessage(error))))
    if (stopped !== undefined) return reportRunError({ format, envelope }, stopped)
    if (rewind !== undefined)
      return yield* rewindFiles({
        client,
        session,
        messageID: rewind,
        report: (message, sessionID) => reportRunError({ format, envelope }, message, sessionID),
      })
    // Before the first prompt, and in the format that was asked for, like the trust refusal above.
    const bypass = yield* bypassDecision(
      client,
      directory(),
      input.auto || input.yolo || input.dangerouslySkipPermissions,
    )
    printBypassNotice(bypass.notice, format, envelope)
    const mcpOnly = yield* mcpConfigRefusal(client, directory(), applied.named)
    if (mcpOnly !== undefined) return reportRunError({ format, envelope }, mcpOnly)
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        // The parser already appends the operands after a literal -- to the message.
        message: [...input.message],
        continue: continues,
        session,
        mustExist: resumed !== undefined,
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format,
        jsonSchema,
        attempts,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        envelope,
        stream,
        partial: input.partial,
        verbose: input.verbose,
        maxSteps: Option.getOrUndefined(input.maxSteps),
        maxCost: Option.getOrUndefined(input.maxCost),
        maxTokens: Option.getOrUndefined(input.maxTokens),
        fallbackModel: Option.getOrUndefined(input.fallbackModel),
        labels: input.toolLabels,
        suggestions: input.promptSuggestions,
        auto: bypass.auto,
      }),
    )
  })
}

/**
 * `--rewind-files`: asks the server to put back the files of the named session, or of the folder's latest one with
 * `--continue`, as they were when the prompt's work began. The server refuses a busy session, an untrusted folder and a
 * message without a checkpoint; a refusal is reported and exits 1.
 */
const rewindFiles = Effect.fnUntraced(function* (input: {
  readonly client: OrbitClient
  readonly session: string | undefined
  readonly messageID: string
  readonly report: (message: string, sessionID?: string) => void
}) {
  const latest =
    input.session === undefined
      ? yield* Effect.promise(() =>
          latestSessionOf(input.client, directory()).catch((cause) => new Error(errorMessage(cause))),
        )
      : undefined
  if (latest instanceof Error) return input.report(latest.message)
  const sessionID = input.session ?? latest?.id
  if (sessionID === undefined) return input.report("No session to rewind in this folder")
  const rewound = yield* Effect.tryPromise({
    try: () => input.client.session.revert.files({ sessionID, messageID: input.messageID }),
    catch: (cause) => new Error(`Could not rewind the files to ${input.messageID}: ${errorMessage(cause)}`),
  }).pipe(Effect.catch((error) => Effect.succeed(error)))
  if (rewound instanceof Error) return input.report(rewound.message, sessionID)
  process.stdout.write(`Rewound the files to message ${input.messageID}\n`)
})

export default Runtime.handler(Commands.commands.run, headlessInput)
