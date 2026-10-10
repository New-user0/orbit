export * as ConfigOverlay from "./config-overlay"

import { ConfigAgent } from "@orbit/schema/config/agent"
import { ConfigMCP } from "@orbit/schema/config/mcp"
import { Global } from "@orbit/util/global"
import { Service } from "@orbit/client/effect/service"
import { Orbit, type OrbitClient } from "@orbit/client/promise"
import { Effect, Schema, SchemaIssue } from "effect"
import { parse, type ParseError, printParseErrorCode } from "jsonc-parser"
import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { ServiceConfig } from "./services/service-config"
import { errorMessage } from "./util/error"

/** The largest merged document one run may carry, checked before any process starts. */
export const MAX_BYTES = 4 * 1024 * 1024

/** Older than this, a private overlay folder belongs to a run that died before its server read it. */
const STALE_MS = 60 * 60 * 1000

const FOLDER = /^overlay-/

const Envelope = Schema.Struct({ version: Schema.Literal(1), content: Schema.String })

const decodeMcp = Schema.decodeUnknownResult(ConfigMCP.Info)
const decodeAgents = Schema.decodeUnknownResult(Schema.Record(Schema.String, ConfigAgent.Info))
const decodeEnvelope = Schema.decodeUnknownResult(Schema.fromJsonString(Envelope))

type Json = { [key: string]: unknown }

export type Input = {
  /** Each --mcp-config value, in order. */
  readonly mcpConfig: ReadonlyArray<string>
  /** The --agents value. */
  readonly agents?: string
  /** The inherited ORBIT_CONFIG_CONTENT, which the flags layer on top of. */
  readonly inherited?: string
  /** The folder a relative file name and an inline value's relative paths are taken from. */
  readonly cwd: string
}

/** A flag that adds to the run's config cannot reach a server that is already running somewhere else. */
export function conflict(input: { readonly server: string | undefined; readonly flags: ReadonlyArray<string> }) {
  if (input.server === undefined || input.flags.length === 0) return undefined
  return `${input.flags.join(" and ")} cannot be combined with --server: the config belongs to a private server started for this run`
}

/** The flags of the overlay that were given, as they are typed. */
export function given(input: { readonly mcpConfig: ReadonlyArray<string>; readonly agents?: string }) {
  return [...(input.mcpConfig.length > 0 ? ["--mcp-config"] : []), ...(input.agents !== undefined ? ["--agents"] : [])]
}

/**
 * Reads, validates and merges the flags into one config document: the inherited ORBIT_CONFIG_CONTENT, then each
 * --mcp-config in order, then --agents. Returns undefined when no flag was given. Every error names the flag and, for a
 * value that does not fit the schema, the path inside it.
 */
export async function build(input: Input) {
  if (input.mcpConfig.length === 0 && input.agents === undefined) return undefined
  const inherited =
    input.inherited === undefined
      ? {}
      : object("ORBIT_CONFIG_CONTENT", parseJsonc("ORBIT_CONFIG_CONTENT", input.inherited))
  const layers = [
    ...(await Promise.all(input.mcpConfig.map((value) => mcpLayer(value, input.cwd)))),
    ...(input.agents === undefined ? [] : [await agentsLayer(input.agents, input.cwd)]),
  ]
  const merged = layers.reduce(merge, inherited)
  const content = JSON.stringify(merged)
  const size = Buffer.byteLength(content)
  if (size > MAX_BYTES)
    throw new Error(
      `The config given with --mcp-config and --agents is ${size} bytes; the most one run takes is ${MAX_BYTES}`,
    )
  return content
}

/**
 * Writes the document as a versioned envelope into a folder only this user can open, and returns the file and a
 * function that removes both. Folders left by runs that died are swept first. A file carries the document because the
 * environment and the command line have size limits and are visible to other processes.
 */
export async function write(content: string) {
  await sweep()
  await fs.mkdir(Global.Path.tmp, { recursive: true })
  // mkdtemp creates the folder mode 0700 and fails when the name exists, so no other user can have made it first.
  const folder = await fs.mkdtemp(path.join(Global.Path.tmp, "overlay-"))
  const file = path.join(folder, `${randomUUID()}.json`)
  await fs.writeFile(file, JSON.stringify({ version: 1, content }), { mode: 0o600, flag: "wx" })
  return { file, remove: () => fs.rm(folder, { recursive: true, force: true }) }
}

/** What the server does with ORBIT_CONFIG_CONTENT_FILE: read the envelope once and delete it. */
export async function consume(file: string) {
  const text = await Bun.file(file).text()
  // Only the file: the folder around it is the CLI's to remove, and this path came from the environment.
  await fs.rm(file, { force: true })
  const envelope = decodeEnvelope(text)
  if (envelope._tag === "Failure") throw new Error("ORBIT_CONFIG_CONTENT_FILE does not hold a version 1 overlay")
  return envelope.success.content
}

/**
 * Turns the overlay flags into the private server's config: validates them, writes the envelope and names it in
 * ORBIT_CONFIG_CONTENT_FILE for the server this process starts next. Returns whether the run needs its own server;
 * the file is removed when the scope closes.
 */
export const apply = Effect.fn("cli.config-overlay.apply")(function* (
  input: Omit<Input, "cwd" | "inherited"> & { readonly server: string | undefined },
) {
  const refused = conflict({ server: input.server, flags: given(input) })
  if (refused !== undefined) return yield* Effect.fail(new Error(refused))
  const content = yield* Effect.tryPromise({
    try: () => build({ ...input, cwd: process.cwd(), inherited: process.env.ORBIT_CONFIG_CONTENT }),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })
  if (content === undefined) return false
  const written = yield* Effect.tryPromise({
    try: () => write(content),
    catch: (cause) => new Error(`Could not write the config for this run: ${errorMessage(cause)}`, { cause }),
  })
  process.env.ORBIT_CONFIG_CONTENT_FILE = written.file
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      delete process.env.ORBIT_CONFIG_CONTENT_FILE
      await written.remove().catch(() => undefined)
    }),
  )
  return true
})

