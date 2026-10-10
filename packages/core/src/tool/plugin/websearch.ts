export * as WebSearchTool from "./websearch.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { ToolFailure } from "@orbit/ai"
import { Tool } from "@orbit/schema/tool"
import { Effect, Schema, Semaphore } from "effect"
import { HttpClientError } from "effect/unstable/http"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { WebSearch } from "../../websearch.js"

export const name = "WebSearch"
export const NO_RESULTS = "No search results found. Please try a different query."
const providerSelectionLock = Semaphore.makeUnsafe(1)
const httpErrors = new Map([
  [429, "Web search rate limited (HTTP 429)"],
  [401, "Web search authentication failed (HTTP 401)"],
])

// Fixed text: it never repeats the model's query, and it tells the model to stop rather than work around the missing consent.
export const NOT_ENABLED =
  'Web search is not enabled: the user has not agreed to it, so nothing was searched. The user can turn it on by answering the web search prompt in an interactive client, or by setting `websearch` in their own Orbit config (for example { "provider": "random" } or { "provider": "<provider ID>" }). Only the user can turn it on: do not change any Orbit config or settings file yourself, and do not send the query to a search service some other way. Do not call WebSearch again in this run; carry on without it, or tell the user how to turn it on.'

const notEnabled = () => new ToolFailure({ message: NOT_ENABLED, code: Tool.ErrorCode.WebSearchNotEnabled })

// Placed before the first result: the session runner keeps the head of an oversized result, so a trailing line is lost.
export const SOURCES_REMINDER =
  'Reminder: when your reply uses these results, end it with a "Sources:" section listing each page you used as a markdown link, like [Title](URL).'

export const description = `Search the web using the user's selected search integration. Use this for current information beyond knowledge cutoff.

When your reply draws on search results, end it with a "Sources:" section that lists the pages you used as markdown links, like [Title](URL).

Use allowedDomains to restrict results to certain sites (subdomains included) and blockedDomains to exclude sites. Both are optional and are applied to the results after the search.

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
          options: { authorizes: true, codemode: false },
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
                        if (response.status === "cancelled") return yield* notEnabled()
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
                        if (selection?.status === "cancelled") return yield* notEnabled()
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
                      // Consent is a user decision: no answer (a form that cannot be shown, or a minute without a reply)
                      // means no search. The minute includes the wait for the permit, so a queued call can fail without
                      // seeing a form. The timeout interrupts the pending form, which cancels it; a late reply is rejected.
                      Effect.catchIf(
                        (error): error is Form.AlreadyExistsError | Form.InvalidFormError =>
                          error instanceof Form.AlreadyExistsError || error instanceof Form.InvalidFormError,
                        (error) =>
                          Effect.logWarning("web search consent form could not be created", error).pipe(
                            Effect.andThen(Effect.fail(notEnabled())),
                          ),
                      ),
                      Effect.timeoutOrElse({
                        duration: "1 minute",
                        orElse: () => Effect.fail(notEnabled()),
                      }),
                      Effect.flatMap(search),
                    )
                }),
              )
              const output = {
                provider: result.providerID,
                results: result.results.filter((item) => allowed(item.url, input)),
              }
              const sections = output.results.map((result) => {
                const title = result.title ?? result.url
                const published = result.time.published
                  ? `\nPublished: ${new Date(result.time.published).toISOString()}`
                  : ""
                return `## [${title}](${result.url})${published}${result.content ? `\n\n${result.content}` : ""}`
              })
              const content = sections.length ? [SOURCES_REMINDER, ...sections].join("\n\n") : NO_RESULTS
              return { output, content, metadata: { provider: output.provider } }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure && error.code === Tool.ErrorCode.WebSearchNotEnabled) return error
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
