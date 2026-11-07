import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@orbit/util/global"
import { afterAll, expect, test } from "bun:test"
import { Effect, Option } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import print from "../../src/commands/handlers/print"
import { headlessInput } from "../../src/commands/handlers/run"
import { Config } from "../../src/config"
import { ORBIT_VERSION } from "../../src/version"

// clients-ux-37, in this process: `--tool-labels` and `--prompt-suggestions` are refused before any server is asked when
// the run could not print their lines, and otherwise the run starts. `stream-assist.test.ts` runs the same doors as
// child processes against a real server and model, and pins there that both flags reach the stream driver from `orb -p`
// and from `orb run`.

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
  rewindFiles: Option.none(),
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
// new session, and a quiet event stream. Everything else is not found, so the run stops at its first call.
const asked: string[] = []
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    asked.push(`${request.method} ${url.pathname}`)
    const directory = url.searchParams.get("location[directory]") ?? process.cwd()
    if (url.pathname === "/api/location/trust")
      return Response.json({ directory, trusted: true, persistent: true, source: "saved", withheld: [], changed: [] })
    if (url.pathname === "/api/location") return Response.json({ directory, project: { id: "prj_flags" } })
    if (url.pathname === "/api/session" && request.method === "POST")
      return Response.json({ data: { id: "ses_flags", location: { directory }, agent: "build" } })
    if (url.pathname === "/api/info") return Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] })
    // An event stream that says it is connected and then stays open and quiet.
    if (url.pathname === "/api/event")
      return new Response(
        new ReadableStream({
          start: (controller) =>
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {} })}\n\n`,
              ),
            ),
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    return Response.json({ _tag: "NotFound", message: "not found" }, { status: 404 })
  },
})

afterAll(async () => {
  server.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// That the flags' values reach the stream driver is pinned from both doors in `stream-assist.test.ts`, whose runs are
// child processes; this runs the same command in this process, with no module replaced, up to the run of the session.
test("orb run with stream input and both flags, in this process, creates the session and starts its run", async () => {
  // The run sets the exit code the driver returns; the test runner's own must stay as it was.
  const exitCode = process.exitCode
  const code = await Effect.runPromise(
    provided(
      headlessInput({
        ...headless,
        server: Option.some(server.url.origin),
        toolLabels: true,
        promptSuggestions: true,
      }),
    ),
  )
    .then(() => process.exitCode)
    .finally(() => {
      // Bun keeps an exit code that is set to undefined, so an unset one goes back to 0.
      process.exitCode = exitCode ?? 0
    })

  // The run subscribes to the events and then switches the session to the agent it was created with; the fake server
  // refuses that, so the run ends with a failure.
  expect(asked).toEqual(
    expect.arrayContaining(["POST /api/session", "GET /api/event", "POST /api/session/ses_flags/agent"]),
  )
  expect(code).toBe(1)
}, 60_000)
