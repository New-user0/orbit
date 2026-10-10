import { Config } from "effect"

// Every environment variable the CLI reads, in one place. Consumers yield
// these instead of touching process.env so the full surface stays visible,
// typed, and redacted where secret.

// The orbit server password: sent by clients connecting to an explicit
// --server, and adopted by a manually run or standalone server. The legacy
// name is still honored.
export const password = Config.redacted("ORBIT_PASSWORD").pipe(
  Config.orElse(() => Config.redacted("ORBIT_SERVER_PASSWORD")),
  Config.withDefault(undefined),
)

// Server credentials, and the run's config overlay, which can hold MCP server settings and headers that tools in a
// session's shell have no business reading.
const withheld = new Set([
  "ORBIT_PASSWORD",
  "ORBIT_SERVER_PASSWORD",
  "ORBIT_CONFIG_CONTENT",
  "ORBIT_CONFIG_CONTENT_FILE",
])

export function session() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !withheld.has(entry[0]),
    ),
  )
}

export * as Env from "./env"
