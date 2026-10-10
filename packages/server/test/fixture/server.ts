import path from "node:path"
import { Effect } from "effect"
import { HttpServer } from "effect/unstable/http"
import type { ServerOptions } from "../../src/options"
import { ServerProcess } from "../../src/process"

/**
 * A server on an ephemeral port. Tests put project config next to the code under test, so it trusts every folder
 * unless a test asks otherwise with `trust: { implicit: false }`.
 */
export const startServer = Effect.fnUntraced(function* (
  directory: string,
  options: { readonly trust?: ServerOptions["trust"] } = {},
) {
  const server = yield* ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password: "secret",
    app: { version: "test-version" },
    database: { path: ":memory:" },
    config: { directory },
    managed: { directory: path.join(directory, "managed-missing") },
    fs: { filewatcher: false },
    models: { fetch: false },
    trust: options.trust ?? { implicit: true },
  })
  return {
    base: HttpServer.formatAddress(server.address),
    headers: { authorization: `Basic ${btoa("orbit:secret")}` },
  }
})
