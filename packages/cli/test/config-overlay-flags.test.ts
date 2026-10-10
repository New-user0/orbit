import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"
import { ServiceConfig } from "../src/services/service-config"
import { ORBIT_VERSION } from "../src/version"
import { scriptedModel } from "./fixture/scripted-model"

// `orb -p` with --mcp-config and --agents against a real private server and a scripted model. Every run is a child
// process of src/index.ts, so the flags, the overlay file and the server's read of it are the ones a user reaches.
// Every run takes two steps: a Glob call first, so the second request is made after the MCP servers have connected.
const glob = { delayMs: 2_000, tool: { name: "Glob", input: { pattern: "*.nothing-matches-this" } } }
// What the overlay folders of the run hold at each request: the file is read and deleted by the server at startup, so
// from the first request on there is no overlay file anywhere, though the run's own folder is still there.
const midRun: Array<{ folders: number; files: string[] }> = []
const model = scriptedModel(
  Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? glob : "ok")),
  262_144,
  async () => {
    const folders = (await fs.readdir(path.join(temporary, "orbit")).catch(() => [])).filter((name) =>
      name.startsWith("overlay-"),
    )
    const files = await Promise.all(
      folders.map((folder) => fs.readdir(path.join(temporary, "orbit", folder)).catch(() => [])),
    )
    midRun.push({ folders: folders.length, files: files.flat() })
  },
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

