import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SessionID } from "@orbit/schema/session-id"
import { isolatedEnv } from "./fixture/environment"
import { scriptedModel } from "./fixture/scripted-model"
import { PrintParamFlags } from "../src/commands/commands"

// `orb -p` against a real private server and a scripted model. Every run is a child process of src/index.ts, so the
// argv classification, the Print spec and the handler are the ones a user reaches.
const model = scriptedModel(['{"answer":"ok"}'])
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-print-")))
const workspace = path.join(root, "workspace")
const instructions = "PROJECT-INSTRUCTION-MARKER"
const schema = path.join(root, "schema.json")

beforeAll(async () => {
  await model.configure(root)
  await fs.mkdir(workspace, { recursive: true })
  await Bun.write(path.join(workspace, "AGENTS.md"), `${instructions}\n`)
  await Bun.write(
    schema,
    JSON.stringify({
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    }),
  )
})

test("-p --resume fails with one failed result for a session that does not exist, and creates none", async () => {
  const before = model.requests.length

  const missing = await orb(["-p", ...base, "--resume", "ses_missing", "--output-format", "json", "hello"])
  expect(missing.code).toBe(1)
  expect(missing.stdout.trim().split(/\r?\n/)).toHaveLength(1)
  expect(JSON.parse(missing.stdout)).toMatchObject({ type: "result", is_error: true, error: "Session not found" })

  // Words that match no session are not a new session either, and neither is an empty value.
  for (const value of ["no session has these words", ""]) {
    const result = await orb(["-p", ...base, `--resume=${value}`, "--output-format", "json", "hello"])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ type: "result", is_error: true })
  }
  expect(model.requests.length).toBe(before)

  // A bare -r followed by a flag is an empty value, not a usage error of the parser.
  const bare = await orb(["-p", ...base, "-r", "--output-format", "json", "hello"])
  expect(bare.code).toBe(1)
  expect(JSON.parse(bare.stdout).error).toContain("--resume needs")

  const both = await orb(["-p", ...base, "-c", "-r", "ses_x", "--output-format", "json", "hello"])
  expect(both.code).toBe(1)
  expect(JSON.parse(both.stdout).error).toContain("cannot be combined")
}, 180_000)

// The interface's own checks come before the terminal UI starts, so a child process can reach them without a terminal.
test.each([
  [["--fork"], "--fork requires --continue, --session or --resume"],
  [["-r", "x", "-c"], "--resume cannot be combined with --continue or --session"],
  [["-r", "x", "-s", "ses_x"], "--resume cannot be combined with --continue or --session"],
  [["-r", "no session has these words", "--fork"], "--fork with --resume needs the ID of an existing session"],
  [["-r", "no session has these words", "--prompt", "hi"], "--prompt cannot be combined with a --resume"],
  [["-r", "--prompt", "hi"], "--prompt cannot be combined with a --resume"],
])(
  "orb %j is refused before the terminal UI starts",
  async (flags, message) => {
    const result = await orb([...base, ...flags])

    expect(result.code).toBe(1)
    expect(result.stderr + result.stdout).toContain(message)
  },
  180_000,
)

test("-p --resume continues the session that --session made", async () => {
  const id = SessionID.create()
  await sent([...base, "-p", "--session", id, "first"])

  const resumed = await sent([...base, "-p", "-r", id, "second"])

  expect(resumed.users.at(-1)).toContain("second")
}, 180_000)

afterAll(async () => {
  await model.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function orb(args: string[], input?: string) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      PWD: workspace,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      OLLAMA_CONTEXT_LENGTH: undefined,
    }),
    stdin: input === undefined ? "ignore" : new Response(input),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { code, stdout, stderr }
}

// The user texts the model was sent by one run, one per step.
async function sent(args: string[]) {
  const before = model.steps.length
  const result = await orb(args)
  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  return { ...result, users: model.steps.slice(before).map((step) => step.user), requests: model.steps.slice(before) }
}

const base = ["--standalone", "--model", model.model]

test.each([
  [["-p", ...base, "run", "the", "tests"], "run the tests"],
  [["-p", ...base, "yes", "do", "it"], "yes do it"],
  [["-p", ...base, "debug", "x"], "debug x"],
  [[...base, "fix it", "-p"], "fix it"],
  [["-p", ...base, "--", "--foo", "bar"], "--foo bar"],
  [["run", ...base, "a", "--", "b"], "a b"],
])(
  "%j sends %j to the model exactly once",
  async (args, text) => {
    const run = await sent(args)

    expect(run.users).toEqual([text])
  },
  120_000,
)

