import { Plugin } from "@orbit/core/plugin"
import { Provider } from "@orbit/core/provider"
import { ProviderNotFoundError } from "@orbit/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    // The config's providers and the ones plugins add are registered while the Location's plugins activate, which the
    // first request to a Location starts.
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          yield* Plugin.awaitActivation
          const providers = yield* Provider.Service
          return yield* response(providers.available())
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          yield* Plugin.awaitActivation
          const providers = yield* Provider.Service
          const provider = yield* providers.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(provider))
        }),
      )
  }),
)
