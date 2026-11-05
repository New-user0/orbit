// clients-ux-15 part 2: the chat panel's review of an Edit or Write approval, the changes of one prompt and the
// confirmed restore. The review lives in `src/review.ts`, which knows nothing of VS Code, so it runs here against a real
// `orb serve` (folders trusted only by a grant), real folders with marker files, and recorders that wrap the real disk
// and the real `fetch`, so a test sees what was touched or sent. Only the editor itself is a stand-in: `Host` records the
// tabs the review would open and close.
//
// The door (classes 3, 4 and 6): a file is read only when its real path is inside one of the folders the server names
// for the session and inside one of the window's folders, a share or device spelling is refused before the disk is
// touched, and the value read is the value checked. Every button that changes a file answers through the server
// (classes 8 and 12), and a tab the extension closes itself answers nothing.
import { afterAll, afterEach, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { Orbit, type OrbitEvent } from "@orbit/client"
import { createTwoFilesPatch, formatPatch, structuredPatch } from "diff"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Controller, permissionItem, type Update } from "../src/controller"
import type { Item } from "../src/protocol"
import {
  changedNotice,
  changesView,
  contained,
  disk,
  restoreQuestion,
  Review,
  sides,
  tabTitle,
  type Changes,
  type Disk,
  type Folders,
  type Host,
  type Outcome,
  type Tab,
} from "../src/review"
import { answeredLabel } from "../src/webview/approval"
import { serve, until } from "./fixture/serve"

setDefaultTimeout(60_000)

// A scripted OpenAI-compatible model. A prompt `CALLS <steps> END` names the tool calls of each step; once they are spent,
// and for any other prompt, it answers with text.
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json()
    if (!body.tools) return sse([{ role: "assistant", content: "Title" }], "stop")
    const messages: Array<{ role: string; content?: unknown }> = body.messages
    const index = messages.findLastIndex((message) => message.role === "user")
    const text = textOf(messages[index]?.content)
    const at = text.lastIndexOf("CALLS ")
    const steps: Array<Array<{ name: string; args: unknown }>> =
      at === -1 ? [] : JSON.parse(text.slice(at + 6, text.indexOf(" END", at)))
    const step = steps[messages.slice(index + 1).filter((message) => message.role === "assistant").length]
    if (!step || step.length === 0) return sse([{ role: "assistant", content: "done" }], "stop")
    return sse(
      [
        {
          role: "assistant",
          tool_calls: step.map((call, position) => ({
            index: position,
            id: `call_${crypto.randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
      ],
      "tool_calls",
    )
  },
})

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-review-")))
const project = path.join(root, "project")
const outside = path.join(root, "outside")
const other = path.join(root, "other")
const main = path.join(root, "main")
const tree = path.join(root, "tree")
// The folder the model really edits in: a git repository with no links, so its snapshots can be restored.
const work = path.join(root, "work")
const SECRET = "SECRET-MARKER-41"
const marker = path.join(outside, "marker.txt")
const inside = path.join(project, "a.txt")
const host = "orbit-test.invalid"
// The marker holds the same text as the file inside, so a patch would apply to either: a refusal is never because the
// patch failed, and a marker that was read would show its secret.
const text = `alpha\nbeta\n${SECRET}\n`
const proposal = `alpha\nBETA\n${SECRET}\n`
const patch = createTwoFilesPatch("a.txt", "a.txt", text, proposal)
const added = createTwoFilesPatch("new.txt", "new.txt", "", "fresh\n")
const linkType = process.platform === "win32" ? "junction" : "dir"
let server: Awaited<ReturnType<typeof serve>>
const opened: Controller[] = []

beforeAll(async () => {
  await Promise.all(
    [project, outside, other, main, work, path.join(project, "sub"), path.join(root, "removed")].map((folder) =>
      fs.mkdir(folder, { recursive: true }),
    ),
  )
  await Promise.all([
    Bun.write(inside, text),
    Bun.write(marker, text),
    Bun.write(path.join(other, "marker.txt"), text),
    Bun.write(path.join(project, "sub", "b.txt"), text),
    Bun.write(path.join(main, "m.txt"), text),
    Bun.write(
      path.join(root, "config", "orbit.json"),
      JSON.stringify({
        model: "test/test-model",
        // Edits inside the folder are allowed by default; ask, so that every Edit and Write is a question to review.
        permissions: [{ action: "edit", resource: "*", effect: "ask" }],
        providers: {
          test: {
            name: "Test",
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { apiKey: "test", baseURL: `http://127.0.0.1:${llm.port}/v1` },
            models: {
              "test-model": {
                name: "Test Model",
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: { input: 0, output: 0 },
                limit: { context: 100_000, output: 10_000 },
              },
            },
          },
        },
      }),
    ),
  ])
  // A link in the project to the folder outside, one to a folder inside it, and one that leads nowhere.
  await fs.symlink(outside, path.join(project, "link"), linkType)
  await fs.symlink(path.join(project, "sub"), path.join(project, "alias"), linkType)
  await fs.symlink(path.join(root, "removed"), path.join(project, "gone"), linkType)
  await fs.rm(path.join(root, "removed"), { recursive: true })
  git(project, "init", "--quiet")
  git(work, "init", "--quiet")
  git(main, "init", "--quiet")
  git(main, "add", ".")
  git(main, "commit", "--quiet", "-m", "init")
  git(main, "worktree", "add", "--quiet", tree)
  server = await serve(root)
  for (const folder of [project, main, work])
    await server.client.location.trust.update({ location: { directory: folder }, trust: true, persist: false })
}, 120_000)

afterEach(() => {
  for (const controller of opened.splice(0)) controller.dispose()
})

afterAll(async () => {
  await server?.stop()
  await llm.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", ...args], { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function sse(deltas: Array<Record<string, unknown>>, finish: string) {
  const chunks = [
    ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: { text?: string }) => part.text ?? "").join("")
}

const calls = (...steps: Array<Array<{ name: string; args: unknown }>>) => `CALLS ${JSON.stringify(steps)} END`
const read = (file: string) => ({ name: "Read", args: { file_path: file } })
const write = (file: string, content: string) => ({ name: "Write", args: { file_path: file, content } })

// The real disk, with every access written down.
function recorded() {
  const log: string[] = []
  const recorder: Disk = {
    realpath: (file) => {
      log.push(`realpath ${file}`)
      return disk.realpath(file)
    },
    lstat: (file) => {
      log.push(`lstat ${file}`)
      return disk.lstat(file)
    },
    readFile: (file) => {
      log.push(`read ${file}`)
      return disk.readFile(file)
    },
  }
  return { log, recorder, reads: () => log.filter((call) => call.startsWith("read ")).map((call) => call.slice(5)) }
}

// The real fetch, with every request written down.
function recording(alter?: (url: URL, init: RequestInit | undefined) => Promise<Response> | undefined) {
  const sent: Array<{ method: string; path: string; body?: string }> = []
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    sent.push({ method: init?.method ?? "GET", path: url.pathname, body: typeof init?.body === "string" ? init.body : undefined })
    return alter?.(url, init) ?? fetch(input, init)
  }) as typeof fetch
  return { sent, fetcher }
}

function client(fetcher?: typeof fetch) {
  return Orbit.make({ baseUrl: server.url, headers: { authorization: `Basic ${btoa("orbit:secret")}` }, fetch: fetcher })
}

// A chat in `directory`. With `auto`, every question is allowed as it comes.
async function chat(
  directory: string,
  options: { fetcher?: typeof fetch; auto?: boolean; wait?: { read: number; grant: number } } = {},
) {
  const items = new Map<string, Item>()
  const updates: Update[] = []
  const holder: { controller?: Controller } = {}
  const controller = new Controller(
    client(options.fetcher),
    directory,
    (update) => {
      updates.push(update)
      if (update.type !== "item") return
      items.set(update.item.id, update.item)
      if (options.auto && update.item.type === "permission" && update.item.status === "pending")
        void holder.controller?.reply(update.item.id, "once")
    },
    async () => "later",
    options.wait ?? { read: 20_000, grant: 20_000 },
  )
  holder.controller = controller
  opened.push(controller)
  // The event stream is connected before the first prompt, so no event is missed.
  await Bun.sleep(500)
  const idle = (times = 1) =>
    until(() => (updates.filter((update) => update.type === "busy" && !update.busy).length >= times ? true : undefined))
  const question = () =>
    until(() =>
      [...items.values()].find(
        (item): item is Extract<Item, { type: "permission" }> => item.type === "permission" && item.status === "pending",
      ),
    )
  const notes = () =>
    [...items.values()].flatMap((item) => (item.type === "note" ? [{ text: item.text, tone: item.tone }] : []))
  return { controller, items, updates, idle, question, notes }
}

// What the review would do in the editor, written down.
function editor(
  options: {
    controller?: Controller
    folders?: ReadonlyArray<string>
    window?: ReadonlyArray<string>
    reply?: (id: string, decision: "once" | "reject", content?: string) => Promise<Outcome>
  } = {},
) {
  const tabs: Tab[] = []
  const views: Changes[] = []
  const closed: string[] = []
  const revealed: string[] = []
  const notes: Array<{ text: string; tone: string }> = []
  const warnings: string[] = []
  const replies: unknown[][] = []
  const host: Host = {
    reply: (id, decision, content) => {
      replies.push(content === undefined ? [id, decision] : [id, decision, content])
      if (options.reply) return options.reply(id, decision, content)
      if (options.controller) return options.controller.reply(id, decision, content)
      return Promise.resolve("sent")
    },
    folders: async (sessionID): Promise<Folders> => {
      if (options.folders) return { folders: options.folders }
      if (options.controller) return options.controller.folders(sessionID)
      return { refused: "unavailable" }
    },
    workspace: () => options.window ?? [root],
    show: async (tab) => void tabs.push(tab),
    changes: async (view) => void views.push(view),
    close: async (titles) => void closed.push(...titles),
    reveal: async (title) => void revealed.push(title),
    note: (text, tone) => void notes.push({ text, tone }),
    warn: (text) => void warnings.push(text),
  }
  return { host, tabs, views, closed, revealed, notes, warnings, replies }
}

