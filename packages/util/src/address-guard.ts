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
  /**
   * The address that was refused: the host itself when it is an address, otherwise one it resolved to, in the form a URL
   * has it, or the name itself when it resolved to none.
   */
  readonly address: string
  /** Which kind of address it is, or `unresolved` for a name that stands for no address, so that there is none to check. */
  readonly kind: Kind | "unresolved"
}

/** What `check` decided. */
export type Checked =
  | { readonly allowed: false; readonly refusal: Refusal }
  | {
      readonly allowed: true
      /**
       * The addresses a request to a name must connect to, in the order the resolver gave them and in the form a URL has
       * them, instead of connecting to the name. Empty for a host that is an address, which a request connects to as it is.
       */
      readonly connect: ReadonlyArray<string>
    }

export interface Options {
  /** Kinds the request may reach after all, such as `loopback` for a dev server. Every other non-public kind is refused. */
  readonly allow?: ReadonlyArray<Kind>
  /** Resolves a name to the addresses it stands for. Defaults to the system resolver. */
  readonly lookup?: (name: string) => Promise<ReadonlyArray<string>>
}

/**
 * Checks where a request to `host` would go: whether it may go ahead, and where it must connect. `host` is what a URL
 * calls its hostname: an address in any spelling a URL accepts, such as 2130706433, 0x7f.1 or [::ffff:127.0.0.1], or a
 * name. A name is resolved, once, and one address that is not public is enough to refuse it, since the request may
 * connect to any of them.
 *
 * A name that resolves to no address is refused as well, whether the resolver has none for it or fails. There is nothing
 * to check, and whatever the request then connected to would be a place that nobody looked at: a name can answer with
 * an error the first time and with the real address the second (DNS rebinding), and a proxy resolves a name by itself.
 *
 * What is allowed is the answer that was checked, not the name. The name is resolved again by whatever connects to it,
 * and a name that expires at once can answer differently each time, so a request that is allowed must connect to the
 * addresses in `connect`, and send the name only as what it asks for: in its `Host` header and, with TLS, in the
 * handshake that checks the certificate.
 *
 * Resolving a name is a request to the network, so ask permission for the host before calling this. A string that is not
 * a host, such as one that still has a port or a path on it, is a mistake of the caller and rejects, so that it is never
 * taken for an address that may be reached.
 */
export async function check(host: string, options: Options = {}): Promise<Checked> {
  const name = canonical(host)
  if (name === undefined) throw new TypeError(`Not a host name or address: ${host}`)
  const isAddress = literal(name)
  // Names under .localhost always resolve to the loopback interface (RFC 6761), whatever a resolver says. A server on
  // `localhost` can listen on either family, so a request tries both.
  const addresses = isAddress
    ? [name]
    : name === "localhost" || name.endsWith(".localhost")
      ? ["127.0.0.1", "[::1]"]
      : await resolve(name, options.lookup ?? lookup)
  const refusal = addresses
    .flatMap((address) => {
      const kind = classify(address)
      return kind === undefined || options.allow?.includes(kind) ? [] : [{ address, kind }]
    })
    .at(0)
  if (refusal !== undefined) return { allowed: false, refusal }
  if (addresses.length === 0) return { allowed: false, refusal: { address: name, kind: "unresolved" } }
  return { allowed: true, connect: isAddress ? [] : addresses }
}

/**
 * The kind of non-public address that `address` is, and undefined for a public address, or for a name, which stands for no
 * address until it is resolved. An IPv6 address that stands for an IPv4 one, as a mapped, compatible, translated, NAT64,
 * 6to4, Teredo or ISATAP address does, is held to the rules for that IPv4 address as well as its own.
 */
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

// The addresses a name stands for, in the form a URL has them and without repeats, in the order the resolver gave them. A
// resolver that fails answers none, and so does one that answers with something that is not an address: a request must
// never be told to connect to a name.
async function resolve(name: string, resolver: NonNullable<Options["lookup"]>) {
  const answered = await resolver(name).catch(() => [])
  return [
    ...new Set(
      answered.flatMap((address) => {
        const found = canonical(address)
        return found !== undefined && literal(found) ? [found] : []
      }),
    ),
  ]
}

