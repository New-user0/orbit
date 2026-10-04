import { Effect, Option } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(Commands.commands.run, (input) =>
  Effect.gen(function* () {
    const { runNonInteractive } = yield* Effect.promise(() => import("../../run/run"))
    const separator = process.argv.indexOf("--", 2)
    const schemaFile = Option.getOrUndefined(input.jsonSchema)
    const jsonSchema = schemaFile ? yield* Effect.promise(() => Bun.file(schemaFile).json()) : undefined
    // The private server inherits this process's environment, which is how --bare reaches it.
    if (input.bare) {
      process.env.ORBIT_DISABLE_PROJECT_CONFIG = "1"
      process.env.ORBIT_DISABLE_INSTRUCTIONS = "1"
    }
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone || input.bare,
    })
    yield* Effect.promise(() =>
      runNonInteractive({
        server,
        message: [...input.message, ...(separator === -1 ? [] : process.argv.slice(separator + 1))],
        continue: input.continue,
        session: Option.getOrUndefined(input.session),
        fork: input.fork,
        model: Option.getOrUndefined(input.model),
        agent: Option.getOrUndefined(input.agent),
        format: jsonSchema === undefined ? input.format : "result",
        jsonSchema,
        file: [...input.file],
        title: Option.getOrUndefined(input.title),
        thinking: input.thinking,
        auto: input.auto || input.yolo || input.dangerouslySkipPermissions,
      }),
    )
  }),
)
