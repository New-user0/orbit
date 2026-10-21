/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { EditorContextProvider, useEditorContext } from "../../src/context/editor"
import { IdeLock } from "@orbit/util/ide-lock"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

// What `/ide` asks of the editor context: the windows to offer, a link to the one picked, and letting go of it.

const variables = ["ORBIT_EDITOR_SSE_PORT", "TERM_PROGRAM"]
const original = Object.fromEntries(variables.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

async function wait(condition: () => boolean, timeout = 3_000, label = "condition") {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

async function renderEditor(input: { cwd: string; state: string; connect?: number; autoConnect?: boolean }) {
  let editor!: ReturnType<typeof useEditorContext>
  function Probe() {
    editor = useEditorContext()
    return <box />
  }
  const setup = await testRender(() => (
    <TestTuiContexts cwd={input.cwd} paths={{ state: input.state }}>
      <EditorContextProvider
        compat={() => false}
        autoConnect={input.autoConnect}
        timing={{ poll: 20, window: 200, delays: [20, 20, 20], connect: input.connect ?? 3_000 }}
      >
        <Probe />
      </EditorContextProvider>
    </TestTuiContexts>
  ))
  return { editor, destroy: () => setup.renderer.destroy() }
}

async function bridge(
  state: string,
  options: { hello?: boolean | number; folders?: string[]; name?: string; helloName?: string } = {},
) {
  const token = IdeLock.token()
  const upgrades: Record<string, string>[] = []
  const sockets = new Set<{ send(data: string): void; close(code?: number): void }>()
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      upgrades.push(Object.fromEntries(request.headers))
      if (request.headers.get(IdeLock.header) !== token) return new Response("no", { status: 401 })
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      message(socket, message) {
        if (JSON.parse(String(message)).type === "hello" && options.hello !== false)
          socket.send(JSON.stringify({ type: "hello", version: options.hello ?? 1, editor: options.helloName ?? options.name ?? "Test Editor" }))
      },
    },
  })
  const port = server.port as number
  const directory = path.join(state, "ide")
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, `${port}.lock`),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      port,
      workspaceFolders: options.folders ?? [],
      ideName: options.name ?? "Test Editor",
      authToken: token,
    }),
  )
  return {
    port,
    upgrades,
    connected: () => sockets.size,
    drop: () => sockets.forEach((socket) => socket.close()),
    stop: () => server.stop(true),
  }
}

async function scene() {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  // Outside an editor's terminal, so nothing connects by itself.
  for (const name of variables) delete process.env[name]
  return { root, cwd, state: path.join(root.path, "state") }
}

test("lists the windows that hold the folder before the others, each newest first", async () => {
  const { root, cwd, state } = await scene()
  const other = await bridge(state, { name: "Other", folders: [path.join(root.path, "elsewhere")] })
  await Bun.sleep(30)
  const older = await bridge(state, { name: "Older", folders: [cwd] })
  await Bun.sleep(30)
  const newer = await bridge(state, { name: "Newer", folders: [cwd] })
  const setup = await renderEditor({ cwd, state })
  try {
    const listed = setup.editor.list()
    expect(listed.matched.map((item) => item.name)).toEqual(["Newer", "Older"])
    expect(listed.unmatched.map((item) => item.name)).toEqual(["Other"])
    expect(listed.current).toBeUndefined()
  } finally {
    setup.destroy()
    await Promise.all([other.stop(), older.stop(), newer.stop()])
    await root[Symbol.asyncDispose]()
  }
})

test("connect links to the window picked, reads the token from its lock, and the list names it as current", async () => {
  const { root, cwd, state } = await scene()
  const window = await bridge(state, { folders: [cwd] })
  const setup = await renderEditor({ cwd, state })
  try {
    expect(await setup.editor.connect(window.port)).toBe("connected")
    expect(setup.editor.connected()).toBe(true)
    expect(setup.editor.server()?.name).toBe("Test Editor")
    expect(setup.editor.list().current).toBe(window.port)
    expect(window.upgrades).toHaveLength(1)
  } finally {
    setup.destroy()
    await window.stop()
    await root[Symbol.asyncDispose]()
  }
})

