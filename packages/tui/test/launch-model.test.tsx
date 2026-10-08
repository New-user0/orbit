import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

const location = {
  directory: "/tmp/orbit/packages/tui",
  project: { id: "project", directory: "/tmp/orbit", canonical: "/tmp/orbit" },
}

// Both models have variants, so a model lost to the default one shows in the footer and in the request.
async function launch(model: string) {
  const sent: { path: string; body: unknown }[] = []
  const setup = await createAppFixture({
    args: { model },
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({
          location,
          data: ["first", "second"].map((id) => ({
            id,
            providerID: "demo",
            name: `Demo ${id}`,
            variants: [{ id: "low" }, { id: "high" }],
          })),
        })
      if (request.method === "POST" && url.pathname === "/api/session") {
        const record: { id?: string } = await request.json()
        sent.push({ path: url.pathname, body: record })
        return json({
          data: {
            ...record,
            location: { directory: location.directory },
            projectID: "project",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          },
        })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (request.method !== "GET" && /^\/api\/session\//.test(url.pathname)) {
        sent.push({ path: url.pathname, body: await request.json().catch(() => undefined) })
        return new Response(null, { status: 204 })
      }
      return undefined
    },
  })
  return { setup, sent }
}

test.each([
  { model: "demo/second", variant: undefined },
  { model: "demo/second#high", variant: "high" },
  { model: "demo/second#missing", variant: undefined },
])("--model $model selects that model and its variant", async (row) => {
  const run = await launch(row.model)
  await using setup = run.setup
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes("Demo second"))
  if (row.variant) await setup.waitForFrame((frame) => frame.includes(`· ${row.variant}`))
  await setup.mockInput.typeText("hello")
  setup.mockInput.pressEnter()
  await setup.waitFor(() => run.sent.some((item) => item.path.endsWith("/prompt")))
  const bodies = JSON.stringify(run.sent.map((item) => item.body))
  expect(bodies).toContain('"id":"second"')
  expect(bodies).not.toContain('"id":"first"')
  expect(bodies.includes('"variant":"high"')).toBe(row.variant === "high")
})
