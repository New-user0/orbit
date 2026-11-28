import { Orbit } from "@orbit/client/promise"
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { trustRefusal } from "../src/util/trust"

// The door's decision in this process, against a server that answers with a trust status: a folder that is not trusted
// stops the command whatever it holds, because nothing of it was read and no work starts there (trust-first, class 12),
// and a trusted one goes ahead with nothing to say. `trust.test.ts` runs the same doors as separate processes against a
// real server; this pins the decision itself.
let answer: Record<string, unknown> = {}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/api/location/trust") return new Response("not found", { status: 404 })
    return Response.json({
      directory: url.searchParams.get("location[directory]") ?? "",
      persistent: true,
      withheld: [],
      changed: [],
      ...answer,
    })
  },
})

afterAll(() => server.stop(true))

const client = Orbit.make({ baseUrl: server.url.origin })
const folder = process.platform === "win32" ? "C:\\work\\clone" : "/work/clone"

test("a folder that is not trusted stops the command, though it holds nothing back", async () => {
  answer = { trusted: false }
  const text = await Effect.runPromise(trustRefusal(client, folder))
  expect(text).toContain(folder)
  expect(text).toContain("orb trust")
})

test("a trusted folder lets the command go ahead: the control", async () => {
  answer = { trusted: true, source: "saved" }
  expect(await Effect.runPromise(trustRefusal(client, folder))).toBeUndefined()
})
