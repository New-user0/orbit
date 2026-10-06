export * as CodeModeWeb from "./web.js"

import { Extension } from "@orbit/codemode"
import { checkServerIdentity, type PeerCertificate } from "node:tls"
import { PermissionWeb } from "../permission/web.js"

/** The extension a call to `fetch` names. */
export const name = "web"

const TIMEOUT_MS = 30_000
const MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
// What a request carries for the server it was written for. A redirect to another origin takes none of it along.
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization", "host"]
// The headers that describe a body, which go with it when a redirect turns a request into a GET.
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"]
// What fetch fails with when it could not connect to an address, so that nothing was sent to it.
const NOT_CONNECTED = new Set(["ConnectionRefused", "FailedToOpenSocket"])

type Init = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

/** What `fetch` needs from the execution it runs in. */
export interface Gate {
  /**
   * Asks about a request the program did not write itself: the next one in a chain of redirects. It rejects when that
   * request must not go out, and then the chain ends.
   */
  readonly authorize: (url: URL, method: string) => Promise<void>
  /**
   * Checks where a request to `host` may go, which is asked for every request in a chain, the program's own and each
   * redirect. It answers with the addresses to connect to instead of the host, and with none for a host that is an address
   * itself. It rejects when the request must not go out.
   */
  readonly resolve: (host: string) => Promise<ReadonlyArray<string>>
  /** Aborts when the execution ends, so that a fetch outliving its program asks and sends no more. */
  readonly signal: AbortSignal
}

/**
 * The `fetch` a program calls. Its own request is authorized before it runs, as any call to a host function is. A
 * redirect is a request of its own, to a place the program never named and the user never approved, so `fetch` does not
 * let the runtime follow one: it hands each one to the gate, which asks about it like any other request, and stops where
 * the gate refuses. It follows at most 10, so that a loop ends quickly. Each request, the first and every redirect, goes
 * to the addresses that the gate checked and not to the name that stands for them.
 */
export const extension = (gate: Gate) => {
  // Bun's fetch also reads file:, data: and s3: URLs and takes an array or an object with a url for the URL. Reading the
  // call with the function that authorizes it makes the request that goes out the one that was approved.
  const fetch = async (input: string | URL, init: Init = {}) =>
    send(gate, new URL(input), request([input, init]).metadata.method, init.body, new Headers(init.headers), 0)
  return Extension.make({ name, globals: { fetch } })
}

type Reply = Awaited<ReturnType<typeof reply>>

async function send(
  gate: Gate,
  url: URL,
  method: string,
  body: Init["body"],
  headers: Headers,
  redirects: number,
): Promise<Reply> {
  const response = await connect(gate, url, {
    method,
    headers,
    body,
    redirect: "manual",
    // Each request has its own time, so the time spent waiting for an answer to the one before does not count.
    signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), gate.signal]),
  })
  const location = response.headers.get("location")
  if (!REDIRECT_STATUSES.has(response.status) || location === null) return reply(response, redirects > 0, url)
  // Only the headers of a redirect matter.
  await response.body?.cancel()
  if (redirects === MAX_REDIRECTS) throw new Error(`fetch stopped after following ${MAX_REDIRECTS} redirects`)

  const next = new URL(location, url)
  // As fetch does itself: a POST answered with 301 or 302, and any write but a HEAD answered with 303, goes on as a GET
  // without its body. Every other redirect repeats the request.
  const toGet =
    response.status === 303
      ? method !== "GET" && method !== "HEAD"
      : (response.status === 301 || response.status === 302) && method === "POST"
  if (toGet) BODY_HEADERS.forEach((header) => headers.delete(header))
  if (next.origin !== url.origin) CREDENTIAL_HEADERS.forEach((header) => headers.delete(header))
  const nextMethod = toGet ? "GET" : method
  await gate.authorize(next, nextMethod)
  return send(gate, next, nextMethod, toGet ? undefined : body, headers, redirects + 1)
}

// Sends the request to the addresses that were checked and not to the name, which whatever connects to it would resolve
// again, and a name can answer differently each time (DNS rebinding). The request is still for the name: it is in the
// `Host` header, which a program's own `Host` keeps as it is, and over TLS in the handshake and the check of the
// certificate, so a server and a certificate see the request as they would see one that went to the name. A name with
// several addresses is tried one after the other, as fetch does itself, moving on only when no connection could be made.
async function connect(gate: Gate, url: URL, init: BunFetchRequestInit) {
  const addresses = await gate.resolve(url.hostname)
  if (addresses.length === 0) return globalThis.fetch(url, init)
  const name = url.hostname.replace(/\.+$/, "")
  const headers = new Headers(init.headers)
  if (!headers.has("host")) headers.set("host", url.host)
  const attempt = (index: number): Promise<Response> => {
    const pinned = new URL(url)
    pinned.hostname = addresses[index]
    return globalThis
      .fetch(pinned, {
        ...init,
        headers,
        ...(url.protocol === "https:"
          ? {
              tls: {
                serverName: name,
                checkServerIdentity: (_: string, certificate: PeerCertificate) =>
                  checkServerIdentity(name, certificate),
              },
            }
          : {}),
      })
      .catch((error: unknown) => {
        if (index === addresses.length - 1 || !notConnected(error)) throw error
        return attempt(index + 1)
      })
  }
  return attempt(0)
}

const notConnected = (error: unknown) =>
  error instanceof TypeError && "code" in error && typeof error.code === "string" && NOT_CONNECTED.has(error.code)

// `url` is the one the request is for. The response's own is where it was sent, which is an address and not the name.
async function reply(response: Response, redirected: boolean, url: URL) {
  const bytes = await response.bytes()
  const headers = Object.fromEntries(response.headers)
  const text = () => new TextDecoder().decode(bytes)
  const shown = new URL(url)
  shown.hash = ""
  return {
    url: shown.href,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
      has: (name: string) => name.toLowerCase() in headers,
      entries: () => Object.entries(headers),
    },
    text: async () => text(),
    json: async () => JSON.parse(text()) as unknown,
    bytes: async () => bytes,
  }
}

/**
 * The permission request a fetch call makes. The arguments come from the program, so only a URL string or URL object
 * is a URL and only a string is a method, and anything else throws.
 */
export const request = (args: ReadonlyArray<unknown>) => {
  const [input, init] = args
  if (typeof input !== "string" && !(input instanceof URL)) throw new TypeError("fetch needs a URL string or a URL")
  const method = typeof init === "object" && init !== null && "method" in init ? init.method : undefined
  if (method !== undefined && typeof method !== "string") throw new TypeError("fetch method must be a string")
  return PermissionWeb.request(input, method ?? "GET")
}

/** What to show for a fetch call: its method and URL. */
export const display = (args: ReadonlyArray<unknown>) => {
  const [input, init] = args as [string | URL, Init | undefined]
  const method = init?.method
  return { method: typeof method === "string" ? method.toUpperCase() : "GET", url: String(input) }
}
