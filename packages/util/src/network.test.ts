import { afterAll, describe, expect, test } from "bun:test"
import path from "node:path"
import { Network } from "./network.js"

const fixture = (name: string) => path.join(import.meta.dir, "..", "test", "fixture", "tls", name)
const read = (name: string) => Bun.file(fixture(name)).text()

// The server certificate is issued by a private test CA, so default trust rejects it.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: { cert: await read("server.pem"), key: await read("server.key") },
  fetch: () => new Response("server"),
})
// Mutual TLS: the client must present a certificate issued by the same CA.
const mutual = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls: {
    cert: await read("server.pem"),
    key: await read("server.key"),
    ca: await read("ca.pem"),
    requestCert: true,
    rejectUnauthorized: true,
  },
  fetch: () => new Response("mutual"),
})

afterAll(() => {
  server.stop(true)
  mutual.stop(true)
})

describe("Network", () => {
  test("is inactive without settings", () => {
    expect(Network.settings({})).toBeUndefined()
  })

  test("rejects a private CA by default and trusts it from ORBIT_CA_CERTS", async () => {
    const url = `https://127.0.0.1:${server.port}`
    await expect(fetch(url)).rejects.toThrow()

    const configured = Network.settings({ ORBIT_CA_CERTS: fixture("ca.pem") })
    if (!configured) throw new Error("Expected settings")
    expect(await (await Network.wrap(fetch, configured)(url)).text()).toBe("server")
  })

  test("keeps the default roots alongside a custom CA", () => {
    const seen: Array<BunFetchRequestInit | undefined> = []
    const base = Object.assign(async (_: Parameters<typeof fetch>[0], init?: BunFetchRequestInit) => {
      seen.push(init)
      return new Response()
    }, fetch)
    const configured = Network.settings({ ORBIT_CA_CERTS: fixture("ca.pem") })
    if (!configured) throw new Error("Expected settings")
    Network.wrap(base, configured)("https://example.invalid")

    const ca = seen[0]?.tls?.ca
    expect(Array.isArray(ca) && ca.length).toBeGreaterThan(1)
  })

  test("accepts the Tachyon SDK's CA variables", async () => {
    const url = `https://127.0.0.1:${server.port}`
    const pemText = await read("ca.pem")
    for (const env of [
      { TACHYON_CERT_PATH: fixture("ca.pem") },
      { TACHYON_CERT_B64: Buffer.from(pemText).toString("base64") },
      { TACHYON_CERT_B64: pemText },
    ]) {
      const configured = Network.settings(env)
      if (!configured) throw new Error("Expected settings")
      expect(await (await Network.wrap(fetch, configured)(url)).text()).toBe("server")
    }
  })

  test("presents a client certificate for mutual TLS", async () => {
    const url = `https://127.0.0.1:${mutual.port}`
    const trusted = Network.settings({ ORBIT_CA_CERTS: fixture("ca.pem") })
    if (!trusted) throw new Error("Expected settings")
    await expect(Network.wrap(fetch, trusted)(url)).rejects.toThrow()

    const configured = Network.settings({
      ORBIT_CA_CERTS: fixture("ca.pem"),
      ORBIT_CLIENT_CERT: fixture("client.pem"),
      ORBIT_CLIENT_KEY: fixture("client.key"),
      ORBIT_CLIENT_KEY_PASSPHRASE: "orbit-test",
    })
    if (!configured) throw new Error("Expected settings")
    expect(await (await Network.wrap(fetch, configured)(url)).text()).toBe("mutual")
  })

  test("names the variable whose file is missing", () => {
    expect(() => Network.settings({ ORBIT_CA_CERTS: fixture("missing.pem") })).toThrow("ORBIT_CA_CERTS")
    expect(() => Network.settings({ ORBIT_CLIENT_CERT: fixture("client.pem") })).toThrow(
      "ORBIT_CLIENT_CERT and ORBIT_CLIENT_KEY must be set together",
    )
  })
})
