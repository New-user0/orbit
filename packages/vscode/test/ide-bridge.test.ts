import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { plain } from "@orbit/flow/plain"
import { IdeLock } from "@orbit/util/ide-lock"
import { createTwoFilesPatch } from "diff"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { startBridge, type Bridge, type DiffService, type EditorSelection } from "../src/ide-bridge"
import { contained, disk, Review, tooLargeNotice, type Disk, type Host, type Tab } from "../src/review"

const cleanup: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run()
})

async function folder() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-ide-bridge-"))
  cleanup.push(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  return directory
}

async function start(directory: string, extra: Partial<Parameters<typeof startBridge>[0]> = {}) {
  const logs: string[] = []
  const environment: Array<number | undefined> = []
  const bridge = await startBridge({
    directory,
    folders: ["/work/project"],
    ideName: "Test Editor",
    log: (line) => logs.push(line),
    environment: (port) => environment.push(port),
    debounce: 20,
    helloTimeout: 300,
    ...extra,
  })
  cleanup.push(() => bridge.dispose())
  return { bridge, logs, environment }
}

const lock = async (bridge: Bridge) => JSON.parse(await fs.readFile(bridge.lockFile, "utf8")) as IdeLock.Lock

type Frame = Record<string, unknown>

// A terminal UI's end of the connection, which keeps every frame it gets.
async function connect(bridge: Bridge, token: string, hello: Frame | null = { type: "hello", version: 1, pid: 4242 }) {
  const frames: Frame[] = []
  const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { headers: { [IdeLock.header]: token } })
  socket.on("message", (data) => frames.push(JSON.parse(data.toString())))
  const closed = new Promise<{ code: number }>((resolve) => socket.on("close", (code) => resolve({ code })))
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve)
    socket.once("error", reject)
  })
  cleanup.push(() => socket.close())
  if (hello) socket.send(JSON.stringify(hello))
  return { socket, frames, closed }
}

async function until(condition: () => boolean, label: string, timeout = 3_000) {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(5)
  }
}

const posix = process.platform === "win32" ? test.skip : test

const editing: EditorSelection = {
  filePath: "/work/project/a.ts",
  text: "hello",
  start: { line: 4, character: 0 },
  end: { line: 7, character: 0 },
}

test("writes a lock with the fields a reader needs, named after the port the bridge listens on", async () => {
  const directory = await folder()
  const { bridge, environment } = await start(directory)

  const written = await lock(bridge)

  expect(Object.keys(written).sort()).toEqual(
    ["authToken", "ideName", "pid", "port", "version", "workspaceFolders"].sort(),
  )
  expect(written).toMatchObject({
    version: 1,
    pid: process.pid,
    port: bridge.port,
    workspaceFolders: ["/work/project"],
    ideName: "Test Editor",
  })
  expect(written.authToken).toMatch(IdeLock.tokenPattern)
  expect(path.basename(bridge.lockFile)).toBe(`${bridge.port}.lock`)
  expect(environment).toEqual([bridge.port])
  // Only the lock is in the folder: the temporary file it was written through is gone.
  expect(await fs.readdir(directory)).toEqual([`${bridge.port}.lock`])
})

posix("keeps the lock and its folder private to the person", async () => {
  const directory = path.join(await folder(), "ide")
  const { bridge } = await start(directory)

  expect((await fs.stat(bridge.lockFile)).mode & 0o777).toBe(0o600)
  expect((await fs.stat(directory)).mode & 0o777).toBe(0o700)
})

test("listens on the loopback address and nowhere else", async () => {
  const { bridge } = await start(await folder())
  const token = (await lock(bridge)).authToken

  // The server is bound to the literal, not to a name that could resolve to another interface.
  expect(bridge.host).toBe("127.0.0.1")
  const other = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://[::1]:${bridge.port}`, { headers: { [IdeLock.header]: token } })
    socket.on("open", () => resolve("open"))
    socket.on("error", () => resolve("refused"))
  })
  expect(other).toBe("refused")
})

test("refuses a connection without the token, or with a wrong one of any length, and never logs a token", async () => {
  const { bridge, logs } = await start(await folder())
  const token = (await lock(bridge)).authToken
  const wrong = [undefined, "", "x", token.slice(0, -1), `${token}x`, token.replace(/.$/, token.endsWith("a") ? "b" : "a")]

  for (const value of wrong) {
    const status = await new Promise<number>((resolve) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${bridge.port}`,
        value === undefined ? undefined : { headers: { [IdeLock.header]: value } },
      )
      socket.on("open", () => resolve(0))
      socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? -1))
      socket.on("error", () => {})
    })
    expect({ value, status }).toEqual({ value, status: 401 })
  }

  expect(bridge.clients()).toBe(0)
  expect(logs.filter((line) => line.includes("refused"))).toHaveLength(wrong.length)
  expect(logs.join("\n")).not.toContain(token)
  // A token in the URL is no token.
  const viaUrl = await new Promise<number>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${bridge.port}/?token=${token}`)
    socket.on("open", () => resolve(0))
    socket.on("unexpected-response", (_request, response) => resolve(response.statusCode ?? -1))
    socket.on("error", () => {})
  })
  expect(viaUrl).toBe(401)
})

test("answers a hello with its own, and then sends the current selection", async () => {
  const { bridge } = await start(await folder())
  bridge.select(editing)
  await Bun.sleep(60)
  const client = await connect(bridge, (await lock(bridge)).authToken)

  await until(() => client.frames.length >= 2, "the hello and the selection")

  expect(client.frames[0]).toEqual({ type: "hello", version: 1, editor: "Test Editor" })
  expect(client.frames[1]).toMatchObject({ type: "selection", filePath: "/work/project/a.ts" })
  expect(bridge.clients()).toBe(1)
})

