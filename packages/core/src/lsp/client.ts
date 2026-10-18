export * as LspClient from "./client.js"

import { isRecord } from "@orbit/ai/utils/record"
import { NodeStream } from "@effect/platform-node"
import { Effect, Exit, Scope } from "effect"
import { ChildProcess } from "effect/unstable/process"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import path from "path"
import { PassThrough } from "stream"
import { fileURLToPath, pathToFileURL } from "url"
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node"

/**
 * A small Language Server Protocol client: one server process, its open documents, and the diagnostics it publishes.
 * Documents are always sent whole, which both full and incremental servers accept.
 */

export interface Position {
  readonly line: number
  readonly character: number
}

export interface Range {
  readonly start: Position
  readonly end: Position
}

export interface Diagnostic {
  readonly range: Range
  readonly severity?: number
  readonly message: string
  readonly source?: string
  readonly code?: string | number
}

/** 1 error, 2 warning, 3 information, 4 hint. A missing or unknown number counts as an error, as servers differ on it. */
export const severity = (diagnostic: Pick<Diagnostic, "severity">) =>
  diagnostic.severity === 2 || diagnostic.severity === 3 || diagnostic.severity === 4 ? diagnostic.severity : 1

/** The key a file is filed under: its absolute path, and on Windows without letter case. */
export const keyOf = (file: string) => (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file))

export interface Client {
  readonly id: string
  /** The last diagnostics the server published for the file. Never syncs, sends or waits. */
  readonly current: (file: string) => Diagnostic[] | undefined
  /**
   * Sends the file's current text and waits briefly for the diagnostics the server publishes for it. With `save`, the
   * server is then told the file was saved, which some servers wait for before running their deeper checks.
   */
  readonly diagnostics: (file: string, text: string, options?: { readonly save?: boolean }) => Promise<Diagnostic[]>
  /** Sends the file's current text: `didOpen` the first time, `didChange` after that. Returns the file's URI. */
  readonly open: (file: string, text: string) => Promise<string>
  /** Sends a request with exactly these params; nothing about a document is added. */
  readonly send: (method: string, params: Record<string, unknown>) => Promise<unknown>
  /** Opens or refreshes the file, then sends a request about it. */
  readonly request: (method: string, file: string, text: string, params: Record<string, unknown>) => Promise<unknown>
  readonly shutdown: () => Promise<void>
}

const INITIALIZE_TIMEOUT_MS = 45_000
const DIAGNOSTICS_TIMEOUT_MS = 3_000
// Servers often publish several times in a burst after a change; wait for the burst to settle.
const DIAGNOSTICS_SETTLE_MS = 150

