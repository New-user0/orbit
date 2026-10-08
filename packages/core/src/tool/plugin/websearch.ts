export * as WebSearchTool from "./websearch.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { ToolFailure } from "@orbit/ai"
import { Effect, Schema, Semaphore } from "effect"
import { HttpClientError } from "effect/unstable/http"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { WebSearch } from "../../websearch.js"

export const name = "websearch"
export const NO_RESULTS = "No search results found. Please try a different query."
const providerSelectionLock = Semaphore.makeUnsafe(1)
const httpErrors = new Map([
  [429, "Web search rate limited (HTTP 429)"],
  [401, "Web search authentication failed (HTTP 401)"],
])

export const description = `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

The current year is ${new Date().getFullYear()}. Use this year when searching for recent information or current events.`

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Websearch query" }),
  allowedDomains: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: 'Only return results from these domains and their subdomains, such as ["docs.python.org"]',
  }),
  blockedDomains: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Never return results from these domains or their subdomains",
  }),
})

const Output = Schema.Struct({
  provider: WebSearch.ID,
  results: Schema.Array(WebSearch.Result),
})
// Filters apply to the results, since search providers differ in whether and how they accept site restrictions.
function allowed(url: string, input: typeof Input.Type) {
  const host = URL.parse(url)?.hostname.toLowerCase()
  if (!host) return !input.allowedDomains?.length
  const matches = (domain: string) => {
    const bare = domain.toLowerCase().replace(/^\*?\./, "")
    return host === bare || host.endsWith(`.${bare}`)
  }
  if (input.blockedDomains?.some(matches)) return false
  return !input.allowedDomains?.length || input.allowedDomains.some(matches)
}

export const Plugin = {
  id: "orbit.tool.websearch",
  effect: Effect.fn("WebSearchTool.Plugin")(function* (ctx: Context) {
    const permission = yield* Permission.Service
    const forms = yield* Form.Service
    const websearch = yield* WebSearch.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          traits: { readOnly: true, concurrencySafe: true, openWorld: true, interruptBehavior: "cancel" },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              const search = (providerID?: WebSearch.ID) =>
                websearch.query(
                  { query: input.query, providerID },
                  {
                    sessionID: context.sessionID,
                    onProvider: (provider) => context.progress({ provider: provider.id }),
                  },
                )
              const result = yield* search().pipe(
                Effect.catchTag("WebSearch.ProviderRequired", () => {
                  return providerSelectionLock
                    .withPermit(
                      Effect.gen(function* () {
                        if (yield* websearch.default()) return
                        const providers = (yield* ctx.websearch.providers()).data
                        const defaultProvider = providers[0]
                        if (!defaultProvider) return yield* new WebSearch.ProviderRequiredError()
                        const response = yield* forms.ask({
                          sessionID: context.sessionID,
                          title: "Web Search",
                          metadata: { kind: "websearch.provider" },
                          fields: [
                            {
                              key: "choice",
                              description: "Allow Orbit to search the web for up-to-date information?",
                              type: "string",
                              required: true,
                              custom: false,
                              options: [
                                {
                                  value: "allow",
                                  label: `Allow search via ${providers.map((provider) => provider.name).join(", ")}`,
                                },
                                {
                                  value: "choose",
                                  label: "Choose another provider",
                                },
                                { value: "disable", label: "Disable web search" },
                              ],
                            },
                          ],
                        })
                        if (response.status === "cancelled")
                          return yield* Effect.fail(new Error("Web search cancelled"))
                        if (response.answer.choice === "disable") {
                          yield* websearch.select(false)
                          return yield* new WebSearch.DisabledError()
                        }
                        const selection =
                          response.answer.choice === "choose"
                            ? yield* forms.ask({
                                sessionID: context.sessionID,
                                title: "Choose a web search provider",
                                metadata: { kind: "websearch.provider" },
                                fields: [
                                  {
                                    key: "provider",
                                    description: "Choose a provider for web search.",
                                    type: "string",
                                    required: true,
                                    custom: false,
                                    options: providers.map((provider) => ({
                                      value: provider.id,
                                      label: provider.name,
                                    })),
                                  },
                                ],
                              })
                            : undefined
                        if (selection?.status === "cancelled")
                          return yield* Effect.fail(new Error("Web search cancelled"))
                        const providerID = selection?.answer.provider ?? "random"
                        if (providerID === "random") {
                          yield* websearch.select("random")
                          return
                        }
                        const provider = providers.find((provider) => provider.id === providerID)
                        if (!provider) return yield* new WebSearch.ProviderRequiredError()
                        yield* websearch.select(provider.id)
                        return provider.id
                      }),
                    )
                    .pipe(
                      Effect.timeoutOrElse({
                        duration: "1 minute",
                        orElse: () => Effect.fail(new Error("Web search cancelled")),
                      }),
                      Effect.flatMap(search),
                    )
                }),
              )
              const output = {
                provider: result.providerID,
                results: result.results.filter((item) => allowed(item.url, input)),
              }
              const content = output.results.length
                ? output.results
                    .map((result) => {
                      const title = result.title ?? result.url
                      const published = result.time.published
                        ? `\nPublished: ${new Date(result.time.published).toISOString()}`
                        : ""
                      return `## [${title}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`
                    })
                    .join("\n\n")
                : NO_RESULTS
              return { output, content, metadata: { provider: output.provider } }
            }).pipe(
              Effect.mapError((error) => {
                const fallback = `Unable to search the web for ${input.query}`
                if (!Schema.is(WebSearch.RequestError)(error)) return new ToolFailure({ message: fallback, error })
                const status = HttpClientError.isHttpClientError(error.cause) ? error.cause.response?.status : undefined
                return new ToolFailure({
                  message:
                    status === undefined
                      ? fallback
                      : (httpErrors.get(status) ?? `Web search request failed (HTTP ${status})`),
                  error,
                  metadata: { provider: error.providerID },
                })
              }),
            ),
        }),
      )
      .pipe(Effect.orDie)

    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const disabled = yield* websearch.default().pipe(
          Effect.as(false),
          Effect.catchTag("WebSearch.Disabled", () => Effect.succeed(true)),
        )
        if (disabled) delete event.tools[name]
      })
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
}