/**
 * A private server and the background service share one database, so a run that continues a session the service is
 * driving would drain it twice. Looks the service up without starting it and refuses when it reports the target active.
 */
export const refuseActive = Effect.fn("cli.config-overlay.refuse-active")(function* (input: {
  readonly client: OrbitClient
  readonly session: string | undefined
  readonly continue: boolean
  readonly directory: string
}) {
  const target = yield* Effect.tryPromise({
    try: async () =>
      input.session ??
      (input.continue
        ? (await input.client.session.list({ directory: input.directory, parentID: null, limit: 1, order: "desc" }))
            .data[0]?.id
        : undefined),
    catch: (cause) => new Error(errorMessage(cause), { cause }),
  })
  if (target === undefined) return
  const endpoint = yield* Service.discover(yield* ServiceConfig.options()).pipe(
    Effect.catch(() => Effect.succeed(undefined)),
  )
  if (endpoint === undefined) return
  const active = yield* Effect.tryPromise({
    try: () => Orbit.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) }).session.active(),
    catch: () =>
      new Error(
        "Could not ask the background service whether the session is running, so the run stopped before sharing it",
      ),
  })
  if (target in active)
    return yield* Effect.fail(
      new Error(
        `Session ${target} is running in the background service. A run with --mcp-config or --agents uses a private server and would run it a second time; stop it there or start a new session`,
      ),
    )
})

async function sweep() {
  const entries = await fs.readdir(Global.Path.tmp, { withFileTypes: true }).catch(() => [])
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && FOLDER.test(entry.name))
      .map(async (entry) => {
        const folder = path.join(Global.Path.tmp, entry.name)
        const stat = await fs.stat(folder).catch(() => undefined)
        if (stat && Date.now() - stat.mtimeMs > STALE_MS) await fs.rm(folder, { recursive: true, force: true })
      }),
  )
}

async function mcpLayer(value: string, cwd: string) {
  const flag = "--mcp-config"
  const source = await read(flag, value, cwd)
  const document = object(flag, parseJsonc(flag, source.text))
  if ("mcpServers" in document)
    throw new Error(
      `${flag}: "mcpServers" is another product's shape. Use {"servers": {"<name>": {"type": "local", "command": ["<program>", "<argument>"]}}} instead`,
    )
  const decoded = decodeMcp(document, { onExcessProperty: "error", errors: "all" })
  if (decoded._tag === "Failure") throw new Error(describe(flag, decoded.failure.issue))
  const servers = decoded.success.servers
  if (servers === undefined) return { mcp: document }
  const raw = document.servers as Record<string, Json>
  return {
    mcp: {
      ...document,
      servers: Object.fromEntries(
        Object.entries(raw).map(([name, server]) => [name, anchor(server, source.directory)]),
      ),
    },
  }
}

async function agentsLayer(value: string, cwd: string) {
  const flag = "--agents"
  const source = await read(flag, value, cwd)
  const document = object(flag, parseJsonc(flag, source.text))
  const decoded = decodeAgents(document, { onExcessProperty: "error", errors: "all" })
  if (decoded._tag === "Failure") throw new Error(describe(flag, decoded.failure.issue))
  return { agents: document }
}

// A local server's program and working folder, when they are relative paths, mean the folder of the file that names
// them, not the folder the run starts in. A bare program name is a PATH lookup and stays as it is.
function anchor(server: Json, directory: string) {
  if (server.type !== "local") return server
  const command = server.command as ReadonlyArray<string>
  const program = command[0]
  return {
    ...server,
    ...(program !== undefined && /[\\/]/.test(program) && !path.isAbsolute(program)
      ? { command: [path.resolve(directory, program), ...command.slice(1)] }
      : {}),
    ...(typeof server.cwd === "string" && !path.isAbsolute(server.cwd)
      ? { cwd: path.resolve(directory, server.cwd) }
      : {}),
  }
}

// A value that names a file is read from it; any other value is the JSON itself.
async function read(flag: string, value: string, cwd: string) {
  if (value.trimStart().startsWith("{")) return { text: value, directory: cwd }
  const file = path.resolve(cwd, value)
  if (await Bun.file(file).exists()) return { text: await Bun.file(file).text(), directory: path.dirname(file) }
  throw new Error(
    `${flag}: ${value.length > 80 ? `${value.slice(0, 80)}...` : value} is not a file that exists and is not JSON`,
  )
}

function parseJsonc(flag: string, text: string): unknown {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0)
    throw new Error(`${flag}: invalid JSON (${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset})`)
  return value
}

function object(flag: string, value: unknown): Json {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Json
  throw new Error(`${flag}: expected a JSON object`)
}

function describe(flag: string, issue: SchemaIssue.Issue) {
  return SchemaIssue.makeFormatterStandardSchemaV1()(issue)
    .issues.map(
      (item) => `${flag}: ${item.message} at ${item.path?.length ? item.path.map(String).join(".") : "the top level"}`,
    )
    .join("\n")
}

function merge(base: Json, layer: Json): Json {
  return Object.fromEntries(
    [...new Set([...Object.keys(base), ...Object.keys(layer)])].map((key) => {
      const left = base[key]
      const right = layer[key]
      if (!(key in layer)) return [key, left]
      if (isObject(left) && isObject(right)) return [key, merge(left, right)]
      return [key, right]
    }),
  )
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
