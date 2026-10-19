import type { TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

const title = "Trust this folder?"
// Whether the question is on screen and asks about the folder, which is what its first line names.
const asksAbout = (frame: string, folder: string) => frame.includes(title) && frame.includes(`⊙ Untrusted  ${folder}`)

function untrusted(root: string): TrustStatus {
  return {
    directory: root,
    trusted: false,
    persistent: true,
    changed: [],
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
      status = { ...status, trusted: true, source: "saved", withheld: [], changed: [] }
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
  ["a trusted folder", { ...untrusted("/tmp/orbit"), trusted: true, source: "saved", withheld: [], changed: [] }],
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

// A session that works in `folder`, and what the server answers about it, for a terminal UI started in `directory`.
// `released` keeps the session itself back until it is resolved.
function sessionIn(folder: string, released?: Promise<void>) {
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const session = {
    id: "ses_elsewhere",
    title: "Work somewhere else",
    projectID: "project",
    location: { directory: folder },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const serve: FetchHandler = async (url) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/session" || url.pathname === `/api/session/${session.id}`) await released
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
    if (url.pathname === "/api/agent")
      return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
    if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
    if (url.pathname === "/api/model")
      return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
    return undefined
  }
  return { session, serve }
}

test("a session is asked about for its own folder, which is not the one the terminal UI started in", async () => {
  await using state = await tmpdir()
  const elsewhere = "/elsewhere/app"
  const { session, serve } = sessionIn(elsewhere)
  const asked: string[] = []
  await using setup = await createAppFixture({
    state: state.path,
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: (url, request) => {
      if (url.pathname !== "/api/location/trust") return serve(url, request)
      const folder = url.searchParams.get("location[directory]") ?? ""
      asked.push(folder)
      return json(
        folder === elsewhere
          ? untrusted(elsewhere)
          : { directory: folder, trusted: true, persistent: true, source: "saved", withheld: [], changed: [] },
      )
    },
  })

  const frame = await setup.waitForFrame((frame) => frame.includes(title))

  expect(frame).toContain(elsewhere)
  expect(asked).toContain(directory)
  expect(asked).toContain(elsewhere)
})

test("the question about the folder the terminal UI started in is not answered for the folder of a session that opens", async () => {
  await using state = await tmpdir()
  const elsewhere = "/elsewhere/other-clone"
  const opened = Promise.withResolvers<void>()
  const answered = Promise.withResolvers<void>()
  const { session, serve } = sessionIn(elsewhere, opened.promise)
  const grants: unknown[] = []
  const trusted = new Set<string>()
  const status = (folder: string): TrustStatus =>
    trusted.has(folder)
      ? { directory: folder, trusted: true, persistent: true, source: "saved", withheld: [], changed: [] }
      : untrusted(folder)
  await using setup = await createAppFixture({
    state: state.path,
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname !== "/api/location/trust") return serve(url, request)
      const folder = url.searchParams.get("location[directory]") ?? ""
      if (request.method === "POST") {
        grants.push({ directory: folder, ...((await request.json()) as object) })
        trusted.add(folder)
        return json(status(folder))
      }
      // The server has not yet said what holds back in the session's folder.
      if (folder === elsewhere) await answered.promise
      return json(status(folder))
    },
  })

  // The folder the terminal UI started in is asked about while the session is still being fetched.
  await setup.waitForFrame((frame) => asksAbout(frame, directory))
  opened.resolve()

  // Once the session's folder is in view the question about the first one is no longer the one on screen, so nothing
  // chosen now can be taken for an answer about the folder that is.
  await setup.waitForFrame((frame) => !frame.includes(title))
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await setup.renderOnce()
  expect(grants).toEqual([])

  answered.resolve()
  await setup.waitForFrame((frame) => asksAbout(frame, elsewhere))
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await setup.waitForFrame((frame) => !frame.includes(title))
  expect(grants).toEqual([{ directory: elsewhere, trust: true, persist: true }])
})

// An orbit.json that only rewrites the text of an agent that exists is reported with the kind `permissions` (core
// `ProjectTrust.status`), and that is enough for the question to open: before, the status listed nothing for it.
test("Home asks about a folder whose only held-back config is agent text", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url, request) => {
      if (url.pathname !== "/api/location/trust" || request.method !== "GET") return undefined
      return json({
        directory: "/tmp/orbit",
        trusted: false,
        persistent: true,
        changed: [],
        withheld: [{ path: "/tmp/orbit/orbit.json", kinds: ["permissions"] }],
      } satisfies TrustStatus)
    },
  })
  await setup.waitForFrame((frame) => asksAbout(frame, "/tmp/orbit"))
})
