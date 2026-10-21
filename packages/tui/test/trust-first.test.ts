import type { TrustStatus } from "@orbit/client"
import { expect, test } from "bun:test"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json, type FetchHandler } from "./fixture/tui-client"

// trust-first: as the reference does, the terminal UI asks about the folder it starts in whenever that folder is not
// trusted, whatever the folder holds, before the person can work there, and offers two answers: trust it, or leave. The
// question lists nothing from the folder, because nothing was read. Leaving ends the terminal UI and grants nothing.
// These draw the real app against a scripted server that holds nothing back for the folder, where before trust-first
// nothing was asked at all.
const title = "Trust this folder?"
const root = "/tmp/orbit"

// An untrusted folder that holds nothing back: the case the old question never opened for.
const clean = (folder: string): TrustStatus => ({
  directory: folder,
  trusted: false,
  persistent: true,
  changed: [],
  withheld: [],
})
const trusted = (folder: string): TrustStatus => ({
  directory: folder,
  trusted: true,
  persistent: true,
  source: "saved",
  changed: [],
  withheld: [],
})

// A server that answers the trust routes for `answer` and records the grants it is asked for.
function trustServer(answer: (folder: string) => TrustStatus) {
  const grants: unknown[] = []
  const granted = new Set<string>()
  const fetch: FetchHandler = async (url, request) => {
    if (url.pathname !== "/api/location/trust") return undefined
    const folder = url.searchParams.get("location[directory]") ?? ""
    if (request.method === "POST") {
      grants.push(await request.json())
      granted.add(folder)
    }
    return json(granted.has(folder) ? trusted(root) : answer(folder))
  }
  return { grants, fetch }
}

test("the folder the terminal UI starts in is asked about when it holds nothing back, with a choice to trust it or exit", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => clean(root))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  const frame = await setup.waitForFrame((frame) => frame.includes(title))

  expect(frame).toContain(root)
  // It says what trusting the folder lets Orbit do there.
  expect(frame).toContain("can read, change and run")
  expect(frame).toContain("Trust this folder")
  expect(frame).toContain("Exit")
  // There is no answer that leaves the folder untrusted and carries on.
  expect(frame).not.toContain("Not now")
  // Nothing from the folder is listed, because nothing was read.
  expect(frame).not.toContain("Orbit is leaving out")
})

test("choosing Exit ends the terminal UI and grants nothing", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => clean(root))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()

  await setup.waitFor(() => setup.renderer.isDestroyed)
  expect(server.grants).toEqual([])
})

test("Escape on the question ends the terminal UI as well", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => clean(root))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressEscape()

  await setup.waitFor(() => setup.renderer.isDestroyed)
  expect(server.grants).toEqual([])
})

test("choosing Trust this folder trusts it for good, and the question does not come back", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => clean(root))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressEnter()

  await setup.waitForFrame((frame) => !frame.includes(title) && frame.includes("Ask anything"))
  expect(server.grants).toEqual([{ trust: true, persist: true }])
  expect(setup.renderer.isDestroyed).toBe(false)
})

test("a home directory is offered trust until Orbit restarts, or exit", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => ({ ...clean(root), persistent: false }))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  const frame = await setup.waitForFrame((frame) => frame.includes(title))

  expect(frame).toContain("Trust until Orbit restarts")
  expect(frame).toContain("Exit")
  expect(frame).not.toContain("Not now")
})

// A session the terminal UI opens can work in a folder other than the one it started in. That folder is asked about as
// well, but leaving would end the person's other work, so declining it closes the question and keeps the terminal UI.
function sessionIn(folder: string): FetchHandler {
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
  return async (url) => {
    if (url.pathname === "/api/fs/list") return json({ location, data: [] })
    if (url.pathname === "/api/location") return json(location)
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
}

test("a session in another folder that holds nothing back is asked about, and declining keeps the terminal UI open", async () => {
  await using state = await tmpdir()
  const elsewhere = "/elsewhere/app"
  const serve = sessionIn(elsewhere)
  const grants: unknown[] = []
  await using setup = await createAppFixture({
    state: state.path,
    args: { sessionID: "ses_elsewhere" },
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname !== "/api/location/trust") return serve(url, request)
      const folder = url.searchParams.get("location[directory]") ?? ""
      if (request.method === "POST") grants.push(await request.json())
      return json(folder === elsewhere ? clean(elsewhere) : trusted(folder))
    },
  })

  const frame = await setup.waitForFrame((frame) => frame.includes(title) && frame.includes(elsewhere))
  expect(frame).toContain("Not now")
  expect(frame).not.toContain("Exit")

  setup.mockInput.pressEscape()
  await setup.waitForFrame((frame) => !frame.includes(title))
  expect(setup.renderer.isDestroyed).toBe(false)
  expect(grants).toEqual([])
})

// Class 7: a trust read that fails says nothing about the folder, so the question opens anyway and names the folder it
// asked about. The server refuses work there whatever the terminal UI shows.
test("when the trust read fails, the question opens anyway and names the folder it asked about", async () => {
  await using state = await tmpdir()
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url) =>
      url.pathname === "/api/location/trust" ? new Response("unavailable", { status: 503 }) : undefined,
  })

  const frame = await setup.waitForFrame((frame) => frame.includes(title))

  expect(frame).toContain(directory)
  expect(frame).toContain("Exit")
})

// The reference's question has a key of its own for "no", which leaves with status 0 where Exit and Escape leave with 1.
test("the n key on the question ends the terminal UI and grants nothing", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => clean(root))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressKey("n")

  await setup.waitFor(() => setup.renderer.isDestroyed)
  expect(server.grants).toEqual([])
})
