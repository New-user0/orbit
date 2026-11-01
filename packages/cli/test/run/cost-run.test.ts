import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { Orbit } from "@orbit/client/promise"
import { costLine, costText, readSessionCost } from "../../src/run/cost-report"
import { runNonInteractive, type RunCommandInput } from "../../src/run/run"

// clients-ux-23 part 2: `orb run "/cost"` in process, against a stub server that answers the run's session, its folder and
// the cost route. The spawned runs in cost-command.test.ts pin the same door end to end, but a spawned process records no
// coverage; these pin each shape of summary, the row a client cannot read, and the refusal of an old server.

const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
const row = {
  providerID: "provider",
  modelID: "big\u001b[31m",
  responses: 2,
  tokens: { input: 1_200, output: 300, reasoning: 40, cache: { read: 500, write: 60 } },
  cost: 0.5,
  unrecorded: 0,
  zero: 0,
}
const full = {
  cost: 0.75,
  own: 0.5,
  subagents: 0.25,
  other: 0.01,
  api: 4_000,
  wall: 65_000,
  lines: { added: 1, removed: 2 },
  rows: [row, { ...row, modelID: "free", cost: 0, unrecorded: 1, tokens: { ...zero, input: 3 } }],
}
const bare = { cost: 0, own: 0, subagents: 0, rows: [] }

const SESSION = "ses_cost_run"
const answers: Record<string, () => Response> = {
  [SESSION]: () => Response.json({ data: full }),
  ses_dropped: () => Response.json({ data: { ...full, rows: [row, { modelID: 7 }] } }),
  ses_old: () => new Response(null, { status: 404 }),
  ses_gone: () =>
    Response.json({ _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "Session not found: ses_gone" }, { status: 404 }),
}
const unexpected: string[] = []
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    const cost = pathname.match(/^\/api\/session\/([^/]+)\/cost$/)
    if (cost) return answers[cost[1]!]?.() ?? new Response(null, { status: 404 })
    const session = pathname.match(/^\/api\/session\/([^/]+)$/)
    if (session && request.method === "GET")
      return Response.json({ data: { id: session[1], agent: "build", location: { directory: "/repo" } } })
    if (pathname === "/api/location") return Response.json({ directory: "/repo" })
    unexpected.push(`${request.method} ${pathname}`)
    return new Response(null, { status: 500 })
  },
})
const endpoint = { url: `http://127.0.0.1:${stub.port}` }

afterAll(() => stub.stop(true))
afterEach(() => {
  expect(unexpected).toEqual([])
})

test("costText prints every part of a full summary, and drops the parts a bare one lacks", () => {
  const text = costText(full as never)
  expect(text).toContain("Total cost:")
  expect(text).toContain("Subagents:")
  expect(text).toContain("Total API duration:")
  expect(text).toContain("Total code changes:")
  expect(text).toContain("1 line added, 2 lines removed")
  expect(text).toContain("Other:")
  expect(text).toContain("40 reasoning")
  expect(text).not.toContain("\u001b")

  const empty = costText(bare as never)
  expect(empty).not.toContain("Subagents:")
  expect(empty).not.toContain("Other:")
  expect(empty).not.toContain("Total code changes:")
  expect(empty).toContain("No model response yet in this session.")
  expect(JSON.parse(costLine("ses_x", bare as never))).toEqual({ type: "cost", sessionID: "ses_x", cost: bare })
})

test("the default format prints the block, and a row the client cannot read is named once", async () => {
  const run = await capture({ format: "default" })
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("Total cost:")
  expect(run.stderr).toBe("")

  const dropped = await capture({ format: "default", session: "ses_dropped" })
  expect(dropped.exitCode).toBe(0)
  expect(dropped.stdout).toContain("Total cost:")
  expect(dropped.stderr.trimEnd().split("\n")).toEqual(["Left out cost rows this client could not read: rows[1]"])
})

test("the JSON format prints one cost line", async () => {
  const json = await capture({ format: "json" })
  expect(json.stdout.trimEnd().split("\n")).toHaveLength(1)
  expect(JSON.parse(json.stdout)).toMatchObject({ type: "cost", sessionID: SESSION, cost: { cost: 0.75 } })
})

test("an old server ends the run with one message", async () => {
  const run = await capture({ format: "default", session: "ses_old" })
  expect(run.exitCode).toBe(1)
  expect(run.stdout).toBe("")
  expect(run.stderr).toContain("older than this client")

  const gone = await capture({ format: "default", session: "ses_gone" })
  expect(gone.exitCode).toBe(1)
  expect(gone.stderr.toLowerCase()).toContain("not found")
})

test("a server that does not answer in time ends the read with one message", async () => {
  const hang = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) })
  try {
    const client = Orbit.make({ baseUrl: `http://127.0.0.1:${hang.port}` })
    expect(await readSessionCost(client, "ses_slow", 100)).toEqual({ error: "The server did not answer in time" })
  } finally {
    await hang.stop(true)
  }
})

// Runs last: the result line marks this process's result as written, after which an error report prints nothing more.
test("--format result prints one result line whose result is the block", async () => {
  const run = await capture({ format: "result", message: ["/usage", "ignored words"] })
  expect(run.exitCode).toBe(0)
  const line = JSON.parse(run.stdout)
  expect(line).toMatchObject({ type: "result", sessionID: SESSION, is_error: false })
  expect(line.result).toContain("Total cost:")
})

test("/cost with --file is refused before any request", async () => {
  const run = await capture({ format: "default", file: ["notes.txt"] })
  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain("--file")
})

async function capture(input: Partial<RunCommandInput> & Pick<RunCommandInput, "format">) {
  const stdout: string[] = []
  const stderr: string[] = []
  const exitCode = process.exitCode
  const isTTY = process.stdin.isTTY
  // A terminal on standard input means the run reads no piped message.
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true, writable: true })
  const stdoutWrite = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout.push(String(chunk))
    return true
  })
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk))
    return true
  })
  process.exitCode = 0
  try {
    await runNonInteractive({ server: { endpoint }, message: ["/cost"], session: SESSION, file: [], ...input })
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode }
  } finally {
    process.exitCode = exitCode ?? 0
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true, writable: true })
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
}