async function orb(args: string[], env: Record<string, string | undefined> = {}, cwd = path.join(import.meta.dir, "..")) {
  // The preload that compiles the interface's JSX comes from the package's bunfig.toml, which Bun reads from the
  // working folder, and some runs start elsewhere.
  const preload = Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, ".."))
  const child = Bun.spawn([process.execPath, "run", "--preload", preload, path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd,
    timeout: 120_000,
    env: isolatedEnv(root, {
      USERPROFILE: root,
      PWD: workspace,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT_FILE: undefined,
      OLLAMA_CONTEXT_LENGTH: undefined,
      ...env,
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
  // While the run was in progress its own folder existed and the server had already deleted the file it held.
  expect(midRun.length).toBeGreaterThan(0)
  expect(midRun.some((seen) => seen.folders > 0)).toBe(true)
  expect(midRun.flatMap((seen) => seen.files)).toEqual([])
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

// A refusal before a session exists goes out in the format that was asked for, so a script that asked for JSON gets one
// result object on stdout and no stack trace.
test.each([
  ["a value that does not fit", ["--agents", '{"scribe":{"steps":0}}'], "--agents: "],
  ["another product's shape", ["--mcp-config", '{"mcpServers":{}}'], "is another product's shape"],
  ["--server", ["--server", "http://127.0.0.1:1", "--agents", "{}"], "--agents cannot be combined with --server"],
  ["a file over the cap", ["--agents", "BIG"], "the most one run takes is 4194304"],
])("with --output-format json, %s is refused as a result object", async (_, flags, expected) => {
  const big = path.join(root, "over-the-cap.json")
  await Bun.write(big, " ".repeat(4 * 1024 * 1024 + 1))

  const run = await orb([
    "-p",
    "--output-format",
    "json",
    "--model",
    model.model,
    ...flags.map((flag) => (flag === "BIG" ? big : flag)),
    "say ok",
  ])

  expect(run.code).not.toBe(0)
  expect(JSON.parse(run.stdout.trim())).toMatchObject({
    type: "result",
    is_error: true,
    error: expect.stringContaining(expected),
  })
  expect(run.stderr).not.toMatch(/^\s+at /m)
}, 120_000)

// The overlay adds a private server; it must not add trust. A folder that is not trusted stops `orb -p` whatever flags
// it carries. The controls: --trust gets past the check (what the model does afterwards is not this test's concern: a
// grant reloads the config, and the scripted model's discovery can lag behind it), and a server that is told to trust
// its folders runs the same flags.
test("an overlay run in a folder that is not trusted is refused, and --trust and a trusting server get past the check", async () => {
  const untrusted = { ORBIT_TRUST_PROJECT: undefined }
  const flags = ["--model", model.model, "--agents", "{}", "say ok"]

  const refused = await orb(["-p", ...flags], untrusted)
  const granted = await orb(["-p", "--trust", ...flags], untrusted)
  const trusting = await orb(["-p", ...flags])

  expect(refused.code).toBe(1)
  expect(refused.stdout + refused.stderr).toContain("is not trusted")
  expect(granted.stdout + granted.stderr).not.toContain("is not trusted")
  expect({ code: trusting.code, stderr: trusting.code === 0 ? "" : trusting.stderr }).toEqual({ code: 0, stderr: "" })
  expect(trusting.stdout).toContain("ok")
}, 240_000)

// On the root path the person's start folder is the one that holds their files; the folder they ask Orbit to open may be
// a clone that ships a file of the same name.
test.each([
  ["--mcp-config", "mcp.json"],
  ["--agents", "agents.json"],
])("%s names a file in the folder the person typed it in, not in the folder they open", async (flag, name) => {
  const home = path.join(root, `home-${flag.slice(2)}`)
  const project = path.join(root, `project-${flag.slice(2)}`)
  const marker = path.join(project, "ran.marker")
  await fs.mkdir(home, { recursive: true })
  await fs.mkdir(project, { recursive: true })
  await Bun.write(path.join(home, name), "{ the person's own file, which does not parse")
  // The clone's file is valid and would start a program that leaves a marker, if it were read.
  await Bun.write(path.join(project, "mark.ts"), `await Bun.write(${JSON.stringify(marker)}, "ran")`)
  await Bun.write(
    path.join(project, name),
    JSON.stringify(
      flag === "--mcp-config"
        ? { servers: { clone: { type: "local", command: [process.execPath, path.join(project, "mark.ts")] } } }
        : { clone: { system: "CLONE-AGENT" } },
    ),
  )

  const run = await orb([project, flag, name], {}, home)

  expect(run.stderr).toContain(`${flag}: invalid JSON`)
  expect(await Bun.file(marker).exists()).toBe(false)
}, 180_000)

// With --continue the run must not drain a session the background service is running. The service here is a stand-in
// that reports one session as running, registered where the child looks for it. The folder is spelled several ways,
// and the guard must find the same session the run would continue in every one.
test.each([
  ["the real path", (dir: string) => dir, true],
  ["a trailing separator", (dir: string) => dir + path.sep, true],
  ["a link to it", (dir: string) => dir.replace(/workspace$/, "workspace-link"), false],
])("--continue never drains the session the service runs, with PWD as %s", async (_, spell, refusal) => {
  const first = await orb(["-p", "--output-format", "json", "--model", model.model, "--agents", "{}", "say ok"])
  const sessionID = JSON.parse(first.stdout.trim()).sessionID as string
  expect(sessionID).toStartWith("ses")
  const link = path.join(root, "workspace-link")
  await fs.rm(link, { force: true })
  await fs.symlink(workspace, link, process.platform === "win32" ? "junction" : "dir")
  const service = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/session/active"
        ? Response.json({ data: { [sessionID]: { type: "running" } } })
        : Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] }),
  })
  const registration = path.join(root, "state", "orbit", ServiceConfig.filename())
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await Bun.write(registration, JSON.stringify({ id: "stand-in", version: ORBIT_VERSION, url: service.url.toString(), pid: process.pid }))
  try {
    const run = await orb(
      ["-p", "--output-format", "json", "--model", model.model, "--agents", "{}", "--continue", "say ok"],
      { PWD: spell(workspace) },
    )

    const result = JSON.parse(run.stdout.trim())
    // Whatever way the folder is spelled, the run never continues the session the service is running; and where the
    // folder is the same one, it is refused for that reason.
    expect(result.sessionID).not.toBe(sessionID)
    if (refusal) {
      expect(run.code).not.toBe(0)
      expect(result.error).toContain(`Session ${sessionID} is running in the background service`)
    }
  } finally {
    await service.stop(true)
    await fs.rm(registration, { force: true })
    await fs.rm(link, { force: true })
  }
}, 240_000)
