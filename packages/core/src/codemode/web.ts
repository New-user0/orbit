export * as CodeModeWeb from "./web.js"

import { Extension } from "@orbit/codemode"
import { PermissionWeb } from "../permission/web.js"

const TIMEOUT_MS = 30_000

type Init = {
  readonly method?: string
  readonly headers?: Record<string, string> | Array<[string, string]>
  readonly body?: string | Uint8Array<ArrayBuffer> | URLSearchParams
}

const fetch = async (input: string | URL, init: Init = {}) => {
  // Bun's fetch also reads file:, data: and s3: URLs and takes an array or an object with a url for the URL. Reading the
  // call with the function that authorizes it makes the request that goes out the one that was approved.
  const response = await globalThis.fetch(input, {
    method: request([input, init]).metadata.method,
    headers: init.headers,
    body: init.body,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const bytes = await response.bytes()
  const headers = Object.fromEntries(response.headers)
  const text = () => new TextDecoder().decode(bytes)
  return {
    url: response.url,
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    redirected: response.redirected,
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

export const extension = Extension.make({ name: "web", globals: { fetch } })

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
