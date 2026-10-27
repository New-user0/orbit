import { afterEach, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { plant } from "../../../core/test/fixture/decoy"
import { DialogMemory } from "../../src/component/dialog-memory"
import { Toast, useToast } from "../../src/ui/toast"
import type { JSX } from "solid-js"
import { tmpdir } from "../fixture/fixture"
import { renderLocal } from "../fixture/local"
import { json } from "../fixture/tui-client"

// The real dialog, the real client and a recording server: what the dialog asks the server for, what it starts and what it
// draws are what is asserted. `/memory` posts a target and opens only the path the server answered (class 3); every
// string from the server is drawn through `plain` (class 9).

const search = process.env.PATH
const visual = process.env.VISUAL
const editor = process.env.EDITOR

afterEach(() => {
  process.env.PATH = search
  for (const [name, value] of [
    ["VISUAL", visual],
    ["EDITOR", editor],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

async function project() {
  const folder = await tmpdir()
  return { dir: folder.path, [Symbol.asyncDispose]: () => folder[Symbol.asyncDispose]() }
}

type Target = Record<string, string>
type Listing = {
  files: Record<string, unknown>[]
  warnings: Record<string, unknown>[]
  folders: Record<string, unknown>[]
  enabled: boolean
  git: boolean
  available: boolean
}

const fileTarget = (file: string): Target => ({ type: "file", path: file })

function listing(dir: string, overrides: Partial<Listing> = {}): Listing {
  const agents = path.join(dir, "AGENTS.md")
  return {
    files: [
      { path: agents, kind: "project", chars: 10, role: "project", exists: true, target: fileTarget(agents) },
      {
        path: path.join(dir, "docs", "a.md"),
        kind: "project",
        chars: 3,
        importedBy: agents,
        exists: true,
        target: fileTarget(path.join(dir, "docs", "a.md")),
      },
      {
        path: path.join(dir, "docs", "b.md"),
        kind: "project",
        chars: 3,
        importedBy: path.join(dir, "docs", "a.md"),
        exists: true,
        target: fileTarget(path.join(dir, "docs", "b.md")),
      },
      {
        path: "/tmp/orbit/home/.config/orbit/ORBIT.md",
        kind: "user",
        chars: 0,
        role: "user",
        exists: false,
        target: { type: "scope", scope: "user" },
      },
    ],
    warnings: [],
    folders: [
      { type: "memory", path: path.join(dir, "data", "memory"), exists: false, target: { type: "memory" } },
      { type: "team", path: path.join(dir, ".orbit", "team-memory"), exists: false, target: { type: "team" } },
      {
        type: "agent",
        agent: "review",
        scope: "user",
        path: path.join(dir, "data", "agents", "review"),
        exists: false,
        target: { type: "agent", agent: "review" },
      },
    ],
    enabled: true,
    git: true,
    available: true,
    ...overrides,
  }
}

function server(dir: string, input: { listing: () => Listing; answer?: (target: Target) => Response }) {
  const posted: Target[] = []
  const patched: unknown[] = []
  let listed = 0
  const fetch = async (url: URL, request: Request) => {
    if (url.pathname === "/api/location") return json({ directory: dir, project: { id: "proj_test", directory: dir, canonical: dir } })
    if (url.pathname === "/api/location/memory" && request.method === "GET") {
      listed++
      return json({ data: input.listing() })
    }
    if (url.pathname === "/api/location/memory" && request.method === "POST") {
      const target = ((await request.clone().json()) as { target: Target }).target
      posted.push(target)
      if (input.answer) return input.answer(target)
      return json({ data: { path: target.path ?? path.join(dir, "made"), created: false, type: target.type === "file" ? "file" : "folder" } })
    }
    if (url.pathname === "/api/experimental/config" && request.method === "PATCH") {
      patched.push(await request.clone().json())
      return new Response(null, { status: 204 })
    }
  }
  return { posted, patched, fetch, listed: () => listed }
}

const flat = (frame: string) => frame.replace(/\s+/g, " ")

async function until(setup: Awaited<ReturnType<typeof renderLocal>>, text: string) {
  const frame = await setup.waitForFrame((frame) => flat(frame).includes(text))
  await Bun.sleep(60)
  return frame
}

async function settle(setup: Awaited<ReturnType<typeof renderLocal>>) {
  await Bun.sleep(150)
  await setup.renderOnce()
  return setup.captureCharFrame()
}

async function wait(done: () => boolean) {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) await Bun.sleep(30)
}

// An editor that records the file it is given and starts nothing.
function editing() {
  const edited: string[] = []
  return {
    edited,
    edit: async (input: { file: string }) => {
      edited.push(input.file)
      return { source: "VISUAL" as const, editor: "fake" }
    },
  }
}

const dot = (...parts: string[]) => `.${path.sep}${path.join(...parts)}`

// The dialog as `/memory` opens it, at the large width, with the toasts drawn beside it and readable after it closes.
const toasts: { current?: ReturnType<typeof useToast> } = {}
// Forgets the toasts of an earlier render, so a wait for a toast reads only the next dialog's.
const forget = () => {
  toasts.current = undefined
}
function ToastProbe() {
  toasts.current = useToast()
  return <box />
}
function show(setup: Awaited<ReturnType<typeof renderLocal>>, dialog: () => JSX.Element) {
  setup.dialog.replace(
    () => (
      <>
        {dialog()}
        <Toast />
        <ToastProbe />
      </>
    ),
    undefined,
    { size: "large" },
  )
}

test("draws the toggle, the files in load order with imports indented, the user and project rows and the folder rows", async () => {
  await using tmp = await project()
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  const editor = editing()
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  show(setup, () => <DialogMemory edit={editor.edit} open={async () => {}} />)
  const frame = await until(setup, "Open review agent memory")
  const lines = frame.split("\n")
  const at = (text: string) => lines.findIndex((line) => line.includes(text))
  expect(frame).toContain("Auto memory: on")
  expect(frame).toContain("Project memory")
  expect(frame).toContain("User memory")
  expect(frame).toContain("Open memory folder")
  expect(frame).toContain("Open team memory folder")
  expect(frame).toContain("user scope")
  // Load order, then the folders, with the toggle above them all.
  const order = ["Auto memory", "Project memory", path.join("docs", "a.md"), path.join("docs", "b.md"), "User memory", "Open memory folder", "Open team memory folder", "Open review agent memory"].map(at)
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual(order.toSorted((a, b) => a - b))
  // An import sits under its importer, one step deeper for each level.
  const column = (text: string) => lines[at(text)]!.indexOf(text)
  expect(column(path.join("docs", "b.md"))).toBeGreaterThan(column(path.join("docs", "a.md")))
  // The first file row is focused, not the toggle: Enter asks for that file.
  setup.mockInput.pressEnter()
  await wait(() => recorded.posted.length > 0)
  expect(recorded.posted).toEqual([fileTarget(path.join(tmp.dir, "AGENTS.md"))])
})

test("describes the project file as checked in only in a git repository", async () => {
  for (const git of [true, false]) {
    await using tmp = await project()
    const recorded = server(tmp.dir, { listing: () => listing(tmp.dir, { git }) })
    await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
    show(setup, () => <DialogMemory open={async () => {}} />)
    const frame = flat(await until(setup, "Project memory"))
    expect(frame).toContain(`${git ? "Checked in at" : "Saved in"} ${dot("AGENTS.md")}`)
    expect(frame).not.toContain(git ? "Saved in ." : "Checked in at")
  }
})

test("draws every name, path and message from the server through plain", async () => {
  await using tmp = await project()
  const hostile = path.join(tmp.dir, "x\u001b[2Jy\nz\u202ew.md")
  const recorded = server(tmp.dir, {
    listing: () =>
      listing(tmp.dir, {
        files: [{ path: hostile, kind: "project", chars: 4, exists: true, target: fileTarget(hostile) }],
        warnings: [{ path: hostile, type: "size", message: "too long\u001b[31m red\u0007", chars: 50_000, limit: 40_000 }],
        folders: [
          {
            type: "agent",
            agent: "ag\u001b]0;title\u0007ent",
            scope: "user\u202e",
            path: path.join(tmp.dir, "agent"),
            exists: false,
            target: { type: "agent", agent: "agent" },
          },
        ],
      }),
  })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  show(setup, () => <DialogMemory open={async () => {}} />)
  const frame = await until(setup, "agent memory")
  expect(frame).toContain("x\\x1b[2Jy\\nz\\u{202e}w.md")
  expect(frame).toContain("too long\\x1b[31m red\\x07")
  expect(frame).toContain("ag\\x1b]0;title\\x07ent")
  expect(frame).toContain("user\\u{202e} scope")
  expect(frame).not.toContain("\u001b")
  expect(frame).not.toContain("\u202e")
})

test("opens the path the server returned for a file and for a folder", async () => {
  await using tmp = await project()
  const bin = path.join(tmp.dir, "bin")
  const real = path.join(tmp.dir, "real")
  await mkdir(bin)
  await mkdir(real)
  await writeFile(path.join(real, "AGENTS.md"), "")
  const ran = await plant(bin, "orbit-memory-editor")
  process.env.PATH = `${bin}${path.delimiter}${search}`
  process.env.VISUAL = "orbit-memory-editor.exe"
  delete process.env.EDITOR
  const answers = new Map<string, unknown>([
    ["file", { path: path.join(real, "AGENTS.md"), created: false, type: "file" }],
    ["memory", { path: path.join(real, "memory"), created: true, type: "folder" }],
    // A folder row the server answers with a file is never handed to the system opener.
    ["team", { path: path.join(real, "AGENTS.md"), created: false, type: "file" }],
  ])
  const recorded = server(tmp.dir, {
    listing: () => listing(tmp.dir),
    answer: (target) => json({ data: answers.get(target.type!) }),
  })
  const opened: string[] = []
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  const dialog = () => <DialogMemory open={async (folder) => void opened.push(folder)} />
  show(setup, dialog)
  await until(setup, "Open memory folder")
  // The rows below the files: memory folder, then team.
  for (let step = 0; step < 4; step++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await wait(() => opened.length > 0)
  expect(opened).toEqual([path.join(real, "memory")])
  expect(setup.dialog.stack).toHaveLength(1)
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await wait(() => recorded.posted.length >= 2 && toasts.current?.currentToast != null)
  expect(recorded.posted.map((target) => target.type)).toEqual(["memory", "team"])
  expect(opened).toEqual([path.join(real, "memory")])
  expect(toasts.current?.currentToast?.variant).toBe("error")
  expect(setup.dialog.stack).toHaveLength(1)

  // The listed spelling is AGENTS.md at the project; the server answers another, real place. The editor hands the
  // terminal back to a renderer that a test cannot draw again, so this row comes last and reads the toast it left.
  show(setup, dialog)
  await until(setup, "Project memory")
  setup.mockInput.pressEnter()
  await wait(() => setup.dialog.stack.length === 0)
  expect((await ran()).map((line) => line.replace(/^orbit-memory-editor\.exe /, ""))).toEqual([path.join(real, "AGENTS.md")])
  expect(toasts.current?.currentToast?.message).toContain(dot("real", "AGENTS.md"))
  expect(toasts.current?.currentToast?.message).toContain("$VISUAL")
  expect(recorded.posted.map((target) => target.type)).toEqual(["memory", "team", "file"])
})

test("a refused ensure shows the server's message and opens nothing", async () => {
  for (const [status, tag] of [
    [400, "InvalidRequestError"],
    [403, "UntrustedFolderError"],
  ] as const) {
    await using tmp = await project()
    const editor = editing()
    const opened: string[] = []
    const recorded = server(tmp.dir, {
      listing: () => listing(tmp.dir),
      answer: () =>
        json(
          { _tag: tag, message: `refused here \u001b[31m${status}`, field: "target", kind: "refused", directory: tmp.dir, persistent: true },
          { status },
        ),
    })
    await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
    show(setup, () => <DialogMemory edit={editor.edit} open={async (folder) => void opened.push(folder)} />)
    await until(setup, "Project memory")
    // A folder row keeps the dialog open, so the toast is drawn beside it.
    for (let step = 0; step < 4; step++) setup.mockInput.pressArrow("down")
    setup.mockInput.pressEnter()
    // The toast wraps the message where it likes, so the frame holds the start of the written-out escape and the toast
    // the whole of it.
    const frame = await until(setup, "refused here \\x1b[")
    expect(frame).not.toContain("\u001b")
    expect(toasts.current?.currentToast?.message).toContain(`refused here \\x1b[31m${status}`)
    // A file row closes the dialog with the same message.
    for (let step = 0; step < 4; step++) setup.mockInput.pressArrow("up")
    setup.mockInput.pressEnter()
    await wait(() => setup.dialog.stack.length === 0)
    expect(toasts.current?.currentToast).toMatchObject({ variant: "error" })
    expect(toasts.current?.currentToast?.message).toContain(`refused here \\x1b[31m${status}`)
    expect(recorded.posted).toHaveLength(2)
    expect(editor.edited).toEqual([])
    expect(opened).toEqual([])
  }
})

test("an editor that cannot start closes the dialog with an error naming the file", async () => {
  await using tmp = await project()
  const tried: string[] = []
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  show(setup, () => (
    <DialogMemory
      edit={async (input) => {
        tried.push(input.file)
        throw new Error("No editor was found on PATH \u001b[31m")
      }}
      open={async () => {}}
    />
  ))
  await until(setup, "Project memory")
  setup.mockInput.pressEnter()
  await wait(() => setup.dialog.stack.length === 0 && toasts.current?.currentToast != null)
  expect(tried).toEqual([path.join(tmp.dir, "AGENTS.md")])
  expect(setup.dialog.stack).toHaveLength(0)
  expect(toasts.current?.currentToast).toMatchObject({ variant: "error" })
  expect(toasts.current?.currentToast?.message).toBe(`Could not open ${dot("AGENTS.md")}: No editor was found on PATH \\x1b[31m`)
})

test("the toggle writes memory.enabled and redraws from the server's answer", async () => {
  await using tmp = await project()
  // The server reports memory as on whatever is written, as it does when an environment switch wins.
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir, { enabled: true }) })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  show(setup, () => <DialogMemory open={async () => {}} />)
  await until(setup, "Auto memory: on")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await wait(() => recorded.patched.length > 0 && recorded.listed() >= 2)
  expect(recorded.patched).toEqual([{ memory: { enabled: false } }])
  const frame = await settle(setup)
  expect(frame).toContain("Auto memory: on")
  expect(recorded.posted).toEqual([])
  expect(setup.dialog.stack).toHaveLength(1)
})

test("on a server not on this machine, rows that open say unavailable and Enter does nothing", async () => {
  await using tmp = await project()
  const editor = editing()
  const opened: string[] = []
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://example.com:4096", fetch: recorded.fetch })
  show(setup, () => <DialogMemory edit={editor.edit} open={async (folder) => void opened.push(folder)} />)
  const frame = flat(await until(setup, "Open memory folder"))
  expect(frame).toContain("Unavailable")
  setup.mockInput.pressEnter()
  for (let step = 0; step < 4; step++) setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await settle(setup)
  expect(recorded.posted).toEqual([])
  expect(editor.edited).toEqual([])
  expect(opened).toEqual([])
  expect(setup.dialog.stack).toHaveLength(1)
})

test("Esc closes with a cancelled toast, and the file chosen last is focused next time", async () => {
  await using tmp = await project()
  const editor = editing()
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  const dialog = () => <DialogMemory edit={editor.edit} open={async () => {}} />
  show(setup, dialog)
  await until(setup, "Project memory")
  setup.mockInput.pressEscape()
  await wait(() => setup.dialog.stack.length === 0)
  expect(toasts.current?.currentToast).toMatchObject({ variant: "info" })
  expect(toasts.current?.currentToast?.message).toContain("cancelled")
  expect(recorded.posted).toEqual([])

  show(setup, dialog)
  await until(setup, "Project memory")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await wait(() => editor.edited.length > 0)
  expect(editor.edited).toEqual([path.join(tmp.dir, "docs", "a.md")])
  await wait(() => setup.dialog.stack.length === 0)

  show(setup, dialog)
  await until(setup, "Project memory")
  setup.mockInput.pressEnter()
  await wait(() => editor.edited.length > 1)
  expect(recorded.posted).toEqual([fileTarget(path.join(tmp.dir, "docs", "a.md")), fileTarget(path.join(tmp.dir, "docs", "a.md"))])
})

test("draws a warning whose file did not load as its own row, and Enter on it does nothing", async () => {
  await using tmp = await project()
  const editor = editing()
  const agents = path.join(tmp.dir, "AGENTS.md")
  const recorded = server(tmp.dir, {
    listing: () =>
      listing(tmp.dir, {
        files: [{ path: agents, kind: "project", chars: 1, role: "project", exists: true, target: fileTarget(agents) }],
        warnings: [
          {
            path: path.join(tmp.dir, "ORBIT.local.md"),
            type: "outside",
            message: "Left out: this file leads outside the project's folders.",
          },
        ],
        folders: [],
        enabled: false,
      }),
  })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  show(setup, () => <DialogMemory edit={editor.edit} open={async () => {}} />)
  const frame = flat(await until(setup, "Left out"))
  expect(frame).toContain(dot("ORBIT.local.md"))
  expect(frame).toContain("Auto memory: off")
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await settle(setup)
  expect(recorded.posted).toEqual([])
  expect(editor.edited).toEqual([])
  expect(setup.dialog.stack).toHaveLength(1)
})

// A listing the server refuses or cannot answer is read as an error, never left in the resource: reading an errored
// resource throws again, and the root ErrorBoundary would replace the whole UI (class 7, 13). Each failure closes the
// dialog with its message written out through `plain`; a listing that answers is the control.
test("a listing that fails closes the dialog with the server's message and throws nothing", async () => {
  const failures: [string, () => Response][] = [
    [
      "not trusted",
      () => json({ _tag: "UntrustedFolderError", message: "not trusted \u001b[31m", directory: "x", persistent: true }, { status: 403 }),
    ],
    ["older server", () => new Response("Not Found", { status: 404 })],
    ["server error", () => json({ _tag: "UnknownError", message: "broke \u001b[2J" }, { status: 500 })],
    [
      "lost connection",
      () => {
        throw new TypeError("connection refused \u0007")
      },
    ],
  ]
  for (const [name, fail] of failures) {
    await using tmp = await project()
    const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
    await using setup = await renderLocal({
      directory: tmp.dir,
      url: "http://127.0.0.1:4096",
      fetch: (url, request) =>
        url.pathname === "/api/location/memory" && request.method === "GET" ? fail() : recorded.fetch(url, request),
    })
    forget()
    show(setup, () => <DialogMemory open={async () => {}} />)
    await wait(() => setup.dialog.stack.length === 0 && toasts.current?.currentToast != null)
    const frame = await settle(setup)
    expect({ name, stack: setup.dialog.stack.length, variant: toasts.current?.currentToast?.variant }).toEqual({
      name,
      stack: 0,
      variant: "error",
    })
    expect(toasts.current?.currentToast?.message).toStartWith("Could not list memory: ")
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("\u0007")
    expect(recorded.posted).toEqual([])
    if (name === "not trusted") expect(toasts.current?.currentToast?.message).toContain("not trusted \\x1b[31m")
    // An answer the API does not declare reaches the client as its status alone.
    if (name === "server error") expect(toasts.current?.currentToast?.message).toContain("500")
    if (name === "lost connection") expect(toasts.current?.currentToast?.message).toContain("connection refused \\x07")
  }

  // The control: the same dialog over a listing that answers stays open and draws it.
  await using tmp = await project()
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  show(setup, () => <DialogMemory open={async () => {}} />)
  await until(setup, "Project memory")
  expect(setup.dialog.stack).toHaveLength(1)
})

test("a listing that fails after the toggle closes the dialog with its message", async () => {
  await using tmp = await project()
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  await using setup = await renderLocal({
    directory: tmp.dir,
    url: "http://127.0.0.1:4096",
    // The first listing answers; the one the toggle asks for afterwards fails.
    fetch: (url, request) =>
      url.pathname === "/api/location/memory" && request.method === "GET" && recorded.listed() >= 1
        ? json({ _tag: "UnknownError", message: "gone \u001b[2J" }, { status: 500 })
        : recorded.fetch(url, request),
  })
  forget()
  show(setup, () => <DialogMemory open={async () => {}} />)
  await until(setup, "Auto memory: on")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await wait(() => setup.dialog.stack.length === 0)
  await settle(setup)
  expect(recorded.patched).toEqual([{ memory: { enabled: false } }])
  expect(setup.dialog.stack).toHaveLength(0)
  expect(toasts.current?.currentToast).toMatchObject({ variant: "error" })
  expect(toasts.current?.currentToast?.message).toStartWith("Could not list memory: ")
  expect(toasts.current?.currentToast?.message).toContain("500")
})

test("a toggle whose write is refused shows the server's message through plain and keeps the dialog", async () => {
  await using tmp = await project()
  const recorded = server(tmp.dir, { listing: () => listing(tmp.dir) })
  await using setup = await renderLocal({
    directory: tmp.dir,
    url: "http://127.0.0.1:4096",
    fetch: (url, request) =>
      url.pathname === "/api/experimental/config" && request.method === "PATCH"
        ? json({ _tag: "InvalidRequestError", message: "cannot write \u001b[31m", field: "memory", kind: "refused" }, { status: 400 })
        : recorded.fetch(url, request),
  })
  forget()
  show(setup, () => <DialogMemory open={async () => {}} />)
  await until(setup, "Auto memory: on")
  setup.mockInput.pressArrow("up")
  setup.mockInput.pressEnter()
  await wait(() => recorded.listed() >= 2 && toasts.current?.currentToast != null)
  const frame = await settle(setup)
  expect(toasts.current?.currentToast?.variant).toBe("error")
  expect(toasts.current?.currentToast?.message).toContain("cannot write \\x1b[31m")
  expect(frame).not.toContain("\u001b")
  expect(setup.dialog.stack).toHaveLength(1)
})

// As the reference does, the chosen place is kept rather than the row: a project file made from the Project memory row
// comes back as a loaded file with a file target, and that file is focused the next time.
test("a user or project file made from its row is focused the next time, now listed as a loaded file", async () => {
  await using tmp = await project()
  const editor = editing()
  const agents = path.join(tmp.dir, "AGENTS.md")
  const other = path.join(tmp.dir, "x.md")
  // The missing file is listed at its default spelling, through a link; the server answers, and then lists, its real place.
  const spelled = path.join(tmp.dir, "link", "AGENTS.md")
  const state = { made: false }
  const recorded = server(tmp.dir, {
    listing: () =>
      listing(tmp.dir, {
        files: [
          { path: other, kind: "project", chars: 1, exists: true, target: fileTarget(other) },
          state.made
            ? { path: agents, kind: "project", chars: 0, role: "project", exists: true, target: fileTarget(agents) }
            : { path: spelled, kind: "project", chars: 0, role: "project", exists: false, target: { type: "scope", scope: "project" } },
        ],
        folders: [],
      }),
    answer: (target) => {
      state.made = true
      return json({ data: { path: target.type === "scope" ? agents : target.path, created: target.type === "scope", type: "file" } })
    },
  })
  await using setup = await renderLocal({ directory: tmp.dir, url: "http://127.0.0.1:4096", fetch: recorded.fetch })
  const dialog = () => <DialogMemory edit={editor.edit} open={async () => {}} />
  show(setup, dialog)
  await until(setup, "Project memory")
  // No earlier choice names a file here, so the first file is focused and one step down is Project memory.
  setup.mockInput.pressArrow("down")
  setup.mockInput.pressEnter()
  await wait(() => editor.edited.length > 0 && setup.dialog.stack.length === 0)
  expect(recorded.posted).toEqual([{ type: "scope", scope: "project" }])

  show(setup, dialog)
  await until(setup, "Project memory")
  setup.mockInput.pressEnter()
  await wait(() => editor.edited.length > 1)
  expect(recorded.posted).toEqual([{ type: "scope", scope: "project" }, fileTarget(agents)])
  expect(editor.edited).toEqual([agents, agents])
})
