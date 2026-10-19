export * as WebFetchTool from "./webfetch.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { Duration, Effect, Schema, Stream } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { isIP } from "node:net"
import { Config } from "../../config.js"
import { Permission } from "../../permission.js"
import { PermissionWeb } from "../../permission/web.js"
import { SideQuery } from "../../side-query.js"
import { Tool } from "../../tool.js"
import { Wildcard } from "../../util/wildcard.js"
import { convertHTMLToMarkdown } from "../html-markdown.js"
import { collectBoundedResponseBody } from "../http-body.js"
import { WebFetchCache } from "../webfetch-cache.js"
import { WebPin } from "../web-pin.js"

export const name = "WebFetch"
// Decoupled from the 5 MiB budget of the Markdown conversion: a larger page is fetched and converted up to that budget.
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024
export const DEFAULT_TIMEOUT_SECONDS = 30
export const MAX_TIMEOUT_SECONDS = 120
export const MAX_URL_LENGTH = 2000
export const MAX_REDIRECTS = 10
export const CACHE_TTL_MS = 15 * 60 * 1000
export const CACHE_MAX_BYTES = 50 * 1024 * 1024

export const description = `Fetch a web page and answer a question about it. Give the complete URL and a prompt that says exactly what to extract; a small model reads the page and returns only its answer, so the page itself does not fill your context. HTML is converted to Markdown before it is read.

This fails for pages behind a sign-in and for private services. For those, use a dedicated tool with authenticated access, such as one provided by an MCP server, or a code host's own command-line tool through the shell, when one is available.

An http: URL is fetched over https: (a local host keeps its scheme). A redirect within the same site, including one that only adds or drops a leading "www.", is followed; a redirect to another host, port or protocol is not followed but reported with its target, which you can fetch with a new call. A Markdown page under 100,000 characters from a host the user configured is returned whole instead. Pages are cached for 15 minutes, so repeating a call is cheap. This tool is read-only.`

const Timeout = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  prompt: Schema.String.annotate({
    description: "What to find in the page, such as the question to answer or the facts to extract",
  }),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
})

const Output = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  output: Schema.String,
})

const headers = (userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
  "Accept-Language": "en-US,en;q=0.9",
})

const orbitUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Orbit-User/1.0; +https://orbit.invalid"

// Keeps an answer within a small model's context window. A Markdown page shorter than this from a listed host is
// returned whole instead.
const MAX_PROMPT_PAGE_CHARS = 100_000
// An answer reads up to 100,000 characters, which a slow or local model may take longer than a side query's default.
const ANSWER_TIMEOUT = Duration.seconds(MAX_TIMEOUT_SECONDS)

// 303 is not one: it asks for a GET of another resource, and fails as a status error.
const REDIRECT_STATUSES = new Set([301, 302, 307, 308])

const isCloudflareChallenge = (response: HttpClientResponse.HttpClientResponse) =>
  response.status === 403 && response.headers["cf-mitigated"] === "challenge"

const isNotConnected = (error: HttpClientError.HttpClientError) =>
  error.reason._tag === "TransportError" && WebPin.notConnected(error.reason.cause)

const mimeFrom = (contentType: string) => contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
const isImageAttachment = (mime: string) =>
  mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
const isTextualMime = (mime: string) =>
  !mime ||
  mime.startsWith("text/") ||
  mime === "application/json" ||
  mime.endsWith("+json") ||
  mime === "application/xml" ||
  mime.endsWith("+xml") ||
  mime === "application/javascript" ||
  mime === "application/x-javascript"
const convert = (content: string, contentType: string) =>
  contentType.includes("text/html") ? convertHTMLToMarkdown(content) : content

