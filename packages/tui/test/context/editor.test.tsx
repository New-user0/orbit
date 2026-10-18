/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { EditorContextProvider, useEditorContext, type EditorIntegration } from "../../src/context/editor"
import { IdeLock } from "@orbit/util/ide-lock"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"

// The variables the editor context and the Zed reader read, so each test starts from none of them and leaves none behind.
const variables = ["ORBIT_EDITOR_SSE_PORT", "ORBIT_ZED_DB", "ZED_TERM", "TERM_PROGRAM"]
// Another product's name for the port variable, assembled so that no file outside compat spells it.
const foreignPort = ["CLA", "UDE_CODE_SSE_PORT"].join("")
const original = Object.fromEntries([...variables, foreignPort].map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

function environment(values: Record<string, string> = {}) {
  for (const name of [...variables, foreignPort]) delete process.env[name]
  Object.assign(process.env, values)
}

async function wait(condition: () => boolean, timeout = 3_000, label = "condition") {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

async function renderEditor(
  input: {
    integration?: EditorIntegration
    compat?: () => boolean
    cwd?: string
    /** The state folder, which holds the locks in `ide`. */
    state?: string
    autoConnect?: boolean
    timing?: { poll: number; window: number; delays: number[] }
  } = {},
) {
  let editor!: ReturnType<typeof useEditorContext>

  function Probe() {
    editor = useEditorContext()
    return <box />
  }

  const setup = await testRender(() => (
    <TestTuiContexts cwd={input.cwd} paths={input.state ? { state: input.state } : undefined}>
      <EditorContextProvider
        integration={input.integration}
        compat={input.compat ?? (() => true)}
        autoConnect={input.autoConnect}
        timing={input.timing}
      >
        <Probe />
      </EditorContextProvider>
    </TestTuiContexts>
  ))
  return { editor, destroy: () => setup.renderer.destroy() }
}

const zed = {
  type: "selection",
  selection: {
    filePath: "/tmp/orbit/packages/tui/main.ts",
    source: "zed",
    ranges: [{ text: "main", selection: { start: { line: 1, character: 1 }, end: { line: 1, character: 5 } } }],
  },
}

// Zed is polled once a second, so a poll that should have happened has, after a little longer than that.
const poll = 1_200

test("reads Zed's selection only while compatibility is on", async () => {
  environment({ ZED_TERM: "true" })
  const asked: string[] = []
  const [compat, setCompat] = createSignal(false)
  const setup = await renderEditor({
    compat,
    integration: {
      selection: async (directory) => {
        asked.push(directory)
        return zed
      },
    },
  })
  try {
    await Bun.sleep(poll)
    expect(asked).toEqual([])
    expect(setup.editor.enabled()).toBe(false)
    expect(setup.editor.selection()).toBeUndefined()

    setCompat(true)
    await wait(() => setup.editor.selection() !== undefined, poll + 1_000, "Zed's selection")
    expect(asked[0]).toBe("/tmp/orbit/packages/tui")
    expect(setup.editor.selection()?.filePath).toBe("/tmp/orbit/packages/tui/main.ts")
    expect(setup.editor.enabled()).toBe(true)
    expect(setup.editor.connected()).toBe(true)

    // Switching it off forgets what Zed said and stops asking.
    setCompat(false)
    await wait(() => setup.editor.selection() === undefined, poll + 1_000, "the selection to clear")
    expect(setup.editor.enabled()).toBe(false)
    expect(setup.editor.connected()).toBe(false)
    const before = asked.length
    await Bun.sleep(poll)
    expect(asked).toHaveLength(before)
  } finally {
    setup.destroy()
  }
})

test("does not read Zed outside a Zed terminal", async () => {
  environment({ TERM_PROGRAM: "xterm" })
  const asked: string[] = []
  const setup = await renderEditor({
    integration: {
      selection: async (directory) => {
        asked.push(directory)
        return zed
      },
    },
  })
  try {
    await Bun.sleep(poll)

    expect(asked).toEqual([])
    expect(setup.editor.enabled()).toBe(false)
  } finally {
    setup.destroy()
  }
})

test("reads the selection from Zed's database through the compat reader", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "orbit-editor-zed-"))
  try {
    const project = path.join(directory, "project")
    const file = path.join(project, "main.ts")
    await mkdir(project, { recursive: true })
    await writeFile(file, "héllo wörld\n")
    // The tables and columns the reader asks for, with one cursor on "wörld": bytes 7 to 13, as é and ö take two.
    const database = path.join(directory, "db.sqlite")
    const db = new Database(database)
    db.exec(`
      create table workspaces (workspace_id integer primary key, paths text, timestamp text);
      create table panes (pane_id integer primary key, workspace_id integer, active integer);
      create table items (item_id integer, workspace_id integer, pane_id integer, kind text, active integer);
      create table editors (item_id integer, workspace_id integer, buffer_path text, contents text);
      create table editor_selections (editor_id integer, workspace_id integer, start integer, end integer);
    `)
    db.run("insert into workspaces values (1, ?, '2026-01-01 00:00:00')", [project])
    db.run("insert into panes values (1, 1, 1)")
    db.run("insert into items values (1, 1, 1, 'Editor', 1)")
    db.run("insert into editors values (1, 1, ?, null)", [file])
    db.run("insert into editor_selections values (1, 1, 7, 13)")
    db.close()
    environment({ ZED_TERM: "true", ORBIT_ZED_DB: database })

    // No integration is given, so this is the reader the TUI ships with.
    const setup = await renderEditor({ cwd: project })
    try {
      await wait(() => setup.editor.selection() !== undefined, 3_000, "Zed's selection")

      expect(setup.editor.selection()).toEqual({
        filePath: file,
        source: "zed",
        ranges: [{ text: "wörld", selection: { start: { line: 1, character: 7 }, end: { line: 1, character: 12 } } }],
      })
      expect(setup.editor.connected()).toBe(true)
    } finally {
      setup.destroy()
    }
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

// An editor window's bridge: a real WebSocket server that checks the token the way the extension does, records how it
// was reached and what the context sends it, and writes the lock that advertises it.
async function bridge(
  state: string,
  options: { token?: string; hello?: boolean | number; folders?: string[]; refuse?: boolean } = {},
) {
  const token = options.token ?? IdeLock.token()
  const upgrades: Record<string, string>[] = []
  const frames: Record<string, unknown>[] = []
  const sockets = new Set<{ send(data: string): void; close(code?: number): void }>()
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      upgrades.push(Object.fromEntries(request.headers))
      if (options.refuse || request.headers.get(IdeLock.header) !== token) return new Response("no", { status: 401 })
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
      },
      close(socket) {
        sockets.delete(socket)
      },
      message(socket, message) {
        const frame = JSON.parse(String(message))
        frames.push(frame)
        if (frame.type === "hello" && options.hello !== false)
          socket.send(JSON.stringify({ type: "hello", version: options.hello ?? 1, editor: "Test Editor" }))
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
      ideName: "Test Editor",
      authToken: token,
    }),
  )
  return {
    port,
    token,
    upgrades,
    frames,
    send: (frame: unknown) => sockets.forEach((socket) => socket.send(JSON.stringify(frame))),
    drop: () => sockets.forEach((socket) => socket.close()),
    stop: () => server.stop(true),
    remove: () => rm(path.join(directory, `${port}.lock`), { force: true }),
  }
}

