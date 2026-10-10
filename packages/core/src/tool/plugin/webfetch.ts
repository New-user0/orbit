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
import { Parser } from "htmlparser2"
import { Permission } from "../../permission.js"
import { PermissionWeb } from "../../permission/web.js"
import { Tool } from "../../tool.js"
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

export const description = `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.

Use a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.

An http: URL is fetched over https: (a local host keeps its scheme). A redirect within the same site, including one that only adds or drops a leading "www.", is followed; a redirect to another host, port or protocol is not followed but reported with its target, which you can fetch with a new call. Pages are cached for 15 minutes, so repeating a call is cheap.`

const Timeout = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(MAX_TIMEOUT_SECONDS))

export const Input = Schema.Struct({
  url: Schema.String.annotate({ description: "The HTTP or HTTPS URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({ description: "The format to return the content in. Defaults to markdown." })
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed("markdown" as const))),
  timeout: Schema.optionalKey(Timeout).annotate({
    description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
  }),
  prompt: Schema.optionalKey(Schema.String).annotate({
    description:
      "What you want from the page. When given, a model reads the page and returns only the answer instead of the whole page, which saves context on long pages.",
  }),
})

const Output = Schema.Struct({
  url: Schema.String,
  contentType: Schema.String,
  format: Input.fields.format,
  output: Schema.String,
})
type Format = (typeof Input.Type)["format"]

const acceptHeader = (format: Format) => {
  switch (format) {
    case "markdown":
      return "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
    case "text":
      return "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
    case "html":
      return "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
  }
}

const headers = (format: Format, userAgent: string) => ({
  "User-Agent": userAgent,
  Accept: acceptHeader(format),
  "Accept-Language": "en-US,en;q=0.9",
})

const orbitUserAgent =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; Orbit-User/1.0; +https://orbit.invalid"

// Keeps a prompted read within a small model's context window.
const MAX_PROMPT_PAGE_CHARS = 100_000

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
const convert = (content: string, contentType: string, format: Format) => {
  if (!contentType.includes("text/html")) return content
  if (format === "markdown") return convertHTMLToMarkdown(content)
  if (format === "text") return extractTextFromHTML(content)
  return content
}

