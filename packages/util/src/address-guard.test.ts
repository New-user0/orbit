import { describe, expect, test } from "bun:test"
import { AddressGuard } from "./address-guard.js"

describe("AddressGuard.classify", () => {
  const kinds: ReadonlyArray<readonly [AddressGuard.Kind, ReadonlyArray<string>]> = [
    [
      "loopback",
      [
        "127.0.0.1",
        "127.255.255.254",
        // Unspecified addresses reach this machine too.
        "0.0.0.0",
        "0.1.2.3",
        "::",
        "::1",
        "[::1]",
        // Every spelling a URL accepts for 127.0.0.1.
        "2130706433",
        "0x7f.1",
        "0177.0.0.1",
        "127.1",
        "127.0.0.1.",
        // An IPv4 address inside an IPv6 one.
        "::ffff:127.0.0.1",
        "::FFFF:7F00:1",
        "0:0:0:0:0:ffff:7f00:1",
        "::127.0.0.1",
      ],
    ],
    [
      "private",
      [
        "10.0.0.1",
        "10.255.255.255",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.20",
        "100.64.0.1",
        "100.127.255.255",
        "198.18.0.1",
        "198.19.255.255",
        // The IETF protocol assignments, apart from 192.0.0.192 below.
        "192.0.0.0",
        "192.0.0.8",
        "192.0.0.191",
        "192.0.0.193",
        "192.0.0.255",
        "fc00::1",
        "fd12:3456:789a::1",
        "fec0::1",
        "::ffff:10.1.2.3",
        "::ffff:c0a8:101",
        // Next to the IPv6 metadata endpoints below, which are only these exact addresses of the unique local range.
        "fd00:ec2::253",
        "fd00:ec2::24",
        "fd00:ec2:1::254",
        "fd20:ce::253",
        "fd00:ce::254",
        "fd00:c1::a9fe:a9ff",
        "fd00:c1:1::a9fe:a9fe",
      ],
    ],
    [
      "link-local",
      ["169.254.0.1", "169.254.170.2", "169.254.169.253", "fe80::1", "febf::1", "fe80::1%eth0", "::ffff:169.254.0.1"],
    ],
    [
      "metadata",
      [
        "169.254.169.254",
        "[::ffff:169.254.169.254]",
        "::ffff:a9fe:a9fe",
        // Where AWS, Compute Engine and Oracle Cloud Infrastructure serve instance credentials over IPv6, and where the EKS
        // Pod Identity Agent serves its own. All of them are inside the unique local range, which is otherwise private.
        "fd00:ec2::254",
        "fd00:ec2::23",
        "fd20:ce::254",
        "fd00:c1::a9fe:a9fe",
        // The same addresses in the other spellings of an IPv6 literal.
        "[fd20:ce::254]",
        "FD20:CE:0:0:0:0:0:254",
        "fd00:0c1:0::a9fe:a9fe",
        "fd00:ec2::23%eth0",
        "100.100.100.200",
        "168.63.129.16",
        // Where Oracle Cloud Infrastructure Classic serves instance credentials, inside a range that is otherwise private.
        "192.0.0.192",
        "::ffff:192.0.0.192",
      ],
    ],
  ]

  for (const [kind, addresses] of kinds)
    for (const address of addresses)
      test(`${address} is ${kind}`, () => {
        expect(AddressGuard.classify(address)).toBe(kind)
      })

  // An IPv6 address that stands for an IPv4 one, in a form that a translator or a tunnel delivers to that IPv4 host, is
  // that host's kind, so that no form is a way past the IPv4 checks. A row is a form with the addresses that carry
  // 127.0.0.1, 10.0.0.1, 169.254.0.1 and 169.254.169.254 in it, in that order.
  const embeddings: ReadonlyArray<readonly [string, string, string, string, string]> = [
    // Mapped, compatible and translated (SIIT, RFC 2765) addresses carry it in their last 32 bits, and so does NAT64
    // (RFC 6052) with its well-known prefix.
    ["mapped", "::ffff:7f00:1", "::ffff:a00:1", "::ffff:a9fe:1", "::ffff:169.254.169.254"],
    ["compatible", "::7f00:1", "::a00:1", "::a9fe:1", "::a9fe:a9fe"],
    ["translated", "::ffff:0:7f00:1", "::ffff:0:a00:1", "::ffff:0:a9fe:1", "::ffff:0:169.254.169.254"],
    ["NAT64", "64:ff9b::7f00:1", "64:ff9b::a00:1", "64:ff9b::a9fe:1", "64:ff9b::169.254.169.254"],
    // 6to4 carries it in the 32 bits after its 2002::/16 prefix.
    ["6to4", "2002:7f00:1::", "2002:a00:1::", "2002:a9fe:1::", "2002:a9fe:a9fe::"],
    // Teredo (RFC 4380) carries the client's address in the last 32 bits, with every bit of it inverted.
    [
      "Teredo",
      "2001:0:4136:e378:8000:63bf:80ff:fffe",
      "2001:0:4136:e378:8000:63bf:f5ff:fffe",
      "2001:0:4136:e378:8000:63bf:5601:fffe",
      "2001:0:4136:e378:8000:63bf:5601:5601",
    ],
    // ISATAP (RFC 5214) carries it after a fixed interface identifier, under any prefix.
    [
      "ISATAP",
      "2001:db8::5efe:7f00:1",
      "2001:db8::5efe:a00:1",
      "2001:db8::200:5efe:a9fe:1",
      "2001:db8::200:5efe:a9fe:a9fe",
    ],
  ]

  for (const [form, ...addresses] of embeddings)
    test(`a ${form} address is the kind of the IPv4 address it carries`, () => {
      expect(addresses.map(AddressGuard.classify)).toEqual(["loopback", "private", "link-local", "metadata"])
    })

  test("takes a NAT64 address of the local-use prefix for private, and stricter when it carries such an address", () => {
    // The operator picks the length of the prefix used inside 64:ff9b:1::/48, which decides which bits of the address
    // hold the IPv4 address (RFC 6052, section 2.2). These carry 169.254.169.254 as a /96, /64, /56 and /48 prefix would.
    for (const address of [
      "64:ff9b:1::a9fe:a9fe",
      "64:ff9b:1:0:a9:fea9:fe00:0",
      "64:ff9b:1:a9:fe:a9fe::",
      "64:ff9b:1:a9fe:a9:fe00::",
    ])
      expect(AddressGuard.classify(address)).toBe("metadata")
    expect(AddressGuard.classify("64:ff9b:1::a9fe:1")).toBe("link-local")
    // The prefix is not routed beyond the local network, so even a public address in it is not a public one.
    for (const address of ["64:ff9b:1::", "64:ff9b:1::808:808", "64:ff9b:1::a00:1", "64:ff9b:1::7f00:1"])
      expect(AddressGuard.classify(address)).toBe("private")
  })

  test("takes the strictest kind when an address is one kind and carries another", () => {
    // Link-local by its prefix, and a metadata address by what it carries.
    expect(AddressGuard.classify("fe80::5efe:a9fe:a9fe")).toBe("metadata")
    // A configuration can allow loopback addresses but never link-local ones, so the strictest is the one reported.
    expect(AddressGuard.classify("fe80::5efe:7f00:1")).toBe("link-local")
  })

  test("leaves public addresses and names alone", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "172.15.255.255",
      "172.32.0.0",
      "192.169.0.1",
      "100.63.255.255",
      "100.128.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "169.253.255.255",
      // Next to 192.0.0.0/24, which is private.
      "191.255.255.255",
      "192.0.1.1",
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "2001:db8::1",
      // A public IPv4 address in each form that carries one is as public as it is itself.
      "::ffff:0:8.8.8.8",
      "64:ff9b::8.8.8.8",
      "2002:808:808::",
      "2001:0:4136:e378:8000:63bf:f7f7:f7f7",
      "2001:db8::5efe:808:808",
      // Next to the prefixes that carry one: only the /96 of 64:ff9b::/32, and 2001::/32 for Teredo.
      "64:ff9b:2::1",
      "2001:1::1",
      // A name stands for no address until it is resolved, localhost included.
      "example.com",
      "localhost",
      "metadata.google.internal",
      "not a host",
    ])
      expect(AddressGuard.classify(address)).toBeUndefined()
  })
})

