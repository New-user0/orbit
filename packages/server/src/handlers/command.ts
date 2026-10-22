import { Command } from "@orbit/core/command"
import { Plugin } from "@orbit/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const CommandHandler = HttpApiBuilder.group(Api, "server.command", (handlers) =>
  // Like the agents, the plugins fill these in, so a Location that was just built lists them once they are active.
  handlers.handle("command.list", () =>
    Plugin.awaitActivation.pipe(Effect.andThen(response(Command.Service.use((command) => command.list())))),
  ),
)
