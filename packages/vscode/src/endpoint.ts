import { launch } from "./program.js"

export interface Endpoint {
  readonly url: string
  readonly auth?: { readonly type: "basic"; readonly username: string; readonly password: string }
}

/**
 * Start or reuse the local background service through `orb` itself, so the registration file, release channel and
 * credentials are whatever that `orb` build uses. The first start can take a while on a cold machine.
 */
export async function start(executable: string, timeout = 120_000): Promise<Endpoint> {
  const stdout = await launch(executable, ["service", "start", "--json"], { timeout, maxBuffer: 1024 * 1024 })
  const endpoint = parse(stdout.trim().split(/\r?\n/).at(-1) ?? "")
  if (!endpoint) throw new Error(`orb service start printed no endpoint: ${stdout.trim().slice(0, 200)}`)
  return endpoint
}

export function headers(endpoint: Endpoint) {
  if (!endpoint.auth) return undefined
  return {
    authorization: `Basic ${Buffer.from(`${endpoint.auth.username}:${endpoint.auth.password}`).toString("base64")}`,
  }
}

function parse(line: string): Endpoint | undefined {
  const value: unknown = (() => {
    try {
      return JSON.parse(line)
    } catch {
      return undefined
    }
  })()
  if (typeof value !== "object" || value === null || !("url" in value) || typeof value.url !== "string") return
  return value as Endpoint
}

/** The version `orb --version` prints, for the chat's setup checks. */
export async function version(executable: string): Promise<string> {
  const stdout = await launch(executable, ["--version"], { timeout: 30_000 })
  return (stdout.trim().split(/\r?\n/).at(-1) ?? "").replace(/^orb\s+/, "")
}
