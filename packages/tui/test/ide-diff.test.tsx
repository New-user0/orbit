/** @jsxImportSource @opentui/solid */
// clients-ux-15 part 3: an Edit or Write approval opens in the linked editor's diff while the terminal UI shows a short
// prompt, as the reference does. The prompt is the real `PermissionPrompt` in the real contexts, drawn and read from the
// screen. The editor is a real WebSocket peer that speaks Orbit's bridge, and the server is the recording `tui-client`
// fixture, so a test sees every frame the terminal UI sends and every reply it makes. What the editor is told comes from
// the request alone, never the tool's input (class 8); its answers become the reply they stand for, sent to the server
// (class 12); and whatever does not fit keeps the question in the terminal (class 7).
import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import type { PermissionRequest } from "@orbit/client"
import { SimulationSemantics } from "@orbit/simulation/frontend/semantics"
import { IdeLock } from "@orbit/util/ide-lock"
import { InputRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal, onMount, Show } from "solid-js"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { EditorContextProvider, useEditorContext, type EditorDiffEvent } from "../src/context/editor"
import { ExitProvider } from "../src/context/exit"
import { InteractivityProvider } from "../src/context/interactivity"
import { Keymap } from "../src/context/keymap"
import { LocationProvider } from "../src/context/location"
import type { LogLevel } from "../src/context/log"
import { RouteProvider } from "../src/context/route"
import { ThemeProvider } from "../src/context/theme"
import { TrustProvider } from "../src/context/trust"
import { PermissionPrompt } from "../src/routes/session/permission"
import { DialogProvider } from "../src/ui/dialog"
import { Toast, ToastProvider, useToast } from "../src/ui/toast"
import { createAppFixture, promptReady } from "./fixture/app"
import { emptyThemeSource, tmpdir } from "./fixture/fixture"
import { createApi, createEventStream, createFetch, directory, json, worktree } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"

const environment = { port: process.env.ORBIT_EDITOR_SSE_PORT, program: process.env.TERM_PROGRAM }
afterEach(() => {
  for (const [key, value] of [
    ["ORBIT_EDITOR_SSE_PORT", environment.port],
    ["TERM_PROGRAM", environment.program],
  ] as const)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
})

// The session works in a folder of its own, and its project's folder is another: neither is the folder the terminal UI
// started in, nor the project's canonical folder, so a frame that names one of those took the wrong folder (class 3).
const sessionFolder = "/work/session-folder"
const projectFolder = "/work/session-project"
const canonicalFolder = "/work/canonical"
const place = `${sessionFolder}/src/a.ts`
const patch = "Index: src/a.ts\n===\n--- src/a.ts\n+++ src/a.ts\n@@ -1,1 +1,1 @@\n-OLD-LINE-TEXT\n+NEW-LINE-TEXT\n"
const session = {
  id: "ses_diff",
  title: "Diff session",
  projectID: "proj_test",
  location: { directory: sessionFolder },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}
const entry = { file: "src/a.ts", place, patch, status: "modified", additions: 1, deletions: 1 }
const base: PermissionRequest = {
  id: "per_diff1",
  sessionID: session.id,
  action: "Edit",
  resources: ["src/a.ts"],
  save: ["src/*"],
  revisable: true,
  source: { type: "tool", messageID: "msg_diff", id: "call_diff" },
  metadata: {
    paths: [place],
    files: [entry],
  },
}
// The model's own input to the call: it names another file and another change. Nothing of it may reach the editor.
const decoy = {
  file_path: "/work/DECOY-FILE.ts",
  content: "DECOY-CONTENT",
  old_string: "DECOY-OLD",
  new_string: "DECOY-NEW",
  link: { place: "/work/DECOY-LINK", outside: true },
}
const message = {
  id: "msg_diff",
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  time: { created: 0 },
  content: [
    {
      type: "tool",
      id: "call_diff",
      name: "edit",
      time: { created: 0 },
      state: { status: "running", input: decoy, metadata: {} },
    },
  ],
}

type Frame = Record<string, unknown>

// An editor window's bridge: it answers a hello with its own, names the features it is given, and keeps every frame.
async function editor(
  state: string,
  options: { features?: readonly string[] | null; name?: string; early?: Frame } = {},
) {
  const token = IdeLock.token()
  const frames: Frame[] = []
  const sockets = new Set<{ send(data: string): void; close(): void }>()
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      if (request.headers.get(IdeLock.header) !== token) return new Response("no", { status: 401 })
      return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 })
    },
    websocket: {
      open: (socket) => void sockets.add(socket),
      close: (socket) => void sockets.delete(socket),
      message(socket, data) {
        const frame = JSON.parse(String(data)) as Frame
        frames.push(frame)
        if (frame.type !== "hello") return
        // A frame a window sends before its own hello, which the terminal UI must not take.
        if (options.early) socket.send(JSON.stringify(options.early))
        socket.send(
          JSON.stringify({
            type: "hello",
            version: 1,
            editor: options.name ?? "Test Editor",
            ...(options.features === null ? {} : { features: options.features ?? ["diff"] }),
          }),
        )
      },
    },
  })
  // Listening on TCP, so the server has a port.
  const port = Number(server.port)
  await lock(state, port, token)
  process.env.ORBIT_EDITOR_SSE_PORT = String(port)
  return {
    port,
    frames,
    of: (type: string) => frames.filter((frame) => frame.type === type),
    answer: (fields: Frame) => sockets.forEach((socket) => socket.send(JSON.stringify({ type: "diff.answer", ...fields }))),
    drop: () => sockets.forEach((socket) => socket.close()),
    stop: () => server.stop(true),
  }
}