test("sends one selection for a burst of changes, with the positions counted from 1", async () => {
  const { bridge } = await start(await folder())
  const client = await connect(bridge, (await lock(bridge)).authToken)
  await until(() => client.frames.length >= 2, "the first selection")
  client.frames.length = 0

  bridge.select({ ...editing, text: "first" })
  bridge.select(editing)
  await until(() => client.frames.length > 0, "the selection")
  await Bun.sleep(80)

  // The editor's line 4, character 0 is line 5, character 1; the selection ends at the start of a later line, which the
  // terminal UI then does not count as covered.
  expect(client.frames).toEqual([
    {
      type: "selection",
      filePath: "/work/project/a.ts",
      text: "hello",
      selection: { start: { line: 5, character: 1 }, end: { line: 8, character: 1 } },
    },
  ])
})

test("sends a cleared selection when no file editor remains", async () => {
  const { bridge } = await start(await folder())
  bridge.select(editing)
  const client = await connect(bridge, (await lock(bridge)).authToken)
  await until(() => client.frames.length >= 2, "the selection")
  client.frames.length = 0

  bridge.select(undefined)
  await until(() => client.frames.length > 0, "the cleared selection")

  expect(client.frames).toEqual([{ type: "selection", filePath: null }])
})

test("cuts selected text at the cap and leaves the range exact", async () => {
  const { bridge } = await start(await folder())
  const client = await connect(bridge, (await lock(bridge)).authToken)
  await until(() => client.frames.length >= 2, "the first selection")
  client.frames.length = 0

  bridge.select({ ...editing, text: "x".repeat(IdeLock.selectionTextCap + 500), end: { line: 90000, character: 3 } })
  await until(() => client.frames.length > 0, "the selection")

  const frame = client.frames[0] as { text: string; selection: { end: { line: number } } }
  expect(frame.text).toHaveLength(IdeLock.selectionTextCap)
  expect(frame.selection.end.line).toBe(90001)
})

test("closes a client that speaks another version, after answering it", async () => {
  const { bridge, logs } = await start(await folder())
  const client = await connect(bridge, (await lock(bridge)).authToken, { type: "hello", version: 2, pid: 1 })

  expect((await client.closed).code).toBe(IdeLock.closeVersion)
  expect(client.frames).toEqual([{ type: "hello", version: 1, editor: "Test Editor" }])
  expect(logs.some((line) => line.includes("version 2"))).toBe(true)
})

test("closes a client that never says hello, and ignores frames that are not one", async () => {
  const { bridge } = await start(await folder())
  const silent = await connect(bridge, (await lock(bridge)).authToken, null)
  const noise = await connect(bridge, (await lock(bridge)).authToken, null)
  noise.socket.send("not json")
  noise.socket.send(JSON.stringify({ type: "selection", filePath: "/x" }))

  await silent.closed
  await noise.closed

  expect(silent.frames).toEqual([])
  expect(noise.frames).toEqual([])
})

test("closes a client that sends a frame far larger than a hello", async () => {
  const { bridge } = await start(await folder())
  const client = await connect(bridge, (await lock(bridge)).authToken, null)

  client.socket.send("x".repeat(64 * 1024))

  expect((await client.closed).code).toBe(1009)
})

test("sends a mention to the client of the terminal asked for, else to the one that connected last, and to no other", async () => {
  const { bridge } = await start(await folder())
  const token = (await lock(bridge)).authToken
  const first = await connect(bridge, token, { type: "hello", version: 1, pid: 100 })
  await until(() => first.frames.length >= 2, "the first client")
  const second = await connect(bridge, token, { type: "hello", version: 1, pid: 200 })
  await until(() => second.frames.length >= 2, "the second client")
  const mentions = (client: { frames: Frame[] }) => client.frames.filter((frame) => frame.type === "mention")

  expect(bridge.mention({ filePath: "/work/project/a.ts", lineStart: 3, lineEnd: 9 }, 100)).toBe(true)
  await until(() => mentions(first).length === 1, "the mention")
  expect(mentions(first)).toEqual([{ type: "mention", filePath: "/work/project/a.ts", lineStart: 3, lineEnd: 9 }])
  expect(mentions(second)).toEqual([])

  // No terminal matches: the newest client.
  expect(bridge.mention({ filePath: "/work/project/b.ts" }, 999)).toBe(true)
  await until(() => mentions(second).length === 1, "the second mention")
  // A file alone has no line fields.
  expect(mentions(second)).toEqual([{ type: "mention", filePath: "/work/project/b.ts" }])
  expect(mentions(first)).toHaveLength(1)
})

test("a mention with no client connected reaches nobody", async () => {
  const { bridge } = await start(await folder())

  expect(bridge.mention({ filePath: "/work/project/a.ts" })).toBe(false)
})

test("dispose removes the lock, closes the clients and clears the environment", async () => {
  const directory = await folder()
  const { bridge, environment } = await start(directory)
  const client = await connect(bridge, (await lock(bridge)).authToken)
  await until(() => client.frames.length >= 2, "the client")

  bridge.dispose()

  expect(await fs.readdir(directory)).toEqual([])
  expect((await client.closed).code).toBe(1001)
  expect(environment).toEqual([bridge.port, undefined])
})

test("removes the locks of editors that are gone at start, and leaves every other file alone", async () => {
  const directory = await folder()
  const gone = Bun.spawn([process.execPath, "-e", "0"], { stdout: "ignore" })
  await gone.exited
  const base = { version: 1, workspaceFolders: [], ideName: "x", authToken: "t" }
  await fs.writeFile(path.join(directory, "41001.lock"), JSON.stringify({ ...base, pid: gone.pid, port: 41001 }))
  await fs.writeFile(path.join(directory, "41002.lock"), JSON.stringify({ ...base, pid: process.pid, port: 41002 }))
  await fs.writeFile(path.join(directory, "41003.lock"), "not json")
  await fs.writeFile(path.join(directory, "41004.lock"), JSON.stringify({ ...base, version: 2, pid: gone.pid, port: 41004 }))
  await fs.writeFile(path.join(directory, "notes.txt"), "mine")
  const { bridge, logs } = await start(directory)

  expect((await fs.readdir(directory)).sort()).toEqual(
    ["41002.lock", "41003.lock", "41004.lock", `${bridge.port}.lock`, "notes.txt"].sort(),
  )
  expect(logs.filter((line) => line.includes("left"))).toHaveLength(2)
})

