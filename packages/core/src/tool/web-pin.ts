export * as WebPin from "./web-pin.js"

import { isIP } from "node:net"
import { checkServerIdentity, type PeerCertificate } from "node:tls"

// What fetch fails with when it could not connect to an address, so that nothing was sent to it.
const NOT_CONNECTED = new Set(["ConnectionRefused", "FailedToOpenSocket"])

/**
 * The places a request to `url` connects to, in order, given the addresses that `AddressGuard` checked for its host.
 * The checked addresses are connected to and not the name, which whatever connects to it would resolve again, and a name
 * can answer differently each time (DNS rebinding). The request is still for the name: it is in the `Host` header (`host`)
 * and, over TLS, in the handshake and the check of the certificate. With no addresses, the host is an address itself and
 * the request connects to it as it is.
 */
export function targets(url: URL, addresses: ReadonlyArray<string>) {
  if (addresses.length === 0) return [{ url, host: undefined, tls: undefined }]
  const name = url.hostname.replace(/\.+$/, "")
  return addresses.map((address) => {
    const pinned = new URL(url)
    pinned.hostname = address
    return {
      url: pinned,
      host: url.host,
      tls:
        url.protocol === "https:"
          ? {
              serverName: name,
              checkServerIdentity: (_: string, certificate: PeerCertificate) => checkServerIdentity(name, certificate),
            }
          : undefined,
    }
  })
}

/** Whether `error` is fetch failing to connect, so that the next address of a name may be tried. */
export const notConnected = (error: unknown) =>
  error instanceof TypeError && "code" in error && typeof error.code === "string" && NOT_CONNECTED.has(error.code)

/**
 * The proxy a request to `url` goes through, or undefined when it connects directly. One proxy serves every scheme, the
 * first of `https_proxy`, `HTTPS_PROXY`, `http_proxy` and `HTTP_PROXY` that is set, unless `NO_PROXY` names the host. The
 * owner's exception to the rule above (2026-10-19, FU-M1-008, "whatever the reference does"): a request that goes
 * through a proxy is sent with the host name, because the proxy resolves and connects, and a proxy that filters by name
 * must see the name. Nothing connects to the checked address then. An address written as a literal and the names
 * `localhost` and `*.localhost` never take the exception, and stay under `AddressGuard`.
 */
export function proxyFor(url: URL, environment: Readonly<Record<string, string | undefined>> = process.env) {
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, "")
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0 || hostname === "localhost" || hostname.endsWith(".localhost"))
    return undefined
  const value = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"].map((name) => environment[name]).find(Boolean)
  const noProxy = environment.NO_PROXY || environment.no_proxy
  if (!value || bypasses(url, hostname, noProxy)) return undefined
  // Anything but an http(s) proxy address is ignored, so a malformed value cannot turn into another scheme.
  const proxy = URL.parse(value)
  return proxy && (proxy.protocol === "http:" || proxy.protocol === "https:") ? proxy.href : undefined
}

function bypasses(url: URL, hostname: string, list: string | undefined) {
  if (!list) return false
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return list.split(/[\s,]+/).some((entry) => {
    if (!entry) return false
    if (entry === "*") return true
    const match = entry.match(/^(.+?):(\d+)$/)
    if (match?.[2] && match[2] !== port) return false
    const host = (match?.[1] ?? entry).toLowerCase().replace(/^\*?\.?/, "")
    return hostname === host || hostname.endsWith(`.${host}`)
  })
}