// A WebSocket whose close event waits a second, as one does for a window slow to answer the close: the standard waits
// for the peer, while Bun's own fires on the next tick.
class SlowClose extends WebSocket {
  override close(code?: number, reason?: string) {
    setTimeout(() => super.close(code, reason), 1_000)
  }
}

// The lock of a window on `port`, where the terminal UI looks for one.
async function lock(state: string, port: number, token: string) {
  await mkdir(path.join(state, "ide"), { recursive: true })
  await writeFile(
    path.join(state, "ide", `${port}.lock`),
    JSON.stringify({ version: 1, pid: process.pid, port, workspaceFolders: [], ideName: "Test Editor", authToken: token }),
  )
}

// The labels of the dialogs drawn, as the simulation reads them.
function dialogs(renderable: Renderable): string[] {
  const own = SimulationSemantics.read(renderable)?.()
  return [
    ...(own?.role === "dialog" && own.label !== undefined ? [own.label] : []),
    ...renderable.getChildren().flatMap(dialogs),
  ]
}

type Options = {
  request?: Partial<PermissionRequest>
  trusted?: boolean
  tool?: "auto" | "terminal"
  features?: readonly string[] | null
  linked?: boolean
  name?: string
  early?: Frame
  folders?: "ok" | "fail" | "hang" | "slow"
  WebSocketImpl?: typeof WebSocket
  /** The session that asks is a subagent's, under this parent. */
  parent?: string
  reply?: (body: Frame) => Response | Promise<Response> | undefined
}