export async function start(input: {
  readonly id: string
  readonly command: readonly string[]
  readonly root: string
  /** Starts the server, so its program is looked up on PATH only. */
  readonly spawner: ChildProcessSpawner["Service"]
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}): Promise<Client> {
  const [command, ...args] = input.command
  if (!command) throw new Error(`Language server ${input.id} has no command`)
  // The server's process lives in this scope.
  const scope = Scope.makeUnsafe()
  const stop = () => Effect.runPromise(Scope.close(scope, Exit.void))
  const toServer = new PassThrough()
  const child = await Effect.runPromise(
    input.spawner
      .spawn(
        ChildProcess.make(command, args, {
          cwd: input.root,
          env: input.env,
          extendEnv: true,
          // A PassThrough that this process writes to has no failure the type could carry, so the error stays never.
          stdin: NodeStream.fromReadable({ evaluate: () => toServer, onError: (error) => error as never }),
          stderr: "ignore",
        }),
      )
      .pipe(Scope.provide(scope)),
  )
  const failed = Effect.runPromise(child.exitCode).then(
    () => Promise.reject(new Error(`Language server ${input.id} exited`)),
    () => Promise.reject(new Error(`Language server ${input.id} exited`)),
  )
  failed.catch(() => undefined)
  const connection = createMessageConnection(
    new StreamMessageReader(NodeStream.toReadableNever(child.stdout)),
    new StreamMessageWriter(toServer),
  )

  // Filed by path, not by the address the server wrote: servers spell a Windows drive in lower case with an encoded colon.
  const published = new Map<string, Diagnostic[]>()
  const listeners = new Map<string, Set<() => void>>()
  const versions = new Map<string, number>()

  connection.onNotification("textDocument/publishDiagnostics", (params: unknown) => {
    const publication = decodePublication(params)
    if (!publication) {
      console.warn(`language server ${input.id} sent a diagnostics publication that was dropped`)
      return
    }
    const key = keyOf(publication.file)
    published.set(key, publication.diagnostics)
    listeners.get(key)?.forEach((listener) => listener())
  })
  // Servers ask for settings and capabilities; answer with what was configured and accept registrations.
  connection.onRequest("workspace/configuration", (params: { items: { section?: string }[] }) =>
    params.items.map((item) => (item.section ? (input.initialization?.[item.section] ?? null) : null)),
  )
  connection.onRequest("client/registerCapability", () => null)
  connection.onRequest("window/workDoneProgress/create", () => null)
  connection.listen()

  const root = pathToFileURL(input.root).href
  const initialized = await Promise.race([
    failed,
    timeout(INITIALIZE_TIMEOUT_MS, `Language server ${input.id} did not start`),
    connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: root,
      workspaceFolders: [{ uri: root, name: path.basename(input.root) }],
      initializationOptions: input.initialization,
      capabilities: {
        textDocument: {
          synchronization: { didSave: true },
          publishDiagnostics: { relatedInformation: false },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          implementation: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          callHierarchy: {},
        },
        // No resolveSupport for symbols: without it servers send complete locations.
        workspace: { configuration: true, workspaceFolders: true, symbol: {} },
      },
    }),
  ]).catch(async (error: unknown) => {
    connection.dispose()
    await stop()
    throw error
  })
  // The one place the server's unknown answer is checked: a save carries the text only when the server asked for it.
  const saveText = saveIncludesText(initialized)
  await connection.sendNotification("initialized", {})

  const sync = async (file: string, text: string) => {
    const uri = pathToFileURL(file).href
    const version = (versions.get(uri) ?? 0) + 1
    versions.set(uri, version)
    if (version === 1)
      await connection.sendNotification("textDocument/didOpen", {
        textDocument: { uri, languageId: languageId(file), version, text },
      })
    else
      await connection.sendNotification("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text }],
      })
    return uri
  }

  return {
    id: input.id,
    current: (file) => published.get(keyOf(file)),
    diagnostics: async (file, text, options) => {
      const uri = pathToFileURL(file).href
      const key = keyOf(file)
      const settled = new Promise<void>((resolve) => {
        const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
        const deadline = setTimeout(done, DIAGNOSTICS_TIMEOUT_MS)
        const listener = () => {
          clearTimeout(timer.current)
          timer.current = setTimeout(done, DIAGNOSTICS_SETTLE_MS)
        }
        const set = listeners.get(key) ?? new Set()
        set.add(listener)
        listeners.set(key, set)
        function done() {
          clearTimeout(deadline)
          clearTimeout(timer.current)
          set.delete(listener)
          resolve()
        }
      })
      await sync(file, text)
      if (options?.save)
        await connection
          .sendNotification("textDocument/didSave", { textDocument: { uri }, ...(saveText ? { text } : {}) })
          .catch(() => undefined)
      await settled
      return published.get(key) ?? []
    },
    open: sync,
    send: (method, params) => connection.sendRequest(method, params),
    request: async (method, file, text, params) => {
      const uri = await sync(file, text)
      return connection.sendRequest(method, { textDocument: { uri }, ...params })
    },
    shutdown: async () => {
      await Promise.race([
        connection.sendRequest("shutdown").then(() => connection.sendNotification("exit")),
        timeout(2_000, "shutdown timed out"),
      ]).catch(() => undefined)
      connection.dispose()
      toServer.end()
      await Promise.race([stop(), new Promise((resolve) => setTimeout(resolve, 3_000))])
    },
  }
}

/**
 * The one place a publication is checked. A publication without an address or a list is dropped whole; a malformed entry
 * is dropped alone with one log line, so one bad entry costs only itself.
 */
function decodePublication(params: unknown) {
  if (!isRecord(params) || typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return undefined
  const file = fileOf(params.uri)
  if (file === undefined) return undefined
  const diagnostics = params.diagnostics.flatMap((entry: unknown) => {
    const decoded = decodeDiagnostic(entry)
    if (decoded) return [decoded]
    console.warn("language server sent a malformed diagnostic, which was dropped")
    return []
  })
  return { file, diagnostics }
}

function decodeDiagnostic(entry: unknown): Diagnostic | undefined {
  if (!isRecord(entry) || typeof entry.message !== "string") return undefined
  const range = entry.range
  if (!isRecord(range) || !position(range.start) || !position(range.end)) return undefined
  return {
    range: { start: range.start, end: range.end },
    message: entry.message,
    ...(typeof entry.severity === "number" ? { severity: entry.severity } : {}),
    ...(typeof entry.source === "string" ? { source: entry.source } : {}),
    ...(typeof entry.code === "string" || typeof entry.code === "number" ? { code: entry.code } : {}),
  }
}

function position(value: unknown): value is Position {
  return isRecord(value) && typeof value.line === "number" && typeof value.character === "number"
}

// A `file:` address as a path; anything else, or an address that does not convert, names no file.
function fileOf(uri: string) {
  if (!uri.startsWith("file:")) return undefined
  const converted = Effect.runSync(Effect.try(() => fileURLToPath(uri)).pipe(Effect.option))
  return converted._tag === "Some" ? converted.value : undefined
}

function saveIncludesText(initialized: unknown) {
  if (!isRecord(initialized) || !isRecord(initialized.capabilities)) return false
  const sync = initialized.capabilities.textDocumentSync
  return isRecord(sync) && isRecord(sync.save) && sync.save.includeText === true
}

function timeout(ms: number, message: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms))
}

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascriptreact",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".rb": "ruby",
  ".php": "php",
  ".lua": "lua",
  ".json": "json",
  ".css": "css",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
}

export function languageId(file: string) {
  return LANGUAGES[path.extname(file).toLowerCase()] ?? "plaintext"
}
