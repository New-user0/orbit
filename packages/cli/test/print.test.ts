import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { scriptedModel, type ScriptedReply } from "./fixture/scripted-model"

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

afterAll(async () => {
  await model.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function orb(args: string[], input?: string, home = root) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(home, {
      USERPROFILE: home,
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
])("%j sends %j to the model exactly once", async (args, text) => {
  const run = await sent(args)

  expect(run.users).toEqual([text])
}, 120_000)

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

test("--json-schema: text prints only the JSON, json and stream-json carry structured_output, run keeps its result object", async () => {
  const text = await sent(["-p", ...base, "--json-schema", schema, "say ok"])
  const json = await sent(["-p", ...base, "--json-schema", schema, "--output-format", "json", "say ok"])
  const stream = await sent(["-p", ...base, "--json-schema", schema, "--output-format", "stream-json", "say ok"])
  const run = await sent(["run", ...base, "--json-schema", schema, "say ok"])

  expect(text.stdout.trim()).toBe('{"answer":"ok"}')
  expect(JSON.parse(json.stdout)).toMatchObject({ type: "result", is_error: false, structured_output: { answer: "ok" } })
  expect(parseLines(stream.stdout).at(-1)).toMatchObject({ type: "result", structured_output: { answer: "ok" } })
  // `orb run` prints the result it always printed, without the fields of the envelope.
  expect(JSON.parse(run.stdout)).toMatchObject({ type: "result", is_error: false, structured_output: { answer: "ok" } })
  expect(Object.keys(JSON.parse(run.stdout))).not.toContain("outcome")
}, 240_000)

// Runs with its own scripted model and its own home, so that each script starts at its first step.
async function scripted<T>(
  replies: ReadonlyArray<ScriptedReply>,
  run: (model: ReturnType<typeof scriptedModel>, home: string) => Promise<T>,
) {
  const own = scriptedModel(replies)
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-print-own-")))
  await own.configure(home)
  try {
    return await run(own, home)
  } finally {
    await own.stop()
    await fs.rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
}

function parseLines(output: string) {
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

// A line of the envelope must hold no character that acts on a terminal, whatever a tool or a title called itself.
const raw = /[\p{C}\p{Zl}\p{Zp}]/u

// `orb -p` against a model of its own, in the output format that is given, with the flags that are given.
function print(own: ReturnType<typeof scriptedModel>, home: string, args: string[], format = "json") {
  return orb(["-p", "--standalone", "--model", own.model, "--output-format", format, ...args], undefined, home)
}

test("--output-format json prints one result object with the outcome, the steps and the tokens", async () => {
  const run = await sent(["-p", ...base, "--output-format", "json", "say ok"])

  const lines = run.stdout.trim().split(/\r?\n/)
  expect(lines).toHaveLength(1)
  expect(JSON.parse(lines[0])).toMatchObject({
    type: "result",
    is_error: false,
    outcome: "succeeded",
    result: '{"answer":"ok"}',
    rejected: [],
  })
  const result = JSON.parse(lines[0])
  expect(result.steps).toBeGreaterThanOrEqual(1)
  expect(result.tokens.input).toBeGreaterThan(0)
  expect(result.duration_ms).toBeGreaterThan(0)
  expect(result.sessionID).toStartWith("ses_")
}, 120_000)

test("a failed step is counted in the steps and the tokens", async () => {
  await scripted([{ chunks: ["blocked"], finish: "content_filter" }], async (own, home) => {
    const run = await print(own, home, ["say ok"])

    const result = JSON.parse(run.stdout)
    expect(result.steps).toBe(1)
    expect(result.tokens.input).toBe(10)
    expect(result.tokens.output).toBe(2)
    expect(result).toMatchObject({ is_error: true, outcome: "failed", reason: "error" })
    expect(run.code).toBe(1)
  })
}, 120_000)

test("the steps of a subagent are counted with the steps of the run", async () => {
  const call = { name: "subagent", input: { agent: "general", description: "child work", prompt: "answer" } }
  await scripted([{ tool: call }, "from the child", "done"], async (own, home) => {
    const run = await print(own, home, ["say ok"])

    expect(own.steps).toHaveLength(3)
    const result = JSON.parse(run.stdout)
    expect({ code: run.code, error: result.error }).toEqual({ code: 0, error: undefined })
    expect(result.steps).toBe(3)
    expect(result.tokens.input).toBe(30)
  })
}, 120_000)

test("stream-json starts with the init line, ends with the result line, and every line parses", async () => {
  const run = await sent(["-p", ...base, "--output-format", "stream-json", "say ok"])

  const lines = parseLines(run.stdout)
  expect(lines[0]).toMatchObject({ type: "init", protocol: 1, model: model.model, version: expect.any(String) })
  expect(path.normalize(String(lines[0].cwd)).toLowerCase()).toBe(path.normalize(workspace).toLowerCase())
  expect(lines.at(-1)).toMatchObject({ type: "result", is_error: false, outcome: "succeeded", result: '{"answer":"ok"}' })
  expect(lines.filter((line) => line.type === "result")).toHaveLength(1)
  expect(lines.filter((line) => line.type === "init")).toHaveLength(1)
  expect(lines[0].sessionID).toBe(lines.at(-1)?.sessionID)
  expect(lines.map((line) => line.type)).toContain("text")
  // Fragments are only printed when they are asked for.
  expect(lines.map((line) => line.type)).not.toContain("text_delta")
}, 120_000)

test("--include-partial-messages prints text fragments that add up to the answer", async () => {
  await scripted([{ chunks: ["Hel", "lo ", "there"] }], async (own, home) => {
    const run = await print(own, home, ["--include-partial-messages", "say hi"], "stream-json")

    const lines = parseLines(run.stdout)
    const deltas = lines.filter((line) => line.type === "text_delta")
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.map((line) => line.delta).join("")).toBe("Hello there")
    expect(lines.at(-1)).toMatchObject({ type: "result", result: "Hello there" })
  })
}, 120_000)

test("--include-partial-messages without stream-json is a usage error", async () => {
  const before = model.requests.length

  const run = await orb(["-p", ...base, "--include-partial-messages", "say ok"])

  expect(run.code).toBe(1)
  expect(run.stderr).toContain("--include-partial-messages requires --output-format stream-json")
  expect(model.requests.length).toBe(before)
}, 60_000)

test("an answer that is not JSON under --json-schema is an error in every format", async () => {
  await scripted(["not json"], async (own, home) => {
    const text = await print(own, home, ["--json-schema", schema, "say ok"], "text")
    const json = await print(own, home, ["--json-schema", schema, "say ok"])

    expect(text.code).toBe(1)
    expect(text.stdout).toBe("")
    expect(text.stderr).toContain("The answer was not valid JSON.")
    expect(json.code).toBe(1)
    expect(JSON.parse(json.stdout)).toMatchObject({ is_error: true, outcome: "failed", reason: "invalid_output" })
  })
}, 180_000)

test("a run whose write was rejected prints one summary on stderr and exits 0", async () => {
  // A file outside the folder of the run needs a permission that nobody can give.
  const target = path.join(root, "rejected.txt")
  const outside = { name: "write", input: { path: target, content: "x" } }
  await scripted([{ tool: outside }, "done"], async (own, home) => {
    const text = await print(own, home, ["say ok"], "text")

    expect(text.code).toBe(0)
    expect(text.stdout.trim()).toBe("done")
    expect(text.stderr).toContain("1 request was auto-rejected: ")
    expect(await Bun.file(target).exists()).toBe(false)
  })
  await scripted([{ tool: outside }, "done"], async (own, home) => {
    const json = await print(own, home, ["say ok"])

    const result = JSON.parse(json.stdout)
    expect(json.code).toBe(0)
    expect(result).toMatchObject({ is_error: false, outcome: "succeeded" })
    expect(result.rejected).toHaveLength(1)
  })
}, 180_000)

test("--verbose shows tool output and one usage line per step on stderr", async () => {
  const call = { name: "read", input: { path: path.join(workspace, "AGENTS.md") } }
  await scripted([{ tool: call }, "done"], async (own, home) => {
    const verbose = await print(own, home, ["--verbose", "say ok"], "text")

    expect(verbose.code).toBe(0)
    expect(verbose.stdout.trim()).toBe("done")
    expect(verbose.stderr).toContain(instructions)
    expect(verbose.stderr.match(/usage: /g)).toHaveLength(2)
  })
  await scripted([{ tool: call }, "done"], async (own, home) => {
    const quiet = await print(own, home, ["say ok"], "text")

    expect(quiet.stderr).not.toContain("usage: ")
    expect(quiet.stderr).not.toContain(instructions)
  })
}, 180_000)

test("--verbose tool output keeps tabs and writes out the characters that act on a terminal", async () => {
  const file = path.join(workspace, "tabbed.txt")
  await Bun.write(file, "col\tone\n\u001b[31mred\u001b[0m\rlone\n")
  const call = { name: "read", input: { path: file } }
  const verbose = await scripted([{ tool: call }, "done"], (own, home) => print(own, home, ["--verbose", "say ok"], "text"))

  expect(verbose.stderr).toContain("col\tone")
  expect(verbose.stderr).toContain("\\x1b[31mred")
  expect(verbose.stderr).not.toContain("\u001b[31m")
  // A lone carriage return breaks the line instead of overwriting the one before it.
  expect(verbose.stderr).not.toMatch(/\[0m\\x0d/)
  expect(verbose.stderr).toMatch(/\[0m\r?\n\s*lone/)
}, 180_000)

test("a hostile tool name reaches no terminal or reader as a control character", async () => {
  const hostile = "evil\u001b]0;pwned\u0007\u009b31m x"
  const stream = await scripted([{ tool: { name: hostile, input: {} } }, "done"], (own, home) =>
    print(own, home, ["say ok"], "stream-json"),
  )
  // Its own script, so that the text run calls the tool as well; a shared script would answer it with "done" only.
  const text = await scripted([{ tool: { name: hostile, input: {} } }, "done"], (own, home) =>
    print(own, home, ["--verbose", "say ok"], "text"),
  )
  const control = await scripted([{ tool: { name: "plain_name", input: {} } }, "done"], (own, home) =>
    print(own, home, ["--verbose", "say ok"], "text"),
  )

  // Every line is one JSON value with no raw control or separator character, and the name is still what the model sent.
  stream.stdout
    .trim()
    .split(/\r?\n/)
    .forEach((line) => expect(raw.test(line)).toBe(false))
  expect(parseLines(stream.stdout).some((line) => JSON.stringify(line).includes("evil"))).toBe(true)
  // What reaches the terminal is the text with the characters written out, never the sequence that sets a title.
  expect(text.stderr).toContain("evil\\x1b]0;pwned\\x07")
  expect(text.stderr).not.toContain("\u001b]0;")
  expect(text.stderr).not.toContain("\u0007")
  expect(text.stderr).not.toContain("\u009b")
  // The control run shows that the tool is called and printed, so the absence above is the escaping's doing.
  expect(control.stderr).toContain("plain_name")
}, 240_000)

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

test("a flag of a printed run without -p is a usage error", async () => {
  const before = model.requests.length

  const result = await orb(["--output-format", "json"])

  expect(result.code).toBe(1)
  expect(result.stderr).toContain("--output-format can only be used with -p")
  expect(model.requests.length).toBe(before)
}, 60_000)

// One hostile string per sink of `renderTool`: the inline title, the description, the block title and the block body.
// Each tool succeeds, so the line that is drawn is the one for a finished call and not the failed line.
const evil = "e\u001b]0;pwned\u0007\u009b31m"
const sinks: Array<{
  sink: string
  name: string
  input: (value: string) => Record<string, unknown>
  hostile: string
  escaped: string
}> = [
  { sink: "inline title", name: "grep", input: (value) => ({ pattern: value }), hostile: evil, escaped: "e\\x1b]0;pwned\\x07" },
  {
    sink: "description",
    name: "read",
    input: (value) => ({ path: path.join(workspace, "AGENTS.md"), note: value }),
    hostile: evil,
    escaped: "e\\x1b]0;pwned\\x07",
  },
  // The command is the title of the block; a comment keeps the shell from running the characters.
  {
    sink: "block title",
    name: "shell",
    input: (value) => ({ command: `echo marker # ${value}`, description: "marker" }),
    hostile: evil,
    escaped: "e\\x1b]0;pwned\\x07",
  },
  // The shell writes the escape sequence itself, so the title holds only its spelling and the output holds the bytes.
  {
    sink: "block body",
    name: "shell",
    input: (value) => ({ command: `printf '${value}\\n'`, description: "marker" }),
    hostile: "e\\033]0;pwned\\007\\233",
    escaped: "e\\x1b]0;pwned\\x07",
  },
]

test.each(sinks)("a hostile $name input reaches no terminal through the $sink", async (row) => {
  const run = await scripted([{ tool: { name: row.name, input: row.input(row.hostile) } }, "done"], (own, home) =>
    print(own, home, ["--yolo", "say ok"], "text"),
  )
  const control = await scripted([{ tool: { name: row.name, input: row.input("plain") } }, "done"], (own, home) =>
    print(own, home, ["--yolo", "say ok"], "text"),
  )

  const printed = run.stdout + run.stderr
  expect(printed).toContain(row.escaped)
  // The interface's own colors are escape sequences too, so only what a tool could inject is looked for.
  expect(printed).not.toContain("\u001b]")
  expect(printed).not.toContain("\u0007")
  expect(printed).not.toContain("\u009b")
  // The same call with a plain value is printed too, so the absence above is the escaping's doing.
  expect(control.stdout + control.stderr).toContain("plain")
}, 240_000)
