import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { Orbit } from "@orbit/client/promise"
import type { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { readContextUsage } from "../../src/run/context-report"
import { runNonInteractive, type RunCommandInput } from "../../src/run/run"

// clients-ux-23: `orb run "/context"` and `orb -p "/context"` in process, against a stub server that answers the run's
// session, its folder and the context usage route. The spawned runs in context-command.test.ts pin the same doors end to
// end; these pin each output format, each refusal and each answer the client can get, and count the chat requests.

type Info = SessionContextUsage.Info

const SESSION = "ses_context"
const info: Info = {
  model: { providerID: "provider", id: "model" } as Info["model"],
  window: 100_000,
  percentage: 20,
  threshold: 90_000,
  total: 20_000,
  measured: true,
  auto: true,
  categories: [
    { kind: "system", tokens: 4_000 },
    { kind: "messages", tokens: 16_000 },
    { kind: "auto-buffer", tokens: 10_000 },
    { kind: "free", tokens: 70_000 },
  ],
  files: [{ path: "/repo/ORBIT.md", type: "file", tokens: 1_000 }],
  mcp: [],
  agents: [],
  skills: [],
  systemTools: [],
  deferredTools: [],
  sections: [],
  messages: { toolCalls: 0, toolResults: 0, attachments: 0, assistant: 8_000, user: 8_000, tools: [], attachmentKinds: [] },
}

// What the stub answers on the usage route, by session ID; every other path it counts as a request it should not get.
const answers: Record<string, () => Response> = {
  [SESSION]: () => Response.json({ data: info }),
  ses_malformed: () => Response.json({ data: { model: "not a payload" } }),
  // One category kind from a newer server, next to the ones this client knows.
  ses_newer: () =>
    Response.json({ data: { ...info, categories: [...info.categories.slice(0, 1), { kind: "newer-kind", tokens: 9 }, ...info.categories.slice(1)] } }),
  ses_old: () => new Response(null, { status: 404 }),
  ses_child: () =>
    Response.json(
      { _tag: "MainSessionOnlyError", sessionID: "ses_child", parentID: "ses_root", message: "Context usage is reported for a main session only" },
      { status: 409 },
    ),
}
const unexpected: string[] = []
const asked: string[] = []
const stub = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const pathname = new URL(request.url).pathname
    const usage = pathname.match(/^\/api\/session\/([^/]+)\/context\/usage$/)
    if (usage) asked.push(usage[1]!)
    if (usage) return answers[usage[1]!]?.() ?? new Response(null, { status: 404 })
    const session = pathname.match(/^\/api\/session\/([^/]+)$/)
    if (session && request.method === "GET")
      return Response.json({ data: { id: session[1], agent: "build", location: { directory: "/repo" } } })
    if (pathname === "/api/location") return Response.json({ directory: "/repo" })
    unexpected.push(`${request.method} ${pathname}`)
    return new Response(null, { status: 500 })
  },
})
const endpoint = { url: `http://127.0.0.1:${stub.port}` }
const client = Orbit.make({ baseUrl: endpoint.url })

afterAll(() => stub.stop(true))
afterEach(() => {
  expect(unexpected).toEqual([])
})

test("readContextUsage decodes the payload, and names an unreadable answer, an old server and the server's refusal", async () => {
  expect(await readContextUsage(client, SESSION, 5_000)).toEqual({ info, dropped: [] })
  expect(await readContextUsage(client, "ses_newer", 5_000)).toEqual({ info, dropped: ["categories[1]"] })
  expect(await readContextUsage(client, "ses_malformed", 5_000)).toEqual({
    error: "The server's answer about context usage could not be read",
  })
  expect(await readContextUsage(client, "ses_old", 5_000)).toEqual({
    error: "The server is older than this client and does not report context usage",
  })
  expect(await readContextUsage(client, "ses_child", 5_000)).toEqual({
    error: "Context usage is reported for a main session only",
  })
})