// The real prompt in the real contexts, for the first pending request of the session, while `shown()` holds.
async function mount(options: Options = {}) {
  const state = await tmpdir()
  const peer = options.linked === false ? undefined : await editor(state.path, options)
  if (options.linked === false) delete process.env.ORBIT_EDITOR_SSE_PORT
  const request = { ...base, ...options.request }
  const events = createEventStream()
  const replies: Frame[] = []
  const reads: string[] = []
  const logs: Array<{ level: LogLevel; message: string }> = []
  const calls = createFetch(async (url, init) => {
    if (url.pathname === `/api/session/${session.id}`)
      return json({ data: options.parent ? { ...session, parentID: options.parent } : session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: [message], cursor: {} })
    if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [request] })
    if (url.pathname === `/api/session/${session.id}/permission/${request.id}/reply`) {
      const body = (await init.json()) as Frame
      replies.push(body)
      return options.reply?.(body) ?? new Response(null, { status: 204 })
    }
    if (url.pathname === "/api/location/trust")
      return json({ directory: worktree, trusted: options.trusted ?? true, persistent: true, source: "saved", withheld: [] })
    if (url.pathname === "/api/location" && url.searchParams.get("location[directory]") === sessionFolder) {
      reads.push(sessionFolder)
      if (options.folders === "fail") return json({ _tag: "InvalidRequestError", message: "no" }, { status: 400 })
      // A server that takes the read and never answers; the read gives up when its signal aborts, as a real fetch does.
      if (options.folders === "hang")
        return new Promise<Response>((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)))
      if (options.folders === "slow") await Bun.sleep(400)
      return json({
        directory: sessionFolder,
        project: { id: "proj_test", directory: projectFolder, canonical: canonicalFolder },
      })
    }
  }, events)
  const [shown, setShown] = createSignal(true)
  // The toasts, read as the app keeps them: a toast is drawn over whatever is on the screen, wrapped in its own box.
  const toasts: { current?: ReturnType<typeof useToast> } = {}
  function ToastProbe() {
    toasts.current = useToast()
    return <box />
  }
  // The editor context, so a test can link to another window as `/ide` does.
  const editors: { current?: ReturnType<typeof useEditorContext> } = {}
  function EditorProbe() {
    editors.current = useEditorContext()
    return <box />
  }

  function Route() {
    const data = useData()
    onMount(() => {
      void data.session.sync(session.id)
      void data.session.message.sync(session.id)
      void data.session.permission.sync(session.id)
    })
    return (
      <Show when={shown() && data.session.get(session.id) && data.session.permission.list(session.id)?.[0]}>
        {(pending) => <PermissionPrompt request={pending()} directory={sessionFolder} />}
      </Show>
    )
  }

  const app = await testRender(
    () => (
      <TestTuiContexts
        directory={directory}
        paths={{ state: state.path, home: "/home/test" }}
        log={(level, text) => void logs.push({ level, message: text })}
      >
        <ExitProvider exit={() => {}}>
          <ConfigProvider config={createTuiResolvedConfig({ animations: false, diffs: { tool: options.tool } })}>
            <Keymap.Provider>
              <ToastProvider>
                <RouteProvider initialRoute={{ type: "home" }}>
                  <ClientProvider api={createApi(calls.fetch)}>
                    <DataProvider directory={directory}>
                      <LocationProvider>
                        <ThemeProvider mode="dark" source={emptyThemeSource}>
                          <DialogProvider>
                            <TrustProvider directory={directory}>
                              <EditorContextProvider compat={() => false} WebSocketImpl={options.WebSocketImpl}>
                                <InteractivityProvider enabled>
                                  <Route />
                                  <Toast />
                                  <ToastProbe />
                                  <EditorProbe />
                                </InteractivityProvider>
                              </EditorContextProvider>
                            </TrustProvider>
                          </DialogProvider>
                        </ThemeProvider>
                      </LocationProvider>
                    </DataProvider>
                  </ClientProvider>
                </RouteProvider>
              </ToastProvider>
            </Keymap.Provider>
          </ConfigProvider>
        </ExitProvider>
      </TestTuiContexts>
    ),
    { width: 140, height: 40, kittyKeyboard: true },
  )
  app.renderer.start()
  const frame = async () => {
    await app.renderOnce()
    return app.captureCharFrame()
  }
  const until = async (condition: (frame: string) => boolean, label: string, timeout = 8_000) => {
    const started = Date.now()
    while (!condition(await frame())) {
      if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}:\n${await frame()}`)
      await Bun.sleep(20)
    }
    return frame()
  }
  return {
    app,
    peer,
    events,
    replies,
    reads,
    request,
    frame,
    until,
    state: state.path,
    hide: () => setShown(false),
    editor: () => editors.current!,
    toast: () => toasts.current?.currentToast,
    warnings: () => logs.filter((line) => line.level === "warn" && line.message.includes("diff")),
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await peer?.stop()
      await state[Symbol.asyncDispose]()
    },
  }
}

// The compact prompt says where the diff opened; the full dialog draws the diff itself.
const compact = (frame: string) => frame.includes("Reviewing in")
const full = (frame: string) => frame.includes("NEW-LINE-TEXT") && !compact(frame)
type Setup = Awaited<ReturnType<typeof mount>>
const opened = (setup: Setup) => setup.until(() => (setup.peer?.of("diff.open").length ?? 0) === 1, "the diff to open")

test("the diff the TUI opens is the request's place and patch, never the tool input", async () => {
  await using setup = await mount()
  await opened(setup)
  expect(setup.peer!.of("diff.open")).toEqual([
    { type: "diff.open", id: "per_diff1", place, patch, status: "modified", roots: [sessionFolder, projectFolder] },
  ])
  expect(JSON.stringify(setup.peer!.frames)).not.toContain("DECOY")
  // The folders were read for the session's own location, once, as the open was made.
  expect(setup.reads).toEqual([sessionFolder])
  // A hello names the feature, so a bridge from before it is never sent a diff.
  expect(setup.peer!.of("hello")[0]).toMatchObject({ type: "hello", version: 1, features: ["diff"] })
})

// A Write of a new file opens as an added file, which the editor shows against an empty left side without reading it.
test("a new file opens as added, with the request's status", async () => {
  await using setup = await mount({
    request: { action: "Write", metadata: { paths: [place], files: [{ ...entry, status: "added" }] } },
  })
  await opened(setup)
  expect(setup.peer!.of("diff.open")).toEqual([
    { type: "diff.open", id: "per_diff1", place, patch, status: "added", roots: [sessionFolder, projectFolder] },
  ])
})

test("while the diff is open the prompt says where it opened and asks about the file by name", async () => {
  await using setup = await mount()
  const frame = await setup.until(compact, "the compact prompt")
  expect(frame).toContain("Reviewing in Test Editor")
  expect(frame).toContain("Make this change to a.ts?")
  expect(frame).toContain("Allow once")
  expect(frame).toContain("Always allow")
  expect(frame).toContain("Reject")
  expect(frame).not.toContain("NEW-LINE-TEXT")
  expect(frame).not.toContain("DECOY")
  // The dialog names the file by name for a screen reader too.
  expect(dialogs(setup.app.renderer.root)).toEqual(["Permission required: Edit a.ts"])
})

// A Windows place is named by its last part as well, whichever separator the server wrote.
test("the prompt names a file of a Windows place by its own name", async () => {
  const windows = "C:\\work\\session-folder\\src\\b.ts"
  await using setup = await mount({
    request: { metadata: { paths: [windows], files: [{ ...entry, file: "src\\b.ts", place: windows }] } },
  })
  const frame = await setup.until(compact, "the compact prompt")
  expect(frame).toContain("Make this change to b.ts?")
  expect(setup.peer!.of("diff.open")[0]).toMatchObject({ place: windows })
})

// The grant Always allow makes reaches past this one file, so the short prompt names it while that option is focused,
// as the full dialog does, and keeps the question and the link warning on screen.
test("while Always allow is focused the prompt says what it grants", async () => {
  for (const row of [
    { save: ["*"], lines: ["This will always allow Edit for this project."] },
    { save: ["src/*"], lines: ["This will always allow the following patterns for this project.", "- src/*"] },
  ]) {
    await using setup = await mount({
      request: {
        save: row.save,
        metadata: { paths: [place], files: [{ ...entry, link: { place: "/work/elsewhere/a.ts", outside: true } }] },
      },
    })
    const before = await setup.until(compact, "the compact prompt")
    expect([row.save, before.includes("This will always allow")]).toEqual([row.save, false])
    setup.app.mockInput.pressArrow("down")
    const frame = await setup.until((value) => value.includes("This will always allow"), "the grant")
    for (const line of row.lines) expect(frame).toContain(line)
    expect(frame).toContain("Reviewing in Test Editor")
    expect(frame).toContain("Make this change to a.ts?")
    expect(frame.replace(/\s+/g, "")).toContain("outsidethesession'sfolder,throughalink")
    // Another option focused again hides it.
    setup.app.mockInput.pressArrow("down")
    await setup.until((value) => compact(value) && !value.includes("This will always allow"), "the grant hidden")
  }
})

// As in the full dialog, Always allow is offered only for a request that has a pattern to save.
test("the short prompt offers Always allow only for a request that can be saved", async () => {
  await using setup = await mount({ request: { save: [] } })
  const frame = await setup.until(compact, "the compact prompt")
  expect(frame).toContain("Allow once")
  expect(frame).toContain("Reject")
  expect(frame).not.toContain("Always allow")
})

// A window whose hello names no diff feature is never sent a diff frame: not a close, not a close-all.
test("a bridge without diffs is sent no diff frame", async () => {
  await using setup = await mount({ features: null })
  await setup.until(full, "the full dialog")
  setup.editor().diff.close("per_diff1")
  setup.editor().diff.closeAll()
  await Bun.sleep(200)
  expect(setup.peer!.frames.filter((frame) => String(frame.type).startsWith("diff."))).toEqual([])
})

test("the save hint shows only in the editor's own terminal", async () => {
  for (const program of ["vscode", undefined]) {
    if (program === undefined) delete process.env.TERM_PROGRAM
    else process.env.TERM_PROGRAM = program
    await using setup = await mount()
    const frame = await setup.until(compact, "the compact prompt")
    expect([program, frame.includes("Save in the editor to answer")]).toEqual([program, program === "vscode"])
  }
})

test("an editor answer becomes the server reply it stands for", async () => {
  const rows: Array<{ name: string; answer: Frame; reply: Frame; close: boolean; status?: number }> = [
    { name: "saved", answer: { answer: "saved", content: "mine\n" }, reply: { decision: "once", content: "mine\n" }, close: true },
    { name: "closed", answer: { answer: "closed" }, reply: { decision: "once" }, close: false },
    { name: "rejected", answer: { answer: "rejected" }, reply: { decision: "reject" }, close: true },
    // Another client answered first: the server's 404 is dropped quietly, and the question goes away.
    { name: "lost-race", answer: { answer: "closed" }, reply: { decision: "once" }, close: false, status: 404 },
  ]
  for (const row of rows) {
    await using setup = await mount({
      reply: () =>
        row.status === 404
          ? json(
              { _tag: "PermissionNotFoundError", requestID: "per_diff1", message: "Permission request not found" },
              { status: 404 },
            )
          : undefined,
    })
    await setup.until(compact, "the compact prompt")
    setup.peer!.answer({ id: "per_diff1", ...row.answer })
    await setup.until(() => setup.replies.length === 1, `${row.name}'s reply`)
    expect([row.name, setup.replies]).toEqual([row.name, [row.reply]])
    const frame = await setup.until((frame) => !compact(frame) && !full(frame), `${row.name}: the prompt to go`)
    // No reply was refused: a lost race says nothing.
    expect([row.name, setup.toast()]).toEqual([row.name, null])
    expect(frame).not.toContain("not found")
    await Bun.sleep(100)
    // The tab of a save or a Reject is closed by request; one the person closed is gone already.
    expect([row.name, setup.peer!.of("diff.close")]).toEqual([
      row.name,
      row.close ? [{ type: "diff.close", id: "per_diff1" }] : [],
    ])
    expect(setup.replies).toHaveLength(1)
  }
})

