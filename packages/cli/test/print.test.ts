// `orb -p` against a real private server and a scripted model: resuming, the message, the bare run and --json-schema.
// Every run is a child process of src/index.ts, so the argv classification, the Print spec and the handler are the
// ones a user reaches. The model, the root and the helpers are in fixture/print-harness.ts.
import { expect, test } from "bun:test"
import path from "node:path"
import { SessionID } from "@orbit/schema/session-id"
import {
  model,
  root,
  instructions,
  schema,
  orb,
  sent,
  base,
  accepted,
  scripted,
  parseLines,
  print,
} from "./fixture/print-harness"

test("-p --resume fails with one failed result for a session that does not exist, and creates none", async () => {
  const before = model.requests.length

  const missing = await orb(["-p", ...base, "--resume", "ses_missing", "--output-format", "json", "hello"])
  expect(missing.code).toBe(1)
  expect(missing.stdout.trim().split(/\r?\n/)).toHaveLength(1)
  expect(JSON.parse(missing.stdout)).toMatchObject({ type: "result", is_error: true, error: "Session not found" })

  // Under stream-json no session exists to name in an init line, so the stream is the result line alone.
  const streamed = await orb(["-p", ...base, "--resume", "ses_missing", "--output-format", "stream-json", "hello"])
  expect(streamed.code).toBe(1)
  expect(
    streamed.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line)),
  ).toEqual([expect.objectContaining({ type: "result", is_error: true, sessionID: "", subtype: "error" })])

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

test("--json-schema: text prints only the JSON, json and stream-json carry structured_output, run keeps its result object", async () => {
  await scripted([...accepted, ...accepted, ...accepted, ...accepted], async (own, home) => {
    const text = await orb(["-p", "--standalone", "--model", own.model, "--json-schema", schema, "say ok"], undefined, home)
    const json = await print(own, home, ["--json-schema", schema, "say ok"])
    const stream = await print(own, home, ["--json-schema", schema, "say ok"], "stream-json")
    const run = await orb(["run", "--standalone", "--model", own.model, "--json-schema", schema, "say ok"], undefined, home)

    expect(text.stdout.trim()).toBe('{"answer":"ok"}')
    expect(JSON.parse(json.stdout)).toMatchObject({
      type: "result",
      is_error: false,
      subtype: "success",
      structured_output: { answer: "ok" },
    })
    const lines = parseLines(stream.stdout)
    expect(lines.at(-1)).toMatchObject({ type: "result", structured_output: { answer: "ok" } })
    expect(lines.some((line) => line.type === "tool_use")).toBe(true)
    // `orb run` prints the result it always printed, without the fields of the envelope.
    expect(JSON.parse(run.stdout)).toMatchObject({ type: "result", is_error: false, structured_output: { answer: "ok" } })
    expect(Object.keys(JSON.parse(run.stdout))).not.toContain("outcome")
    expect([text.code, json.code, stream.code, run.code]).toEqual([0, 0, 0, 0])
    // The prompt is the message and nothing else, and the tool is offered beside the others with the schema as given.
    // Each run makes two steps: the hand-in, then the empty follow-up that reads its result.
    expect(own.steps).toHaveLength(8)
    expect(own.steps.filter((_, index) => index % 2 === 0).map((step) => step.user)).toEqual(Array(4).fill("say ok"))
    const tools = (own.steps[0].body as { tools?: Array<{ function: { name: string; parameters: unknown } }> }).tools ?? []
    expect(tools.at(-1)?.function.name).toBe("StructuredOutput")
    expect(tools.at(-1)?.function.parameters).toMatchObject({ type: "object", required: ["answer"] })
  })
}, 240_000)

test("--json-schema takes inline JSON, and files with a byte order mark or in UTF-16", async () => {
  const inline = JSON.stringify({ type: "object", properties: { answer: { type: "string" } } })
  const bom = path.join(root, "schema-bom.json")
  const utf16 = path.join(root, "schema-utf16.json")
  await Bun.write(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(inline)]))
  await Bun.write(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(inline, "utf16le")]))
  await scripted([...accepted, ...accepted, ...accepted], async (own, home) => {
    const runs = [
      await print(own, home, ["--json-schema", inline, "say ok"]),
      await print(own, home, ["--json-schema", bom, "say ok"]),
      await print(own, home, ["--json-schema", utf16, "say ok"]),
    ]

    runs.forEach((result) => {
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ is_error: false, structured_output: { answer: "ok" } })
    })
  })
}, 240_000)

// A schema that cannot be used is a usage error in the requested format, before any session or model request exists.
test.each([
  ["a missing file", () => path.join(root, "no-such-schema.json"), "does not exist"],
  ["inline JSON that lost its quotes", () => "{type:object}", "PowerShell"],
  ["a file that is not JSON", () => path.join(root, "not-json.txt"), "not valid JSON"],
  ["an array in a file", () => path.join(root, "array.json"), 'declares "type": "object"'],
  ["a root that is not an object type", () => '{"type":"array"}', 'declares "type": "object"'],
])("--json-schema with %s is a usage error in every format", async (_name, value, message) => {
  await Bun.write(path.join(root, "not-json.txt"), "{ nope")
  await Bun.write(path.join(root, "array.json"), "[1, 2]")
  const before = model.requests.length

  for (const format of ["text", "json", "stream-json"]) {
    const result = await orb(["-p", ...base, "--output-format", format, "--json-schema", value(), "say ok"])
    expect(result.code).toBe(1)
    if (format === "text") {
      expect(result.stdout).toBe("")
      expect(result.stderr).toContain(message)
    } else {
      expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1)
      expect(parseLines(result.stdout)[0]).toMatchObject({ type: "result", is_error: true })
      expect(String(parseLines(result.stdout)[0].error)).toContain(message)
    }
  }
  expect(model.requests.length).toBe(before)
}, 180_000)