test("the text formats print the report, and nothing goes to the model", async () => {
  const run = await capture({ format: "default" })
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("## Context usage")
  expect(run.stdout).toContain("/repo/ORBIT.md")
  expect(run.stdout.trimEnd().split("\n").some((line) => line.startsWith("{"))).toBe(false)

  // stream-json with the envelope is `orb -p`'s stream: its result line carries the report.
  const stream = await capture({ format: "stream-json", envelope: true })
  expect(stream.exitCode).toBe(0)
  const line = JSON.parse(stream.stdout)
  expect(line).toMatchObject({ type: "result", sessionID: SESSION, is_error: false, subtype: "success", steps: 0 })
  expect(line.result).toContain("## Context usage")
})

test("the JSON formats print one context_usage line with the payload", async () => {
  for (const format of ["json", "stream-json"] as const) {
    const run = await capture({ format })
    expect(run.exitCode).toBe(0)
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1)
    expect(JSON.parse(run.stdout)).toEqual({ type: "context_usage", sessionID: SESSION, usage: info })
  }
})

test("an entry the client cannot read costs only itself: the report is printed and one line names it", async () => {
  const run = await capture({ format: "default", session: "ses_newer" })
  expect(run.exitCode).toBe(0)
  expect(run.stdout).toContain("## Context usage")
  expect(run.stdout).toContain("| System prompt | 4,000 | 4.0% |")
  expect(run.stdout).toContain("| Messages | 16,000 | 16.0% |")
  expect(run.stderr.trimEnd().split("\n")).toEqual([
    "Left out context usage entries this client could not read: categories[1]",
  ])

  // A whole payload prints nothing on the error stream.
  expect((await capture({ format: "default" })).stderr).toBe("")
})

test("a refusal exits 1 with the server's message in the run's error form", async () => {
  const text = await capture({ format: "default", session: "ses_child" })
  expect(text.exitCode).toBe(1)
  expect(text.stdout).toBe("")
  expect(text.stderr).toContain("Context usage is reported for a main session only")

  const json = await capture({ format: "json", session: "ses_child" })
  expect(json.exitCode).toBe(1)
  expect(JSON.parse(json.stdout)).toMatchObject({
    type: "error",
    sessionID: "ses_child",
    error: { message: "Context usage is reported for a main session only" },
  })
})

test("/context with --file is refused before any request", async () => {
  const run = await capture({ format: "default", file: ["notes.txt"] })
  expect(run.exitCode).toBe(1)
  expect(run.stderr).toContain("/context takes no --file")
})

// Runs last: the result line marks this process's result as written, after which an error report prints nothing more.
test("--format result prints one result line whose result is the report", async () => {
  const run = await capture({ format: "result", message: ["/context", "ignored words"] })
  expect(run.exitCode).toBe(0)
  const line = JSON.parse(run.stdout)
  expect(line).toMatchObject({ type: "result", sessionID: SESSION, is_error: false, subtype: "success" })
  expect(line.usage).toEqual({ steps: 0, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } })
  expect(line.result).toContain("## Context usage")
})

// Stream input answers `/context` through its own control request (clients-ux-47), so the positional `/context` of a
// stream run is the stream's first input, and the run does not ask the route. The stub answers none of the stream's own
// requests, which is all this run needs: it is not a report.
test("stream input leaves /context to the stream and does not ask the route", async () => {
  asked.length = 0
  const run = await capture({ format: "stream-json", envelope: true, stream: true })
  unexpected.length = 0
  expect(asked).toEqual([])
  expect(run.stdout).not.toContain("## Context usage")
  expect(run.stdout).not.toContain('"context_usage"')
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
    await runNonInteractive({ server: { endpoint }, message: ["/context"], session: SESSION, file: [], ...input })
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: process.exitCode }
  } finally {
    process.exitCode = exitCode ?? 0
    Object.defineProperty(process.stdin, "isTTY", { value: isTTY, configurable: true, writable: true })
    stdoutWrite.mockRestore()
    stderrWrite.mockRestore()
  }
}