describe("AddressGuard.check", () => {
  // A resolver that must not be reached: using it fails the call that did, and so the test.
  const unreachable = (): Promise<never> => {
    throw new Error("looked up")
  }

  test("refuses an address of every kind, naming the address and why", async () => {
    for (const [host, address, kind] of [
      ["127.0.0.1", "127.0.0.1", "loopback"],
      ["2130706433", "127.0.0.1", "loopback"],
      ["[::1]", "[::1]", "loopback"],
      ["10.0.0.5", "10.0.0.5", "private"],
      ["169.254.169.254", "169.254.169.254", "metadata"],
      ["192.0.0.192", "192.0.0.192", "metadata"],
      ["[64:ff9b::a9fe:a9fe]", "[64:ff9b::a9fe:a9fe]", "metadata"],
      ["2002:a9fe:a9fe::", "[2002:a9fe:a9fe::]", "metadata"],
      ["fe80::1", "[fe80::1]", "link-local"],
    ] as const)
      expect(await AddressGuard.check(host, { lookup: unreachable })).toEqual({ address, kind })
  })

  test("lets through the kinds it is told to allow, and no others", async () => {
    const allow = ["loopback", "private"] as const
    expect(await AddressGuard.check("127.0.0.1", { allow })).toBeUndefined()
    expect(await AddressGuard.check("192.168.1.2", { allow })).toBeUndefined()
    expect(await AddressGuard.check("[64:ff9b::7f00:1]", { allow })).toBeUndefined()
    expect(await AddressGuard.check("169.254.169.254", { allow })).toEqual({
      address: "169.254.169.254",
      kind: "metadata",
    })
    expect(await AddressGuard.check("169.254.1.1", { allow })).toEqual({ address: "169.254.1.1", kind: "link-local" })
    expect(await AddressGuard.check("169.254.169.254", { allow: ["metadata"] })).toBeUndefined()
  })

  test("keeps every address of a metadata endpoint closed to a configuration that allows local servers", async () => {
    const allow = ["loopback", "private"] as const
    for (const host of [
      "169.254.169.254",
      "192.0.0.192",
      "100.100.100.200",
      "[fd00:ec2::254]",
      "[fd00:ec2::23]",
      "[fd20:ce::254]",
      "[fd00:c1::a9fe:a9fe]",
      "[::ffff:a9fe:a9fe]",
      "[::ffff:0:a9fe:a9fe]",
      "[64:ff9b::a9fe:a9fe]",
      "[64:ff9b:1::a9fe:a9fe]",
      "[2002:a9fe:a9fe::]",
      "[2001:0:4136:e378:8000:63bf:5601:5601]",
    ])
      expect(await AddressGuard.check(host, { allow, lookup: unreachable })).toMatchObject({ kind: "metadata" })
  })

  test("lets a public address through", async () => {
    expect(await AddressGuard.check("8.8.8.8", { lookup: unreachable })).toBeUndefined()
    expect(await AddressGuard.check("[2606:4700:4700::1111]", { lookup: unreachable })).toBeUndefined()
    expect(await AddressGuard.check("[64:ff9b::808:808]", { lookup: unreachable })).toBeUndefined()
  })

  test("takes localhost and the names under it for loopback without asking a resolver", async () => {
    for (const host of ["localhost", "LOCALHOST.", "app.localhost", "a.b.localhost"])
      expect(await AddressGuard.check(host, { lookup: unreachable })).toEqual({
        address: "127.0.0.1",
        kind: "loopback",
      })
    expect(await AddressGuard.check("localhost", { allow: ["loopback"], lookup: unreachable })).toBeUndefined()
    // Only a label of its own: a name that ends in the same letters is an ordinary name.
    expect(await AddressGuard.check("notlocalhost", { lookup: async () => ["8.8.8.8"] })).toBeUndefined()
  })

  test("resolves a name and refuses it when any address it stands for is not public", async () => {
    const asked: string[] = []
    const lookup = async (name: string) => {
      asked.push(name)
      return name.startsWith("rebound") ? ["93.184.216.34", "10.1.2.3"] : ["93.184.216.34", "2606:2800:220:1::1"]
    }

    expect(await AddressGuard.check("rebound.example.com", { lookup })).toEqual({
      address: "10.1.2.3",
      kind: "private",
    })
    expect(await AddressGuard.check("rebound.example.com", { allow: ["private"], lookup })).toBeUndefined()
    expect(await AddressGuard.check("Example.COM.", { lookup })).toBeUndefined()
    // The name that is resolved is the one a URL would connect to, in lowercase and without its trailing dot.
    expect(asked).toEqual(["rebound.example.com", "rebound.example.com", "example.com"])
  })

  test("refuses a name that a resolver answers with an IPv6 address for a metadata endpoint", async () => {
    // What a DNS64 resolver makes of a name whose IPv4 address is the metadata endpoint's.
    const lookup = async () => ["2606:2800:220:1::1", "64:ff9b::a9fe:a9fe"]

    expect(await AddressGuard.check("synthesized.example.com", { lookup })).toEqual({
      address: "64:ff9b::a9fe:a9fe",
      kind: "metadata",
    })
  })

  test("does not refuse a name that does not resolve", async () => {
    const lookup = () => Promise.reject(new Error("no such host"))
    expect(await AddressGuard.check("gone.example.com", { lookup })).toBeUndefined()
    // The system resolver answers for a name that cannot exist, which takes as long as the network needs to say so.
    expect(await AddressGuard.check("orbit-address-guard.invalid")).toBeUndefined()
  }, 30_000)

  test("rejects what is not a host rather than taking it for an address that may be reached", async () => {
    for (const host of ["127.0.0.1:8080", "not a host", "", "localhost/x", "[::1"])
      await expect(AddressGuard.check(host, { lookup: unreachable })).rejects.toThrow("Not a host name or address")
  })
})