test("rewrites the lock while a reader holds it open, and leaves no temporary file", async () => {
  const directory = await folder()
  const { bridge, logs } = await start(directory)
  const other = path.join(directory, "reader.ts")
  // The reader is another process, as the terminal UI is, and it holds the lock open for a while: on Windows the rename
  // is refused until it lets go, and this process blocks while it retries, so the reader cannot be a timer here.
  await Bun.write(
    other,
    `import fs from "node:fs"
const fd = fs.openSync(process.argv[2], "r")
console.log("held")
setTimeout(() => { fs.closeSync(fd); process.exit(0) }, 120)`,
  )
  const reader = Bun.spawn([process.execPath, other, bridge.lockFile], { stdout: "pipe" })
  cleanup.push(() => reader.kill())
  const stream = reader.stdout.getReader()
  await stream.read()

  bridge.folders(["/work/project", "/work/moved"])
  await reader.exited

  expect(logs.filter((line) => line.includes("could not update"))).toEqual([])
  expect((await lock(bridge)).workspaceFolders).toEqual(["/work/project", "/work/moved"])
  expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
})

test("logs one line and leaves no temporary file when the lock cannot be rewritten", async () => {
  const directory = await folder()
  const { bridge, logs } = await start(directory)
  // A folder where the lock should be: the rename fails for every attempt and with a code that is not retried.
  await fs.rm(bridge.lockFile)
  await fs.mkdir(bridge.lockFile)
  cleanup.push(() => fs.rm(bridge.lockFile, { recursive: true, force: true }))
  await fs.writeFile(path.join(bridge.lockFile, "keep"), "x")

  expect(() => bridge.folders(["/work/other"])).not.toThrow()

  expect(logs.filter((line) => line.includes("could not update the lock"))).toHaveLength(1)
  expect((await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([])
})

test("closes its listener when the lock folder cannot be used", async () => {
  const directory = await folder()
  const blocked = path.join(directory, "ide")
  await fs.writeFile(blocked, "a file where the folder should be")
  // In a process of its own: a listener left open keeps that process alive, which a deadline shows.
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { startBridge } = await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/ide-bridge"))})
try { await startBridge({ directory: ${JSON.stringify(blocked)}, folders: [], ideName: "x", log() {}, environment() {} }) } catch { console.log("rejected") }`,
    ],
    { stdout: "pipe" },
  )
  const deadline = setTimeout(() => child.kill(), 5_000)
  const code = await child.exited
  clearTimeout(deadline)

  expect(await new Response(child.stdout).text()).toContain("rejected")
  expect(code).toBe(0)
})

test("rewrites the lock with the new folders, and a reader never sees half of it", async () => {
  const { bridge } = await start(await folder())
  const token = (await lock(bridge)).authToken
  let broken = 0
  let reading = true
  const reader = (async () => {
    while (reading) {
      const text = await fs.readFile(bridge.lockFile, "utf8").catch(() => undefined)
      if (text !== undefined)
        try {
          JSON.parse(text)
        } catch {
          broken += 1
        }
      await Bun.sleep(0)
    }
  })()

  for (let index = 0; index < 40; index++) bridge.folders([`/work/project`, `/work/other${index}`])
  reading = false
  await reader

  expect(broken).toBe(0)
  expect(await lock(bridge)).toMatchObject({ workspaceFolders: ["/work/project", "/work/other39"], authToken: token })
})

// clients-ux-15 part 3: the bridge opens the review of an Edit or Write approval that the terminal UI asks for. The
// review is part 2's real `Review` over the real disk with every access written down, and the only stand-in is the tab
// opener (`Host`), since VS Code cannot run under Bun. A file is read only when its real path is inside one of the
// folders the frame names for the session and one of the window's folders (classes 3 and 4); a share or device spelling
// is refused before the disk is touched; every answer goes to the terminal UI that asked, never to a server, and nothing
// writes a file (class 12).
const SECRET = "SECRET-MARKER-73"
const text = `alpha\nbeta\n${SECRET}\n`
const proposal = `alpha\nBETA\n${SECRET}\n`
const patch = createTwoFilesPatch("a.txt", "a.txt", text, proposal)
const added = createTwoFilesPatch("new.txt", "new.txt", "", "fresh\n")
const host = "orbit-test.invalid"
const linkType = process.platform === "win32" ? "junction" : "dir"
const world = await (async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-ide-review-")))
  const project = path.join(root, "project")
  const outside = path.join(root, "outside")
  const other = path.join(root, "other")
  const main = path.join(root, "main")
  const tree = path.join(root, "tree")
  for (const folder of [project, outside, other, main, path.join(project, "sub"), path.join(root, "removed")])
    await fs.mkdir(folder, { recursive: true })
  for (const file of [
    path.join(project, "a.txt"),
    path.join(project, "sub", "b.txt"),
    path.join(outside, "marker.txt"),
    path.join(other, "marker.txt"),
    path.join(main, "m.txt"),
  ])
    await fs.writeFile(file, text)
  // A link in the project to the folder outside, one to a folder inside it, and one that leads nowhere.
  await fs.symlink(outside, path.join(project, "link"), linkType)
  await fs.symlink(path.join(project, "sub"), path.join(project, "alias"), linkType)
  await fs.symlink(path.join(root, "removed"), path.join(project, "gone"), linkType)
  await fs.rm(path.join(root, "removed"), { recursive: true })
  const git = (cwd: string, ...args: string[]) => {
    // The worktree's file is checked out as it was written, whatever the machine's line ending setting.
    const result = Bun.spawnSync(
      ["git", "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "core.autocrlf=false", ...args],
      { cwd },
    )
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  git(main, "init", "--quiet")
  git(main, "add", ".")
  git(main, "commit", "--quiet", "-m", "init")
  git(main, "worktree", "add", "--quiet", tree)
  return {
    root,
    project,
    outside,
    other,
    tree,
    inside: path.join(project, "a.txt"),
    marker: path.join(outside, "marker.txt"),
  }
})()
afterAll(() => fs.rm(world.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// The real disk, with every access written down.
function recorded() {
  const log: string[] = []
  const recorder: Disk = {
    realpath: (file) => (log.push(`realpath ${file}`), disk.realpath(file)),
    lstat: (file) => (log.push(`lstat ${file}`), disk.lstat(file)),
    readFile: (file) => (log.push(`read ${file}`), disk.readFile(file)),
  }
  return { log, recorder, reads: () => log.filter((call) => call.startsWith("read ")).map((call) => call.slice(5)) }
}

// What the review would do in the editor, written down. A tab the review closes is reported closed, as VS Code reports
// it. A server is never asked anything for a bridge review, so `reply` and `folders` only record.
function tabs(options: { fail?: number; hold?: Promise<void> } = {}) {
  const shown: Tab[] = []
  const attempts: string[] = []
  const closed: string[] = []
  const replies: unknown[] = []
  const warnings: string[] = []
  const holder: { review?: Review } = {}
  // The first `fail` tabs fail to open, as `vscode.diff` can, once `hold` lets them.
  const failing = { left: options.fail ?? 0 }
  const host: Host = {
    reply: async (...args) => (replies.push(args), "gone"),
    folders: async (...args) => (replies.push(args), { refused: "unavailable" }),
    workspace: () => [],
    show: async (tab) => {
      attempts.push(tab.title)
      if (failing.left-- > 0) {
        await options.hold
        throw new Error("the editor could not open the tab")
      }
      shown.push(tab)
    },
    changes: async () => {},
    close: async (titles) => {
      closed.push(...titles)
      await Bun.sleep(0)
      // A tab that never opened has no close to report.
      for (const title of titles) if (shown.some((tab) => tab.title === title)) await holder.review?.closed(title)
    },
    reveal: async () => {},
    note: () => {},
    warn: (text) => void warnings.push(text),
    unmark: () => {},
  }
  return { host, shown, attempts, closed, replies, warnings, holder }
}

const features = { type: "hello", version: 1, pid: 4242, features: ["diff"] }

async function reviewing(
  options: {
    window?: readonly string[]
    fail?: number
    hold?: Promise<void>
    diff?: (review: Review) => DiffService
  } = {},
) {
  const seen = recorded()
  const editor = tabs({ fail: options.fail, hold: options.hold })
  const review = new Review(editor.host, seen.recorder)
  editor.holder.review = review
  const { bridge, logs } = await start(await folder(), {
    folders: options.window ?? [world.root],
    diff: options.diff?.(review) ?? review.bridge,
  })
  cleanup.push(() => review.dispose())
  await Bun.sleep(60)
  const client = await connect(bridge, (await lock(bridge)).authToken, features)
  await until(() => client.frames.length >= 2, "the hello and the selection")
  return { bridge, logs, review, seen, editor, client }
}

const answers = (client: { frames: Frame[] }) => client.frames.filter((frame) => frame.type === "diff.answer")
const ask = (client: { socket: WebSocket }, fields: Frame = {}) =>
  client.socket.send(
    JSON.stringify({
      type: "diff.open",
      id: "per_a1",
      place: world.inside,
      patch,
      status: "modified",
      roots: [world.project],
      ...fields,
    }),
  )
const right = (review: Review, tab: Tab) => new TextDecoder().decode(review.provider.readFile(tab.right.path))

test("answers a hello that names features with its own, and a version 1 hello without them as before", async () => {
  const { bridge } = await reviewing()
  const token = (await lock(bridge)).authToken
  const named = await connect(bridge, token, features)
  await until(() => named.frames.length >= 2, "the hello and the selection")
  expect(named.frames[0]).toEqual({ type: "hello", version: 1, editor: "Test Editor", features: ["diff"] })
  // A terminal UI from before diffs names no features and still gets its selections.
  const old = await connect(bridge, token)
  await until(() => old.frames.length >= 2, "the hello and the selection")
  expect(old.frames[0]).toEqual({ type: "hello", version: 1, editor: "Test Editor", features: ["diff"] })
  expect(old.frames[1]).toMatchObject({ type: "selection" })
  // A bridge without the review service names no feature, so a terminal UI never sends it a diff.
  const bare = await start(await folder())
  const client = await connect(bare.bridge, (await lock(bare.bridge)).authToken, features)
  await until(() => client.frames.length >= 1, "the hello")
  expect(client.frames[0]).toEqual({ type: "hello", version: 1, editor: "Test Editor" })
})

test("takes a diff frame up to the frame cap after hello, and still closes a large frame before it", async () => {
  const { bridge, client } = await reviewing()
  // A patch of about 200 KiB that does not apply: the frame is read and answered, and the link stays.
  ask(client, { patch: `${patch}${"+x\n".repeat(70_000)}` })
  await until(() => answers(client).length === 1, "the answer")
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "unavailable", reason: "changed" }])
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  // Before hello, a frame above the hello's cap still closes the link.
  const early = await connect(bridge, (await lock(bridge)).authToken, null)
  early.socket.send(JSON.stringify({ type: "diff.open", padding: "x".repeat(5 * 1024) }))
  expect((await early.closed).code).toBe(1009)
})

describe("opens a diff the terminal UI asks for from the request's place and patch, with an Orbit title", () => {
  const short = () => {
    const result = Bun.spawnSync(
      [process.env.ComSpec ?? "cmd.exe", "/d", "/s", "/c", `"for %I in ("${world.inside}") do @echo %~sI"`],
      { windowsVerbatimArguments: true },
    )
    return result.stdout.toString().trim()
  }
  const rows: Array<{ name: string; fields: () => Frame; left: string; right: string; read?: () => string; windows?: boolean }> = [
    { name: "inside", fields: () => ({}), left: text, right: proposal, read: () => world.inside },
    {
      name: "added",
      fields: () => ({ place: path.join(world.project, "new.txt"), patch: added, status: "added" }),
      left: "",
      right: "fresh\n",
    },
    {
      name: "case",
      fields: () => ({ place: world.inside.replace(/project/i, "PROJECT"), roots: [world.project.toUpperCase()] }),
      left: text,
      right: proposal,
      read: () => world.inside,
      windows: true,
    },
    {
      name: "short",
      fields: () => ({ place: short() || world.inside }),
      left: text,
      right: proposal,
      read: () => world.inside,
      windows: true,
    },
    {
      name: "worktree",
      // A linked worktree's session works in the worktree, which is its Location's folder and its project's.
      fields: () => ({ place: path.join(world.tree, "m.txt"), roots: [world.tree] }),
      left: text,
      right: proposal,
      read: () => path.join(world.tree, "m.txt"),
    },
  ]
  for (const row of rows)
    test.skipIf(row.windows === true && process.platform !== "win32")(row.name, async () => {
      const { client, editor, review, seen } = await reviewing()
      ask(client, row.fields())
      await until(() => editor.shown.length === 1, "the tab")
      const tab = editor.shown[0]!
      expect(tab.mode).toBe("review")
      expect(tab.left.scheme).toBe("orbit-proposed")
      expect(tab.right.scheme).toBe("orbit-review")
      expect(review.text(tab.left.path)).toBe(row.left)
      expect(right(review, tab)).toBe(row.right)
      expect(tab.title).toMatch(/^Orbit: [^()]+ \([a-z0-9]{6}\)$/)
      expect(seen.reads()).toEqual(row.read ? [await fs.realpath(row.read())] : [])
      expect(answers(client)).toEqual([])
      expect(editor.replies).toEqual([])
    })

  test("two opens have their own titles, and a name is written out in the title", async () => {
    const odd = path.join(world.project, "o‮b​d.txt")
    await fs.writeFile(odd, text)
    const { client, editor } = await reviewing()
    ask(client)
    ask(client, { id: "per_a2", place: odd })
    await until(() => editor.shown.length === 2, "both tabs")
    const named = editor.shown.find((tab) => tab.right.path.includes("/per_a2/"))!
    const first = editor.shown.find((tab) => tab !== named)!
    expect(first.title).toMatch(/^Orbit: a\.txt \([a-z0-9]{6}\)$/)
    expect(named.title.startsWith(`Orbit: ${plain("o‮b​d.txt")} (`)).toBe(true)
    expect(named.title).not.toContain("‮")
    expect(named.title).not.toContain("​")
    // Two reviews of one file still have their own titles.
    ask(client, { id: "per_a3" })
    await until(() => editor.shown.length === 3, "the third tab")
    expect(editor.shown[2]!.title).not.toBe(first.title)
  })
})

describe("an open diff outside the window's folders or the session's folders is refused before any read", () => {
  const rows: Array<{ name: string; fields: () => Frame; window?: () => string[]; windows?: boolean }> = [
    { name: "outside", fields: () => ({ place: world.marker }) },
    { name: "dot-dot", fields: () => ({ place: [world.project, "..", "outside", "marker.txt"].join(path.sep) }) },
    { name: "link-out", fields: () => ({ place: path.join(world.project, "link", "marker.txt") }) },
    {
      name: "dangling",
      fields: () => ({ place: path.join(world.project, "gone", "new.txt"), patch: added, status: "added" }),
    },
    {
      name: "added-under-link",
      fields: () => ({ place: path.join(world.project, "link", "new.txt"), patch: added, status: "added" }),
    },
    {
      name: "git-bash",
      fields: () => ({ place: `/${world.inside[0]?.toLowerCase()}${world.inside.slice(2).replaceAll("\\", "/")}` }),
      windows: true,
    },
    { name: "root-relative", fields: () => ({ place: world.inside.slice(2) }), windows: true },
    { name: "relative", fields: () => ({ place: "a.txt" }) },
    { name: "stream", fields: () => ({ place: `${world.inside}::$DATA` }), windows: true },
    { name: "trailing-dot", fields: () => ({ place: `${world.inside}.` }), windows: true },
    { name: "trailing-space", fields: () => ({ place: `${world.inside} ` }), windows: true },
    // The session's folder is outside every folder of the window, and so is its file.
    {
      name: "root-outside-window",
      fields: () => ({ place: world.marker, roots: [world.outside] }),
      window: () => [world.project],
    },
    // Inside the window, outside the session's folders.
    { name: "outside-roots", fields: () => ({ place: path.join(world.other, "marker.txt") }) },
    // VS Code opened a folder below the session's: the file is the session's, but not the window's.
    { name: "outside-window", fields: () => ({}), window: () => [path.join(world.project, "sub")] },
  ]
  for (const row of rows)
    test.skipIf(row.windows === true && process.platform !== "win32")(row.name, async () => {
      const { client, editor, seen } = await reviewing({ window: row.window?.() })
      ask(client, row.fields())
      await until(() => answers(client).length === 1, "the answer")
      expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "unavailable", reason: "outside" }])
      expect(seen.reads()).toEqual([])
      expect(editor.shown).toEqual([])
      expect(JSON.stringify(client.frames)).not.toContain(SECRET)
    })
})

describe("a share or device spelling in an open diff is refused before the disk is touched", () => {
  const rows = [
    { name: "unc", place: () => `\\\\${host}\\share\\a.txt` },
    { name: "forward-slash unc", place: () => `//${host}/share/a.txt` },
    { name: "device unc", place: () => `\\\\?\\UNC\\${host}\\share\\a.txt` },
    { name: "device drive", place: () => `\\\\?\\${world.inside}` },
    { name: "dot device", place: () => `\\\\.\\${world.inside}` },
    { name: "nt prefix", place: () => `\\??\\UNC\\${host}\\share\\a.txt` },
  ]
  for (const row of rows)
    test(row.name, async () => {
      const { client, editor, seen } = await reviewing()
      ask(client, { place: row.place() })
      await until(() => answers(client).length === 1, "the answer")
      expect(answers(client)[0]).toMatchObject({ answer: "unavailable", reason: "outside" })
      expect(seen.log).toEqual([])
      expect(editor.shown).toEqual([])
    })

  test("a share spelled as a root is dropped before the disk is touched, and the other root still counts", async () => {
    const { client, editor, seen } = await reviewing()
    ask(client, { roots: [`\\\\${host}\\share`, world.project] })
    await until(() => editor.shown.length === 1, "the tab")
    expect(seen.log.filter((call) => call.includes(host))).toEqual([])
  })

  // Making a link needs Developer Mode or an elevated shell on Windows. Where it cannot be made the row says so.
  test.skipIf(process.platform !== "win32")("link-to-share", async () => {
    const link = path.join(world.project, "share")
    const made = await fs.symlink(`\\\\${host}\\share`, link, "dir").then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code,
    )
    if (made !== true) return console.warn(`link-to-share skipped: cannot make a link here (${made})`)
    try {
      const { client, editor, seen } = await reviewing()
      ask(client, { place: path.join(link, "a.txt") })
      await until(() => answers(client).length === 1, "the answer")
      expect(answers(client)[0]).toMatchObject({ answer: "unavailable", reason: "outside" })
      expect(editor.shown).toEqual([])
      expect(seen.log.filter((call) => call.includes(link) || call.includes(host))).toEqual([])
    } finally {
      await fs.rm(link, { force: true, recursive: true })
    }
  })
})

test("the file a bridge review reads is the real path that was checked", async () => {
  const { client, editor, seen } = await reviewing()
  // Spelled through a link that stays inside the project.
  const place = path.join(world.project, "alias", "b.txt")
  ask(client, { place })
  await until(() => editor.shown.length === 1, "the tab")
  const checked = await contained(place, { session: [world.project], window: [world.root] }, disk)
  expect(checked).toBe(await fs.realpath(path.join(world.project, "sub", "b.txt")))
  expect(seen.reads()).toEqual([checked!])
})

describe("a frame with a malformed id, place, patch or roots answers unavailable and costs only itself", () => {
  const rows: Array<{ name: string; fields: () => Frame; reason?: string }> = [
    // An id without the server's shape is never named back, so it gets no answer at all.
    { name: "id-traversal", fields: () => ({ id: "per_../x" }) },
    { name: "id-long", fields: () => ({ id: `per_${"a".repeat(65)}` }) },
    { name: "id-control", fields: () => ({ id: "per_a\u001b[31m" }) },
    { name: "id-missing", fields: () => ({ id: undefined }) },
    { name: "no-roots", fields: () => ({ roots: [] }), reason: "invalid" },
    { name: "three-roots", fields: () => ({ roots: [world.project, world.project, world.project] }), reason: "invalid" },
    { name: "empty-root", fields: () => ({ roots: [""] }), reason: "invalid" },
    { name: "status", fields: () => ({ status: "deleted" }), reason: "invalid" },
    { name: "place", fields: () => ({ place: 7 }), reason: "invalid" },
    { name: "empty-place", fields: () => ({ place: "" }), reason: "invalid" },
    { name: "patch", fields: () => ({ patch: null }), reason: "invalid" },
    { name: "notebook", fields: () => ({ place: path.join(world.project, "n.ipynb") }), reason: "invalid" },
  ]
  for (const row of rows)
    test(row.name, async () => {
      const { client, editor, logs } = await reviewing()
      ask(client, { id: "per_bad", ...row.fields() })
      ask(client, { id: "per_good" })
      await until(() => editor.shown.length === 1, "the good frame's tab")
      await Bun.sleep(20)
      expect(answers(client)).toEqual(
        row.reason ? [{ type: "diff.answer", id: "per_bad", answer: "unavailable", reason: row.reason }] : [],
      )
      expect(logs.filter((line) => line.includes("diff"))).toHaveLength(1)
      expect(editor.shown).toHaveLength(1)
      expect(editor.shown[0]!.right.path).toContain("/per_good/")
    })

  test("busy", async () => {
    const { bridge, client, editor } = await reviewing()
    ask(client)
    await until(() => editor.shown.length === 1, "the tab")
    ask(client)
    await until(() => answers(client).length === 1, "the answer")
    expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "unavailable", reason: "busy" }])
    expect(editor.shown).toHaveLength(1)
    // Another terminal UI reviews the same request in a tab of its own.
    const other = await connect(bridge, (await lock(bridge)).authToken, { ...features, pid: 5151 })
    await until(() => other.frames.length >= 2, "the second client")
    ask(other)
    await until(() => editor.shown.length === 2, "the second tab")
    expect(answers(other)).toEqual([])
  })
})