// A review is answered once. A second answer for it, such as a save after the person closed the tab, names no review
// that is open: it is dropped with one log line, and only the first answer is replied.
test("a second answer for a review already answered is dropped with one log line", async () => {
  await using setup = await mount()
  await setup.until(compact, "the compact prompt")
  setup.peer!.answer({ id: "per_diff1", answer: "closed" })
  setup.peer!.answer({ id: "per_diff1", answer: "saved", content: "LATE-TEXT\n" })
  await setup.until(() => setup.replies.length === 1, "the reply")
  await setup.until(
    () => setup.warnings().some((line) => line.message.includes("a review that is not open")),
    "the dropped answer",
  )
  await Bun.sleep(300)
  expect(setup.replies).toEqual([{ decision: "once" }])
  expect(setup.warnings()).toHaveLength(1)
})

test("answering in the terminal sends the reply and closes the tab", async () => {
  for (const row of [
    { key: "1", reply: { decision: "once" } },
    { key: "2", reply: { decision: "always" } },
    { key: "3", reply: { decision: "reject" } },
  ]) {
    await using setup = await mount()
    await setup.until(compact, "the compact prompt")
    setup.app.mockInput.pressKey(row.key)
    await setup.until(() => setup.replies.length === 1, "the reply")
    expect(setup.replies).toEqual([row.reply])
    await setup.until(() => setup.peer!.of("diff.close").length === 1, "the close")
    expect(setup.peer!.of("diff.close")).toEqual([{ type: "diff.close", id: "per_diff1" }])
    // The review closed with its tab: a save the editor sends after it names nothing open, and is not replied.
    setup.peer!.answer({ id: "per_diff1", answer: "saved", content: "LATE-TEXT\n" })
    await setup.until(
      () => setup.warnings().some((line) => line.message.includes("a review that is not open")),
      "the late answer dropped",
    )
    expect(setup.replies).toEqual([row.reply])
  }
  // A terminal answer the server refuses still closes the tab: the question is asked here again, in the full dialog.
  await using setup = await mount({
    reply: () => json({ _tag: "InvalidRequestError", message: "Refused here" }, { status: 400 }),
  })
  await setup.until(compact, "the compact prompt")
  setup.app.mockInput.pressKey("1")
  await setup.until(full, "the full dialog")
  await setup.until(() => setup.peer!.of("diff.close").length === 1, "the close")
  expect(setup.replies).toEqual([{ decision: "once" }])
  expect(setup.toast()?.message).toBe("Refused here")
})