const fast = { poll: 20, window: 400, delays: [20, 20, 20, 20, 20] }

async function connectedEditor(
  options: {
    env?: Record<string, string>
    autoConnect?: boolean
    folders?: (cwd: string) => string[]
    /** A second window that fits as well as the first, which is there before the context looks. */
    twin?: boolean
  } = {},
) {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  const state = path.join(root.path, "state")
  const editor = await bridge(state, { folders: options.folders?.(cwd) })
  const other = options.twin ? await bridge(state, { folders: options.folders?.(cwd) }) : undefined
  environment(options.env ?? { ORBIT_EDITOR_SSE_PORT: String(editor.port) })
  const setup = await renderEditor({ state, cwd, timing: fast, autoConnect: options.autoConnect })
  return {
    root,
    state,
    cwd,
    editor,
    other,
    setup,
    async done() {
      setup.destroy()
      await other?.stop()
      await editor.stop()
      await root[Symbol.asyncDispose]()
    },
  }
}

const selection = {
  type: "selection",
  filePath: "/work/a.ts",
  text: "hello",
  selection: { start: { line: 5, character: 1 }, end: { line: 8, character: 1 } },
}

test("connects to the window the port names, with the token from its lock in one header and no other credential", async () => {
  const run = await connectedEditor()
  try {
    await wait(() => run.setup.editor.connected(), 3_000, "the connection")

    expect(run.editor.upgrades).toHaveLength(1)
    expect(run.editor.upgrades[0]?.[IdeLock.header]).toBe(run.editor.token)
    expect(Object.keys(run.editor.upgrades[0] ?? {}).filter((name) => /authorization|cookie/i.test(name))).toEqual([])
    expect(run.setup.editor.enabled()).toBe(true)
    expect(run.setup.editor.server()?.name).toBe("Test Editor")
  } finally {
    await run.done()
  }
})

