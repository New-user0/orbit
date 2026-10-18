import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { IdeLock } from "@orbit/util/ide-lock"
import { createAppFixture, promptReady } from "./fixture/app"
import { directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// The real app, drawn, with an editor window's bridge behind ORBIT_EDITOR_SSE_PORT. Names that the editor sends reach
// the footer of the prompt and the prompt itself, and a clone can name its files as it likes (class 9).
const location = { directory, project: { id: "project", directory, canonical: directory } }
const port = process.env.ORBIT_EDITOR_SSE_PORT

afterEach(() => {
  if (port === undefined) delete process.env.ORBIT_EDITOR_SSE_PORT
  else process.env.ORBIT_EDITOR_SSE_PORT = port
})

async function editor(state: string) {
  const token = IdeLock.token()
  const sockets = new Set<{ send(data: string): void }>()
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
  const lockFolder = path.join(state, "ide")
  await mkdir(lockFolder, { recursive: true })
  await writeFile(
    path.join(lockFolder, `${server.port}.lock`),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port: server.port,
      workspaceFolders: [],
      ideName: "Test Editor",
      authToken: token,
    }),
  )
  process.env.ORBIT_EDITOR_SSE_PORT = String(server.port)
  return {
    send: (frame: unknown) => sockets.forEach((socket) => socket.send(JSON.stringify(frame))),
    connected: () => sockets.size > 0,
    stop: () => server.stop(true),
  }
}

function render(state: string) {
  return createAppFixture({
    state,
    width: 120,
    config: { animations: false },
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

const range = { start: { line: 3, character: 1 }, end: { line: 9, character: 4 } }

test("draws the open file in the footer, and drops a name that holds control characters", async () => {
  await using state = await tmpdir()
  const bridge = await editor(state.path)
  await using setup = await render(state.path)
  try {
    await setup.waitForFrame(promptReady)
    await Bun.sleep(200)
    while (!bridge.connected()) await Bun.sleep(20)
    await Bun.sleep(100)

    // The control: a plain name is drawn, with its lines.
    bridge.send({ type: "selection", filePath: "/work/plain.ts", text: "x", selection: range })
    const plain = await setup.waitForFrame((frame) => frame.includes("plain.ts#3-9"))
    expect(plain).toContain("plain.ts#3-9")

    bridge.send({
      type: "selection",
      filePath: "/work/evil\u001b]0;pwned\u0007\u001b[31mred.ts",
      text: "x",
      selection: range,
    })
    await Bun.sleep(300)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()

    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("pwned")
    expect(frame).not.toContain("red.ts")
    // The refused frame also drops the previous selection.
    expect(frame).not.toContain("plain.ts#3-9")
  } finally {
    await bridge.stop()
  }
})

test("a mention from the editor puts @path in the prompt, with the lines when the selection came with it", async () => {
  await using state = await tmpdir()
  const bridge = await editor(state.path)
  await using setup = await render(state.path)
  try {
    await setup.waitForFrame(promptReady)
    while (!bridge.connected()) await Bun.sleep(20)
    await Bun.sleep(200)

    bridge.send({ type: "mention", filePath: "/work/plain.ts" })
    const bare = await setup.waitForFrame((frame) => frame.includes("@") && frame.includes("plain.ts"))
    expect(bare).toMatch(/@\S*plain\.ts(?!#)/)
    expect(bare).not.toMatch(/plain\.ts#/)

    bridge.send({ type: "mention", filePath: "/work/ranged.ts", lineStart: 3, lineEnd: 9 })
    const ranged = await setup.waitForFrame((frame) => frame.includes("ranged.ts#3-9"))
    expect(ranged).toMatch(/@\S*ranged\.ts#3-9/)

    // A name with an escape sequence is refused before it reaches the prompt.
    bridge.send({ type: "mention", filePath: "/work/men\u001b]0;pwned\u0007tion.ts" })
    await Bun.sleep(300)
    await setup.renderOnce()
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("pwned")
  } finally {
    await bridge.stop()
  }
})
