import { EOL } from "os"
import { Effect } from "effect"
import { Orbit } from "@orbit/client"
import { Service } from "@orbit/client/effect/service"
import { Commands } from "../../commands"
import { ConfigOverlay } from "../../../config-overlay"
import { Runtime } from "../../../framework/runtime"
import { ServerConnection } from "../../../services/server-connection"
import { redactConfig } from "./redact"

export default Runtime.handler(
  Commands.commands.debug.commands.config,
  Effect.fn("cli.debug.config")(function* (input) {
    // A --settings file or JSON reaches a private server, which is then asked what it loaded. Nothing here runs work.
    const overlay = yield* ConfigOverlay.apply({ settings: input.settings, server: undefined })
    const { endpoint } = yield* ServerConnection.resolve({ standalone: overlay })
    yield* Effect.promise(() => ConfigOverlay.release())
    const client = Orbit.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const entries = yield* Effect.promise(() => client.config.get({ location: { directory: process.cwd() } }))
    process.stdout.write(JSON.stringify(redactConfig(entries), null, 2) + EOL)
  }),
)
