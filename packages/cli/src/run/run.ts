import { Service, type Endpoint } from "@orbit/client/effect/service"
import { Orbit, type JsonValue, type OrbitClient, type SessionMessageAssistantTool } from "@orbit/client/promise"
import { body, jsonLine, progress } from "@orbit/flow/plain"
import { FSUtil } from "@orbit/util/fs-util"
import { open } from "node:fs/promises"
import { EOL } from "node:os"
import path from "node:path"
import { readStdin } from "../util/io"
import { ServerConnection } from "../services/server-connection"
import { parseSessionTargetModel, resolveSessionTarget } from "../session-target"
import { toolInlineInfo, toolOutputText } from "@orbit/tui/mini/tool"
import { runNonInteractivePrompt, wroteResult } from "./noninteractive"
import { runStream } from "./stream"
import { UI } from "./ui"
import { Env } from "../env"
import { errorMessage } from "../util/error"
import { ORBIT_VERSION } from "../version"

export type RunCommandInput = {
  server: ServerConnection.Resolved
  message: string[]
  continue?: boolean
  session?: string
  /** `session` came from --resume: it must exist already, and a miss never creates it. */
  mustExist?: boolean
  fork?: boolean
  model?: string
  agent?: string
  format: "default" | "json" | "stream-json" | "result"
  /** The schema the final answer must follow, handed to the server as `turn.output`. */
  jsonSchema?: { readonly [key: string]: JsonValue }
  /** How many responses may hand in a non-matching answer; the server's default when absent. */
  attempts?: number
  file: string[]
  title?: string
  thinking?: boolean
  maxSteps?: number
  maxCost?: number
  maxTokens?: number
  fallbackModel?: string
  auto?: boolean
  /** `orb -p`: init and result lines, the enriched result, and the schema text mode. `orb run --format` has none. */
  envelope?: boolean
  /** With the stream-json envelope: text, reasoning and tool input fragments as they stream. */
  partial?: boolean
  /** With the text format: tool output bodies and a usage line per step. */
  verbose?: boolean
  /** With stream input: ask for a label after each finished batch of tool calls (`--tool-labels`). */
  labels?: boolean
  /** With stream input: ask for a suggestion after each result (`--prompt-suggestions`). */
  suggestions?: boolean
  /** `--input-format stream-json`: standard input is a stream of JSON inputs, answered with the envelope of lines. */
  stream?: boolean
}

type FilePart = {
  url: string
  filename: string
  mime: string
}

type Prepared = {
  directory?: string
  message: string
  files: FilePart[]
}

type ExecutionOptions = {
  root?: string
  directory?: string
  useServerDirectory?: boolean
  variant?: string
  attached?: boolean
  compatibility?: "v1"
}

class RunTargetError extends Error {
  constructor(
    message: string,
    readonly sessionID?: string,
  ) {
    super(message)
  }
}

const ATTACH_FILE_MAX_BYTES = 10 * 1024 * 1024

export function runNonInteractive(input: RunCommandInput) {
  return runNonInteractiveWithOptions(input, {})
}

/** @internal Used only by the V1 command boundary. */
export function runNonInteractiveWithOptions(input: RunCommandInput, options: ExecutionOptions) {
  return run(input, options).catch((error) => reportRunError(input, errorMessage(error)))
}

async function run(input: RunCommandInput, options: ExecutionOptions) {
  if (input.fork && !input.continue && !input.session) fail("--fork requires --continue, --session or --resume")
  const root = options.root ?? process.env.PWD ?? process.cwd()
  const local = localDirectory(root)
  const directory = options.useServerDirectory ? undefined : (options.directory ?? local)
  // Stream input leaves standard input to the protocol, and needs no message: the first one may come down the stream.
  const message = input.stream
    ? (formatMessage(input.message) ?? "")
    : mergeInput(formatMessage(input.message), process.stdin.isTTY ? undefined : await readStdin())
  if (!input.stream && !message?.trim()) fail("You must provide a message")
  const files = await Promise.all(input.file.map((file) => prepareFile(file, root, options)))
  const prepared = { directory, message: message ?? "", files }
  return execute(input, prepared, input.server.endpoint, options, root)
}