// Esc in the short prompt rejects, as the full dialog's Esc does; a subagent's question asks for a word first.
test("Esc in the compact prompt rejects and closes the tab, and asks a subagent's reject for a word first", async () => {
  {
    await using setup = await mount()
    await setup.until(compact, "the compact prompt")
    setup.app.mockInput.pressEscape()
    await setup.until(() => setup.replies.length === 1, "the reply")
    expect(setup.replies).toEqual([{ decision: "reject" }])
    await setup.until(() => setup.peer!.of("diff.close").length === 1, "the close")
    expect(setup.peer!.of("diff.close")).toEqual([{ type: "diff.close", id: "per_diff1" }])
  }
  await using setup = await mount({ parent: "ses_parent" })
  await setup.until(compact, "the compact prompt")
  setup.app.mockInput.pressEscape()
  await setup.until((frame) => frame.includes("Tell Orbit what to do differently"), "the reject stage")
  await Bun.sleep(300)
  expect(setup.replies).toEqual([])
})

// An answer goes away with its request: while the reply is on its way the short prompt stays up, and the full dialog,
// with its diff and live options, is never drawn, neither then nor once the server takes the reply.
test("an answer on its way keeps the short prompt, and the full dialog is never drawn", async () => {
  const rows: Array<{ name: string; key?: string; answer?: Frame; taken: boolean; closes: boolean }> = [
    { name: "key 1, on its way", key: "1", taken: false, closes: true },
    { name: "key 2, on its way", key: "2", taken: false, closes: true },
    { name: "key 3, on its way", key: "3", taken: false, closes: true },
    { name: "key 1, taken", key: "1", taken: true, closes: true },
    { name: "saved, on its way", answer: { answer: "saved", content: "mine\n" }, taken: false, closes: false },
    { name: "saved, taken", answer: { answer: "saved", content: "mine\n" }, taken: true, closes: true },
    { name: "rejected, on its way", answer: { answer: "rejected" }, taken: false, closes: false },
    { name: "rejected, taken", answer: { answer: "rejected" }, taken: true, closes: true },
  ]
  for (const row of rows) {
    // A reply the server takes after a round trip, or one that has not come back yet.
    await using setup = await mount({
      reply: () =>
        row.taken
          ? Bun.sleep(300).then(() => new Response(null, { status: 204 }))
          : new Promise<Response>(() => {}),
    })
    await setup.until(compact, "the compact prompt")
    if (row.key) setup.app.mockInput.pressKey(row.key)
    if (row.answer) setup.peer!.answer({ id: "per_diff1", ...row.answer })
    await setup.until(() => setup.replies.length === 1, `${row.name}: the reply`)
    // Every frame drawn over the round trip and after it.
    const frames: string[] = []
    const started = Date.now()
    while (Date.now() - started < 600) {
      frames.push(await setup.frame())
      await Bun.sleep(20)
    }
    expect([row.name, frames.some(full)]).toEqual([row.name, false])
    // Taken, the request goes away with its prompt; on its way, the short prompt is still up.
    expect([row.name, compact(frames.at(-1)!)]).toEqual([row.name, !row.taken])
    expect([row.name, setup.peer!.of("diff.close")]).toEqual([
      row.name,
      row.closes ? [{ type: "diff.close", id: "per_diff1" }] : [],
    ])
    expect([row.name, setup.replies.length]).toEqual([row.name, 1])
  }
})

test("a request answered elsewhere, or a prompt that goes away, closes its tab", async () => {
  {
    await using setup = await mount()
    await setup.until(compact, "the compact prompt")
    setup.events.emit({
      id: "evt_replied",
      created: 1,
      type: "permission.replied",
      data: { sessionID: session.id, requestID: "per_diff1", reply: "once" },
    } as never)
    await setup.until(() => setup.peer!.of("diff.close").length === 1, "the close")
    expect(setup.peer!.of("diff.close")).toEqual([{ type: "diff.close", id: "per_diff1" }])
    expect(setup.replies).toEqual([])
  }
  {
    await using setup = await mount()
    await setup.until(compact, "the compact prompt")
    setup.hide()
    await setup.until(() => setup.peer!.of("diff.close").length === 1, "the close")
    expect(setup.replies).toEqual([])
  }
})

// A prompt that goes away while the session's folders are still being read sends nothing once the read ends: no tab
// opens for a question that is no longer shown.
test("a prompt that goes away while its folders are read opens no diff", async () => {
  await using setup = await mount({ folders: "slow" })
  await setup.until(() => setup.reads.length === 1, "the read")
  setup.hide()
  await Bun.sleep(800)
  expect(setup.peer!.of("diff.open")).toEqual([])
})

// A review belongs to the link it was opened over. After `/ide` links to another window, an answer from that window
// for the review is dropped with one line, and no reply is sent, even while the first window's link has not closed.
test("an answer from a window linked later is not taken for a review opened in the window before", async () => {
  await using setup = await mount({ WebSocketImpl: SlowClose })
  await opened(setup)
  await setup.until(compact, "the compact prompt")
  const other = await editor(setup.state)
  try {
    expect(await setup.editor().connect(other.port)).toBe("connected")
    // The first window's link has not closed yet, so its review is still open.
    expect(setup.warnings()).toEqual([])
    other.answer({ id: "per_diff1", answer: "saved", content: "OTHER-TEXT\n" })
    await setup.until(
      () => setup.warnings().some((line) => line.message.includes("a review that is not open")),
      "the dropped answer",
    )
    // When the first window's link closes, its review goes with it: the question comes back to the terminal.
    await setup.until(full, "the full dialog after the first link closed")
    await Bun.sleep(300)
    expect(full(await setup.frame())).toBe(true)
    expect(setup.warnings().filter((line) => line.message.includes("the link to the editor went away"))).toHaveLength(1)
    expect(setup.replies).toEqual([])
  } finally {
    await other.stop()
  }
})

