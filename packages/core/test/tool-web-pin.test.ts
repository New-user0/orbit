import { describe, expect, test } from "bun:test"
import net from "node:net"
import { WebPin } from "../src/tool/web-pin"

// `notConnected` decides whether a request may go to the next address of a name, so it must say yes only when nothing
// reached the address. The codes are the ones Bun's fetch rejects with.
describe("WebPin.notConnected", () => {
  test("is true for a fetch to an address where nothing listens", async () => {
    const server = net.createServer().listen(0, "127.0.0.1")
    await new Promise((resolve) => server.once("listening", resolve))
    const port = (server.address() as net.AddressInfo).port
    await new Promise((resolve) => server.close(resolve))

    const error = await fetch(`http://127.0.0.1:${port}/a`).catch((error: unknown) => error)
    // Bun 1.4.2 says ConnectionRefused, 1.4.5 ECONNREFUSED.
    expect(String((error as { code?: unknown }).code)).toMatch(/^(ECONNREFUSED|ConnectionRefused)$/)
    expect(WebPin.notConnected(error)).toBeTrue()
  })

  test("is false for a fetch whose connection closed after it was made", async () => {
    const server = net.createServer((socket) => socket.destroy()).listen(0, "127.0.0.1")
    await new Promise((resolve) => server.once("listening", resolve))
    const port = (server.address() as net.AddressInfo).port

    const error = await fetch(`http://127.0.0.1:${port}/a`).catch((error: unknown) => error)
    server.close()
    expect(error).toMatchObject({ code: "ECONNRESET" })
    expect(WebPin.notConnected(error)).toBeFalse()
  })

  test.each([
    ["ECONNREFUSED", true],
    ["ENETUNREACH", true],
    ["EHOSTUNREACH", true],
    ["EADDRNOTAVAIL", true],
    ["FailedToOpenSocket", true],
    ["ConnectionRefused", true],
    ["ECONNRESET", false],
    ["ETIMEDOUT", false],
    ["EPROTO", false],
  ])("a fetch error with the code %s means nothing was sent: %p", (code, expected) => {
    expect(WebPin.notConnected(Object.assign(new TypeError(`${code}: failed`), { code }))).toBe(expected)
  })

  test("is false for an error that is not fetch's", () => {
    expect(WebPin.notConnected(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }))).toBeFalse()
  })
})
