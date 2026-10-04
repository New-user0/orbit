import { execFile } from "node:child_process"

export interface Endpoint {
  readonly url: string
  readonly auth?: { readonly type: "basic"; readonly username: string; readonly password: string }
}

/**
 * Start or reuse the local background service through `orb` itself, so the registration file, release channel and
 * credentials are whatever that `orb` build uses. The first start can take a while on a cold machine.
 */
export function start(executable: string, timeout = 120_000): Promise<Endpoint> {
  return new Promise((resolve, reject) =>
    execFile(
      executable,
      ["service", "start", "--json"],
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || error.message))
        const endpoint = parse(stdout.trim().split(/\r?\n/).at(-1) ?? "")
        if (!endpoint) return reject(new Error(`orb service start printed no endpoint: ${stdout.trim().slice(0, 200)}`))
        resolve(endpoint)
      },
    ),
  )
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
export function version(executable: string): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(executable, ["--version"], { timeout: 30_000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr.trim() || error.message))
      resolve((stdout.trim().split(/\r?\n/).at(-1) ?? "").replace(/^orb\s+/, ""))
    }),
  )
}