// What a URL makes of the host: a numeric IPv4 spelling is written as four decimal parts, an IPv6 literal as its shortest
// lowercase form in brackets, and a name in lowercase without a trailing dot. A zone id (fe80::1%eth0) says which
// interface to use and is no part of the address. Undefined when the text is not only a host: a port, a path, credentials
// or a space would be read as something else, and the URL would then be about another host than the text names.
export function canonical(host: string) {
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
  // Where Alibaba Cloud, Azure and Oracle Cloud Infrastructure Classic serve instance credentials. None of them is
  // private in its own range, and the last is inside the IETF protocol assignments below.
  if (
    (a === 100 && b === 100 && c === 100 && d === 200) ||
    (a === 168 && b === 63 && c === 129 && d === 16) ||
    (a === 192 && b === 0 && c === 0 && d === 192)
  )
    return "metadata"
  if (a === 10 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168)) return "private"
  // Shared address space (carrier-grade NAT), benchmarking, and the IETF protocol assignments.
  if ((a === 100 && b >= 64 && b < 128) || (a === 198 && b >= 18 && b < 20) || (a === 192 && b === 0 && c === 0))
    return "private"
  return undefined
}

function kind6(g: ReadonlyArray<number>): Kind | undefined {
  // :: and ::1.
  if (zero(g, 0, 7) && g[7] <= 1) return "loopback"
  return strictest([range6(g), ...embedded(g).map(kind4)])
}

// Where AWS (instance metadata, and the EKS Pod Identity Agent), Compute Engine and Oracle Cloud Infrastructure serve
// instance credentials over IPv6, and where Akamai (Linode) and Scaleway serve their metadata services. Each one is inside
// the unique local range, which is otherwise only private.
const metadata6 = [
  "fd00:ec2::254",
  "fd00:ec2::23",
  "fd20:ce::254",
  "fd00:c1::a9fe:a9fe",
  "fd00:a9fe:a9fe::1",
  "fd00:42::42",
].map((address) => groups(`[${address}]`))

// The kind of the range that an IPv6 address is in, whatever IPv4 address it stands for.
function range6(g: ReadonlyArray<number>): Kind | undefined {
  if (metadata6.some((address) => address.every((group, index) => group === g[index]))) return "metadata"
  if ((g[0] & 0xffc0) === 0xfe80) return "link-local"
  // Unique local (fc00::/7), site-local (fec0::/10), which was deprecated, and the NAT64 prefix for local use
  // (64:ff9b:1::/48, RFC 8215). None of them is routed beyond the networks around this machine.
  if ((g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfec0 || (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1))
    return "private"
  return undefined
}

// The IPv4 addresses that an IPv6 address stands for, in the forms that a translator or a tunnel delivers to the IPv4
// host. A request to such an address is a request to that host, so each one is held to the IPv4 rules.
function embedded(g: ReadonlyArray<number>) {
  const bytes = g.flatMap((group) => [group >> 8, group & 255])
  const at = (...offsets: ReadonlyArray<number>) => offsets.map((offset) => bytes[offset])
  const last = at(12, 13, 14, 15)
  // Compatible (::a.b.c.d), mapped (::ffff:a.b.c.d) and translated (::ffff:0:a.b.c.d, RFC 2765).
  if (zero(g, 0, 5) && (g[5] === 0 || g[5] === 0xffff)) return [last]
  if (zero(g, 0, 4) && g[4] === 0xffff && g[5] === 0) return [last]
  // NAT64 with the well-known prefix (64:ff9b::/96, RFC 6052).
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(g, 2, 6)) return [last]
  // NAT64 with the prefix for local use (64:ff9b:1::/48). The operator picks how long a prefix to use inside it, and that
  // decides which bits hold the address (RFC 6052, section 2.2, which leaves bits 64 to 71 out), so each place counts.
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)
    return [at(6, 7, 9, 10), at(7, 9, 10, 11), at(9, 10, 11, 12), last]
  // 6to4 (2002::/16) holds it in the 32 bits after the prefix.
  if (g[0] === 0x2002) return [at(2, 3, 4, 5)]
  // Teredo (2001::/32, RFC 4380) holds the client's address in the last 32 bits, with every bit of it inverted.
  if (g[0] === 0x2001 && g[1] === 0) return [last.map((octet) => octet ^ 255)]
  // ISATAP (RFC 5214) holds it in the last 32 bits, under any prefix, after an interface identifier of its own.
  if ((g[4] === 0 || g[4] === 0x0200) && g[5] === 0x5efe) return [last]
  return []
}

// An address can be one kind by its range and another by what it stands for, and is reported as the first that applies.
// Metadata and link-local come first, since nothing allows them. Loopback comes last, because the places of the NAT64
// prefix for local use that are mostly zeros read as 0.x.y.z, which is loopback, where the address is only private.
const strictness: ReadonlyArray<Kind> = ["metadata", "link-local", "private", "loopback"]

function strictest(kinds: ReadonlyArray<Kind | undefined>) {
  return strictness.find((kind) => kinds.includes(kind))
}

function zero(g: ReadonlyArray<number>, from: number, to: number) {
  return g.slice(from, to).every((group) => group === 0)
}
