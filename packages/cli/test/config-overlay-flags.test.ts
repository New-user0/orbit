import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { scriptedModel } from "./fixture/scripted-model"

// `orb -p` with --mcp-config and --agents against a real private server and a scripted model. Every run is a child
// process of src/index.ts, so the flags, the overlay file and the server's read of it are the ones a user reaches.
// Every run takes two steps: a Glob call first, so the second request is made after the MCP servers have connected.
const glob = { delayMs: 2_000, tool: { name: "Glob", input: { pattern: "*.nothing-matches-this" } } }
const model = scriptedModel(
  Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? glob : "ok")),
  262_144,
)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-overlay-flags-")))
const workspace = path.join(root, "workspace")
// The child's temporary folder, where the overlay file is written, so the test can see what it leaves.
const temporary = path.join(root, "tmp")
const fixture = path.join(import.meta.dir, "../../core/test/fixture/mcp-output-schema.ts")

beforeAll(async () => {
  await model.configure(root)
  await fs.mkdir(workspace, { recursive: true })
  await fs.mkdir(temporary, { recursive: true })
})

afterAll(async () => {
  await model.stop()
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

async function orb(args: string[]) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      PWD: workspace,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT_FILE: undefined,
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

async function sent(args: string[]) {
  const before = model.steps.length
  const result = await orb(["-p", "--model", model.model, ...args, "say ok"])
  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  return { ...result, requests: model.steps.slice(before) }
}

// What the child left in its temporary folder: nothing, once the run is over.
const leftovers = () => fs.readdir(path.join(temporary, "orbit")).catch(() => [])

test("--agents with --agent: the agent's system prompt reaches the model, and no overlay file or service is left", async () => {
  const marker = "OVERLAY-AGENT-MARKER"
  const agents = JSON.stringify({ scribe: { system: marker, mode: "primary", description: "Writes things" } })

  const run = await sent(["--agents", agents, "--agent", "scribe"])
  const plain = await sent(["--standalone"])
  // --mcp-config and --agents imply a private server, as --bare does: no service was started under the isolated root.
  const status = await orb(["service", "status"])

  expect(run.requests.map((request) => request.system).join("")).toContain(marker)
  expect(plain.requests.map((request) => request.system).join("")).not.toContain(marker)
  expect(await leftovers()).toEqual([])
  expect(status.stdout.trim()).toBe("stopped")
}, 180_000)

test("--mcp-config adds the tools of the server it names", async () => {
  const servers = JSON.stringify({
    servers: { fx: { type: "local", command: [process.execPath, fixture], codemode: false } },
  })
  await Bun.write(path.join(root, "servers.json"), servers)

  const inline = await sent(["--mcp-config", servers])
  const file = await sent(["--mcp-config", path.join(root, "servers.json")])
  const plain = await sent(["--standalone"])

  const tools = (run: { requests: typeof inline.requests }) =>
    run.requests.flatMap((request) =>
      ((request.body as { tools?: Array<{ function: { name: string } }> }).tools ?? []).map(
        (tool) => tool.function.name,
      ),
    )
  expect(tools(inline)).toContain("fx_first")
  expect(tools(file)).toContain("fx_first")
  expect(tools(plain)).not.toContain("fx_first")
  expect(await leftovers()).toEqual([])
}, 240_000)

test("an --agents payload over 40 KB arrives intact", async () => {
  // A file, because a command line holds less than that on Windows; the environment is what the overlay file avoids.
  const system = `START-${"alpha ".repeat(7_000)}-END`
  await Bun.write(path.join(root, "agents.json"), JSON.stringify({ big: { system, mode: "primary" } }))

  const run = await sent(["--agents", path.join(root, "agents.json"), "--agent", "big"])

  expect(system.length).toBeGreaterThan(40_000)
  expect(run.requests.map((request) => request.system).join("")).toContain(system)
}, 180_000)

test("a value that does not fit stops the run before any server starts, naming the flag and the path", async () => {
  const before = model.requests.length

  const bad = await orb(["-p", "--model", model.model, "--agents", '{"scribe":{"steps":0}}', "say ok"])
  const foreign = await orb(["-p", "--model", model.model, "--mcp-config", '{"mcpServers":{}}', "say ok"])

  expect(bad.code).not.toBe(0)
  expect(bad.stderr).toContain("--agents: ")
  expect(bad.stderr).toContain("at scribe.steps")
  expect(foreign.code).not.toBe(0)
  expect(foreign.stderr).toContain('"mcpServers" is another product\'s shape')
  expect(model.requests.length).toBe(before)
  expect(await leftovers()).toEqual([])
}, 120_000)

test("the overlay flags cannot be combined with --server", async () => {
  const run = await orb(["-p", "--server", "http://127.0.0.1:1", "--agents", "{}", "say ok"])

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("--agents cannot be combined with --server")
}, 120_000)
