import { afterEach, expect, spyOn, test } from "bun:test"
import { Effect } from "effect"
import type { OrbitClient } from "@orbit/client/promise"
import { bypassDecision, MANAGED_BYPASS_NOTICE, printBypassNotice } from "../src/util/managed-bypass"

// Managed settings that turn the mode off, and a server that cannot say, drop the mode with a notice. Dropping it is
// never wider than the request (class 7): the run keeps asking, and a question nobody can answer is declined.
const server = (effective: () => Promise<unknown>) => ({ config: { effective } }) as unknown as OrbitClient

const decide = (client: OrbitClient, requested = true) =>
  Effect.runPromise(bypassDecision(client, "/project", requested))

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
  test(`drops the mode with a notice on ${row.name}`, async () => {
    const decision = await decide(server(row.reply))
    expect(decision.auto).toBe(false)
    expect(decision.notice).toMatch(row.expected)
    expect(decision.notice).toMatch(/ignored/)
  })
}

test("drops the mode when the server says bypass is off, and keeps it when it says on", async () => {
  expect(await decide(server(() => Promise.resolve({ permissions: { bypass: false } })))).toEqual({
    auto: false,
    notice: MANAGED_BYPASS_NOTICE,
  })
  expect(await decide(server(() => Promise.resolve({ permissions: { bypass: true } })))).toEqual({
    auto: true,
    notice: undefined,
  })
})

test("asks nothing when the mode was not requested", async () => {
  let asked = false
  const client = server(() => {
    asked = true
    return Promise.resolve({})
  })
  expect(await decide(client, false)).toEqual({ auto: false, notice: undefined })
  expect(asked).toBe(false)
})

const printed = () => {
  const out: string[] = []
  const err: string[] = []
  spyOn(process.stdout, "write").mockImplementation(((text: string) => (out.push(String(text)), true)) as never)
  spyOn(process.stderr, "write").mockImplementation(((text: string) => (err.push(String(text)), true)) as never)
  return { out, err }
}

afterEach(() => {
  ;(process.stdout.write as unknown as { mockRestore?: () => void }).mockRestore?.()
  ;(process.stderr.write as unknown as { mockRestore?: () => void }).mockRestore?.()
})

test.each([
  ["text output", undefined, false, "err"],
  ["the default format", "default", false, "err"],
  ["a single result", "result", false, "err"],
  ["json lines", "json", false, "out"],
  ["stream-json lines", "stream-json", false, "out"],
  ["the result envelope", "stream-json", true, "err"],
] as const)("prints the notice once for %s", (_, format, envelope, stream) => {
  const written = printed()
  printBypassNotice("A notice.", format, envelope)
  expect(written[stream]).toHaveLength(1)
  expect(written[stream === "out" ? "err" : "out"]).toEqual([])
  if (stream === "out") expect(JSON.parse(written.out[0]!)).toMatchObject({ type: "warning", message: "A notice." })
})

test("prints nothing when there is no notice", () => {
  const written = printed()
  printBypassNotice(undefined, "json")
  expect(written).toEqual({ out: [], err: [] })
})
