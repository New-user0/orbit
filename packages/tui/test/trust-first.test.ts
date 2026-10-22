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
  withheld: [],
})
const trusted = (folder: string): TrustStatus => ({
  directory: folder,
  trusted: true,
  persistent: true,
  source: "saved",
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
  // It asks whether the person knows where the folder came from, and says what trusting it lets Orbit do there.
  expect(frame).toContain("Do you know where this folder came from?")
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
  await setup.ended
  expect(server.grants).toEqual([])
  // As the reference's Exit does, `orb` ends with status 1.
  expect(process.exitCode).toBe(1)
})

test("Escape on the question ends the terminal UI as well", async () => {
  await using state = await tmpdir()
  const server = trustServer(() => clean(root))
  await using setup = await createAppFixture({ state: state.path, fetch: server.fetch })

  await setup.waitForFrame((frame) => frame.includes(title))
  setup.mockInput.pressEscape()

  await setup.waitFor(() => setup.renderer.isDestroyed)
  await setup.ended
  expect(server.grants).toEqual([])
  expect(process.exitCode).toBe(1)
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
  // A status other than the one the n key leaves, so that the 0 below is the terminal UI's own.
  process.exitCode = 1
  setup.mockInput.pressKey("n")

  await setup.waitFor(() => setup.renderer.isDestroyed)
  await setup.ended
  expect(server.grants).toEqual([])
  expect(process.exitCode).toBe(0)
})

// Waits up to ten seconds for a frame, for the rows below whose reads are held or time out: `waitForFrame` gives up
// after twenty passes.
async function frameWhere(setup: { captureCharFrame: () => string }, predicate: (frame: string) => boolean) {
  await within(
    () => predicate(setup.captureCharFrame()),
    () => `no frame came that matched:
${setup.captureCharFrame()}`,
  )
  return setup.captureCharFrame()
}

async function within(predicate: () => boolean, failure: () => string) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (predicate()) return
    await Bun.sleep(20)
  }
  throw new Error(failure())
}

// As the reference asks before it draws anything that takes input, Home's prompt takes no keys until the folder's trust
// is read and, when the folder is not trusted, answered. So nothing typed while the read is under way is sent, and an
// Enter typed ahead cannot answer the question, which starts on Trust.
test("typing ahead into Home before the question opens, and Enter as it opens, sends nothing and trusts nothing", async () => {
  await using state = await tmpdir()
  const grants: unknown[] = []
  const created: unknown[] = []
  const release = Promise.withResolvers<void>()
  // The start folder's reads, the ones the plugin loader waits for, answer at once, so Home is drawn; the reads of the
  // folder in view wait until the person has typed, and the first of them presses Enter just before it answers. The test
  // sets the key once the app is drawn. The two are told apart by folder, because two reads made in the same moment can
  // reach the server in either order.
  const keys = { enter: () => {}, entered: false }
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url, request) => {
      if (url.pathname === "/api/session" && request.method === "POST") created.push(await request.json())
      if (url.pathname !== "/api/location/trust") return undefined
      if (request.method === "POST") {
        grants.push(await request.json())
        return json(trusted(root))
      }
      if (url.searchParams.get("location[directory]") !== directory) return json(clean(root))
      await release.promise
      if (!keys.entered) {
        keys.entered = true
        keys.enter()
      }
      return json(clean(root))
    },
  })
  keys.enter = () => setup.mockInput.pressEnter()

  const home = await frameWhere(setup, (frame) => frame.includes("Welcome back."))
  expect(home).not.toContain("Ask anything")
  expect(home).not.toContain(title)
  await setup.mockInput.typeText("fix the bug")
  setup.mockInput.pressEnter()
  release.resolve()

  const frame = await frameWhere(setup, (frame) => frame.includes(title))
  await Bun.sleep(300)
  expect(keys.entered).toBe(true)
  expect(frame).not.toContain("fix the bug")
  expect(setup.captureCharFrame()).toContain(title)
  expect(grants).toEqual([])
  expect(created).toEqual([])
}, 15_000)

test("a slow trust read keeps Home's prompt closed, and a trusted folder's prompt opens and takes typing", async () => {
  await using state = await tmpdir()
  const release = Promise.withResolvers<void>()
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url) => {
      if (url.pathname !== "/api/location/trust") return undefined
      // The start folder's reads let Home be drawn; those of the folder in view are slow. They are told apart by folder,
      // because two reads made in the same moment can reach the server in either order.
      if (url.searchParams.get("location[directory]") === directory) await release.promise
      return json(trusted(root))
    },
  })

  const waiting = await frameWhere(setup, (frame) => frame.includes("Welcome back."))
  expect(waiting).not.toContain("Ask anything")
  await setup.mockInput.typeText("early")
  release.resolve()

  const open = await frameWhere(setup, (frame) => frame.includes("Ask anything"))
  expect(open).not.toContain("early")
  expect(open).not.toContain(title)
  await setup.mockInput.typeText("hello there")
  await frameWhere(setup, (frame) => frame.includes("hello there"))
}, 15_000)

