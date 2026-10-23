import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { afterAll, expect, mock, test } from "bun:test"
import { Effect, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import print from "../../src/commands/handlers/print"
import { headlessInput } from "../../src/commands/handlers/run"
import { Config } from "../../src/config"
import type { StreamInput } from "../../src/run/stream"
import { ORBIT_VERSION } from "../../src/version"

// clients-ux-37, in this process: `--tool-labels` and `--prompt-suggestions` are refused before any server is asked when
// the run could not print their lines, and otherwise reach the stream driver as its `labels` and `suggestions`.
// `stream-assist.test.ts` runs the same doors as child processes against a real server and model; this pins the two
// handlers' checks and the hand-over from the command to the driver, which a child process does not report.

const headless: Parameters<typeof headlessInput>[0] = {
  server: Option.none(),
  standalone: false,
  trust: false,
  bare: false,
  settings: [],
  mcpConfig: [],
  agents: Option.none(),
  message: [],
  continue: false,
  session: Option.none(),
  resume: Option.none(),
  fork: false,
  model: Option.none(),
  agent: Option.none(),
  format: "stream-json",
  jsonSchema: Option.none(),
  file: [],
  inputFormat: Option.some("stream-json"),
  title: Option.none(),
  thinking: false,
  maxSteps: Option.none(),
  maxCost: Option.none(),
  maxTokens: Option.none(),
  fallbackModel: Option.none(),
  toolLabels: false,
  promptSuggestions: false,
  auto: false,
  yolo: false,
  dangerouslySkipPermissions: false,
}

const printInput = (flags: {
  outputFormat: "text" | "json" | "stream-json"
  toolLabels: boolean
}): Parameters<typeof print>[0] => ({
  ...headless,
  print: true,
  outputFormat: Option.some(flags.outputFormat),
  inputFormat: Option.none(),
  includePartialMessages: false,
  verbose: false,
  toolLabels: flags.toolLabels,
})

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-stream-assist-flags-")))

// Runs a command handler with what the CLI's runtime gives it.
const provided = <A, E, R>(run: Effect.Effect<A, E, R>) =>
  run.pipe(
    Effect.provide(Config.layer),
    Effect.provide(Global.layerWith({ config: path.join(root, "config"), state: path.join(root, "state") })),
    Effect.provide(NodeFileSystem.layer),
    Effect.scoped,
  )

test.each([
  { output: "text", message: "--tool-labels requires --output-format stream-json" },
  { output: "json", message: "--tool-labels requires --output-format stream-json" },
] as const)("orb -p --output-format $output --tool-labels is refused", async (row) => {
  const run = print(printInput({ outputFormat: row.output, toolLabels: true }))
  expect((await Effect.runPromise(Effect.flip(provided(run)))).message).toBe(row.message)
})

test.each([
  {
    name: "--tool-labels without the stream-json format",
    input: { format: "result", inputFormat: Option.none(), toolLabels: true },
    message: "--tool-labels requires --format stream-json",
  },
  {
    name: "--tool-labels without stream input",
    input: { inputFormat: Option.none(), toolLabels: true },
    message: "--tool-labels requires --input-format stream-json",
  },
  {
    name: "--prompt-suggestions without stream input",
    input: { inputFormat: Option.none(), promptSuggestions: true },
    message: "--prompt-suggestions requires --input-format stream-json",
  },
] as const)("orb run: $name is refused", async (row) => {
  const run = headlessInput({ ...headless, ...row.input })
  expect((await Effect.runPromise(Effect.flip(provided(run)))).message).toBe(row.message)
})

// A server that answers what the command asks before the run starts: its version, a trusted folder, the folder and a
// new session. Everything else is not found.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    const directory = url.searchParams.get("location[directory]") ?? process.cwd()
    if (url.pathname === "/api/location/trust")
      return Response.json({ directory, trusted: true, persistent: true, source: "saved", withheld: [], changed: [] })
    if (url.pathname === "/api/location") return Response.json({ directory, project: { id: "prj_flags" } })
    if (url.pathname === "/api/session" && request.method === "POST")
      return Response.json({ data: { id: "ses_flags", location: { directory }, agent: "build" } })
    if (url.pathname === "/api/info") return Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] })
    return Response.json({ _tag: "NotFound", message: "not found" }, { status: 404 })
  },
})

afterAll(async () => {
  server.stop(true)
  mock.restore()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test.each([
  { flags: { toolLabels: true, promptSuggestions: true }, driver: { labels: true, suggestions: true } },
  { flags: { toolLabels: false, promptSuggestions: false }, driver: { labels: false, suggestions: false } },
])("orb run with stream input hands $flags to the stream driver as $driver", async (row) => {
  const driven: StreamInput[] = []
  const stream = await import("../../src/run/stream")
  mock.module("../../src/run/stream", () => ({
    ...stream,
    runStream: async (input: StreamInput) => {
      driven.push(input)
      return 0
    },
  }))
  // The run sets the exit code the driver returns; the test runner's own must stay as it was.
  const exitCode = process.exitCode
  try {
    await Effect.runPromise(
      provided(headlessInput({ ...headless, server: Option.some(server.url.origin), ...row.flags })),
    )
  } finally {
    process.exitCode = exitCode
    mock.restore()
  }

  expect(driven.map((input) => ({ labels: input.labels, suggestions: input.suggestions }))).toEqual([row.driver])
})
