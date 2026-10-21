import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Effect, Option } from "effect"
import { EOL } from "node:os"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { settledModels } from "../../util/models"

export default Runtime.handler(
  Commands.commands.models,
  Effect.fn("cli.models")(function* (input) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = Orbit.make({
      baseUrl: server.endpoint.url,
      headers: Service.headers(server.endpoint),
    })
    const models = (yield* Effect.promise(() => settledModels(client, process.cwd())))
      .map((model) => `${model.providerID}/${model.id}`)
      .toSorted((a, b) => a.localeCompare(b))
    if (models.length > 0) return process.stdout.write(models.join(EOL) + EOL)
    process.stderr.write(`No models are available. \`orb doctor\` shows which providers are configured.${EOL}`)
  }),
)
