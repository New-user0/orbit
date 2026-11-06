import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { Orbit } from "@orbit/client/promise"
import { costLine, costText, readCatalog, readSessionCost } from "../../src/run/cost-report"
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
  ses_unpriced: () =>
    Response.json({
      data: { ...bare, rows: [{ ...row, providerID: "ollama", modelID: "llama3", responses: 3, cost: 0, zero: 3 }] },
    }),
  ses_nocatalog: () => Response.json({ data: { ...bare, rows: [{ ...row, providerID: "ollama", modelID: "llama3", responses: 3, cost: 0, zero: 3 }] } }),
  ses_old: () => new Response(null, { status: 404 }),
  ses_broken: () => new Response(null, { status: 500 }),
  ses_garbled: () => Response.json({ data: { cost: "lots" } }),
  ses_gone: () =>
    Response.json({ _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "Session not found: ses_gone" }, { status: 404 }),
}
const unexpected: string[] = []
const asked: string[] = []
let catalogDown = false
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    const cost = pathname.match(/^\/api\/session\/([^/]+)\/cost$/)
    if (cost) {
      asked.push(pathname)
      return answers[cost[1]!]?.() ?? new Response(null, { status: 404 })
    }
    const session = pathname.match(/^\/api\/session\/([^/]+)$/)
    if (session && request.method === "GET")
      return Response.json({
        data: { id: session[1], agent: "build", location: { directory: "/repo" } },
      })
    if (pathname === "/api/location") return Response.json({ directory: "/repo" })
    if (pathname === "/api/model")
      return catalogDown
        ? new Response(null, { status: 500 })
        : Response.json({ data: [{ providerID: "ollama", id: "llama3", name: "Llama 3", cost: [] }] })
    unexpected.push(`${request.method} ${pathname}`)
    return new Response(null, { status: 500 })
  },
})
const endpoint = { url: `http://127.0.0.1:${stub.port}` }

afterAll(() => stub.stop(true))
afterEach(() => {
  expect(unexpected).toEqual([])
})

test("costText prints line counts without thousands separators", () => {
  const big = { ...full, lines: { added: 1234, removed: 0 } }
  const text = costText(big as never)
  expect(text).toContain("+1234 / -0 lines")
})

test("costText prints every part of a full summary, and drops the parts a bare one lacks", () => {
  const text = costText(full as never)
  expect(text).toContain("Spent:")
  expect(text).toContain("Subagents:")
  expect(text).toContain("Model time:")
  expect(text).toContain("Lines changed:")
  expect(text).toContain("+1 / -2 lines")
  expect(text).toContain("Other:")
  expect(text).toContain("reasoning 40")
  // Token figures are compact, as in the dialog.
  expect(text).toContain("in 1.2K · out 300 · from cache 500 · to cache 60")
  expect(text).toContain("(undone responses, older usage)")
  expect(text).not.toContain("\u001b")
  // The total says so when some row is unpriced. Mutation: call `price(summary.cost)` without the partial flag.
  expect(text.split("\n").find((line) => line.startsWith("Spent:"))).toContain("+ unpriced")
  // The row that is unpriced in part says so; the fully priced one does not.
  expect(text.split("\n").find((line) => line.includes("provider/free"))).toContain("+ unpriced")
  expect(text.split("\n").find((line) => line.includes("provider/big"))).not.toContain("unpriced")

  // The provider ID comes from a record or a config, so it is escaped like the model ID (class 9).
  const hostile = costText({ ...full, rows: [{ ...row, providerID: "evil\u001b]0;x\u0007\u009b2K‮name" }] } as never)
  expect(hostile).toContain("evil")
  expect(hostile.replaceAll("\n", "")).not.toMatch(/\p{C}/u)

  const empty = costText(bare as never)
  // An unknown duration reads as a dash.
  expect(empty).toContain(`${"Model time:".padEnd(16)} -\n`)
  expect(empty).not.toContain("Subagents:")
  expect(empty).not.toContain("Other:")
  expect(empty).not.toContain("Lines changed:")
  expect(empty).not.toContain("Per model:")
  expect(empty.split("\n").at(-1)).toBe(`${"Tokens:".padEnd(16)} in 0 · out 0 · from cache 0 · to cache 0`)
  expect(JSON.parse(costLine("ses_x", bare as never))).toEqual({ type: "cost", sessionID: "ses_x", cost: bare })
})

test("the default format prints the block, and a row the client cannot read is named once", async () => {
  const run = await capture({ format: "default" })
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("Spent:")
  expect(run.stderr).toBe("")

  const dropped = await capture({ format: "default", session: "ses_dropped" })
  expect(dropped.exitCode).toBe(0)
  expect(dropped.stdout).toContain("Spent:")
  expect(dropped.stderr.trimEnd().split("\n")).toEqual(["Left out cost rows this client could not read: rows[1]"])
})

