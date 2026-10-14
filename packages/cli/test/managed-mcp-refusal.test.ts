import { expect, test } from "bun:test"
import { Effect } from "effect"
import type { OrbitClient } from "@orbit/client/promise"
import { mcpConfigRefusal, MANAGED_MCP_MESSAGE } from "../src/util/managed-mcp"

// A server that cannot say whether --mcp-config servers are allowed counts as refusing (class 7).
const server = (effective: () => Promise<unknown>) => ({ config: { effective } }) as unknown as OrbitClient

const refusal = (client: OrbitClient, named = true) => Effect.runPromise(mcpConfigRefusal(client, "/project", named))

for (const row of [
  { name: "an old server that reports nothing", reply: () => Promise.resolve({}), expected: /does not report it/ },
  {
    name: "a server that answers without a managed_only flag",
    reply: () => Promise.resolve({ mcp: {} }),
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

test("refuses when the server says managed settings run only their own servers and allows when it says not", async () => {
  expect(await refusal(server(() => Promise.resolve({ mcp: { managed_only: true } })))).toBe(MANAGED_MCP_MESSAGE)
  expect(await refusal(server(() => Promise.resolve({ mcp: { managed_only: false } })))).toBeUndefined()
})

test("asks nothing when no server was named", async () => {
  let asked = false
  const client = server(() => {
    asked = true
    return Promise.resolve({})
  })
  expect(await refusal(client, false)).toBeUndefined()
  expect(asked).toBe(false)
})