export const Plugin = {
  id: "orbit.tool.webfetch",
  effect: Effect.fn("WebFetchTool.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient
    const permission = yield* Permission.Service
    const tools = yield* Tool.Service
    const config = yield* Config.Service
    const sideQuery = yield* SideQuery.Service
    // Shared by the sessions of this Location. It holds page content only.
    const cache = WebFetchCache.make({ ttl: CACHE_TTL_MS, maxBytes: CACHE_MAX_BYTES })

    // One request of the chain. The host is checked after the permission for it, and the request connects to the
    // addresses that were checked and not to the name, which would be resolved again. Redirects are never followed by
    // the client: the loop below decides about each one.
    const send = Effect.fnUntraced(function* (url: URL, userAgent: string) {
      // Through a configured proxy the request is for the name, which the proxy resolves (the owner's exception to the
      // checked-address rule); every other request is checked and pinned.
      const proxy = WebPin.proxyFor(url)
      const places = WebPin.targets(url, proxy ? [] : yield* tools.resolveWeb(url.hostname))
      const attempt = (index: number): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
        const place = places[index]
        const request = HttpClientRequest.get(place.url.href).pipe(
          HttpClientRequest.setHeaders(headers(userAgent)),
          (request) => (place.host === undefined ? request : HttpClientRequest.setHeader(request, "host", place.host)),
        )
        return http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            ...(proxy ? { proxy } : {}),
            ...(place.tls ? { tls: place.tls } : {}),
          }),
          // The site must not receive Orbit's trace context (traceparent, b3): it would link every hop and call of a run.
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.catchIf(
            (error) => index < places.length - 1 && isNotConnected(error),
            () => attempt(index + 1),
          ),
        )
      }
      return yield* attempt(0)
    })

    // The Cloudflare challenge retry applies to each request of the chain. It is sent again to the name, which is checked
    // and resolved again for it.
    const hop = (url: URL) =>
      send(url, orbitUserAgent).pipe(
        Effect.flatMap((response) =>
          isCloudflareChallenge(response) ? send(url, "orbit") : Effect.succeed(response),
        ),
      )

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
              const assertWeb = (web: ReturnType<typeof PermissionWeb.request>, metadata: Record<string, unknown>) =>
                // Rules are written against the URL, its host or its origin; "always" saves the origin.
                permission.assert({
                  action: name,
                  resources: web.resources,
                  aliases: web.aliases,
                  save: web.save,
                  metadata,
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })

              // The URL that will be fetched is the one that is asked about, so an http: URL cannot step around a rule
              // written for the https: one.
              const start = yield* Effect.try({ try: () => prepare(input.url), catch: refusal })
              const web = yield* Effect.try({
                try: () => PermissionWeb.request(start.href, "GET"),
                catch: refusal,
              })
              // The method and the URL are the ones the rules matched and the fetch connects to (no credentials, an
              // ASCII host), so a client shows them rather than the spelling the model chose, which stays in the call's
              // raw input.
              yield* assertWeb(web, { ...input, method: web.metadata.method, url: web.metadata.url })

              // The timeout is for the network, not for the person: it wraps each request and each body read, and never an
              // ask, which can wait as long as the person takes.
              const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
                effect.pipe(
                  Effect.timeoutOrElse({
                    duration: Duration.seconds(input.timeout ?? DEFAULT_TIMEOUT_SECONDS),
                    orElse: () => Effect.fail(new Error("Request timed out")),
                  }),
                )

              // Every hop is asked about, so a redirect cannot step around a rule written for another URL.
              const assertHop = Effect.fnUntraced(function* (from: string, to: string, status: number) {
                const hopWeb = yield* Effect.try({
                  try: () => PermissionWeb.request(to, "GET"),
                  catch: refusal,
                })
                yield* assertWeb(hopWeb, {
                  method: hopWeb.metadata.method,
                  url: hopWeb.metadata.url,
                  redirect: { from, status },
                })
              })

              // Only after the permission above: a hit must not skip it. It also asks about each hop the page was reached
              // through, in order, so a rule written for a hop applies to a cached page as to a live one.
              const key = web.metadata.url
              const cached = yield* cache.get(key)
              if (cached) for (const item of cached.hops) yield* assertHop(item.from, item.to, item.status)

              const follow = (
                url: URL,
                hops: ReadonlyArray<WebFetchCache.Hop>,
              ): Effect.Effect<
                | {
                    readonly response: HttpClientResponse.HttpClientResponse
                    readonly url: URL
                    readonly hops: ReadonlyArray<WebFetchCache.Hop>
                  }
                | { readonly redirect: { readonly from: URL; readonly to: URL; readonly status: number } },
                unknown
              > =>
                Effect.gen(function* () {
                  const response = yield* timed(hop(url))
                  if (!REDIRECT_STATUSES.has(response.status)) {
                    // Named by the URL that was asked for: the request itself went to an address.
                    if (response.status < 200 || response.status >= 300)
                      return yield* Effect.fail(new Error(`Request failed with status ${response.status} (GET ${url.href})`))
                    return { response, url, hops }
                  }
                  // Only the headers of a redirect matter: its body is released without being read.
                  yield* timed(Stream.runDrain(Stream.take(response.stream, 0))).pipe(Effect.ignore)
                  const location = response.headers.location
                  if (!location) return yield* Effect.fail(new Error("Redirect response has no Location header"))
                  const next = yield* Effect.try({
                    try: () => new URL(location, url),
                    catch: () => new Error("Redirect Location is not a valid URL"),
                  })
                  if (!sameSite(url, next)) return { redirect: { from: url, to: next, status: response.status } }
                  if (hops.length === MAX_REDIRECTS)
                    return yield* Effect.fail(
                      new ToolFailure({
                        message: `Too many redirects (more than ${MAX_REDIRECTS})`,
                        code: Tool.ErrorCode.WebFetchRedirectLimit,
                      }),
                    )
                  yield* assertHop(url.href, next.href, response.status)
                  return yield* follow(next, [...hops, { from: url.href, to: next.href, status: response.status }])
                })

              const fetched = cached
                ? { contentType: cached.contentType, output: cached.content, finalUrl: cached.finalUrl }
                : yield* Effect.gen(function* () {
                    const chain = yield* follow(start, [])
                    if ("redirect" in chain) return chain
                    const contentType = chain.response.headers["content-type"] || ""
                    const mime = mimeFrom(contentType)
                    if (isImageAttachment(mime))
                      return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                    if (!isTextualMime(mime))
                      return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                    const body = yield* timed(
                      collectBoundedResponseBody(
                        chain.response,
                        MAX_RESPONSE_BYTES,
                        () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
                      ),
                    )
                    const output = yield* Effect.try({
                      try: () => convert(new TextDecoder().decode(body), contentType),
                      catch: (error) => error,
                    })
                    // Only a successful final response is stored, under the URL that was asked for.
                    yield* cache.set(key, {
                      finalUrl: chain.url.href,
                      contentType,
                      content: output,
                      bytes: body.byteLength,
                      hops: chain.hops,
                    })
                    return { contentType, output, finalUrl: chain.url.href }
                  })

              if ("redirect" in fetched) {
                // Nothing was sent to the target: no lookup, no permission request, no connection. The note is neither
                // answered from nor cached. It carries the parsed target, never the raw Location text.
                const note = redirectNote(fetched.redirect)
                return {
                  output: { url: input.url, contentType: "", output: note },
                  content: note,
                  metadata: { redirect: { url: fetched.redirect.to.href, status: fetched.redirect.status } },
                }
              }

              const finish = (
                content: string,
                metadata: Record<string, unknown>,
              ) => ({
                output: { url: input.url, contentType: fetched.contentType, output: content },
                content,
                metadata: { contentType: fetched.contentType, ...metadata },
              })

              // Read now and not at start, so a change applies to the next call, cached pages included.
              const verbatimHosts = Config.latest(yield* config.entries(), "webfetch")?.verbatim_hosts ?? []
              const listed = [web.metadata.url, fetched.finalUrl].every((href) => hostListed(verbatimHosts, new URL(href)))
              // Listing a host only relaxes what reaches the model, and it asks for a Markdown page that is small enough
              // to read whole. A page that fails either is answered like any other.
              if (listed && mimeFrom(fetched.contentType) === "text/markdown" && fetched.output.length < MAX_PROMPT_PAGE_CHARS)
                return finish(fetched.output, { answered: false, verbatim: true })

              const answer = yield* sideQuery
                .text({
                  sessionID: context.sessionID,
                  purpose: "webfetch.summarize",
                  model: "small",
                  history: false,
                  system: extractionInstructions(listed),
                  prompt: [
                    "<page>",
                    fetched.output.length > MAX_PROMPT_PAGE_CHARS
                      ? `${fetched.output.slice(0, MAX_PROMPT_PAGE_CHARS)}\n[The page was cut here because it is too long.]`
                      : fetched.output,
                    "</page>",
                    "",
                    `Question: ${input.prompt}`,
                  ].join("\n"),
                  timeout: ANSWER_TIMEOUT,
                })
                .pipe(
                  Effect.match({
                    onSuccess: (result) => ({ answer: result.text }),
                    onFailure: (error) => ({ failure: error }),
                  }),
                )
              if ("failure" in answer) {
                // The page is not returned in place of an answer: only a listed host's page reaches the model whole. The
                // message of a side query error never holds the provider's own text.
                return finish(
                  [
                    `${input.url} was fetched, but no answer could be produced from it: ${answer.failure.message}.`,
                    `Call ${name} again to retry; the page is cached, so only the answer is asked for again.`,
                  ].join("\n"),
                  { answered: false, error: answer.failure._tag },
                )
              }
              return finish(answer.answer, { answered: true, url: fetched.finalUrl })
            }).pipe(
              // A failure that was given a code where it was made goes out as it is, so a client can tell it from a crash.
              Effect.mapError((error) =>
                error instanceof Tool.Error && error.code !== undefined
                  ? error
                  : new ToolFailure({ message: `Unable to fetch ${input.url}`, error }),
              ),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

// The address was turned down before anything was sent: a URL that cannot be fetched, or one the permission layer refuses.
function refusal(error: unknown) {
  return new ToolFailure({
    message: error instanceof Error ? error.message : String(error),
    code: Tool.ErrorCode.WebFetchRefused,
    error,
  })
}

/**
 * The URL a call fetches. It is refused before anything is asked or sent when it is too long or carries credentials, and
 * an http: URL becomes https:, except for a host that cannot have a certificate worth the name: a single label such as
 * localhost, or an address, which are reached only when the configuration allows local servers.
 */
function prepare(raw: string) {
  if (raw.length > MAX_URL_LENGTH) throw new Error(`URL must not be longer than ${MAX_URL_LENGTH} characters`)
  const url = new URL(raw)
  if (url.username || url.password) throw new Error("URL must not contain a username or password")
  const host = url.hostname.replace(/\.+$/, "")
  if (url.protocol === "http:" && host.includes(".") && isIP(host.replace(/^\[|\]$/g, "")) === 0)
    url.protocol = "https:"
  return url
}

// A redirect is followed only within the site: the same protocol (or http to https), the same port, no credentials, and
// the same host once one leading "www." is dropped from each. Comparing with the hop before and not the first URL means
// a chain cannot drift to another name.
function sameSite(from: URL, to: URL) {
  const bare = (url: URL) => url.hostname.replace(/\.+$/, "").replace(/^www\./, "")
  return (
    (to.protocol === from.protocol || (from.protocol === "http:" && to.protocol === "https:")) &&
    to.port === from.port &&
    !to.username &&
    !to.password &&
    bare(from) === bare(to)
  )
}

/**
 * Whether the host of `url`, and the path when an entry names one, is on the list. Entries are written lower case by the
 * URL parser's rule, and `Wildcard.match` is case-insensitive only on Windows, so both sides are lowered first.
 */
function hostListed(entries: ReadonlyArray<string>, url: URL) {
  const host = url.hostname.replace(/\.+$/, "")
  return entries.some((entry) => {
    const slash = entry.indexOf("/")
    const pattern = (slash === -1 ? entry : entry.slice(0, slash)).trim().toLowerCase().replace(/\.+$/, "")
    if (!pattern || !Wildcard.match(host, pattern)) return false
    const prefix = slash === -1 ? "" : entry.slice(slash).replace(/\/+$/, "")
    // A prefix matches on a segment boundary: /org covers /org and /org/x, and not /org-evil.
    return prefix === "" || url.pathname === prefix || url.pathname.startsWith(`${prefix}/`)
  })
}

// Two tiers: a listed host is one the user trusts, so a longer excerpt is allowed from it.
function extractionInstructions(listed: boolean) {
  return [
    "You answer a question about one web page. The page is between <page> tags and the question follows it.",
    "Take the answer from the page alone, and when the page lacks it, state that. Keep the reply brief.",
    listed
      ? "This host is one the user trusts: longer quotations are acceptable, and code samples or commands that answer the question stay unchanged."
      : "Quote only where the exact wording matters, each quotation in quotation marks and no longer than 125 characters; everything else is in your own words. Song lyrics are never reproduced, and the reply carries no judgement on whether the request or the answer is legal.",
  ].join("\n")
}

function redirectNote(redirect: { readonly from: URL; readonly to: URL; readonly status: number }) {
  const reason =
    redirect.status === 301
      ? "Moved Permanently"
      : redirect.status === 307
        ? "Temporary Redirect"
        : redirect.status === 308
          ? "Permanent Redirect"
          : "Found"
  return [
    `${redirect.from.href} answered with a redirect (${redirect.status} ${reason}) to ${redirect.to.href}.`,
    "That address is another host, port or protocol, so it was not followed and nothing was sent to it.",
    `To read it, call ${name} again with url "${redirect.to.href}" and the same prompt.`,
  ].join("\n")
}

export { convertHTMLToMarkdown }
