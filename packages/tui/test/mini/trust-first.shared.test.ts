import type { OrbitClient, TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { createApi, json } from "../fixture/tui-client"

// The gate the build adds to the Mini, read by name so that this file compiles before it exists: until then every row
// fails with the error below, which is the missing gate.
const mini: Record<string, unknown> & {
  readonly trustRefusal?: (input: { sdk: OrbitClient; directory: string }) => Promise<string | undefined>
} = await import("../../src/mini/trust.shared")

// trust-first: nothing in the mini can ask the question, so `orb mini` is a headless door (class 12): in a folder that is
// not trusted it stops before it hands the terminal over, whatever the folder holds, says how to trust the folder, and
// exits 1. A server that cannot say, or does not answer in time, is a refusal too (class 7): before trust-first the mini
// said nothing and went on.
const status = (overrides: Partial<TrustStatus> = {}): TrustStatus => ({
  directory: "/projects/app",
  trusted: false,
  persistent: true,
  changed: [],
  withheld: [],
  ...overrides,
})

async function refusal(respond: () => Response | Promise<Response>) {
  const fetch = Object.assign(async () => respond(), { preconnect: () => {} })
  if (mini.trustRefusal === undefined)
    throw new Error("the Mini has no trust gate: mini/trust.shared has no trustRefusal")
  return mini.trustRefusal({ sdk: createApi(fetch), directory: "/projects/app/packages" })
}

test("refuses an untrusted folder that holds nothing back, and says how to trust it", async () => {
  const text = await refusal(() => json(status()))
  expect(text).toContain("/projects/app is not trusted")
  expect(text).toContain("`orb trust`")
})

test("refuses a home directory and points at the terminal UI, which can trust it until Orbit restarts", async () => {
  const text = await refusal(() => json(status({ directory: "/home/kit", persistent: false })))
  expect(text).toContain("/home/kit is not trusted")
  expect(text).toContain("start `orb`")
})

test("lets a trusted folder through: the control for the rows above and below", async () => {
  expect(await refusal(() => json(status({ trusted: true, source: "saved" })))).toBeUndefined()
})

test.each([
  ["a server older than workspace trust", () => new Response("not found", { status: 404 })],
  ["a server that fails", () => new Response("unavailable", { status: 503 })],
  ["an answer that is not a trust status", () => json({ hello: "world" })],
])("refuses when it cannot learn that the folder is trusted: %s", async (_, respond) => {
  const text = await refusal(respond)
  expect(text).toBeString()
  expect(text).toContain("/projects/app/packages")
})

// A server that takes the request and never answers is a refusal once the Mini stops waiting, two seconds on.
test("refuses when the server does not answer in time", async () => {
  const silent = Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
      }),
    { preconnect: () => {} },
  )
  if (mini.trustRefusal === undefined) throw new Error("the Mini has no trust gate")
  const started = Date.now()
  const text = await mini.trustRefusal({ sdk: createApi(silent), directory: "/projects/app/packages" })
  expect(text).toContain("/projects/app/packages")
  expect(Date.now() - started).toBeLessThan(10_000)
}, 15_000)

test("shows a folder whose name acts on a terminal without its control characters", async () => {
  const folder = "/work/inner\u001b]0;owned\u0007\u001b[2J"
  const text = await refusal(() => json(status({ directory: folder })))
  expect(text).toContain("/work/inner")
  expect(text).not.toContain("\u001b")
  expect(text).not.toContain("\u0007")
})