// Class 9: the name in the editor's hello is the editor's own to choose, and it reaches the footer and the toast of
// "No editor" through `server().name`.
test("the name an editor sends in hello is written out, and the one in its lock too", async () => {
  const { root, cwd, state } = await scene()
  const window = await bridge(state, { folders: [cwd], name: "Lock\u001b[2J", helloName: "Hello\u001b]0;x\u0007\u001b[31m" })
  const setup = await renderEditor({ cwd, state })
  try {
    expect(setup.editor.list().matched.map((item) => item.name)).toEqual(["Lock\\x1b[2J"])
    expect(await setup.editor.connect(window.port)).toBe("connected")
    expect(setup.editor.server()?.name).toBe("Hello\\x1b]0;x\\x07\\x1b[31m")
  } finally {
    setup.destroy()
    await window.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("connect fails for a port with no lock, for a window of another version, and for one that closes before hello", async () => {
  const { root, cwd, state } = await scene()
  const old = await bridge(state, { hello: 2 })
  const setup = await renderEditor({ cwd, state })
  try {
    expect(await setup.editor.connect(65_000)).toBe("failed")
    expect(await setup.editor.connect(old.port)).toBe("failed")
    expect(setup.editor.connected()).toBe(false)
    // No retries of a window the person picked.
    await Bun.sleep(300)
    expect(old.upgrades).toHaveLength(1)
  } finally {
    setup.destroy()
    await old.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("connect times out against a window that never says hello, and stops dialing", async () => {
  const { root, cwd, state } = await scene()
  const silent = await bridge(state, { hello: false })
  const setup = await renderEditor({ cwd, state, connect: 150 })
  try {
    expect(await setup.editor.connect(silent.port)).toBe("timeout")
    expect(setup.editor.connected()).toBe(false)
    await Bun.sleep(300)
    expect(silent.upgrades).toHaveLength(1)
    expect(silent.connected()).toBe(0)
  } finally {
    setup.destroy()
    await silent.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("disconnect closes the link and stops every retry and search until the next connect", async () => {
  const { root, cwd, state } = await scene()
  const window = await bridge(state, { folders: [cwd] })
  // With auto-connect on, a change of folder would start a search that finds the window again.
  const setup = await renderEditor({ cwd, state, autoConnect: true })
  try {
    expect(await setup.editor.connect(window.port)).toBe("connected")
    setup.editor.disconnect()
    await wait(() => window.connected() === 0, 3_000, "the link to close")
    expect(setup.editor.connected()).toBe(false)
    expect(setup.editor.server()).toBeUndefined()
    expect(setup.editor.list().current).toBeUndefined()

    // A change of folder starts a search, and the window holds the new folder too; a drop would start a retry. Neither happens.
    const attempts = window.upgrades.length
    setup.editor.reconnect(path.join(cwd, "sub"))
    await Bun.sleep(400)
    expect(window.upgrades).toHaveLength(attempts)
    expect(setup.editor.connected()).toBe(false)

    expect(await setup.editor.connect(window.port)).toBe("connected")
    expect(window.upgrades).toHaveLength(attempts + 1)
  } finally {
    setup.destroy()
    await window.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("connect replaces the link it had with the window picked", async () => {
  const { root, cwd, state } = await scene()
  const first = await bridge(state, { name: "First", folders: [cwd] })
  const second = await bridge(state, { name: "Second", folders: [cwd] })
  const setup = await renderEditor({ cwd, state })
  try {
    expect(await setup.editor.connect(first.port)).toBe("connected")
    expect(await setup.editor.connect(second.port)).toBe("connected")
    expect(setup.editor.server()?.name).toBe("Second")
    await wait(() => first.connected() === 0, 3_000, "the first link to close")
    expect(setup.editor.list().current).toBe(second.port)
  } finally {
    setup.destroy()
    await Promise.all([first.stop(), second.stop()])
    await root[Symbol.asyncDispose]()
  }
})
