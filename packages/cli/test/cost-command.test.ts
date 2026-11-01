import { afterAll, beforeAll, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Orbit } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// clients-ux-23 part 2: `orb run "/cost"` prints the whole session's cost block and sends nothing to the model. The
// route reads database rows only (class 12), and each failure is one line and exit 1 (classes 7 and 13). A real private
// server and a scripted model that counts every chat request.
const model = "ollama/cost:1b"
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
const chats: string[] = []
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "cost:1b", model: "cost:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
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
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-cost-cli-")))
const repo = path.join(root, "repo")

beforeAll(async () => {
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ model, providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
  await Bun.write(path.join(repo, "notes.txt"), "notes\n")
  expect((await spawned(["git", "init", "--quiet"], repo)).code).toBe(0)
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})


// PL1: a session that has answered once, then /cost: the block, no chat request; the JSON formats print one line each.
test('orb run "/cost" prints the block and sends nothing to the model; --format json prints one cost line', async () => {
  const first = await orb(["run", "--standalone", "--model", model, "say ok"])
  expect(first.code).toBe(0)
  expect(chats.length).toBeGreaterThan(0)
  chats.length = 0

  const text = await orb(["run", "--standalone", "--continue", "--model", model, "/cost"])
  expect({ code: text.code, stderr: text.stderr }).toEqual({ code: 0, stderr: "" })
  expect(text.stdout).toContain("Total cost:")
  expect(text.stdout).toContain("Total API duration:")
  expect(text.stdout).toContain("Total wall duration:")
  expect(text.stdout).toContain("Total code changes:")
  expect(text.stdout).toContain("Usage by model:")
  expect(text.stdout).toContain("cost:1b")
  expect(text.stdout).toMatch(/\d+ input, \d+ output/)

  // The alias the TUI also has.
  const usage = await orb(["run", "--standalone", "--continue", "--model", model, "/usage"])
  expect(usage.code).toBe(0)
  expect(usage.stdout).toContain("Total cost:")

  const json = await orb(["run", "--standalone", "--continue", "--format", "json", "--model", model, "/cost"])
  expect(json.code).toBe(0)
  const lines = json.stdout.trim().split("\n")
  expect(lines.length).toBe(1)
  const line = JSON.parse(lines[0]!)
  expect(line.type).toBe("cost")
  expect(line.sessionID).toMatch(/^ses_/)
  expect(line.cost.rows[0]).toMatchObject({ modelID: "cost:1b", providerID: "ollama" })

  const result = await orb(["run", "--standalone", "--continue", "--format", "result", "--model", model, "/cost"])
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout.trim())).toMatchObject({ type: "result", is_error: false })
  expect(chats).toEqual([])
}, 300_000)

// PL2, classes 7 and 13: an unknown session ends the run with its message; a server from before the route, and a
// session the server does not know, each end the read with one line.
test("an unknown session and an old server exit 1 with the message", async () => {
  chats.length = 0
  const missing = await orb(["run", "--standalone", "--resume", "ses_cost_missing", "/cost"])
  expect(missing.code).toBe(1)
  expect(missing.stderr.toLowerCase()).toContain("not found")
  expect(missing.stdout).not.toContain("Total cost")
  expect(chats).toEqual([])

  const { readSessionCost } = await import("../src/run/cost-report")
  const stub = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.includes("/known/")) {
        return Response.json({ _tag: "SessionNotFoundError", sessionID: "known", message: "Session not found: known" }, { status: 404 })
      }
      return new Response(null, { status: 404 })
    },
  })
  try {
    const client = Orbit.make({ baseUrl: `http://127.0.0.1:${stub.port}` })
    expect(await readSessionCost(client, "ses_old", 5_000)).toEqual({ error: expect.stringContaining("older") })
    expect(await readSessionCost(client, "known", 5_000)).toEqual({ error: expect.stringContaining("not found") })
  } finally {
    await stub.stop(true)
  }
}, 300_000)

// The block takes no file, so --file is a usage error and nothing reaches the model.
test("/cost with --file is refused", async () => {
  chats.length = 0
  for (const command of ["/cost", "/usage"]) {
    const result = await orb(["run", "--standalone", "--model", model, "--file", "notes.txt", command])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("--file")
    expect(result.stdout).not.toContain("Total cost")
  }
  expect(chats).toEqual([])
}, 300_000)

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