test("-p prints the answer, and --output-format json prints one result object", async () => {
  const text = await sent(["-p", ...base, "say ok"])
  const json = await sent(["-p", ...base, "--output-format", "json", "say ok"])

  expect(text.stdout.trim()).toBe('{"answer":"ok"}')
  const lines = json.stdout.trim().split(/\r?\n/)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0])).toMatchObject({ type: "result", is_error: false, result: '{"answer":"ok"}' })
}, 120_000)

test("-p --bare runs as orb run --bare does: on a private server, with no project instructions", async () => {
  const print = await sent(["-p", "--bare", "--model", model.model, "say ok"])
  const run = await sent(["run", "--bare", "--model", model.model, "say ok"])
  // Neither run started a background service under the isolated root: --bare implies a private server.
  const status = await orb(["service", "status"])
  const plain = await sent(["-p", ...base, "say ok"])

  expect(status.stdout.trim()).toBe("stopped")
  expect(print.stdout).toBe(run.stdout)
  expect(print.requests.map((request) => request.system).join("")).not.toContain(instructions)
  expect(run.requests.map((request) => request.system).join("")).not.toContain(instructions)
  // The marker is what a run without --bare is told, so the absence above is the flag's doing.
  expect(plain.requests.map((request) => request.system).join("")).toContain(instructions)
}, 180_000)

test("-p --json-schema prints the result object that orb run --json-schema prints", async () => {
  const print = await sent(["-p", ...base, "--json-schema", schema, "say ok"])
  const run = await sent(["run", ...base, "--json-schema", schema, "say ok"])

  const withoutID = (output: string) => ({ ...JSON.parse(output), sessionID: undefined })
  expect(withoutID(print.stdout)).toMatchObject({ type: "result", is_error: false })
  expect(withoutID(print.stdout)).toEqual(withoutID(run.stdout))
}, 180_000)

test("-p reads a piped message, and with no message at all it fails", async () => {
  const before = model.steps.length
  const piped = await orb(["-p", ...base], "from stdin")
  const none = await orb(["-p", ...base])
  const noneJson = await orb(["-p", ...base, "--output-format", "json"])

  expect(piped.code).toBe(0)
  expect(model.steps.slice(before).map((step) => step.user)).toEqual(["from stdin"])
  expect(none.code).toBe(1)
  expect(none.stderr).toContain("You must provide a message")
  expect(noneJson.code).toBe(1)
  expect(noneJson.stdout.trim().split(/\r?\n/)).toHaveLength(1)
  expect(JSON.parse(noneJson.stdout)).toMatchObject({ type: "result", is_error: true })
}, 180_000)

// Every flag that only a printed run uses, with a value where it takes one. A new one that is not listed in the root
// handler runs the interface with no limit and no warning, so this list is the one to extend.
const printedRunFlags: ReadonlyArray<readonly [string, ...string[]]> = [
  ["--output-format", "json"],
  ["--json-schema", "schema.json"],
  ["--file", "a.txt"],
  ["--title", "x"],
  ["--bare"],
  ["--thinking"],
  ["--max-steps", "2"],
  ["--max-turns", "2"],
  ["--max-cost", "1"],
  ["--max-tokens", "100"],
  ["--fallback-model", "a/b"],
]

test("a flag of a printed run without -p is a usage error", async () => {
  const before = model.requests.length

  for (const [flag, ...value] of printedRunFlags) {
    const result = await orb([flag, ...value])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain(`${flag === "--max-turns" ? "--max-steps" : flag} can only be used with -p`)
  }
  expect(model.requests.length).toBe(before)
}, 300_000)

// --model and --agent are flags of the interface too, so a plain run takes them and refuses only the rest.
test("the flags that the interface also takes are not refused without -p", async () => {
  const result = await orb(["--model", "a/b", "--agent", "build", "--max-steps", "2"])
  expect(result.code).toBe(1)
  expect(result.stderr).toContain("--max-steps can only be used with -p")
  expect(result.stderr).not.toContain("--model")
  expect(result.stderr).not.toContain("--agent")
}, 60_000)

test("the list of printed-run flags covers every flag the root command refuses without -p", () => {
  const listed = new Set(printedRunFlags.map(([flag]) => flag))
  expect(PrintParamFlags.filter((flag) => !listed.has(flag))).toEqual([])
  expect(PrintParamFlags).not.toContain("--model")
  expect(PrintParamFlags).not.toContain("--agent")
})
