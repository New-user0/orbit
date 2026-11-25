import { Model } from "@orbit/core/model"
import { Plugin } from "@orbit/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    // Plugins add providers and their models, and the first request to a Location starts their activation, so each
    // route waits for it instead of answering with only what was there before.
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          yield* Plugin.awaitActivation
          const models = yield* Model.Service
          return yield* response(models.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          yield* Plugin.awaitActivation
          const models = yield* Model.Service
          return yield* response(models.default())
        }),
      )
  }),
)
