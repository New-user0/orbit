import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          // The providers are the plugins' to fill in, as the agents are, so a Location that was just built lists its
          // models once the plugins available locally are active rather than none. ACP's first session waited for them
          // by polling with a five-second cap, which a loaded machine passed (FU-M4-341). A package that still has to be
          // installed does not hold the list.
          yield* Plugin.awaitApplied
          const models = yield* Model.Service
          return yield* response(models.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          yield* Plugin.awaitApplied
          const models = yield* Model.Service
          return yield* response(models.default())
        }),
      )
  }),
)
