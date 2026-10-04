import fs from "node:fs"
import path from "node:path"
import { getCACertificates } from "node:tls"

/**
 * TLS settings for every outbound request, read once from the environment:
 *
 * - `ORBIT_CA_CERTS`: PEM bundle files, separated like PATH, trusted in addition to the bundled and OS roots.
 * - `TACHYON_CERT_PATH`, `TACHYON_CERT_B64`: the Tachyon SDK's CA bundle (a file, or base64 or raw PEM), trusted the
 *   same way so an environment set up for the SDK works unchanged.
 * - `ORBIT_CLIENT_CERT`, `ORBIT_CLIENT_KEY`, `ORBIT_CLIENT_KEY_PASSPHRASE`: a client certificate for mutual TLS.
 *
 * Proxies come from the standard `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` variables, which Bun's fetch honors.
 */
export interface Settings {
  readonly ca: readonly string[]
  readonly cert?: string
  readonly key?: string
  readonly passphrase?: string
}

export function settings(env: Readonly<Record<string, string | undefined>> = process.env): Settings | undefined {
  const ca = (env.ORBIT_CA_CERTS ?? "")
    .split(path.delimiter)
    .filter((file) => file.trim() !== "")
    .map((file) => read("ORBIT_CA_CERTS", file.trim()))
    .concat(env.TACHYON_CERT_PATH ? [read("TACHYON_CERT_PATH", env.TACHYON_CERT_PATH)] : [])
    .concat(env.TACHYON_CERT_B64 ? [pem(env.TACHYON_CERT_B64)] : [])
  const cert = env.ORBIT_CLIENT_CERT ? read("ORBIT_CLIENT_CERT", env.ORBIT_CLIENT_CERT) : undefined
  const key = env.ORBIT_CLIENT_KEY ? read("ORBIT_CLIENT_KEY", env.ORBIT_CLIENT_KEY) : undefined
  if ((cert === undefined) !== (key === undefined))
    throw new Error("ORBIT_CLIENT_CERT and ORBIT_CLIENT_KEY must be set together")
  if (ca.length === 0 && cert === undefined) return undefined
  return { ca, cert, key, passphrase: env.ORBIT_CLIENT_KEY_PASSPHRASE || undefined }
}

/** Apply `settings` to every request made through `base`; TLS options a caller passes explicitly still win. */
export function wrap(base: typeof fetch, input: Settings): typeof fetch {
  const tls = {
    // A custom CA list replaces the default trust store, so keep the bundled and OS roots alongside the extra CAs.
    ...(input.ca.length > 0
      ? { ca: [...new Set([...getCACertificates("default"), ...getCACertificates("system"), ...input.ca])] }
      : {}),
    ...(input.cert === undefined ? {} : { cert: input.cert, key: input.key, passphrase: input.passphrase }),
  }
  return Object.assign(
    (request: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) =>
      base(request, { ...init, tls: { ...tls, ...init?.tls } }),
    base,
  )
}

/** Route the process's global fetch through the configured TLS settings. Call once, before any request. */
export function install(env: Readonly<Record<string, string | undefined>> = process.env) {
  const configured = settings(env)
  if (configured) globalThis.fetch = wrap(globalThis.fetch, configured)
  return configured
}

function pem(value: string) {
  return value.includes("-----BEGIN") ? value : Buffer.from(value, "base64").toString("utf8")
}

function read(variable: string, file: string) {
  if (!fs.existsSync(file)) throw new Error(`${variable}: ${file} does not exist`)
  return fs.readFileSync(file, "utf8")
}

export * as Network from "./network.js"
