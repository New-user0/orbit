export * as WebPin from "./web-pin.js"

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