test("the JSON format prints one cost line", async () => {
  const json = await capture({ format: "json" })
  expect(json.stdout.trimEnd().split("\n")).toHaveLength(1)
  expect(JSON.parse(json.stdout)).toMatchObject({ type: "cost", sessionID: SESSION, cost: { cost: 0.75 } })
})

// A model the catalog lists without a price reads unknown, as in the dialog. Mutation: pass `undefined` for the catalog.
test("a model listed without a price whose responses recorded $0 reads unknown, and the JSON line keeps the row", async () => {
  const run = await capture({ format: "default", session: "ses_unpriced" })
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("Spent:           unknown")
  expect(run.stdout).toContain("ollama/llama3 (unknown): in ")
  expect(run.stdout).toContain("(unknown)")
  expect(run.stdout).not.toContain("$0.0000")

  const json = await capture({ format: "json", session: "ses_unpriced" })
  expect(JSON.parse(json.stdout).cost.rows[0]).toMatchObject({ modelID: "llama3", cost: 0, zero: 3 })
})

test("a catalog that cannot be read costs one line, and a recorded $0 stays $0", async () => {
  catalogDown = true
  const run = await capture({ format: "default", session: "ses_nocatalog" })
  catalogDown = false
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("$0.0000")
  expect(run.stderr.trimEnd().split("\n")).toHaveLength(1)
  expect(run.stderr).toContain("Could not read the model catalog")
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

test("a server error is not taken for an old server", async () => {
  const run = await capture({ format: "default", session: "ses_broken" })
  expect(run.exitCode).toBe(1)
  expect(run.stderr).not.toContain("older than this client")
  expect(run.stderr.trim()).not.toBe("")
})

test("only the client's own unsupported-content-type error reads as an old server", async () => {
  const client = { session: { cost: () => Promise.reject(new Error("UnsupportedContentType")) } } as unknown as Parameters<typeof readSessionCost>[0]
  expect(await readSessionCost(client, "ses_x", 1_000)).toEqual({ error: "UnsupportedContentType" })
})

// Mutation: reading only the error's own name. The client may wrap the abort in an error whose cause is the timeout.
test("a timeout wrapped as an error's cause reads as no answer in time", async () => {
  const wrapped = new Error("transport", { cause: Object.assign(new Error("timed out"), { name: "TimeoutError" }) })
  const client = { session: { cost: () => Promise.reject(wrapped) } } as unknown as Parameters<typeof readSessionCost>[0]
  expect(await readSessionCost(client, "ses_x", 1_000)).toEqual({ error: "The server did not answer in time" })
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
  expect(line.result).toContain("Spent:")
})

test("a reasoning count is printed only for a model that used reasoning", () => {
  const lines = costText(full as never).split("\n")
  expect(lines.find((line) => line.includes("provider/big"))).toContain("reasoning 40")
  expect(lines.find((line) => line.includes("provider/free"))).not.toContain("reasoning")
})

// Class 9: the JSON line goes through `jsonLine`, which escapes what JSON.stringify leaves raw (C1 controls, bidi marks).
test("the JSON line escapes controls that JSON.stringify leaves raw", () => {
  const hostile = { ...bare, rows: [{ ...row, modelID: "a\u009b2K‮b c" }] }
  const line = costLine("ses_x", hostile as never)
  expect(line).not.toMatch(/\p{C}/u)
  expect(line).not.toContain(" ")
})

test("an answer that is not the summary ends the run with one message", async () => {
  const run = await capture({ format: "default", session: "ses_garbled" })
  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain("The server's answer about session cost could not be read")
})

// Class 9: the catalog's failure text comes from the network.
test("a catalog failure's text is escaped, and the figures read without a catalog", async () => {
  const written: string[] = []
  const stderrWrite = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk))
    return true
  })
  try {
    const client = { model: { list: () => Promise.reject(new Error("down\u001b]0;pwned\u0007\u009b2K‮")) } }
    expect(await readCatalog(client as never, { directory: "/repo" }, 100)).toBeUndefined()
  } finally {
    stderrWrite.mockRestore()
  }
  expect(written.join("")).toContain("Could not read the model catalog")
  expect(written.join("")).not.toMatch(/[\u001b\u009b‮]/)
})

test("a leading space before /cost still reports", async () => {
  const run = await capture({ format: "default", message: ["  /cost"] })
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("Spent:")
})

// Stream input answers its own requests, so the positional `/cost` of a stream run is the stream's first input and the run
// does not ask the route.
test("stream input leaves /cost to the stream and does not ask the route", async () => {
  asked.length = 0
  const run = await capture({ format: "stream-json", envelope: true, stream: true })
  unexpected.length = 0
  expect(asked).toEqual([])
  expect(run.stdout).not.toContain("Spent:")
  expect(run.stdout).not.toContain('"type":"cost"')
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