test("a tab the editor fails to open answers unavailable, logs one line and leaves the question free to open again", async () => {
  const { client, editor, logs } = await reviewing({ fail: 1 })
  ask(client)
  await until(() => answers(client).length === 1, "the answer")
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "unavailable", reason: "failed" }])
  await until(() => logs.some((line) => line.includes("could not open a diff")), "the log line")
  expect(logs.filter((line) => line.includes("could not open a diff"))).toHaveLength(1)
  expect(editor.shown).toEqual([])
  // Its entry is gone, so the same question opens and is not busy.
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  await Bun.sleep(20)
  expect(answers(client)).toHaveLength(1)
})

test("a tab closed by a close-all while it fails to open answers dismissed alone", async () => {
  const hold = Promise.withResolvers<void>()
  const { client, editor, logs } = await reviewing({ fail: 1, hold: hold.promise })
  ask(client)
  await until(() => editor.attempts.length === 1, "the tab opening")
  client.socket.send(JSON.stringify({ type: "diff.closeAll" }))
  await until(() => answers(client).length === 1, "the dismissal")
  hold.resolve()
  await until(() => logs.some((line) => line.includes("could not open a diff")), "the log line")
  await Bun.sleep(20)
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "dismissed" }])
})

test("a patch that no longer applies answers unavailable and opens nothing", async () => {
  const { client, editor } = await reviewing()
  ask(client, { patch: createTwoFilesPatch("a.txt", "a.txt", "else\n", "two\n") })
  await until(() => answers(client).length === 1, "the answer")
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "unavailable", reason: "changed" }])
  expect(editor.shown).toEqual([])
  // A modified file that is gone has no text to apply it to either.
  ask(client, { id: "per_a2", place: path.join(world.project, "missing.txt") })
  await until(() => answers(client).length === 2, "the second answer")
  expect(answers(client)[1]).toEqual({ type: "diff.answer", id: "per_a2", answer: "unavailable", reason: "changed" })
})

