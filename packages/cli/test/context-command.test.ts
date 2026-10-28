import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Orbit } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// clients-ux-23: `orb run "/context"` and `orb -p "/context"` print the context usage report of the run's session and
// send nothing to the model. The folder's trust is settled first (`trustRefusal`), and the route asks again for the
// session's own folder (classes 1 and 12). A real private server and a scripted model that counts every chat request.
const model = "ollama/context:1b"
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
const MARKER = "CONTEXT-COMMAND-MARKER"
const chats: string[] = []
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "context:1b", model: "context:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
        ],
      })
    if (pathname === "/api/show")
      return Response.json({
        parameters: "",
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
        details: { parent_model: "", ...details },
      })
    if (pathname === "/api/ps") return Response.json({ models: [] })
    chats.push(await request.text())
    const events = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "done" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-context-cli-")))
const repo = path.join(root, "repo")
const marker = path.join(repo, "ORBIT.md")

beforeAll(async () => {
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ model, providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
  await Bun.write(marker, `Project rules ${MARKER}\n`)
  await Bun.write(path.join(repo, "notes.txt"), "notes\n")
  expect((await spawned(["git", "init", "--quiet"], repo)).code).toBe(0)
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// CL1, class 12: the report, and no chat request.
test('orb run "/context" prints the report and sends nothing to the model', async () => {
  chats.length = 0
  const result = await orb(["run", "--standalone", "--model", model, "/context"])

  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(result.stdout).toContain("## Context usage")
  expect(result.stdout).toContain("### Usage by category")
  expect(result.stdout).toContain("| Category | Tokens | Percentage |")
  expect(result.stdout).toContain(`| file | ${marker} |`)
  expect(chats).toEqual([])
}, 300_000)

// CL2, D12 and class 9: the JSON formats print one line each, which `JSON.parse` reads.
test('orb -p "/context" with --format result prints one result line whose result is the report, and --format json prints one context_usage line', async () => {
  chats.length = 0
  for (const args of [
    ["-p", "--standalone", "--output-format", "json", "--model", model, "/context"],
    ["run", "--standalone", "--format", "result", "--model", model, "/context"],
  ]) {
    const result = await orb(args)
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split("\n")
    expect(lines.length).toBe(1)
    const line = JSON.parse(lines[0]!)
    expect(line).toMatchObject({ type: "result", is_error: false, subtype: "success" })
    expect(line.result).toContain("## Context usage")
    expect(line.result).toContain(marker)
  }

  const json = await orb(["run", "--standalone", "--format", "json", "--model", model, "/context"])
  expect(json.code).toBe(0)
  const lines = json.stdout.trim().split("\n")
  expect(lines.length).toBe(1)
  const line = JSON.parse(lines[0]!)
  expect(line.type).toBe("context_usage")
  expect(line.sessionID).toMatch(/^ses_/)
  expect(line.usage.files.map((file: { path: string }) => file.path)).toContain(marker)
  expect(chats).toEqual([])
}, 300_000)

// CL3, classes 1, 12 and 14: without ORBIT_TRUST_PROJECT the folder is not trusted, and the run stops before it asks for
// anything; --trust is the control that lists the marker.
test("an untrusted folder refuses /context before any request, and --trust runs it", async () => {
  chats.length = 0
  const refused = await orb(["run", "--standalone", "--model", model, "/context"], { ORBIT_TRUST_PROJECT: undefined })
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain("--trust")
  expect(refused.stdout + refused.stderr).not.toContain(MARKER)
  expect(refused.stdout + refused.stderr).not.toContain("ORBIT.md")
  expect(refused.stdout).not.toContain("## Context usage")

  const trusted = await orb(["run", "--trust", "--model", model, "/context"], { ORBIT_TRUST_PROJECT: undefined })
  expect(trusted.code).toBe(0)
  expect(trusted.stdout).toContain(`| file | ${marker} |`)
  expect(chats).toEqual([])
}, 300_000)

// CL4: the report takes no file, so --file is a usage error, in the format that was asked for.
test("/context with --file is refused", async () => {
  chats.length = 0
  const text = await orb(["run", "--standalone", "--model", model, "--file", "notes.txt", "/context"])
  expect(text.code).toBe(1)
  expect(text.stderr).toContain("--file")
  expect(text.stdout).not.toContain("## Context usage")

  const json = await orb(["run", "--standalone", "--format", "json", "--model", model, "--file", "notes.txt", "/context"])
  expect(json.code).toBe(1)
  expect(JSON.parse(json.stdout.trim())).toMatchObject({ type: "error", error: { message: expect.stringContaining("--file") } })
  expect(chats).toEqual([])
}, 300_000)

// CL6, class 13: a child session, named with --session, is refused by the server with its message; an unknown session
// named with --resume never reaches the report. Both exit 1 and ask no model.
test("a child session named with --session, and an unknown one, exit 1 with the server's message", async () => {
  expect((await orb(["run", "--standalone", "--model", model, "say ok"])).code).toBe(0)
  expect((await orb(["run", "--standalone", "--model", model, "say ok"])).code).toBe(0)
  const db = new Database(path.join(root, "orbit.db"))
  const [parent, child] = db
    .query<{ id: string }, []>("select id from session_v2 order by time_created desc limit 2")
    .all()
    .toReversed()
  db.query("update session_v2 set parent_id = ? where id = ?").run(parent!.id, child!.id)
  db.close()
  chats.length = 0

  const refused = await orb(["run", "--standalone", "--session", child!.id, "/context"])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(parent!.id)
  expect(refused.stderr).toContain("main session")
  expect(refused.stdout).not.toContain("## Context usage")

  const missing = await orb(["run", "--standalone", "--resume", "ses_context_missing", "/context"])
  expect(missing.code).toBe(1)
  expect(missing.stderr.toLowerCase()).toContain("not found")
  expect(missing.stdout).not.toContain("## Context usage")
  expect(chats).toEqual([])
}, 300_000)

// Class 7: a server from before the route answers 404 with no body, and a server that does not answer in time is given
// up on; each ends with one line saying which.
test("an old server and one that does not answer each end with one line", async () => {
  const { readContextUsage } = await import("../src/run/context-report")
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/slow/context/usage")) await Bun.sleep(2_000)
      return new Response(null, { status: 404 })
    },
  })
  try {
    const client = Orbit.make({ baseUrl: `http://127.0.0.1:${stub.port}` })
    const old = await readContextUsage(client, "ses_old", 5_000)
    expect(old).toEqual({ error: expect.stringContaining("older") })
    const slow = await readContextUsage(client, "slow", 50)
    expect(slow).toEqual({ error: expect.stringContaining("did not answer") })
  } finally {
    await stub.stop(true)
  }
})

async function orb(args: string[], env: Record<string, string | undefined> = {}) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { USERPROFILE: root, PWD: repo, ORBIT_CONFIG_CONTENT: undefined, ...env }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  return finished(child, `orb ${args.join(" ")}`, 120_000)
}

const spawned = (command: string[], cwd: string) =>
  finished(Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" }), command.join(" "), 60_000)

// Waits for a child for `limit` milliseconds at most, and names the command and what it printed when it does not end.
async function finished(child: Bun.Subprocess<"ignore", "pipe", "pipe">, command: string, limit: number) {
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  const timer = setTimeout(() => child.kill("SIGKILL"), limit)
  const [stdout, stderr, code] = await output
  clearTimeout(timer)
  if (child.signalCode === "SIGKILL")
    throw new Error(`${command} did not end within ${limit / 1000} s:\n${stdout}\n${stderr}`)
  return { code, stdout, stderr }
}
