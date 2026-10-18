import { afterEach, expect, test } from "bun:test"
import { IdeLock } from "@orbit/util/ide-lock"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import WebSocket from "ws"
import { startBridge, type Bridge, type EditorSelection } from "../src/ide-bridge"

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