// Every file of the project with its text, to show that nothing was written.
async function snapshot(folder: string) {
  const entries = await fs.readdir(folder, { recursive: true, withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort()
  return Promise.all(files.map(async (file) => [file, await fs.readFile(file, "utf8")]))
}

test("a save answers saved with the text, a close by the person answers closed, Reject answers rejected, and each closes the tab", async () => {
  const before = await snapshot(world.project)
  const { client, editor, review } = await reviewing()
  ask(client, { id: "per_save" })
  ask(client, { id: "per_close" })
  ask(client, { id: "per_reject" })
  await until(() => editor.shown.length === 3, "three tabs")
  const tab = (id: string) => editor.shown.find((item) => item.right.path.includes(`/${id}/`))!
  // A save by the person: the text as saved, without its byte order mark.
  await review.provider.writeFile(tab("per_save").right.path, new TextEncoder().encode("﻿mine\n"))
  await review.closed(tab("per_close").title)
  await review.reject(tab("per_reject").right.path)
  await until(() => answers(client).length === 3, "three answers")
  expect(answers(client)).toEqual([
    { type: "diff.answer", id: "per_save", answer: "saved", content: "mine\n" },
    { type: "diff.answer", id: "per_close", answer: "closed" },
    { type: "diff.answer", id: "per_reject", answer: "rejected" },
  ])
  // The extension closes the tab of a save and of a Reject itself; the one the person closed is gone already.
  await until(() => editor.closed.length === 2, "the two closes")
  expect(editor.closed.sort()).toEqual([tab("per_save").title, tab("per_reject").title].sort())
  // Each answers once: another save, Reject, Accept or close of the same tab says nothing more.
  await review.provider.writeFile(tab("per_save").right.path, new TextEncoder().encode("again\n"))
  await review.reject(tab("per_save").right.path)
  await review.accept(tab("per_reject").right.path)
  await review.closed(tab("per_close").title)
  await Bun.sleep(20)
  expect(answers(client)).toHaveLength(3)
  expect(editor.replies).toEqual([])
  expect(await snapshot(world.project)).toEqual(before)
})

test("Accept on a tab with no unsaved edits answers saved with the text the tab holds", async () => {
  const { client, editor, review } = await reviewing()
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  await review.accept(editor.shown[0]!.right.path)
  await until(() => answers(client).length === 1, "the answer")
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "saved", content: proposal }])
  expect(editor.warnings).toHaveLength(0)
})