// Class 7: a read that fails, does not decode or does not come back in time stands for a folder that is not trusted, so
// the question opens and the prompt stays closed behind it.
test.each([
  ["fails", () => new Response("unavailable", { status: 503 })],
  ["does not decode", () => json({ directory: 7 })],
  ["does not come back in time", () => new Promise<Response>(() => {})],
])(
  "a trust read that %s keeps Home's prompt closed",
  async (_, answer) => {
    await using state = await tmpdir()
    await using setup = await createAppFixture({
      state: state.path,
      fetch: async (url) => (url.pathname === "/api/location/trust" ? answer() : undefined),
    })

    const frame = await frameWhere(setup, (frame) => frame.includes(title))
    expect(frame).toContain("Exit")
    expect(frame).not.toContain("Ask anything")
  },
  15_000,
)

// A question that opens once the prompt takes typing, such as after `orb trust --revoke` in another terminal, can meet an
// Enter meant for the prompt, so it starts on Exit, and that Enter trusts nothing.
test("a question about the start folder that opens after the prompt opened does not start on Trust", async () => {
  await using state = await tmpdir()
  const grants: unknown[] = []
  const answer = { status: trusted(root) }
  await using setup = await createAppFixture({
    state: state.path,
    fetch: async (url, request) => {
      if (url.pathname !== "/api/location/trust") return undefined
      if (request.method === "POST") grants.push(await request.json())
      return json(answer.status)
    },
  })

  await frameWhere(setup, (frame) => frame.includes("Ask anything"))
  answer.status = clean(root)
  setup.events.emit({ id: "evt_trust", created: 1, type: "trust.updated", data: { directory: root, trusted: false } })
  await frameWhere(setup, (frame) => frame.includes(title))
  setup.mockInput.pressEnter()

  await setup.waitFor(() => setup.renderer.isDestroyed)
  await setup.ended
  expect(grants).toEqual([])
}, 15_000)

// `--prompt` is sent by the route once everything it needs is there, which now includes the folder's trust: sent before,
// the closed prompt would drop it.
test("a --prompt on Home waits for the start folder to be trusted, and is sent once it is", async () => {
  await using state = await tmpdir()
  const cwd = process.cwd()
  const location = { directory: cwd, project: { id: "project", directory: cwd, canonical: cwd } }
  const bodies: unknown[] = []
  const store: { granted: boolean; session?: Record<string, unknown> } = { granted: false }
  await using setup = await createAppFixture({
    state: state.path,
    args: { prompt: "HOME_AFTER_TRUST" },
    config: { animations: false, tabs: { mode: "off" } },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location/trust") {
        if (request.method === "POST") store.granted = true
        return json(store.granted ? trusted(cwd) : clean(cwd))
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/session" && request.method === "POST") {
        store.session = {
          ...(await request.json()),
          projectID: "project",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 0, updated: 0 },
        }
        return json({ data: store.session })
      }
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        bodies.push(await request.json())
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (store.session && /^\/api\/session\/[^/]+$/.test(url.pathname)) return json({ data: store.session })
      return undefined
    },
  })

  await frameWhere(setup, (frame) => frame.includes(title))
  await Bun.sleep(300)
  expect(bodies).toEqual([])
  setup.mockInput.pressEnter()

  await within(
    () => bodies.length > 0,
    () => "the prompt was not sent",
  )
  await Bun.sleep(50)
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ text: "HOME_AFTER_TRUST" })
}, 15_000)

// The same holds for a session the terminal UI opens, and for its `--prompt`: they wait for its folder's trust to be read.
test("a session's prompt takes no keys, and its --prompt waits, until its folder's trust is read", async () => {
  await using state = await tmpdir()
  const cwd = process.cwd()
  // The terminal UI starts in a folder of its own, and the session works in the server's folder, so that the start
  // folder's reads are told apart from the session's by folder: two reads made in the same moment can reach the server
  // in either order.
  await using start = await tmpdir()
  process.chdir(start.path)
  await using _restore = { [Symbol.asyncDispose]: async () => process.chdir(cwd) }
  const location = { directory: cwd, project: { id: "project", directory: cwd, canonical: cwd } }
  const session = {
    id: "ses_waiting",
    title: "Work that waits",
    projectID: "project",
    location: { directory: cwd },
    agent: "build",
    model: { providerID: "provider", id: "model" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const bodies: unknown[] = []
  const release = Promise.withResolvers<void>()
  await using setup = await createAppFixture({
    state: state.path,
    args: { sessionID: session.id, prompt: "SESSION_AFTER_TRUST" },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location/trust") {
        // The start folder's reads let the session be drawn; the session's own reads, and any other, are slow.
        const folder = url.searchParams.get("location[directory]") ?? ""
        if (folder !== start.path) await release.promise
        return json(trusted(folder))
      }
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
      if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [], cursor: {} })
      if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: [] })
      if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      if (url.pathname === `/api/session/${session.id}/prompt`) {
        bodies.push(await request.json())
        return json({ data: {} })
      }
      return undefined
    },
  })

  await frameWhere(setup, (frame) => frame.includes("Work that waits"))
  // The session's prompt takes no keys either while its folder's trust is read.
  await setup.mockInput.typeText(" early")
  await Bun.sleep(300)
  expect(bodies).toEqual([])
  expect(setup.captureCharFrame()).not.toContain("early")
  release.resolve()

  await within(
    () => bodies.length > 0,
    () => "the prompt was not sent",
  )
  await Bun.sleep(50)
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ text: "SESSION_AFTER_TRUST" })
}, 15_000)
