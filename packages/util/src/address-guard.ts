export * as AddressGuard from "./address-guard.js"

/**
 * Why an address is not a public one:
 *
 * - `loopback`: this machine. An unspecified address (0.0.0.0, ::) counts as one, because a connection to it reaches this
 *   machine.
 * - `private`: a private network, such as the home or office LAN that holds the user's other machines.
 * - `link-local`: an address only the attached network can route to (169.254.0.0/16, fe80::/10).
 * - `metadata`: an address a cloud host serves its own credentials from. 169.254.169.254 is the best known; the link-local
 *   range around it is still `link-local`.
 */
export type Kind = "loopback" | "private" | "link-local" | "metadata"

export interface Refusal {
  /** The address that was refused: the host itself when it is an address, otherwise one it resolved to. */
  readonly address: string
  readonly kind: Kind
}

export interface Options {
  /** Kinds the request may reach after all, such as `loopback` for a dev server. Every other non-public kind is refused. */
  readonly allow?: ReadonlyArray<Kind>
  /** Resolves a name to the addresses it stands for. Defaults to the system resolver. */
  readonly lookup?: (name: string) => Promise<ReadonlyArray<string>>
}

/**
 * Checks where a request to `host` would go and returns the first address it may not reach, or undefined when it may go
 * ahead. `host` is what a URL calls its hostname: an address in any spelling a URL accepts, such as 2130706433, 0x7f.1 or
 * [::ffff:127.0.0.1], or a name. A name is resolved, and one address that is not public is enough to refuse it, since the
 * request may connect to any of them.
 *
 * A name that does not resolve is not refused. Nothing here can connect to it, so the request fails by itself, or goes
 * through a proxy that resolves it. The answer can still differ from the one the request gets, because the name is
 * resolved again when it connects; that is not guarded against.
 *
 * Resolving a name is a request to the network, so ask permission for the host before calling this. A string that is not
 * a host, such as one that still has a port or a path on it, is a mistake of the caller and rejects, so that it is never
 * taken for an address that may be reached.
 */
export async function check(host: string, options: Options = {}): Promise<Refusal | undefined> {
  const name = canonical(host)
  if (name === undefined) throw new TypeError(`Not a host name or address: ${host}`)
  // Names under .localhost always resolve to the loopback interface (RFC 6761), whatever a resolver says.
  const addresses = literal(name)
    ? [name]
    : name === "localhost" || name.endsWith(".localhost")
      ? ["127.0.0.1"]
      : await (options.lookup ?? lookup)(name).catch(() => [])
  return addresses
    .flatMap((address) => {
      const kind = classify(address)
      return kind === undefined || options.allow?.includes(kind) ? [] : [{ address, kind }]
    })
    .at(0)
}

/** The kind of non-public address that `address` is, and undefined for a public address, or for a name, which stands for no address until it is resolved. */
export function classify(address: string): Kind | undefined {
  const name = canonical(address)
  if (name === undefined || !literal(name)) return undefined
  if (name.startsWith("[")) return kind6(groups(name))
  return kind4(name.split(".").map(Number))
}

async function lookup(name: string) {
  const { lookup } = await import("node:dns/promises")
  return (await lookup(name, { all: true, verbatim: true })).map((entry) => entry.address)
}

// What a URL makes of the host: a numeric IPv4 spelling is written as four decimal parts, an IPv6 literal as its shortest
// lowercase form in brackets, and a name in lowercase without a trailing dot. A zone id (fe80::1%eth0) says which
// interface to use and is no part of the address. Undefined when the text is not only a host: a port, a path, credentials
// or a space would be read as something else, and the URL would then be about another host than the text names.
function canonical(host: string) {
  if (/[\s/?#@\\]/.test(host)) return undefined
  const bare = host.replace(/^\[(.*)\]$/, "$1")
  const href = `http://${bare.includes(":") ? `[${bare.replace(/%.*$/, "")}]` : bare}/`
  return URL.canParse(href) ? new URL(href).hostname.replace(/\.+$/, "") : undefined
}

function literal(name: string) {
  return name.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(name)
}

// The eight 16-bit groups of the shortest form of an IPv6 literal, with its brackets.
function groups(name: string) {
  const [head, tail] = name.slice(1, -1).split("::")
  const left = head === "" ? [] : head.split(":")
  const right = tail === undefined || tail === "" ? [] : tail.split(":")
  return [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right].map((group) =>
    parseInt(group, 16),
  )
}

function kind4([a, b, c, d]: ReadonlyArray<number>): Kind | undefined {
  if (a === 0 || a === 127) return "loopback"
  if (a === 169 && b === 254) return c === 169 && d === 254 ? "metadata" : "link-local"
  // Where Alibaba Cloud and Azure serve instance credentials. Neither is private in its own range.
  if ((a === 100 && b === 100 && c === 100 && d === 200) || (a === 168 && b === 63 && c === 129 && d === 16))
    return "metadata"
  if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)) return "private"
  // Shared address space (carrier-grade NAT), benchmarking, and the IETF protocol assignments.
  if ((a === 100 && b >= 64 && b < 128) || (a === 198 && b >= 18 && b < 20) || (a === 192 && b === 0 && c === 0))
    return "private"
  return undefined
}

function kind6(g: ReadonlyArray<number>): Kind | undefined {
  const zero = (from: number, to: number) => g.slice(from, to).every((group) => group === 0)
  // :: and ::1.
  if (zero(0, 7) && g[7] <= 1) return "loopback"
  // An IPv4 address inside an IPv6 one, mapped (::ffff:a.b.c.d) or compatible (::a.b.c.d), is as private as that address.
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return kind4([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255])
  // Where AWS serves instance credentials over IPv6.
  if (g[0] === 0xfd00 && g[1] === 0x0ec2 && zero(2, 7) && g[7] === 0x254) return "metadata"
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local"
  // Unique local (fc00::/7), and site-local (fec0::/10), which was deprecated.
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfec0) return "private"
  return undefined
}
