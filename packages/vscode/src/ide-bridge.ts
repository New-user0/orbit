// Orbit's bridge between an editor window and the terminal UI that runs in it. The extension hosts a WebSocket server on
// the loopback interface and writes a lock file that names its port and token, and the terminal UI finds the lock,
// connects with the token and gets the file and selection the person is working in. It has no `vscode` import, so the
// tests load it as it is: the editor's lifecycle, logging and environment come in as arguments. It starts no program and
// makes no outbound connection.
import { IdeLock } from "@orbit/util/ide-lock"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { WebSocketServer, type WebSocket } from "ws"

/** A position as the editor has it: lines and characters count from 0. */
export type EditorPosition = { readonly line: number; readonly character: number }

/** The file the person works in and what is selected there. An empty selection has the same start and end. */
export type EditorSelection = {
  readonly filePath: string
  readonly text: string
  readonly start: EditorPosition
  readonly end: EditorPosition
}

export type Mention = {
  readonly filePath: string
  /** Both or neither: 1-based, inclusive. */
  readonly lineStart?: number
  readonly lineEnd?: number
}

export type BridgeOptions = {
  /** The folder that holds the locks. */
  directory: string
  /** The workspace folders of the window, as paths on disk. */
  folders: readonly string[]
  /** The editor's display name. */
  ideName: string
  /** One line per event. A line never holds the token. */
  log: (line: string) => void
  /** Called with the port once the bridge listens, and with `undefined` when it stops, for the terminals' environment. */
  environment: (port: number | undefined) => void
  /** How long selection changes are held back so that a burst is sent once. */
  debounce?: number
  /** How long a client has to say hello before it is closed. */
  helloTimeout?: number
}

export type Bridge = {
  /** The address the server listens on, which is always the loopback literal. */
  readonly host: string
  readonly port: number
  readonly lockFile: string
  select(selection: EditorSelection | undefined): void
  /** Sends the mention to the client whose pid is `preferredPid`, else to the one that connected last. */
  mention(mention: Mention, preferredPid?: number): boolean
  folders(folders: readonly string[]): void
  clients(): number
  dispose(): void
}

type Client = { socket: WebSocket; order: number; pid?: number; ready: boolean }

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const token = IdeLock.token()
  const debounce = options.debounce ?? 100
  const helloTimeout = options.helloTimeout ?? 5_000
  const clients = new Set<Client>()
  // A client sends one hello, so a few KiB is plenty.
  const maxFrame = 4096
  const sockets = new WebSocketServer({ noServer: true, maxPayload: maxFrame })
  const server = http.createServer((_request, response) => {
    response.writeHead(426).end()
  })
  let folders = [...options.folders]
  let current: EditorSelection | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let count = 0
  let disposed = false

  server.on("upgrade", (request, socket, head) => {
    if (!allowed(request.headers[IdeLock.header], token)) {
      // Only that a connection was refused is logged: never what it sent.
      options.log("IDE bridge: refused a connection without the right token")
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      return
    }
    sockets.handleUpgrade(request, socket, head, (ws) => accept(ws))
  })

  const accept = (socket: WebSocket) => {
    const client: Client = { socket, order: (count += 1), ready: false }
    clients.add(client)
    const silent = setTimeout(() => socket.close(1008, "no hello"), helloTimeout)
    socket.on("close", () => {
      clearTimeout(silent)
      clients.delete(client)
    })
    socket.on("error", () => socket.terminate())
    socket.on("message", (data, binary) => {
      // maxPayload makes ws refuse a large frame while it reads it; this holds under any WebSocket implementation.
      if (binary || (data as Buffer).length > maxFrame) return socket.close(1009, "frame too large")
      const hello = parseHello(data.toString())
      if (!hello || client.ready) return
      clearTimeout(silent)
      send(socket, { type: "hello", version: IdeLock.version, editor: options.ideName })
      if (hello.version !== IdeLock.version) {
        options.log(`IDE bridge: closed a client that speaks version ${hello.version}`)
        socket.close(IdeLock.closeVersion, "unsupported version")
        return
      }
      client.ready = true
      client.pid = hello.pid
      send(socket, selectionFrame(current))
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    // Never 0.0.0.0, :: or localhost: the name can resolve to another interface.
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as { address: string; port: number }
  const port = address.port
  const lockFile = IdeLock.file(options.directory, port)

  prune(options.directory, port, options.log)
  writeLock(options.directory, port, lockFile, { ideName: options.ideName, folders, token })
  options.environment(port)
  options.log(`IDE bridge: listening on 127.0.0.1:${port}`)

  const flush = () => {
    timer = undefined
    const frame = selectionFrame(current)
    for (const client of clients) if (client.ready) send(client.socket, frame)
  }

  return {
    host: address.address,
    port,
    lockFile,
    select(selection) {
      if (disposed) return
      current = selection
      timer ??= setTimeout(flush, debounce)
    },
    mention(mention, preferredPid) {
      const ready = [...clients].filter((client) => client.ready)
      const target =
        (preferredPid === undefined ? undefined : ready.find((client) => client.pid === preferredPid)) ??
        ready.reduce<Client | undefined>((last, client) => (!last || client.order > last.order ? client : last), undefined)
      if (!target) return false
      send(target.socket, { type: "mention", ...mention })
      return true
    },
    folders(next) {
      folders = [...next]
      writeLock(options.directory, port, lockFile, { ideName: options.ideName, folders, token })
    },
    clients: () => [...clients].filter((client) => client.ready).length,
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      for (const client of clients) client.socket.close(1001, "editor closed")
      sockets.close()
      server.close()
      server.closeAllConnections()
      fs.rmSync(lockFile, { force: true })
      options.environment(undefined)
    },
  }
}

/** The frame for the current selection, with the editor's 0-based positions as the 1-based ones the wire carries. */
function selectionFrame(selection: EditorSelection | undefined) {
  if (!selection) return { type: "selection", filePath: null }
  return {
    type: "selection",
    filePath: selection.filePath,
    text: selection.text.slice(0, IdeLock.selectionTextCap),
    selection: {
      start: { line: selection.start.line + 1, character: selection.start.character + 1 },
      end: { line: selection.end.line + 1, character: selection.end.character + 1 },
    },
  }
}

function send(socket: WebSocket, frame: object) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame))
}

