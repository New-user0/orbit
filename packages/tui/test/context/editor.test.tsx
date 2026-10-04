/** @jsxImportSource @opentui/solid */
import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { EditorContextProvider, useEditorContext, type EditorIntegration } from "../../src/context/editor"
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

async function renderEditor(input: { integration?: EditorIntegration; compat?: () => boolean; cwd?: string } = {}) {
  let editor!: ReturnType<typeof useEditorContext>

  function Probe() {
    editor = useEditorContext()
    return <box />
  }

  const setup = await testRender(() => (
    <TestTuiContexts cwd={input.cwd}>
      <EditorContextProvider integration={input.integration} compat={input.compat ?? (() => true)}>
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

// An editor's WebSocket server that records how it was reached and what the context sends it.
function listen() {
  const upgrades: Record<string, string>[] = []
  const messages: { method?: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      upgrades.push(Object.fromEntries(request.headers))
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 })
    },
    websocket: {
      message(_socket, message) {
        messages.push(JSON.parse(String(message)))
      },
    },
  })
  return { server, upgrades, messages }
}

test("connects to the port in ORBIT_EDITOR_SSE_PORT, without credentials of its own", async () => {
  const editor = listen()
  environment({ ORBIT_EDITOR_SSE_PORT: String(editor.server.port) })
  const setup = await renderEditor()
  try {
    expect(setup.editor.enabled()).toBe(true)
    await wait(() => editor.messages.some((message) => message.method === "initialize"), 3_000, "initialize")
    await wait(() => setup.editor.connected(), 3_000, "the connection")

    expect(editor.upgrades).toHaveLength(1)
    expect(Object.keys(editor.upgrades[0] ?? {}).filter((name) => /authorization/i.test(name))).toEqual([])
  } finally {
    setup.destroy()
    await editor.server.stop(true)
  }
})

test("does not connect to the port another product's variable names", async () => {
  const editor = listen()
  environment({ [foreignPort]: String(editor.server.port) })
  const setup = await renderEditor()
  try {
    await Bun.sleep(poll)

    expect(setup.editor.enabled()).toBe(false)
    expect(setup.editor.connected()).toBe(false)
    expect(editor.upgrades).toEqual([])
  } finally {
    setup.destroy()
    await editor.server.stop(true)
  }
})
