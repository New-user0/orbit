import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { OrbitClient } from "@orbit/client/promise"
import { bypassRefusal, MANAGED_BYPASS_MESSAGE } from "../src/util/managed-bypass"

// A server that cannot say whether skipping prompts is allowed counts as refusing (class 7).
const server = (effective: () => Promise<unknown>) => ({ config: { effective } }) as unknown as OrbitClient

const refusal = (client: OrbitClient, requested = true) =>
  Effect.runPromise(bypassRefusal(client, "/project", requested))

for (const row of [
  { name: "an old server that reports nothing", reply: () => Promise.resolve({}), expected: /does not report it/ },
  {
    name: "a server that answers without a bypass flag",
    reply: () => Promise.resolve({ permissions: {} }),
    expected: /does not report it/,
  },
  {
    name: "a request that fails",
    reply: () => Promise.reject(new Error("offline")),
    expected: /Cannot confirm.*offline/,
  },
]) {
  test(`refuses on ${row.name}`, async () => {
    expect(await refusal(server(row.reply))).toMatch(row.expected)
  })
}

test("refuses when the server says bypass is off and allows when it says on", async () => {
  expect(await refusal(server(() => Promise.resolve({ permissions: { bypass: false } })))).toBe(MANAGED_BYPASS_MESSAGE)
  expect(await refusal(server(() => Promise.resolve({ permissions: { bypass: true } })))).toBeUndefined()
})

test("asks nothing when the mode was not requested", async () => {
  let asked = false
  const client = server(() => {
    asked = true
    return Promise.resolve({})
  })
  expect(await refusal(client, false)).toBeUndefined()
  expect(asked).toBe(false)
})
