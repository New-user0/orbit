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

// clients-ux-37, in this process: `--tool-labels` and `--prompt-suggestions` are refused before any server is asked when
// the run could not print their lines. `stream-assist.test.ts` runs the same doors as child processes against a real
// server and model, and pins there that both flags reach the stream driver from `orb -p` and from `orb run`.

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

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