// The first window's link closing takes only its own reviews: one opened over the window linked later stays open and
// still hears that window's answer.
test("a review opened in the window linked later stays open when the window before closes", async () => {
  await using setup = await mount({ WebSocketImpl: SlowClose })
  await opened(setup)
  await setup.until(compact, "the compact prompt")
  const other = await editor(setup.state)
  try {
    expect(await setup.editor().connect(other.port)).toBe("connected")
    const heard: EditorDiffEvent[] = []
    const review = { id: "per_later1", place, patch, status: "modified" as const, roots: [sessionFolder] }
    expect(setup.editor().diff.open(review, (event) => void heard.push(event))).toBe(true)
    await setup.until(() => other.of("diff.open").length === 1, "the later window's open")
    // The first window's link closes, and its review is lost; the later one is not.
    await setup.until(full, "the full dialog after the first link closed")
    await Bun.sleep(300)
    expect(heard).toEqual([])
    other.answer({ id: "per_later1", answer: "closed" })
    await setup.until(() => heard.length === 1, "the later window's answer")
    expect(heard).toEqual([{ type: "diff.answer", id: "per_later1", answer: "closed" }])
  } finally {
    await other.stop()
  }
})

test("an odd answer, a dismissed tab, a lost bridge or a bridge without diffs keeps the terminal dialog, with one log line", async () => {
  const rows: Array<{
    name: string
    options?: Options
    act?: (setup: Setup) => void
    dialog: "full" | "compact"
    lines: number
  }> = [
    // A save without its text does not decode, and an answer for another request names nothing open.
    { name: "malformed", act: (setup) => setup.peer!.answer({ id: "per_diff1", answer: "saved" }), dialog: "compact", lines: 1 },
    { name: "unknown-id", act: (setup) => setup.peer!.answer({ id: "per_other", answer: "closed" }), dialog: "compact", lines: 1 },
    { name: "unknown-answer", act: (setup) => setup.peer!.answer({ id: "per_diff1", answer: "accepted" }), dialog: "compact", lines: 1 },
    { name: "dismissed", act: (setup) => setup.peer!.answer({ id: "per_diff1", answer: "dismissed" }), dialog: "full", lines: 1 },
    {
      name: "unavailable",
      act: (setup) => setup.peer!.answer({ id: "per_diff1", answer: "unavailable", reason: "outside" }),
      dialog: "full",
      lines: 1,
    },
    { name: "drop", act: (setup) => setup.peer!.drop(), dialog: "full", lines: 1 },
    // An answer the window sends before its hello is not taken, and is not counted as a dropped answer either: like a
    // selection before the hello, it is not read at all.
    {
      name: "before-hello",
      options: { early: { type: "diff.answer", id: "per_diff1", answer: "closed" } },
      act: () => {},
      dialog: "compact",
      lines: 0,
    },
    { name: "no-feature", options: { features: null }, dialog: "full", lines: 0 },
    { name: "other-feature", options: { features: ["selection"] }, dialog: "full", lines: 0 },
    { name: "no-folders", options: { folders: "fail" }, dialog: "full", lines: 1 },
  ]
  for (const row of rows) {
    await using setup = await mount(row.options)
    if (row.act) {
      await setup.until(compact, `${row.name}: the compact prompt`)
      row.act(setup)
    }
    if (row.dialog === "full") await setup.until(full, `${row.name}: the full dialog`)
    await Bun.sleep(300)
    const frame = await setup.frame()
    expect([row.name, row.dialog === "full" ? full(frame) : compact(frame)]).toEqual([row.name, true])
    expect([row.name, setup.replies]).toEqual([row.name, []])
    expect([row.name, setup.warnings().length]).toEqual([row.name, row.lines])
    if (!row.act) expect([row.name, setup.peer!.of("diff.open")]).toEqual([row.name, []])
    // The question is still answered in the terminal.
    expect(frame).toContain("Allow once")
  }
})

test("a location read that never ends keeps the full dialog once the read limit passes", async () => {
  await using setup = await mount({ folders: "hang" })
  await setup.until(full, "the full dialog")
  await Bun.sleep(2_500)
  expect(setup.peer!.of("diff.open")).toEqual([])
  expect(full(await setup.frame())).toBe(true)
  expect(setup.warnings()).toHaveLength(1)
})

test("no diff opens unless the request is a revisable one-file Edit or Write, the setting is auto and the folder is trusted", async () => {
  const second = { file: "src/b.ts", place: `${sessionFolder}/src/b.ts`, patch, status: "modified" }
  const file = (fields: Frame) => ({ metadata: { paths: [place], files: [{ ...entry, ...fields }] } })
  const rows: Array<{ name: string; options: Options; opens: boolean }> = [
    { name: "control", options: {}, opens: true },
    { name: "write", options: { request: { action: "Write" } }, opens: true },
    { name: "patch", options: { request: { action: "Patch", revisable: undefined } }, opens: false },
    {
      name: "notebook-edit",
      options: { request: { action: "NotebookEdit", revisable: false, ...file({ place: `${sessionFolder}/n.ipynb` }) } },
      opens: false,
    },
    {
      name: "two-files",
      options: { request: { metadata: { paths: [place], files: [entry, second] } } },
      opens: false,
    },
    { name: "ipynb", options: { request: file({ place: `${sessionFolder}/N.IPYNB` }) }, opens: false },
    { name: "no-place", options: { request: file({ place: undefined }) }, opens: false },
    { name: "relative-place", options: { request: file({ place: "src/a.ts" }) }, opens: false },
    // A drive with no separator after it names a folder relative to that drive's current one, not an absolute place.
    { name: "drive-relative-place", options: { request: file({ place: "C:src\\a.ts" }) }, opens: false },
    { name: "drive-place", options: { request: file({ place: "C:\\work\\session-folder\\src\\a.ts" }) }, opens: true },
    { name: "deleted-status", options: { request: file({ status: "deleted" }) }, opens: false },
    { name: "terminal-setting", options: { tool: "terminal" }, opens: false },
    { name: "untrusted", options: { trusted: false }, opens: false },
    { name: "not-linked", options: { linked: false }, opens: false },
  ]
  for (const row of rows) {
    await using setup = await mount(row.options)
    if (row.opens) await opened(setup)
    else {
      await setup.until((frame) => frame.includes("Allow once"), `${row.name}: the prompt`)
      await Bun.sleep(400)
    }
    expect([row.name, setup.peer?.of("diff.open").length ?? 0]).toEqual([row.name, row.opens ? 1 : 0])
    // Nothing is read for a request that is not reviewed in the editor.
    expect([row.name, setup.reads.length]).toEqual([row.name, row.opens ? 1 : 0])
    if (!row.opens) expect([row.name, compact(await setup.frame())]).toEqual([row.name, false])
  }
})

