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

// What the app sent: each prompt's body and each other admission to a session (a synthetic message, a command).
type Sent = { prompts: Record<string, unknown>[]; admissions: string[] }

function render(state: string, sent: Sent = { prompts: [], admissions: [] }) {
  const sessions = new Map<string, Record<string, unknown>>()
  const info = (record: Record<string, unknown>) => ({
    ...record,
    location: { directory: location.directory },
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  })
  return createAppFixture({
    state,
    width: 120,
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname === "/api/fs/list") return json({ location, data: [] })
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/session" && request.method === "POST") {
        const record: Record<string, unknown> = await request.json()
        sessions.set(String(record.id), record)
        return json({ data: info(record) })
      }
      if (url.pathname === "/api/session") return json({ data: [], cursor: {} })
      if (/^\/api\/session\/[^/]+\/prompt$/.test(url.pathname)) {
        sent.prompts.push(await request.json())
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(synthetic|command)$/.test(url.pathname)) {
        sent.admissions.push(url.pathname.split("/").at(-1) ?? "")
        return json({ data: {} })
      }
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname))
        return json({ data: [], cursor: {} })
      if (/^\/api\/session\/[^/]+\/(agent|model)$/.test(url.pathname)) return new Response(null, { status: 204 })
      if (/^\/api\/session\/[^/]+$/.test(url.pathname)) {
        const record = sessions.get(url.pathname.split("/")[3] ?? "")
        return record ? json({ data: info(record) }) : json({ message: "not found" }, { status: 404 })
      }
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

// Review of m5-quality fix loop 1 (classes 3 and 8): the editor's open file and selection go with the prompt as its
// editor field, which the server leaves out when the person's read rules or policies refuse the file (the core rows of
// session-prompt-editor.test.ts decide each rule, policy, link and trust case). Nothing goes as text the terminal UI
// wrote, which the server could not check. A range that ends at the first character of a later line stops at the line
// before it, and an open file with nothing selected goes as its path alone.
test.each([
  [
    "a selection",
    { start: { line: 3, character: 1 }, end: { line: 9, character: 4 } },
    { path: "/work/open.ts", selection: { start: 3, end: 9, text: "SELECTED-TEXT" } },
  ],
  [
    "a selection that ends at the start of a line",
    { start: { line: 3, character: 2 }, end: { line: 9, character: 1 } },
    { path: "/work/open.ts", selection: { start: 3, end: 8, text: "SELECTED-TEXT" } },
  ],
  [
    "an open file with nothing selected",
    { start: { line: 3, character: 2 }, end: { line: 3, character: 2 } },
    { path: "/work/open.ts" },
  ],
])("%s goes with the prompt as its editor field, and as nothing else", async (_, selection, field) => {
  await using state = await tmpdir()
  const bridge = await editor(state.path)
  const sent: Sent = { prompts: [], admissions: [] }
  await using setup = await render(state.path, sent)
  try {
    await setup.waitForFrame(promptReady)
    while (!bridge.connected()) await Bun.sleep(20)
    await Bun.sleep(100)
    bridge.send({ type: "selection", filePath: "/work/open.ts", text: "SELECTED-TEXT", selection })
    await setup.waitForFrame((frame) => frame.includes("open.ts"))

    await setup.mockInput.typeText("What is this?")
    setup.mockInput.pressEnter()
    await setup.waitForFrame(() => sent.prompts.length === 1)

    expect(sent.prompts[0]).toMatchObject({ text: "What is this?" })
    expect(sent.prompts[0]?.editor).toEqual(field)
    expect(sent.admissions).toEqual([])
    expect(JSON.stringify(sent.prompts[0]?.text)).not.toContain("SELECTED-TEXT")
  } finally {
    await bridge.stop()
  }
})