async function execute(
  input: RunCommandInput,
  prepared: Prepared,
  endpoint: Endpoint,
  options: ExecutionOptions,
  root: string,
) {
  const client = Orbit.make({
    baseUrl: endpoint.url,
    headers: Service.headers(endpoint),
    // Bun's default five-minute deadline terminates the event stream used by long-running sessions.
    fetch: ((request: RequestInfo | URL, init?: RequestInit) =>
      fetch(request, { ...init, timeout: false } as BunFetchRequestInit)) as typeof fetch,
  })
  const explicit = parseRunModel(input.model)
  const fallback = parseSessionTargetModel(input.fallbackModel)
  const turn =
    input.maxSteps === undefined &&
    input.maxCost === undefined &&
    input.maxTokens === undefined &&
    !fallback &&
    input.jsonSchema === undefined
      ? undefined
      : {
          ...(input.maxSteps === undefined ? {} : { maxSteps: input.maxSteps }),
          ...(input.maxCost === undefined ? {} : { maxCost: input.maxCost }),
          ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
          ...(fallback ? { fallbackModel: fallback } : {}),
          ...(input.jsonSchema === undefined
            ? {}
            : {
                output: {
                  schema: input.jsonSchema,
                  ...(input.attempts === undefined ? {} : { attempts: input.attempts }),
                },
              }),
        }
  const target = await resolveSessionTarget({
    client,
    location: prepared.directory ? { directory: prepared.directory } : undefined,
    continue: input.continue,
    session: input.session,
    mustExist: input.mustExist,
    fork: input.fork,
    model: explicit
      ? { providerID: explicit.model.providerID, id: explicit.model.modelID, variant: explicit.variant }
      : undefined,
    agent: input.agent,
    environment: input.server.service ? Env.session() : undefined,
    prepare: async (next) => {
      const selected =
        next.model ??
        (options.variant
          ? await client.model
              .default({ location: { directory: next.location.directory } })
              .then((result) => result.data)
          : undefined)
      const model = selected
        ? {
            providerID: selected.providerID,
            id: selected.id,
            variant: options.variant ?? ("variant" in selected ? selected.variant : undefined),
          }
        : undefined
      if ((options.variant ?? explicit?.variant) && !model)
        throw new RunTargetError("Cannot select a variant before selecting a model", next.session?.id)
      return { model, agent: next.agent }
    },
  }).catch((error) => {
    if (!(error instanceof RunTargetError)) throw error
    reportRunError(input, error.message, error.sessionID)
    return undefined
  })
  if (!target) return
  const model = target.model ? { providerID: target.model.providerID, modelID: target.model.id } : undefined
  const variant = target.model?.variant
  if (!target.resume && input.title !== undefined) {
    await client.session.update({
      sessionID: target.session.id,
      title: input.title || prepared.message.slice(0, 50) + (prepared.message.length > 50 ? "..." : ""),
    })
  }

  // The model of the init line is the one the run asks for, or the default of the folder when it asks for none.
  const initModel =
    input.envelope && input.format === "stream-json"
      ? (model ??
        (await client.model
          .default({ location: { directory: target.location.directory } })
          .then((result) => (result.data ? { providerID: result.data.providerID, modelID: result.data.id } : undefined))
          .catch(() => undefined)))
      : undefined
  if (input.stream && input.envelope) {
    process.exitCode = await runStream({
      client,
      sessionID: target.session.id,
      location: target.location,
      agent: target.agent,
      model,
      variant,
      thinking: input.thinking ?? false,
      partial: input.partial,
      labels: input.labels,
      suggestions: input.suggestions,
      jsonSchema: input.jsonSchema,
      turn,
      auto: input.auto ?? false,
      attached: options.attached ?? true,
      envelope: {
        cwd: target.location.directory,
        agent: target.agent,
        model: initModel ? `${initModel.providerID}/${initModel.modelID}` : undefined,
        version: ORBIT_VERSION,
      },
      first: prepared.message.trim() ? { message: prepared.message, files: prepared.files } : undefined,
      // A terminal is not a stream of inputs: the message on the command line is then the only input.
      stdin: process.stdin.isTTY ? undefined : process.stdin,
      resolveFile: (value) => (value.startsWith("data:") ? dataFile(value) : prepareFile(value, root, options)),
    }).catch((error) => {
      reportRunError(input, errorMessage(error), target.session.id)
      return 1
    })
    return
  }
  await runNonInteractivePrompt({
    client,
    sessionID: target.session.id,
    location: target.location,
    message: prepared.message,
    files: prepared.files,
    agent: target.agent,
    model,
    variant,
    thinking: input.thinking ?? false,
    format: input.format,
    envelope: input.envelope
      ? {
          cwd: target.location.directory,
          agent: target.agent,
          model: initModel ? `${initModel.providerID}/${initModel.modelID}` : undefined,
          version: ORBIT_VERSION,
        }
      : undefined,
    partial: input.partial,
    verbose: input.verbose,
    jsonSchema: input.jsonSchema,
    turn,
    auto: input.auto ?? false,
    attached: options.attached ?? true,
    compatibility: options.compatibility,
    renderTool: (part) => renderTool(part, target.location.directory, input.verbose),
    renderToolError: (part) => renderToolError(part, target.location.directory),
  }).catch((error) => reportRunError(input, errorMessage(error), target.session.id))
}

export function mergeInput(message: string | undefined, piped: string | undefined) {
  if (!message) return piped || undefined
  if (!piped) return message
  return message + "\n" + piped
}

export function formatMessage(message: string[]) {
  // Quotes keep word boundaries between several arguments; a single argument is the prompt as typed.
  if (message.length === 1) return message[0] || undefined
  const value = message.map((part) => (part.includes(" ") ? `"${part.replace(/"/g, '\\"')}"` : part)).join(" ")
  return value || undefined
}

function localDirectory(root: string) {
  try {
    process.chdir(root)
    return process.cwd()
  } catch {
    fail(`Failed to change directory to ${root}`)
  }
}