test("a tab Orbit closes answers nothing to the server and tells its owner it was dismissed", async () => {
  const { bridge, client, editor, review } = await reviewing()
  const other = await connect(bridge, (await lock(bridge)).authToken, { ...features, pid: 5151 })
  await until(() => other.frames.length >= 2, "the second client")

  // The owner closes its own tab: nothing is answered.
  ask(client, { id: "per_owner" })
  await until(() => editor.shown.length === 1, "the tab")
  client.socket.send(JSON.stringify({ type: "diff.close", id: "per_owner" }))
  // Another client cannot close it by its id.
  ask(client, { id: "per_mine" })
  await until(() => editor.shown.length === 2, "the second tab")
  other.socket.send(JSON.stringify({ type: "diff.close", id: "per_mine" }))
  await until(() => editor.closed.length === 1, "the owner's close")
  await Bun.sleep(30)
  expect(editor.closed).toEqual([editor.shown[0]!.title])
  expect(answers(client)).toEqual([])

  // Another client's close-all closes every Orbit tab, and each owner is told.
  other.socket.send(JSON.stringify({ type: "diff.closeAll" }))
  await until(() => answers(client).length === 1, "the dismissal")
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_mine", answer: "dismissed" }])
  expect(answers(other)).toEqual([])

  // The chat panel's close-all on a new prompt does the same.
  ask(client, { id: "per_chat" })
  await until(() => editor.shown.length === 3, "the third tab")
  review.closeAll()
  await until(() => answers(client).length === 2, "the second dismissal")
  expect(answers(client)[1]).toEqual({ type: "diff.answer", id: "per_chat", answer: "dismissed" })

  // The window closing: every review closes first and answers nothing.
  ask(client, { id: "per_dispose" })
  await until(() => editor.shown.length === 4, "the fourth tab")
  review.dispose()
  await until(() => editor.closed.includes(editor.shown[3]!.title), "the close")
  await Bun.sleep(30)
  expect(answers(client)).toHaveLength(2)
  expect(editor.replies).toEqual([])
})