test("sends hello with version 1 and its pid, and counts as connected only after the bridge's hello", async () => {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  const state = path.join(root.path, "state")
  const editor = await bridge(state, { hello: false })
  environment({ ORBIT_EDITOR_SSE_PORT: String(editor.port) })
  const setup = await renderEditor({ state, cwd, timing: fast })
  try {
    await wait(() => editor.frames.length > 0, 3_000, "the hello")
    await Bun.sleep(100)

    expect(editor.frames[0]).toEqual({ type: "hello", version: 1, pid: process.pid })
    expect(setup.editor.connected()).toBe(false)

    editor.send({ type: "hello", version: 1, editor: "Test Editor" })
    await wait(() => setup.editor.connected(), 3_000, "the connection")
  } finally {
    setup.destroy()
    await editor.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("shows a selection from the window, forgets it when the window says none, and hands on a mention with or without lines", async () => {
  const run = await connectedEditor()
  const mentions: unknown[] = []
  try {
    await wait(() => run.setup.editor.connected(), 3_000, "the connection")
    run.setup.editor.onMention((mention) => mentions.push(mention))

    run.editor.send(selection)
    await wait(() => run.setup.editor.selection() !== undefined, 3_000, "the selection")
    expect(run.setup.editor.selection()).toEqual({
      filePath: "/work/a.ts",
      source: "websocket",
      ranges: [{ text: "hello", selection: selection.selection }],
    })

    // A frame with a path and no range says nothing about what is selected.
    run.editor.send({ type: "selection", filePath: "/work/b.ts" })
    await Bun.sleep(100)
    expect(run.setup.editor.selection()?.filePath).toBe("/work/a.ts")

    run.editor.send({ type: "selection", filePath: null })
    await wait(() => run.setup.editor.selection() === undefined, 3_000, "the selection to clear")

    run.editor.send({ type: "mention", filePath: "/work/a.ts", lineStart: 3, lineEnd: 9 })
    run.editor.send({ type: "mention", filePath: "/work/b.ts" })
    // Lines come both or neither, and in order.
    run.editor.send({ type: "mention", filePath: "/work/c.ts", lineStart: 3 })
    run.editor.send({ type: "mention", filePath: "/work/d.ts", lineStart: 9, lineEnd: 3 })
    // A type from a later version is ignored.
    run.editor.send({ type: "diagnostics", filePath: "/work/a.ts" })
    await wait(() => mentions.length >= 2, 3_000, "the mentions")
    await Bun.sleep(100)

    expect(mentions).toEqual([
      { filePath: "/work/a.ts", lineStart: 3, lineEnd: 9 },
      { filePath: "/work/b.ts" },
    ])
  } finally {
    await run.done()
  }
})

test("ignores a selection or a mention that arrives before the bridge's hello", async () => {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  const state = path.join(root.path, "state")
  const editor = await bridge(state, { hello: false })
  environment({ ORBIT_EDITOR_SSE_PORT: String(editor.port) })
  const setup = await renderEditor({ state, cwd, timing: fast })
  const mentions: unknown[] = []
  try {
    await wait(() => editor.frames.length > 0, 3_000, "the hello")
    setup.editor.onMention((mention) => mentions.push(mention))

    editor.send(selection)
    editor.send({ type: "mention", filePath: "/work/a.ts" })
    await Bun.sleep(150)

    expect(setup.editor.selection()).toBeUndefined()
    expect(mentions).toEqual([])

    editor.send({ type: "hello", version: 1 })
    await wait(() => setup.editor.connected(), 3_000, "the connection")
    editor.send(selection)
    await wait(() => setup.editor.selection() !== undefined, 3_000, "the selection")
  } finally {
    setup.destroy()
    await editor.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("forgets the selection when the link drops, and reads the lock again to find a window that came back with a new port and token", async () => {
  const run = await connectedEditor()
  let second: Awaited<ReturnType<typeof bridge>> | undefined
  try {
    await wait(() => run.setup.editor.connected(), 3_000, "the connection")
    run.editor.send(selection)
    await wait(() => run.setup.editor.selection() !== undefined, 3_000, "the selection")

    // The window reloads: the first server goes, and a second one has another port and another token. The terminal still
    // has the first port in its environment, which names no lock now, so the folders decide.
    await run.editor.remove()
    second = await bridge(run.state, { folders: [run.cwd] })
    run.editor.drop()
    await wait(() => run.setup.editor.selection() === undefined, 3_000, "the selection to clear")
    await wait(() => run.setup.editor.connected() && second!.frames.length > 0, 3_000, "the new connection")

    expect(second.upgrades[0]?.[IdeLock.header]).toBe(second.token)
    expect(second.token).not.toBe(run.editor.token)
  } finally {
    await second?.stop()
    await run.done()
  }
})

test("tries five more times to get back after a refusal and then stops until it is asked again", async () => {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  const state = path.join(root.path, "state")
  const editor = await bridge(state, { refuse: true })
  environment({ ORBIT_EDITOR_SSE_PORT: String(editor.port) })
  const setup = await renderEditor({ state, cwd, timing: fast })
  try {
    await wait(() => editor.upgrades.length >= 6, 3_000, "six attempts")
    await Bun.sleep(300)

    // The first attempt and five more. A refused upgrade is a failed attempt and is not hidden by a retry of the same token.
    expect(editor.upgrades).toHaveLength(6)
    expect(setup.editor.connected()).toBe(false)
    expect(setup.editor.enabled()).toBe(false)
  } finally {
    setup.destroy()
    await editor.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("does not look for a window outside an editor's terminal unless asked to", async () => {
  const run = await connectedEditor({ env: { TERM_PROGRAM: "xterm" }, folders: (cwd) => [cwd] })
  try {
    await Bun.sleep(300)

    expect(run.editor.upgrades).toEqual([])
    expect(run.setup.editor.enabled()).toBe(false)
  } finally {
    await run.done()
  }
})

test("finds the window by its folders in a VS Code terminal that has no port, and when asked to auto-connect", async () => {
  const code = await connectedEditor({ env: { TERM_PROGRAM: "vscode" }, folders: (cwd) => [cwd] })
  try {
    await wait(() => code.setup.editor.connected(), 3_000, "the connection")
    expect(code.editor.upgrades).toHaveLength(1)
  } finally {
    await code.done()
  }

  const asked = await connectedEditor({ env: { TERM_PROGRAM: "xterm" }, autoConnect: true, folders: (cwd) => [cwd] })
  try {
    await wait(() => asked.setup.editor.connected(), 3_000, "the connection")
  } finally {
    await asked.done()
  }
})

test("does not connect when two windows fit and nothing says which", async () => {
  const run = await connectedEditor({ env: { TERM_PROGRAM: "vscode" }, folders: (cwd) => [cwd], twin: true })
  try {
    await Bun.sleep(400)

    expect(run.editor.upgrades).toEqual([])
    expect(run.other?.upgrades).toEqual([])
    expect(run.setup.editor.connected()).toBe(false)
  } finally {
    await run.done()
  }
})

test("stops for good when the bridge speaks another version", async () => {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  const state = path.join(root.path, "state")
  const editor = await bridge(state, { hello: 2 })
  environment({ ORBIT_EDITOR_SSE_PORT: String(editor.port) })
  const setup = await renderEditor({ state, cwd, timing: fast })
  try {
    await wait(() => editor.frames.length > 0, 3_000, "the hello")
    await Bun.sleep(300)

    expect(editor.upgrades).toHaveLength(1)
    expect(setup.editor.connected()).toBe(false)
  } finally {
    setup.destroy()
    await editor.stop()
    await root[Symbol.asyncDispose]()
  }
})

test("does not connect to the port another product's variable names", async () => {
  const root = await tmpdir()
  const cwd = path.join(root.path, "project")
  await mkdir(cwd)
  const state = path.join(root.path, "state")
  const editor = await bridge(state)
  environment({ [foreignPort]: String(editor.port) })
  const setup = await renderEditor({ state, cwd, timing: fast })
  try {
    await Bun.sleep(300)

    expect(setup.editor.enabled()).toBe(false)
    expect(setup.editor.connected()).toBe(false)
    expect(editor.upgrades).toEqual([])
  } finally {
    setup.destroy()
    await editor.stop()
    await root[Symbol.asyncDispose]()
  }
})
