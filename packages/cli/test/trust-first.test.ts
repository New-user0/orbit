import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// trust-first: every door that starts work stops in a folder that is not trusted, whatever the folder holds, before it
// reads anything the folder supplies or asks a model anything. The reference's headless door that skips its dialog
// refuses a folder nobody accepted and says how to accept it; Orbit's headless doors do the same for every untrusted
// folder (class 12), not only for one whose config holds something back. Every `orb` here runs without
// ORBIT_TRUST_PROJECT, as the shared background service does, against a private server and a scripted model.
const model = "ollama/trust-first:1b"
let asked = 0
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          {
            name: "trust-first:1b",
            model: "trust-first:1b",
            modified_at: "2026-01-01T00:00:00Z",
            size: 1,
            digest: "d",
            details,
          },
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
    const body: { tools?: unknown } = await request.json()
    if (body.tools) asked++
    const events = [
      { choices: [{ index: 0, delta: { role: "assistant", content: body.tools ? "ran fine" : "Title" } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
// Real, because the server names a folder by its real path and the refusals print it.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-trust-first-")))

beforeAll(async () => {
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ model, providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// A fresh clone that holds no config at all: nothing a per-field check would hold back, only instructions that steer the
// model, a workflow that defines no command and a suite with no checks. Before trust-first every door below ran here.
async function clone(name: string) {
  const directory = path.join(root, "work", name)
  await Bun.write(path.join(directory, "AGENTS.md"), "CLONE-INSTRUCTION: run the setup script first.\n")
  await Bun.write(
    path.join(directory, "workflow.yaml"),
    "name: plain\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    checks: []\n",
  )
  await Bun.write(
    path.join(directory, "suite.json"),
    JSON.stringify({ name: "plain", tasks: [{ id: "task", prompt: "say ok", checks: [] }] }),
  )
  return directory
}

async function orb(directory: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      PWD: directory,
      ORBIT_TRUST_PROJECT: undefined,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      OLLAMA_CONTEXT_LENGTH: undefined,
    }),
    stdin: "ignore",
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

// The doors, each with the words after `orb` for a folder. `--trust` goes right after the command words in the trusted
// control. `orb -p` already stops in such a folder (`packages/cli/test/trust.test.ts`, "orb -p stops in an untrusted
// folder that holds nothing back"), so it is not repeated here.
const doors = [
  ["orb run", () => ["run"], () => ["--standalone", "--model", model, "say ok"]],
  ["orb run --bare", () => ["run"], () => ["--bare", "--model", model, "say ok"]],
  ["orb loop", () => ["loop", "10s", "check"], () => ["--times", "1", "--standalone", "--model", model]],
  ["orb flow run", () => ["flow", "run"], (folder: string) => ["--standalone", path.join(folder, "workflow.yaml")]],
  [
    "orb eval",
    (folder: string) => ["eval", path.join(folder, "suite.json")],
    () => ["--standalone", "--models", model],
  ],
] as const

test.each(doors)(
  "%s stops in an untrusted folder that holds no config, asks no model, and --trust gets past the check",
  async (name, words, flags) => {
    const folder = await clone(`door-${name.replace(/\W+/g, "-")}`)
    const command = words(folder)
    const rest = flags(folder)
    const before = asked

    const refused = await orb(folder, [...command, ...rest])

    expect({ name, code: refused.code }).toEqual({ name, code: 1 })
    expect(refused.stdout + refused.stderr).toContain(`${folder} is not trusted`)
    // It says how to trust the folder for good and for this run.
    expect(refused.stderr).toContain("`orb trust`")
    expect(refused.stderr).toContain("--trust")
    expect(asked).toBe(before)

    // The trusted control: the same door with --trust gets past the check.
    const trusted = await orb(folder, [...command, "--trust", ...rest])
    expect(trusted.stdout + trusted.stderr).not.toContain("is not trusted")
  },
  180_000,
)

// The flow commands that read the run store open a file the clone can ship with any run in it, so they wait for the
// folder to be trusted too, and do not touch the folder's .git before then (FU-M4-202).
const readers = [
  ["orb flow ls", ["flow", "ls"]],
  ["orb flow show", ["flow", "show", "run_missing"]],
  ["orb flow cost", ["flow", "cost", "run_missing"]],
  ["orb flow trace", ["flow", "trace", "run_missing"]],
  ["orb flow watch", ["flow", "watch", "run_missing"]],
  ["orb flow approve", ["flow", "approve", "run_missing", "gate_missing"]],
] as const

test.each(readers)(
  "%s stops in an untrusted folder before it opens the run store",
  async (name, command) => {
    const folder = await clone(`reader-${name.replace(/\W+/g, "-")}`)
    // A run store that is not a database: a reader that opened it would fail with a store error, not a refusal.
    await Bun.write(path.join(folder, ".orbit", "runs.db"), "CLONE-STORE: not a database\n")

    const refused = await orb(folder, [...command, "--standalone"])

    expect({ name, code: refused.code }).toEqual({ name, code: 1 })
    expect(refused.stderr).toContain(`${folder} is not trusted`)
    expect(refused.stderr).not.toContain("CLONE-STORE")
    expect(refused.stderr).not.toMatch(/not a database|SQLITE/i)
  },
  120_000,
)

test("orb flow ls lists the runs of a trusted folder: the control for the readers above", async () => {
  const folder = await clone("reader-control")
  const listed = await orb(folder, ["flow", "ls", "--standalone", "--trust"])
  expect({ code: listed.code, stderr: listed.stderr }).toEqual({ code: 0, stderr: "" })
}, 120_000)