test("the bridge stopping closes its clients' reviews and answers nothing", async () => {
  const { bridge, client, editor } = await reviewing()
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  bridge.dispose()
  // The reviews close before the clients' sockets do, so none of them can still answer.
  expect(editor.closed).toEqual([editor.shown[0]!.title])
  expect((await client.closed).code).toBe(1001)
  expect(answers(client)).toEqual([])
})

test("the bridge stopping drops each client's reviews before it closes that client's socket", async () => {
  // Whether a socket's close event fires inside close() depends on the WebSocket implementation (Bun's does, the ws
  // that VS Code runs does not), so the order is read from the bridge: a client whose socket closed has left its count.
  const dropped: number[] = []
  const holder: { bridge?: Bridge } = {}
  const { bridge, client, editor } = await reviewing({
    diff: (review) => ({
      ...review.bridge,
      drop: (owner) => {
        dropped.push(holder.bridge!.clients())
        review.bridge.drop(owner)
      },
    }),
  })
  holder.bridge = bridge
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  bridge.dispose()
  expect(dropped[0]).toBe(1)
  expect(editor.closed).toEqual([editor.shown[0]!.title])
  await client.closed
  expect(answers(client)).toEqual([])
})

test("a diff to open after the window began closing is dismissed and opens nothing", async () => {
  const { client, editor, review } = await reviewing()
  review.dispose()
  ask(client)
  await until(() => answers(client).length === 1, "the answer")
  expect(answers(client)).toEqual([{ type: "diff.answer", id: "per_a1", answer: "dismissed" }])
  expect(editor.shown).toEqual([])
})

