import type { TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

const title = "Trust this folder?"

function untrusted(root: string): TrustStatus {
  return {
    directory: root,
    trusted: false,
    persistent: true,
    withheld: [{ path: `${root}/orbit.json`, kinds: ["hooks", "mcp"] }],
  }
}

test("Home asks about an untrusted folder once, and the indicator and /trust ask again", async () => {
  await using state = await tmpdir()
  let status = untrusted("/tmp/orbit")
  const updates: unknown[] = []
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url, request) => {
      if (url.pathname !== "/api/location/trust") return undefined
      if (request.method === "GET") return json(status)
      updates.push(await request.json())
      status = { ...status, trusted: true, source: "saved", withheld: [] }
      return json(status)
    },
  })

  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(title) && frame.includes("⊙ Untrusted"))

  // The indicator in the prompt's footer asks again.
  const lines = setup.captureCharFrame().split("\n")
  const row = lines.findIndex((line) => line.includes("⊙ Untrusted"))
  await setup.mockMouse.click(lines[row]!.indexOf("⊙ Untrusted"), row)
  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes(title))

  // So does the command, which is offered only while there is something to trust.
  await setup.mockInput.typeText("/trust")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => frame.includes(title))
  expect(updates).toEqual([])

  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(title) && !frame.includes("⊙ Untrusted"))
  expect(updates).toEqual([{ trust: true, persist: true }])
})

// Config in a folder above the project is turned on by that folder's own trust, so trusting the project would not.
const above = { path: "/tmp/orbit.json", kinds: ["hooks"], directory: "/tmp" }

test.each([
  ["a trusted folder", { ...untrusted("/tmp/orbit"), trusted: true, source: "saved", withheld: [] }],
  ["a trusted folder with config above it held back", { ...untrusted("/tmp/orbit"), trusted: true, withheld: [above] }],
  ["an untrusted folder whose only held-back config is above it", { ...untrusted("/tmp/orbit"), withheld: [above] }],
])("%s is not asked about and has no indicator", async (_, answer) => {
  await using state = await tmpdir()
  let reads = 0
  await using setup = await createAppFixture({
    state: state.path,
    fetch: (url) => {
      if (url.pathname !== "/api/location/trust") return undefined
      reads++
      return json(answer)
    },
  })

  await setup.waitFor(() => reads > 0)
  await setup.waitForFrame((frame) => frame.includes("Ask anything"))
  await setup.flush()

  expect(setup.captureCharFrame()).not.toContain(title)
  expect(setup.captureCharFrame()).not.toContain("Untrusted")
})

test("a session is asked about for its own folder, which is not the one the terminal UI started in", async () => {
  await using state = await tmpdir()
  const elsewhere = "/elsewhere/app"
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: "ses_elsewhere",
    title: "Work somewhere else",
    projectID: "project",
    location: { directory: elsewhere },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const asked: string[] = []
  await using setup = await createAppFixture({
    state: state.path,
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: (url) => {
      if (url.pathname === "/api/location/trust") {
        const folder = url.searchParams.get("location[directory]") ?? ""
        asked.push(folder)
        return json(
          folder === elsewhere
            ? untrusted(elsewhere)
            : { directory: folder, trusted: true, persistent: true, source: "saved", withheld: [] },
        )
      }
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      return undefined
    },
  })

  const frame = await setup.waitForFrame((frame) => frame.includes(title))

  expect(frame).toContain(elsewhere)
  expect(asked).toContain(directory)
  expect(asked).toContain(elsewhere)
})
