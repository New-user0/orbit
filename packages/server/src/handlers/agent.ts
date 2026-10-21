import { Agent } from "@orbit/core/agent"
import { Plugin } from "@orbit/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { AgentNotFoundError } from "@orbit/protocol/errors"

export const AgentHandler = HttpApiBuilder.group(Api, "server.agent", (handlers) =>
  handlers
    .handle("agent.list", () =>
      Effect.gen(function* () {
        // The agents are the plugins' to fill in, so a Location that was just built, after a grant, lists them once its
        // plugins are active rather than empty.
        yield* Plugin.awaitActivation
        return yield* response(Agent.Service.use((agent) => agent.list()))
      }),
    )
    .handle(
      "agent.get",
      Effect.fn(function* (ctx) {
        const agent = yield* Agent.Service.use((service) => service.get(ctx.params.agentID))
        if (!agent)
          return yield* new AgentNotFoundError({
            agentID: ctx.params.agentID,
            message: `Agent not found: ${ctx.params.agentID}`,
          })
        return yield* response(Effect.succeed(agent))
      }),
    ),
)