test("frames that are not JSON, a close with a malformed id, and diff frames to a bridge without reviews change nothing", async () => {
  const { client, editor } = await reviewing()
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  client.socket.send("not json")
  client.socket.send(JSON.stringify(["diff.closeAll"]))
  client.socket.send(JSON.stringify({ type: "diff.close", id: "per_a1/../x" }))
  client.socket.send(JSON.stringify({ type: "diff.later", id: "per_a1" }))
  await Bun.sleep(50)
  expect(editor.closed).toEqual([])
  expect(client.socket.readyState).toBe(WebSocket.OPEN)
  // A bridge started without the review service takes a diff frame after hello and does nothing with it.
  const bare = await start(await folder())
  const other = await connect(bare.bridge, (await lock(bare.bridge)).authToken, features)
  await until(() => other.frames.length >= 2, "the hello and the selection")
  ask(other)
  await Bun.sleep(50)
  expect(answers(other)).toEqual([])
  expect(other.socket.readyState).toBe(WebSocket.OPEN)
})

test("a question the chat hears answered closes the chat's tabs of it, and leaves a terminal UI's review of it open", async () => {
  const { client, editor, review } = await reviewing()
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  review.settled("per_a1")
  await Bun.sleep(20)
  expect(editor.closed).toEqual([])
  // The terminal UI closes it when its own prompt goes.
  client.socket.send(JSON.stringify({ type: "diff.close", id: "per_a1" }))
  await until(() => editor.closed.length === 1, "the close")
  expect(answers(client)).toEqual([])
})

describe("a review closed while its file is still being read opens nothing", () => {
  // A disk whose first real path waits until the test lets it go, so a close can come while the review is read.
  function held() {
    const gate = Promise.withResolvers<void>()
    const reader: Disk = {
      realpath: async (file) => (await gate.promise, disk.realpath(file)),
      lstat: (file) => disk.lstat(file),
      readFile: (file) => disk.readFile(file),
    }
    return { reader, release: gate.resolve }
  }
  for (const row of [
    { name: "by a close-all, which tells its owner", close: (frame: Frame) => frame, dismissed: true },
    { name: "by its owner, which is told nothing", close: () => ({ type: "diff.close", id: "per_a1" }), dismissed: false },
  ])
    test(row.name, async () => {
      const disk = held()
      const editor = tabs()
      const review = new Review(editor.host, disk.reader)
      editor.holder.review = review
      const { bridge } = await start(await folder(), { folders: [world.root], diff: review.bridge })
      cleanup.push(() => review.dispose())
      await Bun.sleep(60)
      const client = await connect(bridge, (await lock(bridge)).authToken, features)
      await until(() => client.frames.length >= 2, "the hello and the selection")
      ask(client)
      await Bun.sleep(50)
      client.socket.send(JSON.stringify(row.close({ type: "diff.closeAll" })))
      await Bun.sleep(50)
      disk.release()
      await Bun.sleep(100)
      expect(editor.shown).toEqual([])
      expect(answers(client)).toEqual(row.dismissed ? [{ type: "diff.answer", id: "per_a1", answer: "dismissed" }] : [])
    })
})

test("a client that goes away takes its reviews with it, and nothing is answered", async () => {
  const { client, editor, review } = await reviewing()
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  const tab = editor.shown[0]!
  client.socket.close()
  await client.closed
  await until(() => editor.closed.includes(tab.title), "the tab closing")
  // A save that arrives late answers nothing and does not fail.
  await review.provider.writeFile(tab.right.path, new TextEncoder().encode("late\n"))
  await review.reject(tab.right.path)
  expect(answers(client)).toEqual([])
  expect(editor.replies).toEqual([])
})

test("a saved text too large for a frame is not sent, and the save says why", async () => {
  const { client, editor, review } = await reviewing()
  ask(client)
  await until(() => editor.shown.length === 1, "the tab")
  const tab = editor.shown[0]!
  const large = new TextEncoder().encode("x".repeat(IdeLock.frameCap))
  await expect(review.provider.writeFile(tab.right.path, large)).rejects.toThrow("too large to send back to the terminal")
  await Bun.sleep(30)
  expect(answers(client)).toEqual([])
  expect(editor.closed).toEqual([])
  // The tab still answers: a save that fits goes through.
  await review.provider.writeFile(tab.right.path, new TextEncoder().encode("fits\n"))
  await until(() => answers(client).length === 1, "the answer")
  expect(answers(client)[0]).toEqual({ type: "diff.answer", id: "per_a1", answer: "saved", content: "fits\n" })
  expect(editor.warnings).toHaveLength(0)
})

test("Accept on a tab whose text is too large for a frame sends nothing, keeps the tab and says why", async () => {
  const large = await fs.realpath(await folder())
  const file = path.join(large, "large.txt")
  // Many short lines, so the patch holds a few of them and the text the tab holds is over the cap.
  const body = `${"y".repeat(99)}\n`.repeat(Math.ceil(IdeLock.frameCap / 100))
  await fs.writeFile(file, `${body}alpha\n`)
  const { client, editor, review } = await reviewing({ window: [large] })
  ask(client, {
    place: file,
    roots: [large],
    patch: createTwoFilesPatch("large.txt", "large.txt", `${body}alpha\n`, `${body}ALPHA\n`),
  })
  await until(() => editor.shown.length === 1, "the tab")
  await review.accept(editor.shown[0]!.right.path)
  await Bun.sleep(30)
  expect(answers(client)).toEqual([])
  expect(editor.closed).toEqual([])
  expect(editor.warnings).toEqual([tooLargeNotice])
  // A save that fits still answers.
  await review.provider.writeFile(editor.shown[0]!.right.path, new TextEncoder().encode("fits\n"))
  await until(() => answers(client).length === 1, "the answer")
  expect(editor.warnings).toEqual([tooLargeNotice])
})