function item(files: ReadonlyArray<unknown>, options: { revisable?: boolean; action?: string; sessionID?: string } = {}) {
  return permissionItem({
    id: `per_${crypto.randomUUID().slice(0, 8)}`,
    sessionID: options.sessionID ?? "ses_review",
    action: options.action ?? "Edit",
    resources: ["a.txt"],
    revisable: options.revisable ?? true,
    metadata: { files },
  })
}

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes)
const left = (review: Review, tab: Tab) => review.text(tab.left.path)
const right = (review: Review, tab: Tab) =>
  tab.right.scheme === "orbit-review" ? decode(review.provider.readFile(tab.right.path)) : review.text(tab.right.path)

test("a file really inside the session's folder and the window is read and shown", async () => {
  const seen = recorded()
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host, seen.recorder)

  expect(await contained(inside, { session: [project], window: [project] }, disk)).toBe(await fs.realpath(inside))
  expect(await review.open(item([{ file: "a.txt", place: inside, patch }]), false)).toBe(true)

  const tab = shown.tabs[0]!
  expect(shown.tabs).toHaveLength(1)
  expect(tab).toMatchObject({ mode: "review", left: { scheme: "orbit-proposed" }, right: { scheme: "orbit-review" } })
  expect(left(review, tab)).toBe(text)
  expect(right(review, tab)).toBe(proposal)
  expect(seen.reads()).toEqual([await fs.realpath(inside)])
  expect(shown.notes).toEqual([])
})

describe("a path that is not really inside the session's folder is shown as text and never read", () => {
  const rows: Array<{ name: string; file: Record<string, unknown>; platform?: NodeJS.Platform; spelling?: boolean }> = [
    { name: "outside", file: { file: "marker.txt", place: marker, patch } },
    { name: "dot-dot", file: { file: "marker.txt", place: [project, "..", "outside", "marker.txt"].join(path.sep), patch } },
    { name: "link-out", file: { file: "link/marker.txt", place: path.join(project, "link", "marker.txt"), patch } },
    {
      name: "dangling",
      file: { file: "gone/new.txt", place: path.join(project, "gone", "new.txt"), patch: added, status: "added" },
    },
    {
      name: "added-under-link",
      file: { file: "link/new.txt", place: path.join(project, "link", "new.txt"), patch: added, status: "added" },
    },
    {
      name: "git-bash",
      file: { file: "a.txt", place: `/${inside[0]?.toLowerCase()}${inside.slice(2).replaceAll("\\", "/")}`, patch },
      platform: "win32",
      spelling: true,
    },
    { name: "root-relative", file: { file: "a.txt", place: inside.slice(2), patch }, platform: "win32", spelling: true },
    { name: "relative", file: { file: "a.txt", place: "a.txt", patch }, spelling: true },
    { name: "relative, no place", file: { file: "a.txt", patch }, spelling: true },
    { name: "move-from-outside", file: { file: "moved.txt", place: path.join(project, "moved.txt"), from: marker, patch } },
  ]
  for (const row of rows)
    test.skipIf(row.platform !== undefined && row.platform !== process.platform)(row.name, async () => {
      const seen = recorded()
      const shown = editor({ folders: [project], window: [root] })
      const review = new Review(shown.host, seen.recorder)

      expect(await review.open(item([row.file]), true)).toBe(false)

      expect(shown.tabs).toEqual([])
      expect(seen.reads()).toEqual([])
      // A path that is not a local absolute one is refused by its spelling, before the disk is asked anything: Windows
      // would read a root-relative or Git Bash path from the current drive.
      if (row.spelling) expect(seen.log).toEqual([])
      // One muted note names the file, written out; the secret of the marker is nowhere.
      expect(shown.notes).toHaveLength(1)
      expect(shown.notes[0]?.tone).toBe("muted")
      expect(JSON.stringify([shown.notes, shown.warnings])).not.toContain(SECRET)
      // Opened on its own, the same request opens nothing and says nothing.
      const quiet = editor({ folders: [project], window: [root] })
      expect(await new Review(quiet.host, seen.recorder).open(item([row.file]), false)).toBe(false)
      expect([quiet.tabs, quiet.notes, seen.reads()]).toEqual([[], [], []])
    })
})

describe("a share or device spelling is refused before the disk is touched", () => {
  const rows = [
    { name: "unc", place: `\\\\${host}\\share\\a.txt` },
    { name: "forward-slash unc", place: `//${host}/share/a.txt` },
    { name: "device unc", place: `\\\\?\\UNC\\${host}\\share\\a.txt` },
    { name: "device drive", place: `\\\\?\\${inside}` },
    { name: "dot device", place: `\\\\.\\${inside}` },
    { name: "nt prefix", place: `\\??\\UNC\\${host}\\share\\a.txt` },
  ]
  for (const row of rows)
    test(row.name, async () => {
      const seen = recorded()
      const shown = editor({ folders: [project], window: [root] })
      expect(await new Review(shown.host, seen.recorder).open(item([{ file: "a.txt", place: row.place, patch }]), true)).toBe(
        false,
      )
      expect(seen.log).toEqual([])
      expect(shown.tabs).toEqual([])
      expect(await contained(row.place, { session: [project], window: [root] }, seen.recorder)).toBeUndefined()
      expect(seen.log).toEqual([])
    })

  // Making a link needs Developer Mode or an elevated shell on Windows. Where it cannot be made the row says so.
  test.skipIf(process.platform !== "win32")("link-to-share", async () => {
    const link = path.join(project, "share")
    const made = await fs.symlink(`\\\\${host}\\share`, link, "dir").then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code,
    )
    if (made !== true) return console.warn(`link-to-share skipped: cannot make a link here (${made})`)
    const seen = recorded()
    const shown = editor({ folders: [project], window: [root] })
    await new Review(shown.host, seen.recorder).open(item([{ file: "share/a.txt", place: path.join(link, "a.txt"), patch }]), true)
    expect(shown.tabs).toEqual([])
    // The link is read part by part and never opened: no real path of anything under it is asked for.
    expect(seen.log.filter((call) => call.includes(link) || call.includes(host))).toEqual([])
    await fs.rm(link, { force: true, recursive: true })
  })
})

test("a session or window folder spelled as a share or a relative path is dropped before the disk is touched", async () => {
  const relative = "orbit-relative-folder"
  const share = `//${host}/share`
  const seen = recorded()
  const shown = editor({ folders: [share, relative, project], window: [`\\\\${host}\\share`, relative, root] })
  await new Review(shown.host, seen.recorder).open(item([{ file: "a.txt", place: inside, patch }]), true)
  // The folders spelled well still count, and the others are never asked about.
  expect(shown.tabs).toHaveLength(1)
  expect(seen.log.filter((call) => call.includes(relative) || call.includes(host))).toEqual([])
})

// A disk that answers as one where nothing is there, or where a path cannot be resolved for another reason.
function refusing(code: string, at: (file: string) => boolean) {
  const calls: string[] = []
  const fail = (file: string) => {
    calls.push(file)
    // A walk up that never ends is stopped here, so the test fails instead of hanging.
    if (calls.length > 200) return Promise.reject(new Error("the walk up did not end"))
    return Promise.reject(Object.assign(new Error(code), { code }))
  }
  const reader: Disk = {
    realpath: (file) => (at(file) ? fail(file) : disk.realpath(file)),
    lstat: (file) => (at(file) ? fail(file) : disk.lstat(file)),
    readFile: (file) => disk.readFile(file),
  }
  return { reader, calls }
}

test("a path whose drive or root is not there is refused, and the walk up ends at the root", async () => {
  const nowhere = refusing("ENOENT", () => true)
  const file = path.join(path.parse(project).root, "orbit-nowhere", "a.txt")
  expect(await contained(file, { session: [project], window: [root] }, nowhere.reader)).toBeUndefined()
  expect(nowhere.calls.length).toBeLessThan(10)
})

test("a path the disk cannot resolve for another reason than its absence is refused, not taken for a file to add", async () => {
  const locked = path.join(project, "locked.txt")
  const denied = refusing("EACCES", (file) => file === locked)
  expect(await contained(locked, { session: [project], window: [root] }, denied.reader)).toBeUndefined()
  // The control: the same path when it is only missing is a file still to be added.
  const missing = refusing("ENOENT", (file) => file === locked)
  expect(await contained(locked, { session: [project], window: [root] }, missing.reader)).toBe(
    path.join(await fs.realpath(project), "locked.txt"),
  )
})

