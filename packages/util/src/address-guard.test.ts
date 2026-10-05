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
        "192.0.0.8",
        "fc00::1",
        "fd12:3456:789a::1",
        "fec0::1",
        "::ffff:10.1.2.3",
        "::ffff:c0a8:101",
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
        "fd00:ec2::254",
        "100.100.100.200",
        "168.63.129.16",
      ],
    ],
  ]

  for (const [kind, addresses] of kinds)
    for (const address of addresses)
      test(`${address} is ${kind}`, () => {
        expect(AddressGuard.classify(address)).toBe(kind)
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
      "2606:4700:4700::1111",
      "::ffff:8.8.8.8",
      "2001:db8::1",
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
      ["fe80::1", "[fe80::1]", "link-local"],
    ] as const)
      expect(await AddressGuard.check(host, { lookup: unreachable })).toEqual({ address, kind })
  })

  test("lets through the kinds it is told to allow, and no others", async () => {
    const allow = ["loopback", "private"] as const
    expect(await AddressGuard.check("127.0.0.1", { allow })).toBeUndefined()
    expect(await AddressGuard.check("192.168.1.2", { allow })).toBeUndefined()
    expect(await AddressGuard.check("169.254.169.254", { allow })).toEqual({
      address: "169.254.169.254",
      kind: "metadata",
    })
    expect(await AddressGuard.check("169.254.1.1", { allow })).toEqual({ address: "169.254.1.1", kind: "link-local" })
    expect(await AddressGuard.check("169.254.169.254", { allow: ["metadata"] })).toBeUndefined()
  })

  test("lets a public address through", async () => {
    expect(await AddressGuard.check("8.8.8.8", { lookup: unreachable })).toBeUndefined()
    expect(await AddressGuard.check("[2606:4700:4700::1111]", { lookup: unreachable })).toBeUndefined()
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
