import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { json } from "./fixture/tui-client"

const location = {
  directory: "/tmp/orbit/packages/tui",
  project: { id: "project", directory: "/tmp/orbit", canonical: "/tmp/orbit" },
}

test.each([
  { name: "ordinary", title: "Fix the build", shown: "Fix the build" },
  { name: "hostile", title: "Fix\x1b[2Kbuild‮evil", shown: "Fix\\x1b[2Kbuild\\u{202e}evil" },
])("the title of a session opened with --session is drawn safely: $name", async (row) => {
  const session = {
    id: "ses_resumed",
    projectID: "project",
    title: row.title,
    location: { directory: location.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  await using setup = await createAppFixture({
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: async (url) => {
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "demo", name: "Demo" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "demo", name: "Demo Model", variants: [] }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      return undefined
    },
  })
  await setup.ready
  await setup.waitForFrame((frame) => frame.includes(row.shown))
  const frame = setup.captureCharFrame()
  expect(frame).not.toContain("\x1b")
  expect(frame).not.toContain("‮")
})