export function parseRunModel(value?: string) {
  const ref = parseSessionTargetModel(value)
  if (!ref) return
  return {
    model: { providerID: ref.providerID, modelID: ref.id },
    variant: ref.variant,
  }
}

async function prepareFile(input: string, directory: string, options: ExecutionOptions): Promise<FilePart> {
  const file = path.resolve(directory, input)
  const handle = await open(file, "r").catch(() => fail(`File not found: ${input}`))
  try {
    const stat = await handle.stat()
    if (options.compatibility === "v1" && options.attached && stat.isDirectory())
      fail(`Cannot attach local directory without a shared filesystem: ${input}`)
    if (!stat.isFile() || stat.size > ATTACH_FILE_MAX_BYTES)
      fail(`Cannot attach a directory, special file, or file larger than 10 MiB: ${input}`)
    const content = Buffer.alloc(Number(stat.size))
    let offset = 0
    while (offset < content.length) {
      const read = await handle.read(content, offset, content.length - offset, offset)
      if (read.bytesRead === 0) break
      offset += read.bytesRead
    }
    const bytes = content.subarray(0, offset)
    const detected = FSUtil.mimeType(file)
    const text = bytes.toString("utf8")
    const mime =
      detected.startsWith("image/") || detected === "application/pdf"
        ? detected
        : !isBinaryContent(bytes) && Buffer.from(text, "utf8").equals(bytes)
          ? "text/plain"
          : detected
    return {
      url: `data:${mime};base64,${bytes.toString("base64")}`,
      filename: path.basename(file),
      mime,
    }
  } finally {
    await handle.close()
  }
}

function isBinaryContent(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  if (bytes.includes(0)) return true
  return bytes.reduce((count, byte) => count + Number(byte < 9 || (byte > 13 && byte < 32)), 0) / bytes.length > 0.3
}

async function renderTool(part: SessionMessageAssistantTool, directory: string, verbose?: boolean) {
  const info = toolInlineInfo(part, directory)
  // --verbose also prints what the tool returned, which a block already shows as its body.
  const output =
    verbose && info.mode !== "block" && part.state.status === "completed"
      ? toolOutputText(part.name, part.state.content).trim()
      : ""
  if (info.mode === "block") {
    UI.empty()
    UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + progress(info.title))
    if (info.body?.trim()) UI.println(body(info.body))
    UI.empty()
    return
  }
  UI.println(
    UI.Style.TEXT_NORMAL + info.icon,
    UI.Style.TEXT_NORMAL + progress(info.title),
    info.description ? UI.Style.TEXT_DIM + progress(info.description) + UI.Style.TEXT_NORMAL : "",
  )
  // A lone carriage return would overwrite the line before it on a terminal, so it breaks the line instead.
  if (output)
    UI.println(
      body(output.replace(/\r\n?/g, "\n"))
        .split("\n")
        .map((line) => `  ${line}`)
        .join(EOL),
    )
}

async function renderToolError(part: SessionMessageAssistantTool, directory: string) {
  const info = toolInlineInfo(part, directory)
  UI.println(UI.Style.TEXT_NORMAL + "✗", UI.Style.TEXT_NORMAL + `${progress(info.title)} failed`)
}

/** @internal Used by the V1 command boundary before a Session exists. */
export function reportRunError(
  input: Pick<RunCommandInput, "format" | "envelope">,
  message: string,
  sessionID?: string,
) {
  process.exitCode = 1
  if (input.format === "result" || (input.envelope && input.format === "stream-json")) {
    if (wroteResult()) return
    process.stdout.write(
      jsonLine({
        type: "result",
        sessionID: sessionID ?? "",
        is_error: true,
        subtype: "error",
        ...(input.envelope ? { outcome: "failed", reason: "error" } : {}),
        result: "",
        error: message,
        ...(input.envelope
          ? {
              steps: 0,
              duration_ms: 0,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              rejected: [],
            }
          : {
              usage: { steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } },
            }),
        truncated: false,
      }) + "\n",
    )
    return
  }
  if (input.format === "json" || input.format === "stream-json") {
    process.stdout.write(
      jsonLine({
        type: "error",
        timestamp: Date.now(),
        sessionID: sessionID ?? "",
        subtype: "error",
        error: { type: "unknown", message },
      }) + "\n",
    )
    return
  }
  UI.error(message)
}

// A `data:` URL from a `user` line, which carries its own bytes. Only the base64 form is read, and the same size limit
// as a file applies.
async function dataFile(value: string): Promise<FilePart> {
  const comma = value.indexOf(",")
  const header = comma === -1 ? "" : value.slice(5, comma)
  if (!header.endsWith(";base64")) fail("A data URL file must be base64 encoded: data:<type>;base64,<data>")
  if (value.length > Math.ceil((ATTACH_FILE_MAX_BYTES * 4) / 3) + comma + 4)
    fail("Cannot attach a file larger than 10 MiB")
  return { url: value, filename: "attachment", mime: header.split(";")[0] || "text/plain" }
}

function fail(message: string): never {
  throw new Error(message)
}