export const Plugin = {
  id: "orbit.tool.webfetch",
  effect: Effect.fn("WebFetchTool.Plugin")(function* (ctx: Context) {
    const http = yield* HttpClient.HttpClient
    const permission = yield* Permission.Service
    const tools = yield* Tool.Service
    // Shared by the sessions of this Location. It holds page content only.
    const cache = WebFetchCache.make({ ttl: CACHE_TTL_MS, maxBytes: CACHE_MAX_BYTES })

    // One request of the chain. The host is checked after the permission for it, and the request connects to the
    // addresses that were checked and not to the name, which would be resolved again. Redirects are never followed by
    // the client: the loop below decides about each one.
    const send = Effect.fnUntraced(function* (url: URL, format: Format, userAgent: string) {
      const places = WebPin.targets(url, yield* tools.resolveWeb(url.hostname))
      const attempt = (index: number): Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError> => {
        const place = places[index]
        const request = HttpClientRequest.get(place.url.href).pipe(
          HttpClientRequest.setHeaders(headers(format, userAgent)),
          (request) => (place.host === undefined ? request : HttpClientRequest.setHeader(request, "host", place.host)),
        )
        return http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "manual",
            ...(place.tls ? { tls: place.tls } : {}),
          }),
          Effect.catchIf(
            (error) => index < places.length - 1 && isNotConnected(error),
            () => attempt(index + 1),
          ),
        )
      }
      return yield* attempt(0)
    })

    // The Cloudflare challenge retry applies to each request of the chain, to the same checked addresses.
    const hop = (url: URL, format: Format) =>
      send(url, format, orbitUserAgent).pipe(
        Effect.flatMap((response) =>
          isCloudflareChallenge(response) ? send(url, format, "orbit") : Effect.succeed(response),
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
              const start = yield* Effect.try({ try: () => prepare(input.url), catch: (error) => error })
              const web = yield* Effect.try({
                try: () => PermissionWeb.request(start.href, "GET"),
                catch: (error) => error,
              })
              // The method and the URL are the ones the rules matched and the fetch connects to (no credentials, an
              // ASCII host), so a client shows them rather than the spelling the model chose, which stays in the call's
              // raw input.
              yield* assertWeb(web, { ...input, method: web.metadata.method, url: web.metadata.url })

              // Only after the permission above: a hit must not skip it.
              const key = `${input.format}\n${web.metadata.url}`
              const cached = yield* cache.get(key)

              const follow = (
                url: URL,
                redirects: number,
              ): Effect.Effect<
                | { readonly response: HttpClientResponse.HttpClientResponse; readonly url: URL }
                | { readonly redirect: { readonly from: URL; readonly to: URL; readonly status: number } },
                unknown
              > =>
                Effect.gen(function* () {
                  const response = yield* hop(url, input.format)
                  if (!REDIRECT_STATUSES.has(response.status)) {
                    // Named by the URL that was asked for: the request itself went to an address.
                    if (response.status < 200 || response.status >= 300)
                      return yield* Effect.fail(new Error(`Request failed with status ${response.status} (GET ${url.href})`))
                    return { response, url }
                  }
                  // Only the headers of a redirect matter: its body is released without being read.
                  yield* Stream.runDrain(Stream.take(response.stream, 0)).pipe(Effect.ignore)
                  const location = response.headers.location
                  if (!location) return yield* Effect.fail(new Error("Redirect response has no Location header"))
                  const next = yield* Effect.try({
                    try: () => new URL(location, url),
                    catch: () => new Error("Redirect Location is not a valid URL"),
                  })
                  if (!sameSite(url, next)) return { redirect: { from: url, to: next, status: response.status } }
                  if (redirects === MAX_REDIRECTS)
                    return yield* Effect.fail(new Error(`Too many redirects (more than ${MAX_REDIRECTS})`))
                  // Every request is asked about, so a redirect cannot step around a rule written for another URL.
                  const nextWeb = yield* Effect.try({
                    try: () => PermissionWeb.request(next.href, "GET"),
                    catch: (error) => error,
                  })
                  yield* assertWeb(nextWeb, {
                    method: nextWeb.metadata.method,
                    url: nextWeb.metadata.url,
                    redirect: { from: url.href, status: response.status },
                  })
                  return yield* follow(next, redirects + 1)
                })

              const fetched = cached
                ? { contentType: cached.contentType, output: cached.content }
                : yield* Effect.gen(function* () {
                    const chain = yield* follow(start, 0)
                    if ("redirect" in chain) return chain
                    const contentType = chain.response.headers["content-type"] || ""
                    const mime = mimeFrom(contentType)
                    if (isImageAttachment(mime))
                      return yield* Effect.fail(new Error(`Unsupported fetched image content type: ${mime}`))
                    if (!isTextualMime(mime))
                      return yield* Effect.fail(new Error(`Unsupported fetched file content type: ${mime}`))
                    const body = yield* collectBoundedResponseBody(
                      chain.response,
                      MAX_RESPONSE_BYTES,
                      () => new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`),
                    )
                    const output = yield* Effect.try({
                      try: () => convert(new TextDecoder().decode(body), contentType, input.format),
                      catch: (error) => error,
                    })
                    // Only a successful final response is stored, under the URL that was asked for.
                    yield* cache.set(key, {
                      finalUrl: chain.url.href,
                      contentType,
                      content: output,
                      bytes: body.byteLength,
                    })
                    return { contentType, output }
                  }).pipe(
                    Effect.timeoutOrElse({
                      duration: Duration.seconds(input.timeout ?? DEFAULT_TIMEOUT_SECONDS),
                      orElse: () => Effect.fail(new Error("Request timed out")),
                    }),
                  )

              if ("redirect" in fetched) {
                // Nothing was sent to the target: no lookup, no permission request, no connection. The note is neither
                // answered from nor cached. It carries the parsed target, never the raw Location text.
                const note = redirectNote(fetched.redirect, input.prompt !== undefined)
                return {
                  output: { url: input.url, contentType: "", format: input.format, output: note },
                  content: note,
                  metadata: { redirect: { url: fetched.redirect.to.href, status: fetched.redirect.status } },
                }
              }

              const result = {
                url: input.url,
                contentType: fetched.contentType,
                format: input.format,
                output: fetched.output,
              }
              if (!input.prompt)
                return { output: result, content: result.output, metadata: { contentType: result.contentType } }
              // Answer from the page with the default model; if no model can answer, fall back to the page itself.
              const answer = yield* ctx.generate
                .text({
                  prompt: [
                    `Below is the content of ${input.url}. Using only this content, ${input.prompt}`,
                    "Answer concisely. Quote exact text where it matters. If the page does not contain the answer, say so.",
                    "",
                    "<page>",
                    result.output.slice(0, MAX_PROMPT_PAGE_CHARS),
                    "</page>",
                  ].join("\n"),
                })
                .pipe(
                  Effect.map((response) => response.text),
                  Effect.orElseSucceed(() => undefined),
                )
              return {
                output: result,
                content: answer ?? result.output,
                metadata: { contentType: result.contentType, answered: answer !== undefined },
              }
            }).pipe(Effect.mapError((error) => new ToolFailure({ message: `Unable to fetch ${input.url}`, error }))),
        }),
      )
      .pipe(Effect.orDie)
  }),
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

function redirectNote(redirect: { readonly from: URL; readonly to: URL; readonly status: number }, prompted: boolean) {
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
    `To read it, call ${name} again with url "${redirect.to.href}"${prompted ? " and the same prompt" : ""}.`,
  ].join("\n")
}

export function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0
  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })
  parser.write(html)
  parser.end()
  return text.trim()
}

export { convertHTMLToMarkdown }
