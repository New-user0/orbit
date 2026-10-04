import { define } from "@orbit/plugin/effect/plugin"
import type { SessionRequest } from "@orbit/plugin/effect/session"
import { Effect } from "effect"
import { Provider } from "../../provider.js"
import type { PluginInternal } from "../internal.js"

export const OpenAIPlugin = define({
  id: "orbit.provider.openai",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.provider.transform((providers) => {
      const item = providers.get(Provider.ID.openai)
      if (!item) return
      providers.update(item.provider.id, (provider) => {
        provider.settings = Provider.mergeOverlay(provider.settings, {
          transport: provider.settings?.transport ?? "websocket",
        })
      })
    })
    // OpenAI counts a requested output limit against rate limits.
    const omitOutputLimit = (evt: SessionRequest) =>
      Effect.sync(() => {
        delete evt.options.maxTokens
      })
    for (const name of ["context", "compaction"] as const)
      yield* ctx.session.hook(name, omitOutputLimit, { providerID: Provider.ID.openai })
  }),
} satisfies PluginInternal.InternalPlugin)