function parseHello(text: string) {
  const value: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  if (typeof value !== "object" || value === null) return undefined
  const frame = value as Record<string, unknown>
  if (frame.type !== "hello" || typeof frame.version !== "number") return undefined
  const pid = typeof frame.pid === "number" && Number.isInteger(frame.pid) && frame.pid > 0 ? frame.pid : undefined
  return { version: frame.version, pid }
}

/** Compares in constant time on buffers of one length: a different length is a refusal. */
function allowed(header: string | string[] | undefined, token: string) {
  if (typeof header !== "string") return false
  const given = Buffer.from(header)
  const wanted = Buffer.from(token)
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted)
}

/** Writes the lock to a file of its own first and renames it, so that a reader never sees half of it. */
function writeLock(
  directory: string,
  port: number,
  lockFile: string,
  input: { ideName: string; folders: readonly string[]; token: string },
) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const lock: IdeLock.Lock = {
    version: 1,
    pid: process.pid,
    port,
    workspaceFolders: [...input.folders],
    ideName: input.ideName,
    authToken: input.token,
  }
  const temporary = path.join(directory, `.${port}.${crypto.randomBytes(6).toString("hex")}.tmp`)
  fs.writeFileSync(temporary, JSON.stringify(lock), { mode: 0o600 })
  fs.renameSync(temporary, lockFile)
}

/**
 * Removes the locks of editors that are gone: a version 1 lock whose process no longer runs. A file that does not parse or
 * has another version may belong to a newer extension, so it stays.
 */
function prune(directory: string, own: number, log: (line: string) => void) {
  const names = fs.existsSync(directory) ? fs.readdirSync(directory) : []
  for (const name of names) {
    const port = IdeLock.port(name)
    if (port === undefined || port === own) continue
    const file = path.join(directory, name)
    const pid = (() => {
      try {
        const lock: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
        if (typeof lock !== "object" || lock === null) return undefined
        const fields = lock as Record<string, unknown>
        return fields.version === IdeLock.version && typeof fields.pid === "number" && Number.isInteger(fields.pid)
          ? fields.pid
          : undefined
      } catch {
        return undefined
      }
    })()
    if (pid === undefined) {
      log(`IDE bridge: left ${name} alone, because it is not a version 1 lock`)
      continue
    }
    if (alive(pid)) continue
    try {
      fs.rmSync(file, { force: true })
    } catch (error) {
      log(`IDE bridge: could not remove the stale lock ${name}: ${error instanceof Error ? error.message : "error"}`)
    }
  }
}

/** Signal 0 sends nothing: the process exists when it succeeds or when the system refuses to let this one signal it. */
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}