test("a refused reply shows the server's reason and brings back the dialog", async () => {
  await using setup = await mount({
    reply: () => json({ _tag: "InvalidRequestError", message: "The saved text could not be used here" }, { status: 400 }),
  })
  await setup.until(compact, "the compact prompt")
  setup.peer!.answer({ id: "per_diff1", answer: "saved", content: "mine\n" })
  const frame = await setup.until(
    // The server's own sentence is what the toast says.
    (frame) => setup.toast()?.message === "The saved text could not be used here" && full(frame),
    "the toast and the dialog",
  )
  expect(frame).toContain("Allow once")
  expect(setup.replies).toEqual([{ decision: "once", content: "mine\n" }])
  // The editor's tab of a saved answer is closed by request, refused or not.
  await setup.until(() => setup.peer!.of("diff.close").length === 1, "the tab's close")
  expect(setup.peer!.of("diff.close")).toEqual([{ type: "diff.close", id: "per_diff1" }])
  // The question is still pending: it can be answered in the terminal.
  setup.app.mockInput.pressKey("1")
  await setup.until(() => setup.replies.length === 2, "the second reply")
  expect(setup.replies[1]).toEqual({ decision: "once" })
})

test("the link warning comes from the request: through a link, and outside the session's folder", async () => {
  // `outside` may be a string, for a link without its shape.
  const linked = (link: { place: string; outside: boolean | string } | undefined, tool?: "terminal") => ({
    tool,
    request: { metadata: { paths: [place], files: [{ ...entry, ...(link && { link }) }] } },
  })
  const rows: Array<{ name: string; options: Options; shows?: string; place?: string }> = [
    {
      name: "outside, compact",
      options: linked({ place: "/elsewhere/secrets/a.ts", outside: true }),
      shows: "outside the session's folder, through a link",
      place: "/elsewhere/secrets/a.ts",
    },
    {
      name: "outside, full",
      options: linked({ place: "/elsewhere/secrets/a.ts", outside: true }, "terminal"),
      shows: "outside the session's folder, through a link",
      place: "/elsewhere/secrets/a.ts",
    },
    {
      name: "inside, compact",
      options: linked({ place: `${sessionFolder}/real/a.ts`, outside: false }),
      shows: "The link leads to",
      place: "real/a.ts",
    },
    {
      name: "inside, full",
      options: linked({ place: `${sessionFolder}/real/a.ts`, outside: false }, "terminal"),
      shows: "The link leads to",
      place: "real/a.ts",
    },
    // The tool's input names a link too, and the request does not: nothing is said.
    { name: "decoy, compact", options: linked(undefined) },
    { name: "decoy, full", options: linked(undefined, "terminal") },
    // A link without its shape says nothing either (class 7).
    { name: "outside not a boolean, compact", options: linked({ place: "/elsewhere/secrets/a.ts", outside: "true" }) },
    {
      name: "outside not a boolean, full",
      options: linked({ place: "/elsewhere/secrets/a.ts", outside: "true" }, "terminal"),
    },
    // A place that is not a string has no shape either.
    { name: "place not a string, compact", options: linked({ place: 7 as never, outside: true }) },
    // The link is the one file's: a request of two files names none, even when its first file carries one.
    {
      name: "two files, full",
      options: {
        request: {
          metadata: {
            paths: [place],
            files: [
              { ...entry, link: { place: "/elsewhere/secrets/a.ts", outside: true } },
              { ...entry, file: "src/b.ts", place: `${sessionFolder}/src/b.ts` },
            ],
          },
        },
      },
    },
  ]
  for (const row of rows) {
    await using setup = await mount(row.options)
    const frame = await setup.until(
      (frame) => (row.name.endsWith("compact") ? compact(frame) : full(frame)),
      `${row.name}: the prompt`,
    )
    const flat = frame.replace(/\s+/g, " ")
    if (row.shows) expect([row.name, flat.includes(row.shows), flat.includes(row.place!)]).toEqual([row.name, true, true])
    else expect([row.name, flat.includes("through a link") || flat.includes("The link leads to")]).toEqual([row.name, false])
    expect(flat).not.toContain("DECOY")
  }
})

