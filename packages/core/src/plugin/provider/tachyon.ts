import { Tachyon } from "@orbit/ai/providers/tachyon"
import { define } from "@orbit/plugin/effect/plugin"
import { Effect } from "effect"
import type { PluginInternal } from "../internal.js"

const providerID = "tachyon"
const tachyonPackage = "@orbit/ai/providers/tachyon"

// Configured settings win; the variables the Tachyon Python SDK reads fill whatever is left unset.
const environment = {
  baseURL: "TACHYON_CHAT_COMPLETION_BASE_URL",
  apigeeURL: "TACHYON_APIGEE_URL",
  consumerKey: "TACHYON_CONSUMER_KEY",
  consumerSecret: "TACHYON_CONSUMER_SECRET",
  apiKey: "TACHYON_API_KEY",
  usecaseId: "TACHYON_USECASE_ID",
  useApiGateway: "TACHYON_USE_API_GATEWAY",
} as const

export const TachyonPlugin = define({
  id: "orbit.provider.tachyon",
  effect: Effect.fn(function* (ctx) {
    const providerIDs = new Set<string>()
    yield* ctx.provider.transform((providers) => {
      providerIDs.clear()
      // The SDK's variables define the `tachyon` provider; orbit.json lists its models and may override any setting,
      // because configured providers are applied after this plugin.
      const configured = Object.fromEntries(
        Object.entries(environment).flatMap(([key, name]) => {
          const value = process.env[name]
          return value ? [[key, value]] : []
        }),
      )
      if (configured.baseURL)
        providers.update(providerID, (provider) => {
          provider.name = "Tachyon"
          provider.package = tachyonPackage
          provider.settings = { ...configured, ...provider.settings }
        })
      for (const item of providers.list()) {
        if (item.provider.package !== tachyonPackage) continue
        providerIDs.add(item.provider.id)
        providers.update(item.provider.id, (provider) => {
          // Tachyon authenticates with its own Apigee client credentials, not a stored key.
          provider.integrationID = undefined
          if (provider.activation === "auto") provider.activation = "enabled"
        })
      }
    })
    // A revoked or expired token answers 401: exchange a new one and retry once.
    yield* ctx.session.hook("retry", (event) =>
      Effect.sync(() => {
        if (!providerIDs.has(event.model.providerID) || event.error.status !== 401 || event.attempt !== 2) return
        Tachyon.invalidate()
        event.decision = { retry: true, delay: 0 }
      }),
    )
  }),
} satisfies PluginInternal.InternalPlugin)