test.skipIf(process.platform !== "win32")("a case variant or short name of an inside file is inside", async () => {
  const variant = inside.replace(/project/i, "PROJECT")
  const result = Bun.spawnSync([process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"for %I in ("${inside}") do @echo %~sI"`], {
    windowsVerbatimArguments: true,
  })
  const short = result.stdout.toString().trim()
  for (const place of [variant, ...(short && short !== inside ? [short] : [])]) {
    const seen = recorded()
    const shown = editor({ folders: [project.toUpperCase()], window: [root] })
    const review = new Review(shown.host, seen.recorder)
    expect(await review.open(item([{ file: "a.txt", place, patch }]), true)).toBe(true)
    expect(right(review, shown.tabs[0]!)).toBe(proposal)
    expect(seen.reads()).toEqual([await fs.realpath(inside)])
  }
})

test("an added file inside opens against an empty left side", async () => {
  const seen = recorded()
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host, seen.recorder)
  await review.open(item([{ file: "new.txt", place: path.join(project, "new.txt"), patch: added, status: "added" }]), false)
  const tab = shown.tabs[0]!
  expect(tab.mode).toBe("review")
  expect(left(review, tab)).toBe("")
  expect(right(review, tab)).toBe("fresh\n")
  expect(seen.reads()).toEqual([])
})

test("a move inside shows the old file against the proposal at its new name", async () => {
  const seen = recorded()
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host, seen.recorder)
  const moved = createTwoFilesPatch("a.txt", "moved.txt", text, proposal)
  await review.open(
    item([{ file: "moved.txt", place: path.join(project, "moved.txt"), from: inside, patch: moved }], {
      action: "Patch",
      revisable: false,
    }),
    true,
  )
  const tab = shown.tabs[0]!
  expect(tab.mode).toBe("preview")
  expect(tab.title).toMatch(/^Orbit: moved\.txt \([a-z0-9]{6}\)$/)
  expect(left(review, tab)).toBe(text)
  expect(right(review, tab)).toBe(proposal)
  expect(seen.reads()).toEqual([await fs.realpath(inside)])
})

test("the file read is the real path that was checked", async () => {
  const seen = recorded()
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host, seen.recorder)
  // Spelled through a link inside the project and through `..`; read where they really are.
  for (const place of [path.join(project, "alias", "b.txt"), [project, "sub", "..", "a.txt"].join(path.sep)]) {
    const checked = await contained(place, { session: [project], window: [project] }, disk)
    expect(checked).toBeDefined()
    expect(checked).not.toBe(place)
    seen.log.length = 0
    await review.open(item([{ file: "b.txt", place, patch }]), true)
    expect(seen.reads()).toEqual([checked!])
  }
})

describe("the session's folders as the server names them", () => {
  test("containment uses the session's folders as the server names them", async () => {
    const session = await server.client.session.create({ location: { directory: project } })
    const log = recording()
    const { controller } = await chat(project, { fetcher: log.fetcher })
    log.sent.length = 0
    const shown = editor({ controller, window: [other, project] })
    const seen = recorded()
    const review = new Review(shown.host, seen.recorder)
    // The folder of the editor in view (`other`) holds a marker; it is not the session's folder.
    await review.open(item([{ file: "marker.txt", place: path.join(other, "marker.txt"), patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toEqual([])
    expect(seen.reads()).toEqual([])
    // The chat's folder's trust, the session, the trust of the session's own folder, and its Location.
    expect(log.sent.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /api/location/trust",
      `GET /api/session/${session.id}`,
      "GET /api/location/trust",
      "GET /api/location",
    ])
    await review.open(item([{ file: "a.txt", place: inside, patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
  })

  test("the folders are the session's own, not the folder the chat was opened in", async () => {
    const session = await server.client.session.create({ location: { directory: project } })
    // The chat's folder is another trusted project: its files are not the session's.
    const { controller } = await chat(main)
    const shown = editor({ controller, window: [root] })
    const seen = recorded()
    const review = new Review(shown.host, seen.recorder)
    await review.open(item([{ file: "m.txt", place: path.join(main, "m.txt"), patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toEqual([])
    expect(seen.reads()).toEqual([])
    await review.open(item([{ file: "a.txt", place: inside, patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
  })

  test("a session in a subfolder works in its whole project", async () => {
    const session = await server.client.session.create({ location: { directory: path.join(project, "sub") } })
    const { controller } = await chat(project)
    const folders = await controller.folders(session.id)
    expect("folders" in folders && folders.folders.map((folder) => path.relative(project, folder))).toEqual(["sub", ""])
    const shown = editor({ controller, window: [root] })
    // A file of the project outside the session's own subfolder is still one its file tools work on.
    await new Review(shown.host).open(item([{ file: "a.txt", place: inside, patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
  })

  test("...and the session's folder may be any workspace folder", async () => {
    const session = await server.client.session.create({ location: { directory: project } })
    const { controller } = await chat(project)
    const shown = editor({ controller, window: [other, project] })
    await new Review(shown.host).open(item([{ file: "a.txt", place: inside, patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
  })

  test("a session folder outside every workspace folder shows every path as text", async () => {
    const session = await server.client.session.create({ location: { directory: project } })
    const { controller } = await chat(project)
    const shown = editor({ controller, window: [other] })
    const seen = recorded()
    await new Review(shown.host, seen.recorder).open(
      item([{ file: "a.txt", place: inside, patch }], { sessionID: session.id }),
      true,
    )
    expect(shown.tabs).toEqual([])
    expect(seen.reads()).toEqual([])
    expect(shown.notes).toHaveLength(1)
  })

  test("a file inside the project but outside the window's folders is shown as text", async () => {
    const session = await server.client.session.create({ location: { directory: project } })
    const { controller } = await chat(project)
    const shown = editor({ controller, window: [path.join(project, "sub")] })
    const seen = recorded()
    const review = new Review(shown.host, seen.recorder)
    await review.open(item([{ file: "a.txt", place: inside, patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toEqual([])
    expect(seen.reads()).toEqual([])
    // The control: a file in the window's folder opens.
    await review.open(item([{ file: "sub/b.txt", place: path.join(project, "sub", "b.txt"), patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
  })

  test("a file of a linked worktree session is inside its worktree", async () => {
    const session = await server.client.session.create({ location: { directory: tree } })
    const location = await server.client.location.get({ location: { directory: tree } })
    // The trust root of a linked worktree is the main checkout; the folder its file tools work in is the worktree.
    expect(path.relative(location.project.directory, tree)).toBe("")
    expect(path.relative(location.project.canonical, main)).toBe("")
    const { controller } = await chat(tree)
    const shown = editor({ controller, window: [root] })
    const seen = recorded()
    const review = new Review(shown.host, seen.recorder)
    await review.open(item([{ file: "m.txt", place: path.join(tree, "m.txt"), patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
    // The main checkout is the trust root, not a folder the session works in.
    await review.open(item([{ file: "m.txt", place: path.join(main, "m.txt"), patch }], { sessionID: session.id }), true)
    expect(shown.tabs).toHaveLength(1)
    expect(seen.reads()).toEqual([await fs.realpath(path.join(tree, "m.txt"))])
  })

  test("a session whose own folder is not trusted names no folders, though the chat's folder is trusted", async () => {
    // A session the chat continues from another folder, whose trust is taken back while the chat is open.
    const folder = path.join(root, "elsewhere")
    await fs.mkdir(folder, { recursive: true })
    await Bun.write(path.join(folder, "a.txt"), text)
    git(folder, "init", "--quiet")
    await server.client.location.trust.update({ location: { directory: folder }, trust: true, persist: false })
    const session = await server.client.session.create({ location: { directory: folder } })
    const { controller } = await chat(project)
    const shown = editor({ controller, window: [root] })
    const seen = recorded()
    const review = new Review(shown.host, seen.recorder)
    const change = () => item([{ file: "a.txt", place: path.join(folder, "a.txt"), patch }], { sessionID: session.id })
    // The control: while the session's folder is trusted, its file opens.
    await review.open(change(), true)
    expect(shown.tabs).toHaveLength(1)
    await server.client.location.trust.update({ location: { directory: folder }, trust: false, persist: false })
    seen.log.length = 0
    expect(await controller.folders(session.id)).toEqual({ refused: "untrusted" })
    await review.open(change(), true)
    expect(shown.tabs).toHaveLength(1)
    expect(seen.log).toEqual([])
    expect(shown.notes.at(-1)?.text).toContain("the folder is not trusted")
  })

  test("a project folder that is a filesystem root is not one the session works in", async () => {
    const session = await server.client.session.create({ location: { directory: project } })
    // The server names the root as the project's folder, as it would for a repository at the root of a drive. The file
    // tools leave such a folder out, and so does the review.
    const rooted = recording((url, init) =>
      url.pathname === "/api/location"
        ? fetch(url, init).then(async (response) => {
            const body = await response.json()
            return Response.json({ ...body, project: { ...body.project, directory: path.parse(project).root } })
          })
        : undefined,
    )
    const { controller } = await chat(project, { fetcher: rooted.fetcher })
    const folders = await controller.folders(session.id)
    expect("folders" in folders && folders.folders.map((folder) => path.relative(project, folder))).toEqual([""])
    const shown = editor({ controller, window: [root] })
    const seen = recorded()
    await new Review(shown.host, seen.recorder).open(
      item([{ file: "marker.txt", place: marker, patch }], { sessionID: session.id }),
      true,
    )
    expect(shown.tabs).toEqual([])
    expect(seen.reads()).toEqual([])
  })
})

test("no server folders means text only", async () => {
  const session = await server.client.session.create({ location: { directory: project } })
  // A trusted session folder other than the chat's, so the trust read of the session's own folder is told apart by name.
  const own = path.join(root, "own-trust")
  await fs.mkdir(own, { recursive: true })
  git(own, "init", "--quiet")
  await server.client.location.trust.update({ location: { directory: own }, trust: true, persist: false })
  const elsewhere = await server.client.session.create({ location: { directory: own } })
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)))
  const fail = () => Promise.resolve(Response.json({ message: "no" }, { status: 500 }))
  // The server cannot name the location, takes longer than a read may, or does not know the session.
  const failing = recording((url) => (url.pathname === "/api/location" ? fail() : undefined))
  const hanging = recording((url, init) => (url.pathname === "/api/location" ? hang(init) : undefined))
  const slowSession = recording((url, init) => (url.pathname === `/api/session/${session.id}` ? hang(init) : undefined))
  // The trust read of the session's own folder fails, takes longer than a read may, or answers something unreadable:
  // that folder is not known to be trusted, and no folder is named (classes 3 and 7).
  const ownTrust = (answer: (init: RequestInit | undefined) => Promise<Response>) =>
    recording((url, init) =>
      url.pathname === "/api/location/trust" && decodeURIComponent(url.search).includes("own-trust")
        ? answer(init)
        : undefined,
    )
  const trustFailing = ownTrust(fail)
  const trustHanging = ownTrust(hang)
  const trustGarbled = ownTrust(() => Promise.resolve(Response.json({ trusted: "yes" })))
  // The fresh trust read of the chat's own folder fails, takes longer than a read may, answers something unreadable, or
  // finds a server too old to have one, while the session's folder answers trusted: the chat's folder is not known to
  // be trusted, so nothing more is asked and no folder is named (classes 1 and 7).
  const chatTrust = (answer: (init: RequestInit | undefined) => Promise<Response>) =>
    recording((url, init) =>
      url.pathname === "/api/location/trust" && !decodeURIComponent(url.search).includes("own-trust")
        ? answer(init)
        : undefined,
    )
  const chatFailing = chatTrust(fail)
  const chatHanging = chatTrust(hang)
  const chatGarbled = chatTrust(() => Promise.resolve(Response.json({ trusted: "yes" })))
  const chatOld = chatTrust(() => Promise.resolve(Response.json({ message: "no" }, { status: 404 })))
  // The controls: the session's own folder is named when its trust read answers, and the filter above matches only it.
  const named = async (fetcher: typeof fetch | undefined, sessionID: string) => {
    const folders = await (await chat(project, { fetcher })).controller.folders(sessionID)
    return "folders" in folders ? folders.folders.map((folder) => path.relative(root, folder)) : folders
  }
  expect(await named(undefined, elsewhere.id)).toEqual(["own-trust", "own-trust"])
  expect(await named(trustFailing.fetcher, session.id)).toEqual(["project", "project"])
  for (const [fetcher, sessionID] of [
    [failing.fetcher, session.id],
    [hanging.fetcher, session.id],
    [slowSession.fetcher, session.id],
    [undefined, "ses_unknown"],
    [trustFailing.fetcher, elsewhere.id],
    [trustHanging.fetcher, elsewhere.id],
    [trustGarbled.fetcher, elsewhere.id],
    [chatFailing.fetcher, elsewhere.id],
    [chatHanging.fetcher, elsewhere.id],
    [chatGarbled.fetcher, elsewhere.id],
    [chatOld.fetcher, elsewhere.id],
  ] as const) {
    const { controller } = await chat(project, { fetcher, wait: { read: 3_000, grant: 20_000 } })
    expect(await controller.folders(sessionID)).toEqual({ refused: "unavailable" })
    const shown = editor({ controller, window: [root] })
    const seen = recorded()
    await new Review(shown.host, seen.recorder).open(item([{ file: "a.txt", place: inside, patch }], { sessionID }), true)
    expect(shown.tabs).toEqual([])
    expect(seen.log).toEqual([])
    expect(shown.notes).toHaveLength(1)
    expect(shown.notes[0]?.text).toContain("did not name the session's folder")
  }
})

describe("answers from a review tab", () => {
  // A real question: the model reads `name` and writes "two" over "one".
  async function asked(name: string, options: { fetcher?: typeof fetch; wait?: { read: number; grant: number } } = {}) {
    const file = path.join(work, name)
    await Bun.write(file, "one\n")
    const opened = await chat(work, options)
    await opened.controller.send(calls([read(name)], [write(name, "two\n")]))
    const question = await opened.question()
    if (!question) throw new Error("no question was asked")
    return { ...opened, file, question }
  }
  const replies = (sent: ReturnType<typeof recording>["sent"]) =>
    sent.filter((call) => call.method === "POST" && call.path.endsWith("/reply")).map((call) => JSON.parse(call.body ?? "{}"))

  test("saving the proposal replies once with the saved text, and the file holds it", async () => {
    const log = recording()
    const run = await asked("save.txt", { fetcher: log.fetcher })
    const shown = editor({ controller: run.controller, window: [work] })
    const review = new Review(shown.host)
    expect(await review.open(run.question, false)).toBe(true)
    const tab = shown.tabs[0]!
    expect([left(review, tab), right(review, tab)]).toEqual(["one\n", "two\n"])

    // The person saves, and Reject, Accept and the tab's close arrive while the answer is on its way: the first answer is
    // the only one.
    await Promise.all([
      review.provider.writeFile(tab.right.path, new TextEncoder().encode("mine\n")),
      review.reject(tab.right.path),
      review.accept(tab.right.path),
      review.closed(tab.title),
    ])
    await run.idle()

    expect(await Bun.file(run.file).text()).toBe("mine\n")
    expect(replies(log.sent)).toEqual([{ decision: "once", content: "mine\n" }])
    const answered = run.items.get(run.question.id)
    expect(answered).toMatchObject({ status: "once", revised: true })
    expect(answered?.type === "permission" && answeredLabel(answered)).toBe("Allowed with your changes")
    // The person closed the tab themselves, so the review has nothing left to close.
    expect(shown.closed).toEqual([])
    // The tab is gone: a later save or close of it answers nothing.
    await review.provider.writeFile(tab.right.path, new TextEncoder().encode("again\n"))
    await review.closed(tab.title)
    expect(replies(log.sent)).toHaveLength(1)
  })

  test("closing the review tab accepts the proposal unchanged", async () => {
    const log = recording()
    const run = await asked("close.txt", { fetcher: log.fetcher })
    const shown = editor({ controller: run.controller, window: [work] })
    const review = new Review(shown.host)
    await review.open(run.question, false)
    await review.closed(shown.tabs[0]!.title)
    await run.idle()
    expect(await Bun.file(run.file).text()).toBe("two\n")
    expect(replies(log.sent)).toEqual([{ decision: "once" }])
    const answered = run.items.get(run.question.id)
    expect(answered?.type === "permission" && answeredLabel(answered)).toBe("Allowed")
  })

  test("the Reject action rejects and the file is unchanged", async () => {
    const log = recording()
    const run = await asked("reject.txt", { fetcher: log.fetcher })
    const shown = editor({ controller: run.controller, window: [work] })
    const review = new Review(shown.host)
    await review.open(run.question, false)
    const tab = shown.tabs[0]!
    await review.reject(tab.right.path)
    await run.idle()
    expect(await Bun.file(run.file).text()).toBe("one\n")
    expect(replies(log.sent)).toEqual([{ decision: "reject" }])
    expect(shown.closed).toEqual([tab.title])
    // The close that follows is the extension's own: it answers nothing more.
    await review.closed(tab.title)
    expect(replies(log.sent)).toHaveLength(1)
  })

  test("saving the file as it was read is a reject and the tab closes", async () => {
    const log = recording()
    const run = await asked("same.txt", { fetcher: log.fetcher })
    const shown = editor({ controller: run.controller, window: [work] })
    const review = new Review(shown.host)
    await review.open(run.question, false)
    const tab = shown.tabs[0]!
    await review.provider.writeFile(tab.right.path, new TextEncoder().encode("one\n"))
    await run.idle()
    expect(await Bun.file(run.file).text()).toBe("one\n")
    expect(run.items.get(run.question.id)).toMatchObject({ status: "reject" })
    expect(shown.closed).toEqual([tab.title])
  })

  test("tabs the extension closes answer nothing: an answer elsewhere, a new prompt, the window closing", async () => {
    const log = recording()
    const run = await asked("closes.txt", { fetcher: log.fetcher })
    const shown = editor({ controller: run.controller, window: [work] })

    // A new prompt closes every Orbit tab, and VS Code then reports each one closed.
    const first = new Review(shown.host)
    await first.open(run.question, false)
    first.closeAll()
    await first.closed(shown.tabs[0]!.title)
    await first.provider.writeFile(shown.tabs[0]!.right.path, new TextEncoder().encode("x\n"))
    // The window closes: the review is disposed first, and no close or save after that answers.
    const second = new Review(shown.host)
    await second.open(run.question, false)
    second.dispose()
    await second.closed(shown.tabs[1]!.title)
    await second.provider.writeFile(shown.tabs[1]!.right.path, new TextEncoder().encode("x\n"))
    await second.reject(shown.tabs[1]!.right.path)
    // Nor does a disposed review open anything again.
    expect(await second.open(run.question, true)).toBe(false)
    expect(shown.tabs).toHaveLength(2)
    expect(replies(log.sent)).toEqual([])
    expect(shown.closed).toEqual([shown.tabs[0]!.title, shown.tabs[1]!.title])
    // The question is still pending on the server; it is answered on the card.
    expect((await server.client.permission.list({ sessionID: run.question.sessionID })).map((request) => request.id)).toEqual([
      run.question.id,
    ])
    const third = new Review(shown.host)
    await third.open(run.question, false)
    await run.controller.reply(run.question.id, "once")
    // The answer arrives: the tab closes, and its close event answers nothing.
    third.settled(run.question.id)
    await third.closed(shown.tabs[2]!.title)
    await run.idle()
    expect(replies(log.sent)).toEqual([{ decision: "once" }])
    expect(shown.closed.at(-1)).toBe(shown.tabs[2]!.title)
    expect(await Bun.file(run.file).text()).toBe("two\n")
  })

  test("a refused or late reply keeps the question pending and says why", async () => {
    // Refused: the server takes revised content only with a once reply (400, field content).
    const run = await asked("refused.txt")
    expect(await run.controller.reply(run.question.id, "always", "x\n")).toEqual({
      refused: "Revised content can only be given with a once reply",
    })
    expect(run.notes().at(-1)).toMatchObject({ tone: "error" })
    expect(run.notes().at(-1)?.text).toContain("Revised content can only be given with a once reply")
    expect(run.items.get(run.question.id)).toMatchObject({ status: "pending" })

    // Late: the reply takes longer than `limits.grant`. The save fails with a fixed sentence and the tab stays.
    const slow = recording((url, init) =>
      url.pathname.endsWith("/reply") ? Bun.sleep(1_000).then(() => fetch(url, init)) : undefined,
    )
    const late = await asked("late.txt", { fetcher: slow.fetcher, wait: { read: 20_000, grant: 200 } })
    const shown = editor({ controller: late.controller, window: [work] })
    const review = new Review(shown.host)
    await review.open(late.question, false)
    const failure = await review.provider.writeFile(shown.tabs[0]!.right.path, new TextEncoder().encode("mine\n")).then(
      () => undefined,
      (error: Error) => error.message,
    )
    // The server may still take an answer that came late, so the sentence does not say that nothing was decided.
    expect(failure).toBe(
      "The Orbit service did not answer in time. The card shows the question's state; answer again if it is still waiting.",
    )
    expect(shown.closed).toEqual([])
    expect(late.notes().at(-1)).toMatchObject({ tone: "error", text: failure })
    expect((await server.client.permission.list({ sessionID: late.question.sessionID })).map((request) => request.id)).toEqual([
      late.question.id,
    ])
    for (const pending of [run, late])
      await server.client.permission.reply({ sessionID: pending.question.sessionID, requestID: pending.question.id, decision: "reject" })
  })
})

test("a reply that loses to another answer is dropped quietly and its tab closes", async () => {
  const session = await server.client.session.create({ location: { directory: project } })
  const { controller, notes } = await chat(project)
  // A question this chat still shows as pending, which the server no longer has: another answer won.
  controller.handle({
    id: "evt_gone",
    created: Date.now(),
    type: "permission.asked",
    data: {
      id: "per_gone",
      sessionID: session.id,
      action: "Edit",
      resources: ["a.txt"],
      revisable: true,
      metadata: { files: [{ file: "a.txt", place: inside, patch }] },
    },
  } as OrbitEvent)
  const question = controller.permission("per_gone")!
  expect(await controller.reply("per_gone", "once", "x\n")).toBe("gone")
  const shown = editor({ controller, folders: [project], window: [project] })
  const review = new Review(shown.host)
  await review.open(question, false)
  const tab = shown.tabs[0]!
  await review.provider.writeFile(tab.right.path, new TextEncoder().encode("mine\n"))
  expect(shown.closed).toEqual([tab.title])
  expect([...notes(), ...shown.notes]).toEqual([])
})

test("an auto save keeps the draft and answers nothing; Accept sends the draft, and a close the proposal unchanged", async () => {
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host)
  const encode = (value: string) => new TextEncoder().encode(value)
  const opened = async () => {
    const question = item([{ file: "a.txt", place: inside, patch }])
    await review.open(question, false)
    return { id: question.id, tab: shown.tabs.at(-1)! }
  }
  // VS Code saved the draft on its own: the review keeps it as the tab's text and sends nothing.
  const accepted = await opened()
  review.willSave(accepted.tab.right.path, false)
  await review.provider.writeFile(accepted.tab.right.path, encode("draft\n"))
  expect(shown.replies).toEqual([])
  expect(decode(review.provider.readFile(accepted.tab.right.path))).toBe("draft\n")
  // Accept answers with the text the tab holds.
  await review.accept(accepted.tab.right.path)
  expect(shown.replies).toEqual([[accepted.id, "once", "draft\n"]])

  // Closing the tab is the proposal as it stands, whatever was saved on its own.
  const closed = await opened()
  review.willSave(closed.tab.right.path, false)
  await review.provider.writeFile(closed.tab.right.path, encode("draft\n"))
  await review.closed(closed.tab.title)
  expect(shown.replies.at(-1)).toEqual([closed.id, "once"])

  // A save the person makes after VS Code announced an auto save answers with its text.
  const manual = await opened()
  review.willSave(manual.tab.right.path, false)
  review.willSave(manual.tab.right.path, true)
  await review.provider.writeFile(manual.tab.right.path, encode("mine\n"))
  expect(shown.replies.at(-1)).toEqual([manual.id, "once", "mine\n"])

  // Each auto save covers one write: the save after it, which VS Code did not announce, answers.
  const later = await opened()
  review.willSave(later.tab.right.path, false)
  await review.provider.writeFile(later.tab.right.path, encode("draft\n"))
  await review.provider.writeFile(later.tab.right.path, encode("mine\n"))
  expect(shown.replies.at(-1)).toEqual([later.id, "once", "mine\n"])
  expect(shown.replies).toHaveLength(4)
})

test("a side the extension closes stays readable until VS Code reports its tab closed", async () => {
  // VS Code reads a side again after a save returns and before it closes a tab with unsaved edits; a side gone by then
  // fails the save, and VS Code asks the person whether to save.
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host)
  const encode = (value: string) => new TextEncoder().encode(value)
  const opened = async () => {
    const question = item([{ file: "a.txt", place: inside, patch }])
    await review.open(question, false)
    return { id: question.id, tab: shown.tabs.at(-1)! }
  }
  // A save that answers: the tab closes, and its sides stay until the close is reported.
  const saved = await opened()
  await review.provider.writeFile(saved.tab.right.path, encode("mine\n"))
  expect(shown.replies).toEqual([[saved.id, "once", "mine\n"]])
  expect(shown.closed).toEqual([saved.tab.title])
  expect(decode(review.provider.readFile(saved.tab.right.path))).toBe(proposal)
  expect(review.text(saved.tab.left.path)).toBe(text)
  // The folders above a side are folders, so VS Code never tries to make one.
  expect(review.provider.folder(path.posix.dirname(saved.tab.right.path))).toBe(true)
  expect(review.provider.folder("/")).toBe(true)
  expect(review.provider.folder(saved.tab.right.path)).toBe(false)
  expect(review.provider.folder("/nothing")).toBe(false)
  // The save VS Code makes before it closes the tab succeeds and answers nothing, and the tab is closed only once.
  await review.provider.writeFile(saved.tab.right.path, encode("again\n"))
  await review.accept(saved.tab.right.path)
  await review.reject(saved.tab.right.path)
  review.settled(saved.id)
  review.closeAll()
  expect(shown.closed).toEqual([saved.tab.title])
  expect(shown.replies).toHaveLength(1)
  await review.closed(saved.tab.title)
  expect(review.provider.readFile(saved.tab.right.path)).toBeUndefined()
  expect(review.text(saved.tab.left.path)).toBeUndefined()
  expect(review.provider.folder(path.posix.dirname(saved.tab.right.path))).toBe(false)

  // Answered elsewhere: the same.
  const elsewhere = await opened()
  review.settled(elsewhere.id)
  expect(decode(review.provider.readFile(elsewhere.tab.right.path))).toBe(proposal)
  await review.provider.writeFile(elsewhere.tab.right.path, encode("edited\n"))
  await review.closed(elsewhere.tab.title)
  expect(review.provider.readFile(elsewhere.tab.right.path)).toBeUndefined()
  expect(shown.replies).toEqual([[saved.id, "once", "mine\n"]])

  // A tab the person closes is gone at once: its close is the report.
  const closed = await opened()
  await review.closed(closed.tab.title)
  expect(review.provider.readFile(closed.tab.right.path)).toBeUndefined()
})

test("answering one question closes only its own tabs, and another question's tab still answers", async () => {
  // Parallel tool calls: three questions are open for review at once.
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host)
  const questions = [1, 2, 3].map(() => item([{ file: "a.txt", place: inside, patch }]))
  for (const question of questions) expect(await review.open(question, false)).toBe(true)
  const [saved, elsewhere, last] = shown.tabs
  // A save answers its own question, and only that question's tab closes.
  await review.provider.writeFile(saved!.right.path, new TextEncoder().encode("mine\n"))
  expect(shown.closed).toEqual([saved!.title])
  // An answer from elsewhere closes only its own question's tab too.
  review.settled(questions[1]!.id)
  expect(shown.closed).toEqual([saved!.title, elsewhere!.title])
  // The tab left open still answers, with the person's text.
  await review.provider.writeFile(last!.right.path, new TextEncoder().encode("theirs\n"))
  expect(shown.replies).toEqual([
    [questions[0]!.id, "once", "mine\n"],
    [questions[2]!.id, "once", "theirs\n"],
  ])
  expect(shown.closed).toEqual([saved!.title, elsewhere!.title, last!.title])
})

describe("an open still reading when its question is answered, a new prompt starts or the window closes shows nothing", () => {
  // The open waits on the server's folders or on the file's read; `act` runs while it waits.
  async function racing(act: (review: Review, id: string) => void, at: "folders" | "read") {
    const started = Promise.withResolvers<void>()
    const go = Promise.withResolvers<void>()
    const wait = () => {
      started.resolve()
      return go.promise
    }
    const shown = editor({ folders: [project], window: [project] })
    const host: Host = {
      ...shown.host,
      folders: async (sessionID) => {
        if (at === "folders") await wait()
        return shown.host.folders(sessionID)
      },
    }
    const reader: Disk = {
      ...disk,
      readFile: async (file) => {
        if (at === "read") await wait()
        return disk.readFile(file)
      },
    }
    const review = new Review(host, reader)
    const question = item([{ file: "a.txt", place: inside, patch }])
    const opening = review.open(question, false)
    await started.promise
    act(review, question.id)
    go.resolve()
    return { opened: await opening, shown, review, question }
  }
  const rows = [
    { name: "answered", act: (review: Review, id: string) => review.settled(id) },
    { name: "new prompt", act: (review: Review) => review.closeAll() },
    { name: "window closes", act: (review: Review) => review.dispose() },
  ]
  for (const row of rows)
    for (const at of ["folders", "read"] as const)
      test(`${row.name} while reading ${at}`, async () => {
        const run = await racing(row.act, at)
        expect(run.opened).toBe(false)
        expect(run.shown.tabs).toEqual([])
        expect(run.shown.closed).toEqual([])
        expect(run.shown.replies).toEqual([])
      })

  test("the control: an answer to another question leaves the open alone", async () => {
    for (const at of ["folders", "read"] as const) {
      const run = await racing((review) => review.settled("per_other"), at)
      expect(run.opened).toBe(true)
      expect(run.shown.tabs).toHaveLength(1)
      await run.review.closed(run.shown.tabs[0]!.title)
      expect(run.shown.replies).toEqual([[run.question.id, "once"]])
    }
  })
})

test("Open diff on a question open for review shows its tab again and opens no second one", async () => {
  const seen = recorded()
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host, seen.recorder)
  const question = item([{ file: "a.txt", place: inside, patch }])
  expect(await review.open(question, false)).toBe(true)
  const touched = seen.log.length
  // The card's "Open diff": the tab comes forward as it is, so the disk is not read again.
  expect(await review.open(question, true)).toBe(true)
  expect(shown.tabs).toHaveLength(1)
  expect(shown.revealed).toEqual([shown.tabs[0]!.title])
  expect(seen.log).toHaveLength(touched)

  // The click while the open on its own is still reading: whichever finishes second shows the first one's tab.
  const raced = item([{ file: "a.txt", place: inside, patch }])
  expect(await Promise.all([review.open(raced, false), review.open(raced, true)])).toEqual([true, true])
  expect(shown.tabs).toHaveLength(2)
  expect(shown.revealed).toEqual([shown.tabs[0]!.title, shown.tabs[1]!.title])
  // The one tab answers once when the person closes it.
  await review.closed(shown.tabs[1]!.title)
  expect(shown.replies).toEqual([[raced.id, "once"]])

  // A tab the extension is closing is not brought forward: a new prompt closed it while the question still waits, so
  // "Open diff" opens a fresh one.
  const waiting = item([{ file: "a.txt", place: inside, patch }])
  await review.open(waiting, false)
  review.closeAll()
  expect(await review.open(waiting, true)).toBe(true)
  expect(shown.tabs).toHaveLength(4)
  expect(shown.tabs.at(-1)).toMatchObject({ mode: "review" })
  expect(shown.revealed).toHaveLength(2)
  // A preview answers nothing, so each click opens it afresh, with the file as it is then.
  const previewed = item([{ file: "a.txt", place: inside, patch }], { revisable: false })
  await review.open(previewed, true)
  await review.open(previewed, true)
  expect(shown.tabs).toHaveLength(6)
  expect(shown.tabs.slice(-2).map((tab) => tab.mode)).toEqual(["preview", "preview"])
  expect(shown.revealed).toHaveLength(2)
})

test("two changes views of as many files keep their own texts when one of them closes", async () => {
  const shown = editor({ folders: [project], window: [root] })
  const review = new Review(shown.host)
  await review.changes([{ file: "a.txt", status: "modified", patch: whole("a.txt", "one\n", "two\n") }])
  await review.changes([{ file: "b.txt", status: "modified", patch: whole("b.txt", "three\n", "four\n") }])
  const [first, second] = shown.views
  expect(first!.title).not.toBe(second!.title)
  await review.closed(first!.title)
  const entry = second!.entries[0]!
  expect([review.text(entry.left.path), review.text(entry.right.path)]).toEqual(["three\n", "four\n"])
  expect(review.text(first!.entries[0]!.left.path)).toBeUndefined()
})

describe("a request without revisable opens a read-only preview and closing it answers nothing", () => {
  const rows = [
    {
      // A server older than the edited reply sends no `revisable` at all.
      name: "no revisable",
      request: permissionItem({
        id: "per_old",
        sessionID: "ses_review",
        action: "Edit",
        resources: ["a.txt"],
        metadata: { files: [{ file: "a.txt", place: inside, patch }] },
      }),
    },
    {
      name: "Patch",
      request: item(
        [
          { file: "a.txt", place: inside, patch },
          { file: "sub/b.txt", place: path.join(project, "sub", "b.txt"), patch },
        ],
        { action: "Patch", revisable: false },
      ),
    },
    {
      name: "ipynb",
      request: item([{ file: "n.ipynb", place: path.join(project, "N.IPYNB"), patch: added, status: "added" }]),
    },
    {
      // Only a question about one file is reviewed: one save answers it.
      name: "two files, revisable",
      request: item(
        [
          { file: "a.txt", place: inside, patch },
          { file: "sub/b.txt", place: path.join(project, "sub", "b.txt"), patch },
        ],
        { revisable: true },
      ),
    },
  ]
  for (const row of rows)
    test(row.name, async () => {
      const shown = editor({ folders: [project], window: [project] })
      const review = new Review(shown.host)
      // It does not open on its own.
      expect(await review.open(row.request, false)).toBe(false)
      expect(shown.tabs).toEqual([])
      await review.open(row.request, true)
      expect(shown.tabs.length).toBe(row.request.files.length)
      for (const tab of shown.tabs) {
        expect(tab).toMatchObject({ mode: "preview", right: { scheme: "orbit-proposed" } })
        await review.closed(tab.title)
        await review.provider.writeFile(tab.right.path, new TextEncoder().encode("x\n"))
        await review.reject(tab.right.path)
      }
      expect(shown.replies).toEqual([])
    })
})

test("one malformed file entry costs only itself", async () => {
  const shown = editor({ folders: [project], window: [project] })
  const review = new Review(shown.host)
  const request = item([{ file: 3, patch }, "junk", { place: inside }, { file: "a.txt", place: 7, patch }, { file: "a.txt", place: inside, patch }])
  expect(request.files).toHaveLength(1)
  await review.open(request, false)
  expect(shown.tabs).toHaveLength(1)
  expect(right(review, shown.tabs[0]!)).toBe(proposal)
})

test("the card says Allowed with your changes only when the server approved the person's version", () => {
  const controller = new Controller(client(), project, () => {}, async () => "later")
  opened.push(controller)
  const replied = (requestID: string, reply: "once" | "always" | "reject", files?: unknown[]) =>
    controller.handle({
      id: `evt_${requestID}`,
      created: Date.now(),
      type: "permission.replied",
      data: { sessionID: "ses_label", requestID, reply, ...(files ? { files } : {}) },
    } as OrbitEvent)
  const label = (id: string) => {
    const answered = controller.permission(id)
    return answered ? answeredLabel(answered) : undefined
  }
  for (const id of ["per_a", "per_b", "per_c", "per_d"])
    controller.handle({
      id: `evt_ask_${id}`,
      created: Date.now(),
      type: "permission.asked",
      data: { id, sessionID: "ses_label", action: "Edit", resources: ["a.txt"], revisable: true, metadata: { files: [] } },
    } as OrbitEvent)
  replied("per_a", "once", [{ file: "a.txt", patch, additions: 1, deletions: 1, status: "modified", place: inside }])
  replied("per_b", "once")
  replied("per_c", "always")
  replied("per_d", "reject")
  expect(["per_a", "per_b", "per_c", "per_d"].map(label)).toEqual([
    "Allowed with your changes",
    "Allowed",
    "Always allowed",
    "Rejected",
  ])
})

const whole = (file: string, before: string, after: string) =>
  formatPatch(structuredPatch(file, file, before, after, "", "", { context: 2_147_483_647 }))

test("sides rebuilds both texts from a whole-file patch and refuses a partial one", () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n") + "\n"
  for (const [before, after] of [
    [long, long.replace("line 20", "LINE 20")],
    ["", "fresh\n"],
    ["gone\n", ""],
    ["a\nb", "a\nc"],
    ["a\nb\n", "a\nb"],
    ["one\r\ntwo\r\n", "one\r\nTWO\r\n"],
  ] as const)
    expect(sides(whole("f.txt", before, after))).toEqual({ before, after })
  const many = Array.from({ length: 40 }, (_, index) => `row ${index}`).join("\n") + "\n"
  const changed = many.replace("row 3", "ROW 3").replace("row 35", "ROW 35")
  // Two hunks with a gap between them, and one that does not start at line 1.
  expect(sides(formatPatch(structuredPatch("f", "f", many, changed, "", "", { context: 2 })))).toBeUndefined()
  expect(sides(formatPatch(structuredPatch("f", "f", many, many.replace("row 30", "ROW 30"), "", "", { context: 2 })))).toBeUndefined()
  // One hunk whose old side alone, or new side alone, starts below line 1: that side is missing the file's top.
  expect(sides("@@ -2,2 +1,2 @@\n a\n-b\n+c\n")).toBeUndefined()
  expect(sides("@@ -1,2 +2,2 @@\n a\n-b\n+c\n")).toBeUndefined()
  expect(sides("@@ -1,2 +1,2 @@\n a\n-b\n+c\n")).toEqual({ before: "a\nb\n", after: "a\nc\n" })
  expect(sides("Binary files a/x and b/x differ\n")).toBeUndefined()
  expect(sides("")).toBeUndefined()
})

test("a partial or binary entry in the changes view costs only itself", () => {
  const many = Array.from({ length: 40 }, (_, index) => `row ${index}`).join("\n") + "\n"
  const partial = formatPatch(structuredPatch("p.txt", "p.txt", many, many.replace("row 30", "ROW 30"), "", "", { context: 2 }))
  const view = changesView([
    { file: "a.txt", status: "modified", patch: whole("a.txt", "one\n", "two\n") },
    { file: "p.txt", status: "modified", patch: partial },
    { file: "image.bin", status: "modified", patch: "Binary files a/image.bin and b/image.bin differ\n" },
    { file: 7, status: "modified", patch: "x" },
    { file: "new.txt", status: "added", patch: whole("new.txt", "", "fresh\n") },
  ])
  expect(view).toEqual([
    { label: "a.txt", before: "one\n", after: "two\n" },
    { label: "p.txt", text: partial },
    { label: "image.bin", text: "binary file, not shown" },
    { label: "file 4", text: "this entry could not be read" },
    { label: "new.txt", before: "", after: "fresh\n" },
  ])
})

test("the changes view reads no file, whatever the names", async () => {
  const names = ["../outside/marker.txt", marker, "sa\u202efe\u001b[2K.txt", "a\nb.txt"]
  const view = changesView(names.map((file) => ({ file, status: "modified", patch: whole(file, "one\n", "two\n") })))
  expect(view.map((entry) => "before" in entry && [entry.before, entry.after])).toEqual(names.map(() => ["one\n", "two\n"]))
  for (const entry of view) expect(entry.label).not.toMatch(/[\u001b\u202e\n]/)
  const seen = recorded()
  const shown = editor({ folders: [project], window: [root] })
  const review = new Review(shown.host, seen.recorder)
  await review.changes(names.map((file) => ({ file, status: "modified", patch: whole(file, "one\n", "two\n") })))
  expect(seen.log).toEqual([])
  expect(shown.views).toHaveLength(1)
  expect(shown.views[0]?.title).toMatch(/^Orbit: changes in this prompt \(4 files\) \([a-z0-9]{6}\)$/)
  expect(JSON.stringify(shown.views)).not.toContain(SECRET)
  // Each entry's sides hold the texts rebuilt from its patch.
  const first = shown.views[0]!.entries[0]!
  expect([review.text(first.left.path), review.text(first.right.path)]).toEqual(["one\n", "two\n"])

  // On a real server: two Writes in one prompt give two entries whose sides are the files before and after.
  await Promise.all([Bun.write(path.join(work, "c1.txt"), "first\n"), Bun.write(path.join(work, "c2.txt"), "second\n")])
  git(work, "add", ".")
  const run = await chat(work, { auto: true })
  await run.controller.send(calls([read("c1.txt"), read("c2.txt")], [write("c1.txt", "FIRST\n"), write("c2.txt", "SECOND\n")]))
  await run.idle()
  const user = [...run.items.values()].find((entry) => entry.type === "user")
  const messageID = user?.type === "user" ? user.messageID : undefined
  expect(messageID).toBeDefined()
  const files = await run.controller.changes(messageID!)
  expect(changesView(files ?? []).sort((a, b) => a.label.localeCompare(b.label))).toEqual([
    { label: "c1.txt", before: "first\n", after: "FIRST\n" },
    { label: "c2.txt", before: "second\n", after: "SECOND\n" },
  ])
  seen.log.length = 0
  await review.changes(files ?? [])
  expect(seen.log).toEqual([])
})

test("a server that cannot diff a prompt gets a note", async () => {
  const old = recording((url) =>
    url.pathname.endsWith("/diff")
      ? Promise.resolve(Response.json({ _tag: "InvalidRequestError", message: "Unknown field scope" }, { status: 400 }))
      : undefined,
  )
  const run = await chat(work, { fetcher: old.fetcher, auto: true })
  await run.controller.send(calls())
  await run.idle()
  const user = [...run.items.values()].find((entry) => entry.type === "user")
  expect(await run.controller.changes(user?.type === "user" ? user.messageID! : "msg_x")).toBeUndefined()
  expect(run.notes().at(-1)).toMatchObject({ tone: "error" })
  expect(run.notes().at(-1)?.text).toContain("orb service restart")
})

test("a prompt's changes are its own, not those of a prompt steered into the same turn", async () => {
  await Promise.all([Bun.write(path.join(work, "p1.txt"), "first\n"), Bun.write(path.join(work, "p2.txt"), "second\n")])
  git(work, "add", ".")
  const run = await chat(work)
  await run.controller.send(calls([read("p1.txt"), write("p1.txt", "FIRST\n")]))
  const first = await run.question()
  if (!first) throw new Error("no question was asked")
  // The second prompt arrives while the first one waits on its question, so both belong to one turn.
  await run.controller.send(calls([read("p2.txt"), write("p2.txt", "SECOND\n")]))
  expect(await run.controller.reply(first.id, "once")).toBe("sent")
  const second = await until(() =>
    [...run.items.values()].find((entry) => entry.type === "permission" && entry.status === "pending" && entry.id !== first.id),
  )
  if (!second) throw new Error("no second question was asked")
  expect(await run.controller.reply(second.id, "once")).toBe("sent")
  await run.idle()
  const prompts = [...run.items.values()].flatMap((entry) => (entry.type === "user" && entry.messageID ? [entry.messageID] : []))
  expect(prompts).toHaveLength(2)
  expect(changesView((await run.controller.changes(prompts[0]!)) ?? []).map((entry) => entry.label)).toEqual(["p1.txt"])
  expect(changesView((await run.controller.changes(prompts[1]!)) ?? []).map((entry) => entry.label)).toEqual(["p2.txt"])
})

test("a chat with no session yet asks the server nothing about changes or a restore", async () => {
  const log = recording()
  const run = await chat(work, { fetcher: log.fetcher })
  log.sent.length = 0
  expect(await run.controller.changes("msg_none")).toBeUndefined()
  let asked = 0
  await run.controller.restore("msg_none", async () => (asked++, true))
  expect(asked).toBe(0)
  expect(log.sent.filter((call) => !(call.method === "GET" && call.path === "/api/location/trust"))).toEqual([])
  expect(run.notes().filter((note) => note.text.includes("Send a message first"))).toHaveLength(2)
})

test("a prompt the server does not admit gets no message ID, says why, and leaves the chat idle", async () => {
  const refused = recording((url, init) =>
    url.pathname.endsWith("/prompt") && init?.method === "POST"
      ? Promise.resolve(Response.json({ _tag: "InvalidRequestError", message: "Prompt refused here" }, { status: 400 }))
      : undefined,
  )
  const run = await chat(work, { fetcher: refused.fetcher })
  await run.controller.send("not admitted")
  const user = [...run.items.values()].find((entry) => entry.type === "user")
  expect(user).toMatchObject({ type: "user", text: "not admitted" })
  // Without a message ID the card offers neither the prompt's changes nor a restore.
  expect(user?.type === "user" ? user.messageID : "none").toBeUndefined()
  expect(run.notes().at(-1)?.tone).toBe("error")
  expect(refused.sent.filter((request) => request.path.endsWith("/prompt"))).toHaveLength(1)
  expect(run.updates.findLast((update) => update.type === "busy")).toEqual({ type: "busy", busy: false })
})

// The neighbours of the new controller methods. Bun's line coverage counts the lines before a function as part of it, so
// these keep the last line of `send` and of `trustedNow` counted, and pin what Stop and a dismissed form send.
test("Stop interrupts the chat's session, and a dismissed form is cancelled on the server", async () => {
  const log = recording()
  const run = await chat(work, { fetcher: log.fetcher })
  await run.controller.send(calls())
  await run.idle()
  await run.controller.stop()
  await run.controller.answer({ id: "frm_none", sessionID: "ses_none", title: "Dismissed", fields: [] }, undefined)
  expect(log.sent.filter((request) => request.method === "POST" && request.path.endsWith("/interrupt"))).toHaveLength(1)
  expect(log.sent.filter((request) => request.method === "DELETE" && request.path.endsWith("/form/frm_none"))).toHaveLength(1)
})

test("only a pending question is marked as open for review in the editor, and only one is answered", async () => {
  const log = recording()
  const run = await chat(work, { fetcher: log.fetcher })
  await run.controller.send(calls([write("marked.txt", "marked\n")]))
  const pending = await run.question()
  if (!pending) throw new Error("no question was asked")
  run.controller.reviewing(pending.id)
  expect(run.items.get(pending.id)).toMatchObject({ status: "pending", reviewing: true })
  expect(await run.controller.reply(pending.id, "reject")).toBe("sent")
  await until(() => {
    const answered = run.items.get(pending.id)
    return answered?.type === "permission" && answered.status === "reject" ? true : undefined
  })
  const count = run.updates.length
  run.controller.reviewing(pending.id)
  run.controller.reviewing("per_unknown")
  expect(run.updates.length).toBe(count)
  // A question the chat already shows as answered is not sent again: a late save or close of its tab asks nothing.
  expect(await run.controller.reply(pending.id, "once", "late\n")).toBe("gone")
  expect(log.sent.filter((call) => call.method === "POST" && call.path.endsWith("/reply"))).toHaveLength(1)
  await run.idle()
})

describe("restore files", () => {
  async function prompted(options: { fetcher?: typeof fetch } = {}) {
    await Promise.all([Bun.write(path.join(work, "r1.txt"), "keep\n"), fs.rm(path.join(work, "r2.txt"), { force: true })])
    git(work, "add", ".")
    // A row may stop allowing questions as they come, to leave one waiting.
    const settings = { ...options, auto: true }
    const run = await chat(work, settings)
    await run.controller.send(calls([read("r1.txt")], [write("r1.txt", "changed\n"), write("r2.txt", "new\n")]))
    await run.idle()
    const user = [...run.items.values()].find((entry) => entry.type === "user")
    return { ...run, settings, messageID: user?.type === "user" ? user.messageID! : "" }
  }
  const state = async () => ({
    r1: await Bun.file(path.join(work, "r1.txt")).text(),
    r2: await Bun.file(path.join(work, "r2.txt")).exists(),
  })
  const reverts = (sent: ReturnType<typeof recording>["sent"]) =>
    sent.filter((call) => call.path.endsWith("/revert/files")).map((call) => JSON.parse(call.body ?? "{}"))

  test("a restore calls the dry run, shows its totals, and changes files only after confirm", async () => {
    const log = recording()
    const run = await prompted({ fetcher: log.fetcher })
    expect(await state()).toEqual({ r1: "changed\n", r2: true })
    const asked: Array<{ message: string; detail: string }> = []
    // Declined: nothing more is sent, and nothing changes.
    await run.controller.restore(run.messageID, async (dry) => {
      asked.push(restoreQuestion(dry, work))
      return false
    })
    expect(reverts(log.sent)).toEqual([{ messageID: run.messageID, dryRun: true }])
    expect(await state()).toEqual({ r1: "changed\n", r2: true })
    expect(asked[0]?.message).toBe("Restore 2 files to how they were before this prompt? +1 / −2 lines. This cannot be undone.")
    expect(asked[0]?.detail.split("\n").sort()).toEqual(["r1.txt", "r2.txt"])
    // Confirmed: the same call without the dry run puts the files back.
    await run.controller.restore(run.messageID, async () => true)
    expect(reverts(log.sent).slice(1)).toEqual([{ messageID: run.messageID, dryRun: true }, { messageID: run.messageID }])
    expect(await state()).toEqual({ r1: "keep\n", r2: false })
    expect(run.notes().at(-1)).toEqual({ text: "Restored 2 files to how they were before this prompt.", tone: "muted" })
  })

  test("a restore the server refuses says why and changes nothing", async () => {
    const log = recording()
    const run = await prompted({ fetcher: log.fetcher })
    const asked = [...run.items.values()].find((entry) => entry.type === "permission")
    const messages = (
      await server.client.message.list({
        sessionID: asked?.type === "permission" ? asked.sessionID : "",
        limit: 50,
        order: "asc",
      })
    ).data
    const reply = messages.find((message) => message.type === "assistant")!
    let confirmed = 0
    const confirm = async () => {
      confirmed++
      return true
    }
    // Not a prompt: the dry run answers canRewind false with the server's sentence, and nothing more is sent.
    await run.controller.restore(reply.id, confirm)
    expect(confirmed).toBe(0)
    expect(run.notes().at(-1)?.tone).toBe("error")
    expect(run.notes().at(-1)?.text).toMatch(/checkpoint/i)
    expect(reverts(log.sent)).toEqual([{ messageID: reply.id, dryRun: true }])

    // Busy: a prompt still waiting on a question cannot be restored; the server's typed refusal says why.
    await Bun.write(path.join(work, "busy.txt"), "one\n")
    const waiting = await chat(work, { fetcher: log.fetcher })
    await waiting.controller.send(calls([read("busy.txt")], [write("busy.txt", "two\n")]))
    const question = await waiting.question()
    const user = [...waiting.items.values()].find((entry) => entry.type === "user")
    log.sent.length = 0
    await waiting.controller.restore(user?.type === "user" ? user.messageID! : "", confirm)
    expect(confirmed).toBe(0)
    expect(waiting.notes().at(-1)?.tone).toBe("error")
    expect(waiting.notes().at(-1)?.text).toMatch(/busy|running|active/i)
    expect(reverts(log.sent)).toHaveLength(1)
    await server.client.permission.reply({ sessionID: question!.sessionID, requestID: question!.id, decision: "reject" })
    expect(await Bun.file(path.join(work, "busy.txt")).text()).toBe("one\n")
    expect(await state()).toEqual({ r1: "changed\n", r2: true })
  })

  // The modal waits on the person, and the server's state can change meanwhile: the restore itself is refused then, and
  // the chat says why in one note (class 13).
  type Run = Awaited<ReturnType<typeof prompted>>
  const refusals = [
    {
      name: "UntrustedFolderError",
      // Trust is taken back while the question is open.
      change: async () => {
        await server.client.location.trust.update({ location: { directory: work }, trust: false, persist: false })
      },
      undo: async () => {
        await server.client.location.trust.update({ location: { directory: work }, trust: true, persist: false })
      },
      reason: /not trusted/i,
    },
    {
      name: "SessionBusyError",
      // A new prompt of the session waits on a question while the restore question is open.
      change: async (run: Run) => {
        run.settings.auto = false
        await Bun.write(path.join(work, "busy2.txt"), "one\n")
        await run.controller.send(calls([read("busy2.txt")], [write("busy2.txt", "two\n")]))
        await run.question()
      },
      undo: async (run: Run) => {
        const question = await run.question()
        await server.client.permission.reply({ sessionID: question!.sessionID, requestID: question!.id, decision: "reject" })
        await run.idle(2)
      },
      reason: /busy|running|active/i,
    },
  ]
  for (const row of refusals)
    test(`a restore the server refuses after the person confirms says why and changes nothing (${row.name})`, async () => {
      const log = recording()
      const run = await prompted({ fetcher: log.fetcher })
      const before = run.notes().length
      try {
        await run.controller.restore(run.messageID, async () => {
          await row.change(run)
          return true
        })
        expect(reverts(log.sent)).toEqual([{ messageID: run.messageID, dryRun: true }, { messageID: run.messageID }])
        const said = run.notes().slice(before)
        expect(said).toHaveLength(1)
        expect(said[0]?.tone).toBe("error")
        expect(said[0]?.text).toMatch(/^Files not restored: /)
        expect(said[0]?.text).toMatch(row.reason)
        expect(said[0]?.text).not.toMatch(/[\u001b\n]/)
        expect(said.some((note) => note.text.startsWith("Restored"))).toBe(false)
        expect(await state()).toEqual({ r1: "changed\n", r2: true })
      } finally {
        await row.undo(run)
      }
    })
})

test("no review, changes view or restore while the folder is not trusted", async () => {
  const folder = path.join(root, "revoked")
  await fs.mkdir(folder, { recursive: true })
  await Bun.write(path.join(folder, "a.txt"), text)
  const real = await fs.realpath(folder)
  await server.client.location.trust.update({ location: { directory: real }, trust: true, persist: false })
  const session = await server.client.session.create({ location: { directory: real } })
  const log = recording()
  const run = await chat(real, { fetcher: log.fetcher })
  // The chat continues that session, so its changes and restore have a session to ask about.
  await run.controller.open(session.id)
  await server.client.location.trust.update({ location: { directory: real }, trust: false, persist: false })
  await Bun.sleep(300)
  log.sent.length = 0
  const seen = recorded()
  const shown = editor({ controller: run.controller, window: [real] })
  const review = new Review(shown.host, seen.recorder)
  await review.open(item([{ file: "a.txt", place: path.join(real, "a.txt"), patch }], { sessionID: session.id }), true)
  expect(await run.controller.changes("msg_any")).toBeUndefined()
  let confirmed = 0
  await run.controller.restore("msg_any", async () => {
    confirmed++
    return true
  })
  expect(confirmed).toBe(0)
  expect(shown.tabs).toEqual([])
  expect(seen.log).toEqual([])
  expect(log.sent.filter((call) => !(call.method === "GET" && call.path === "/api/location/trust"))).toEqual([])
  expect(shown.notes).toHaveLength(1)
  expect(shown.notes[0]?.text).toContain("the folder is not trusted, so nothing in it is read")
  expect(run.notes().filter((note) => note.text.includes("is not trusted"))).toHaveLength(2)
})

test("file names in titles, notes and the restore list are written out", async () => {
  const odd = "dir/sa\u202efe\u001b[2K\nx[x](command:workbench.action.quit).txt"
  const title = tabTitle(odd)
  expect(title).toMatch(/^Orbit: .+ \([a-z0-9]{6}\)$/)
  expect(title).not.toMatch(/[\u001b\u202e\n]/)
  expect(title).toContain("\\u{202e}")
  expect(tabTitle("a.txt")).not.toBe(tabTitle("a.txt"))
  expect(tabTitle("C:\\work\\a.txt")).toMatch(/^Orbit: a\.txt \([a-z0-9]{6}\)$/)

  const shown = editor({ folders: [project], window: [project] })
  await new Review(shown.host).open(item([{ file: odd, place: path.join(outside, "sa\u202efe\u001b[2K\nx.txt"), patch }]), true)
  expect(shown.notes).toHaveLength(1)
  expect(shown.notes[0]?.text).not.toMatch(/[\u001b\u202e\n]/)
  expect(shown.notes[0]?.text).toContain("\\u{202e}")

  const question = restoreQuestion(
    { canRewind: true, filesChanged: [path.join(project, "a.txt"), path.join(project, "sa\u202efe\u001b[2K\nx.txt"), marker], insertions: 3, deletions: 1 },
    project,
  )
  const lines = question.detail.split("\n")
  expect(lines).toHaveLength(3)
  expect(lines[0]).toBe("a.txt")
  expect(lines[1]).toContain("\\u{202e}")
  expect(lines[2]).toBe(marker)
  expect(question.detail).not.toMatch(/[\u001b\u202e]/)
  expect(question.message).toBe("Restore 3 files to how they were before this prompt? +3 / −1 lines. This cannot be undone.")
  expect(restoreQuestion({ canRewind: true, filesChanged: [inside], insertions: 0, deletions: 2 }, project).message).toContain(
    "Restore 1 file to",
  )
})

test("the sides of a review, a preview and a changes view are named without the file's own name", async () => {
  // VS Code names a side by its URI's last segment when a save of it fails, in a notification that draws links. Windows
  // allows no colon, escape or line break in a file name, so there the name keeps the rest.
  const crafted =
    process.platform === "win32"
      ? "sa‮fe[Open](command;quit).txt"
      : "sa‮fe\u001b[2K\n[Open](command:workbench.action.quit).txt"
  const file = path.join(project, crafted)
  await Bun.write(file, text)
  try {
    const shown = editor({ folders: [project], window: [project] })
    const review = new Review(shown.host)
    expect(await review.open(item([{ file: crafted, place: file, patch }]), false)).toBe(true)
    await review.open(item([{ file: crafted, place: file, patch }], { revisable: false }), true)
    await review.changes([
      { file: crafted, status: "modified", patch: whole(crafted, "one\n", "two\n") },
      { file: "odd.t(x)", status: "modified", patch: whole("odd.t(x)", "one\n", "two\n") },
    ])
    const sides = [
      ...shown.tabs.flatMap((tab) => [tab.left, tab.right]),
      ...shown.views.flatMap((view) => view.entries.flatMap((entry) => [entry.left, entry.right])),
    ]
    expect(sides).toHaveLength(8)
    for (const side of sides) expect(side.path).not.toMatch(/[[\]():\u001b‮\n]/)
    // The extension stays when it is a plain one, so the editor keeps the file's language.
    expect(sides.slice(0, 6).map((side) => path.posix.basename(side.path))).toEqual(Array(6).fill("proposal.txt"))
    expect(sides.slice(6).map((side) => path.posix.basename(side.path))).toEqual(["proposal", "proposal"])
    // The texts are still the file's.
    expect([left(review, shown.tabs[0]!), right(review, shown.tabs[0]!)]).toEqual([text, proposal])
  } finally {
    await fs.rm(file, { force: true })
  }
})

test("the changed-since-read notice names no file", async () => {
  await Bun.write(path.join(project, "moved-on.txt"), "something else\n")
  const shown = editor({ folders: [project], window: [project] })
  await new Review(shown.host).open(item([{ file: "moved-on.txt", place: path.join(project, "moved-on.txt"), patch }]), true)
  expect(shown.tabs).toEqual([])
  expect(shown.warnings).toEqual([changedNotice])
  expect(changedNotice).not.toContain("moved-on")
  expect(shown.notes.map((note) => note.text)).toEqual([changedNotice])
})
