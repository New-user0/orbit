export * as LspClient from "./client.js"

import { isRecord } from "@orbit/ai/utils/record"
import spawn from "cross-spawn"
import path from "path"
import { pathToFileURL } from "url"
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

export interface Client {
  readonly id: string
  /**
   * Sends the file's current text and waits briefly for the diagnostics the server publishes for it. With `save`, the
   * server is then told the file was saved, which some servers wait for before running their deeper checks.
   */
  readonly diagnostics: (file: string, text: string, options?: { readonly save?: boolean }) => Promise<Diagnostic[]>
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
  readonly env?: Record<string, string>
  readonly initialization?: Record<string, unknown>
}): Promise<Client> {
  const [command, ...args] = input.command
  if (!command) throw new Error(`Language server ${input.id} has no command`)
  const child = spawn(command, args, {
    cwd: input.root,
    env: { ...process.env, ...input.env },
    stdio: ["pipe", "pipe", "pipe"],
  })
  child.stderr?.resume()
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const failed = new Promise<never>((_, reject) => child.once("error", reject))
  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout!),
    new StreamMessageWriter(child.stdin!),
  )

  const published = new Map<string, Diagnostic[]>()
  const listeners = new Map<string, Set<() => void>>()
  const versions = new Map<string, number>()

  connection.onNotification("textDocument/publishDiagnostics", (params: { uri: string; diagnostics: Diagnostic[] }) => {
    published.set(params.uri, params.diagnostics)
    listeners.get(params.uri)?.forEach((listener) => listener())
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
          definition: {},
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { configuration: true, workspaceFolders: true },
      },
    }),
  ])
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
    diagnostics: async (file, text, options) => {
      const uri = pathToFileURL(file).href
      const settled = new Promise<void>((resolve) => {
        const timer = { current: undefined as ReturnType<typeof setTimeout> | undefined }
        const deadline = setTimeout(done, DIAGNOSTICS_TIMEOUT_MS)
        const listener = () => {
          clearTimeout(timer.current)
          timer.current = setTimeout(done, DIAGNOSTICS_SETTLE_MS)
        }
        const set = listeners.get(uri) ?? new Set()
        set.add(listener)
        listeners.set(uri, set)
        function done() {
          clearTimeout(deadline)
          clearTimeout(timer.current)
          set.delete(listener)
          resolve()
        }
      })
      await sync(file, text)
      // A lost save notice must not lose the diagnostics of the change, so its failure is ignored.
      if (options?.save)
        await connection
          .sendNotification("textDocument/didSave", { textDocument: { uri }, ...(saveText ? { text } : {}) })
          .catch(() => undefined)
      await settled
      return published.get(uri) ?? []
    },
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
      child.kill()
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1_000))])
    },
  }
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
