import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { IdeLock } from "@orbit/util/ide-lock"
import { createAppFixture, promptReady } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"
import { directory, json } from "./fixture/tui-client"

// The built-in commands that this task registers, run from the prompt of the real app.

const location = { directory, project: { id: "project", directory, canonical: directory } }
const variables = ["ORBIT_EDITOR_SSE_PORT", "TERM_PROGRAM", "TMUX", "WT_SESSION"]
const original = Object.fromEntries(variables.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function render(state: string, config: Record<string, unknown> = {}) {
  for (const name of variables) delete process.env[name]
  return createAppFixture({
    state,
    width: 120,
    config: { animations: false, ...config },
    fetch: (url) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
    },
  })
}

async function command(setup: Awaited<ReturnType<typeof render>>, text: string, enters = 1) {
  await setup.waitForFrame((frame) => promptReady(frame))
  await Bun.sleep(150)
  await setup.mockInput.typeText(text)
  // A command that takes arguments is first completed by Enter, and run by the next.
  for (let press = 0; press < enters; press++) {
    setup.mockInput.pressEnter()
    await Bun.sleep(60)
  }
}

test.each([
  ["/mcp", "MCP"],
  ["/config", "Settings"],
  ["/plugin", "Plugins"],
])("%s opens the dialog its longer name opens", async (slash, title) => {
  await using state = await tmpdir()
  await using setup = await render(state.path)
  await command(setup, slash)
  await setup.waitForFrame((frame) => frame.includes(title))
})

test("/todos on the home route says there is no session", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)
  await command(setup, "/todos")
  await setup.waitForFrame((frame) => frame.includes("No session is open."))
})

test("/terminal-setup in a terminal it does not know lists the newline keys that already work", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)
  await command(setup, "/terminal-setup")
  // The test renderer reports no capabilities and the environment names no terminal.
  await setup.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes("already insert a newline"))
})

test("/ide lists the window that holds the folder, connects to it, and disconnects again", async () => {
  await using state = await tmpdir()
  const token = IdeLock.token()
  const sockets = new Set<unknown>()
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (request.headers.get(IdeLock.header) !== token) return new Response("no", { status: 401 })
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      message(socket, message) {
        if (JSON.parse(String(message)).type === "hello")
          socket.send(JSON.stringify({ type: "hello", version: 1, editor: "Test Editor" }))
      },
    },
  })
  try {
    const folder = path.join(state.path, "ide")
    await mkdir(folder, { recursive: true })
    await writeFile(
      path.join(folder, `${server.port}.lock`),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        port: server.port,
        // The root of the drive holds every folder.
        workspaceFolders: [path.parse(process.cwd()).root],
        ideName: "Test Editor",
        authToken: token,
      }),
    )
    await using setup = await render(state.path)
    await command(setup, "/ide", 2)
    const listed = await setup.waitForFrame((frame) => frame.includes("Select an editor") && frame.includes("Test Editor"))
    expect(listed).toContain("No editor")
    // Outside an editor nothing connected by itself.
    expect(sockets.size).toBe(0)
    await Bun.sleep(100)
    // "No editor" has the focus while nothing is linked; the window is the row above it.
    setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    for (let attempt = 0; attempt < 100 && sockets.size === 0; attempt++) await Bun.sleep(30)
    expect(sockets.size).toBe(1)

    await command(setup, "/ide", 2)
    await setup.waitForFrame((frame) => frame.includes("Select an editor"))
    await Bun.sleep(100)
    // The window just connected to is focused, and "No editor" is the row below it.
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    for (let attempt = 0; attempt < 100 && sockets.size > 0; attempt++) await Bun.sleep(30)
    expect(sockets.size).toBe(0)
  } finally {
    await server.stop(true)
  }
})

test("/ide with an argument other than open says how it is used", async () => {
  await using state = await tmpdir()
  await using setup = await render(state.path)
  await command(setup, "/ide nonsense")
  await setup.waitForFrame((frame) => frame.replace(/\s+/g, " ").includes("or /ide open"))
})