test("names in the compact prompt are written out", async () => {
  const odd = `${sessionFolder}/src/e\u001b]0;pwned\u0007‮gnp.ts​\nx.ts`
  await using setup = await mount({
    name: "Ed\u001b[31mitor‮",
    request: {
      metadata: {
        paths: [odd],
        files: [
          {
            ...entry,
            place: odd,
            link: { place: "/elsewhere/l\u001b[2Jink‮​\nx", outside: true },
          },
        ],
      },
    },
  })
  const frame = await setup.until(compact, "the compact prompt")
  for (const raw of ["\u001b", "\u0007", "‮", "​"]) expect(frame).not.toContain(raw)
  expect(frame).not.toContain("pwned\n")
  const flat = frame.replace(/\s+/g, "")
  // Each name is drawn, with its hidden characters written out where they were.
  expect(flat).toContain("Ed\\x1b[31mitor\\u{202e}")
  expect(flat).toContain("e\\x1b]0;pwned\\x07\\u{202e}gnp.ts\\u{200b}\\nx.ts")
  expect(flat).toContain("l\\x1b[2Jink\\u{202e}\\u{200b}\\nx")
  // The dialog's label, which a screen reader speaks, holds the name written out as well.
  const [label] = dialogs(setup.app.renderer.root)
  for (const raw of ["\u001b", "\u0007", "‮", "​", "\n"]) expect(label).not.toContain(raw)
  expect(label?.replace(/\s+/g, "")).toContain("Edite\\x1b]0;pwned\\x07\\u{202e}gnp.ts\\u{200b}\\nx.ts")
})

test("a diff too large for a frame is not sent, and the dialog stays", async () => {
  const large = `${patch}${"+x\n".repeat(IdeLock.frameCap / 3)}`
  await using setup = await mount({
    request: { metadata: { paths: [place], files: [{ ...entry, patch: large }] } },
  })
  await setup.until((frame) => frame.includes("Allow once") && setup.reads.length === 1, "the prompt and the read")
  await Bun.sleep(300)
  expect(setup.peer!.of("diff.open")).toEqual([])
  expect(compact(await setup.frame())).toBe(false)
  expect(setup.warnings()).toHaveLength(1)
})

// The real app: its settings dialog and its palette are drawn outside the editor's context, and the app tells them that
// an editor is linked, so both list where an edit approval's diff shows.
test("the app's settings and palette list Diff tool while an editor is linked", async () => {
  await using state = await tmpdir()
  const peer = await editor(state.path)
  await using setup = await createAppFixture({
    state: state.path,
    config: { animations: false, keybinds: { "orbit.settings": "f6" } },
  })
  try {
    await setup.ready
    await setup.waitForFrame(promptReady)
    while (peer.of("hello").length === 0) await Bun.sleep(20)
    await Bun.sleep(200)

    setup.mockInput.pressKey("F6")
    await setup.waitForFrame((frame) => frame.includes("Settings") && frame.includes("Color mode"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("diff tool")
    await setup.waitForFrame((frame) => frame.includes("Diff tool"))
    setup.mockInput.pressEscape()
    await setup.waitForFrame((frame) => !frame.includes("Diff tool"))

    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Commands"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("diff tool")
    await setup.waitForFrame((frame) => frame.includes("Diff tool"))
  } finally {
    await peer.stop()
  }
})

// The real app: a prompt or a command sent to the model closes every diff tab, as the reference does; a `!` command
// runs in the shell and does not.
test("a prompt sent to the model closes every diff tab; a shell command does not", async () => {
  await using state = await tmpdir()
  const peer = await editor(state.path)
  const location = { directory, project: { id: "proj_test", directory: worktree, canonical: worktree } }
  const sent: string[] = []
  const appSession = { ...session, location: { directory } }
  await using setup = await createAppFixture({
    state: state.path,
    width: 120,
    args: { sessionID: session.id },
    config: { animations: false },
    fetch: async (url, request) => {
      if (url.pathname === "/api/location") return json(location)
      if (url.pathname === "/api/agent")
        return json({ location, data: [{ id: "build", mode: "primary", hidden: false, permissions: [] }] })
      if (url.pathname === "/api/provider") return json({ location, data: [{ id: "provider", name: "Provider" }] })
      if (url.pathname === "/api/model")
        return json({ location, data: [{ id: "model", providerID: "provider", name: "Model", variants: [] }] })
      if (url.pathname === "/api/command")
        return json({ location, data: [{ name: "review", description: "Review the input" }] })
      if (url.pathname === `/api/session/${session.id}`) return json({ data: appSession })
      if (/^\/api\/session\/[^/]+\/(message|inbox|permission)$/.test(url.pathname)) return json({ data: [], cursor: {} })
      const kind = url.pathname.match(/^\/api\/session\/[^/]+\/(prompt|command|shell|agent|model)$/)?.[1]
      if (!kind) return
      sent.push(kind)
      if (request.method === "POST") await request.text()
      return kind === "prompt" ? json({ data: {} }) : new Response(null, { status: 204 })
    },
  })
  try {
    await setup.waitForFrame(promptReady)
    while (peer.of("hello").length === 0) await Bun.sleep(20)
    await Bun.sleep(200)

    await setup.mockInput.typeText("hello")
    setup.mockInput.pressEnter()
    await setup.waitFor(() => sent.includes("prompt"))
    await setup.waitFor(() => peer.of("diff.closeAll").length === 1)

    await setup.mockInput.typeText("/review selected input")
    setup.mockInput.pressEscape()
    setup.mockInput.pressEnter()
    await setup.waitFor(() => sent.includes("command"))
    await setup.waitFor(() => peer.of("diff.closeAll").length === 2)

    await setup.mockInput.typeText("!")
    await setup.mockInput.typeText("ls")
    setup.mockInput.pressEnter()
    await setup.waitFor(() => sent.includes("shell"))
    await Bun.sleep(300)
    expect(peer.of("diff.closeAll")).toEqual([{ type: "diff.closeAll" }, { type: "diff.closeAll" }])
  } finally {
    await peer.stop()
  }
})
