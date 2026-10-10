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
// What the overlay folders of the run hold at each request: the server reads and deletes the file at startup and the CLI
// removes the run's folder as soon as the server is up, so from the first request on there is neither (and nothing to inherit).
const midRun: Array<{ folders: number; files: string[] }> = []
const model = scriptedModel(
  Array.from({ length: 60 }, (_, index) => (index % 2 === 0 ? glob : "ok")),
  262_144,
  async () => {
    const folders = (await fs.readdir(overlays).catch(() => [])).filter((name) => name.startsWith("overlay-"))
    const files = await Promise.all(folders.map((folder) => fs.readdir(path.join(overlays, folder)).catch(() => [])))
    midRun.push({ folders: folders.length, files: files.flat() })
  },
)
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-overlay-flags-")))
const workspace = path.join(root, "workspace")
// The child's overlays folder, where the overlay file is written, so the test can see what it leaves.
const overlays = path.join(root, "state", "orbit", "overlays")
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

async function orb(
  args: string[],
  env: Record<string, string | undefined> = {},
  cwd = path.join(import.meta.dir, ".."),
  timeout = 120_000,
) {
  // The preload that compiles the interface's JSX comes from the package's bunfig.toml, which Bun reads from the
  // working folder, and some runs start elsewhere.
  const preload = Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, ".."))
  const child = Bun.spawn(
    [process.execPath, "run", "--preload", preload, path.join(import.meta.dir, "../src/index.ts"), ...args],
    {
      cwd,
      timeout,
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
    },
  )
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

// What the child left in its overlays folder: nothing, once the run is over.
const leftovers = () => fs.readdir(overlays).catch(() => [])

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
  // The folder is gone by the first request, not only at exit.
  expect(midRun.length).toBeGreaterThan(0)
  expect(midRun.every((seen) => seen.folders === 0)).toBe(true)
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
])(
  "with --output-format json, %s is refused as a result object",
  async (_, flags, expected) => {
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
  },
  120_000,
)

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
])(
  "%s names a file in the folder the person typed it in, not in the folder they open",
  async (flag, name) => {
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
  },
  180_000,
)

// With --continue the run must not drain a session the background service is running. The service here is a stand-in
// that reports one session as running, registered where the child looks for it.
async function sessionIn(directory: string) {
  await fs.mkdir(directory, { recursive: true })
  // The servers a run starts are started from the folder it works in, and Bun reads the preload that compiles the
  // interface's JSX from a bunfig.toml there.
  const preload = Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, ".."))
  await Bun.write(path.join(directory, "bunfig.toml"), `preload = [${JSON.stringify(preload.replaceAll("\\", "/"))}]\n`)
  const first = await orb(["-p", "--output-format", "json", "--model", model.model, "--agents", "{}", "say ok"], {
    PWD: directory,
  })
  const sessionID = JSON.parse(first.stdout.trim()).sessionID as string
  expect(sessionID).toStartWith("ses")
  return sessionID
}

async function whileServiceRuns<T>(sessionID: string, body: () => Promise<T>) {
  const service = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/session/active"
        ? Response.json({ data: { [sessionID]: { type: "running" } } })
        : Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] }),
  })
  const registration = path.join(root, "state", "orbit", ServiceConfig.filename())
  await fs.mkdir(path.dirname(registration), { recursive: true })
  await Bun.write(
    registration,
    JSON.stringify({ id: "stand-in", version: ORBIT_VERSION, url: service.url.toString(), pid: process.pid }),
  )
  try {
    return await body()
  } finally {
    await service.stop(true)
    await fs.rm(registration, { force: true })
  }
}

// The folder is spelled several ways, and the guard must find the same session the run would continue in every one.
// A link is resolved by process.cwd() on Linux and kept on Windows, where it is a different folder to the database.
test.each([
  ["the real path", (dir: string) => dir, true],
  ["a trailing separator", (dir: string) => dir + path.sep, true],
  ["a link to it", (dir: string) => dir.replace(/workspace$/, "workspace-link"), process.platform !== "win32"],
])(
  "--continue never drains the session the service runs, with PWD as %s",
  async (_, spell, refusal) => {
    const sessionID = await sessionIn(workspace)
    const link = path.join(root, "workspace-link")
    await fs.rm(link, { force: true })
    await fs.symlink(workspace, link, process.platform === "win32" ? "junction" : "dir")
    try {
      const run = await whileServiceRuns(sessionID, () =>
        orb(["-p", "--output-format", "json", "--model", model.model, "--agents", "{}", "--continue", "say ok"], {
          PWD: spell(workspace),
        }),
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
      await fs.rm(link, { force: true })
    }
  },
  240_000,
)

// `orb <directory>` opens the interface in <directory>, not in the folder it was started in, so the guard must ask
// about the newest session of <directory>. The interface needs a terminal, so only the refusals are pinned, and they
// come before it starts; the control is the same command started in the folder itself.
test.each([
  ["started in the folder itself", "project", "project", "project", true],
  ["named from another folder, the named folder's session running", "home", "project", "project", true],
  ["named from another folder, the start folder's session running", "home", "project", "home", false],
])(
  "orb --agents --continue, %s",
  async (_, start, named, running, refused) => {
    const folders = { home: path.join(root, "root-home"), project: path.join(root, "root-project") }
    const sessions = { home: await sessionIn(folders.home), project: await sessionIn(folders.project) }

    const run = await whileServiceRuns(sessions[running as "home" | "project"], () =>
      orb(
        [...(start === named ? [] : [folders[named as "project"]]), "--agents", "{}", "--continue"],
        {
          PWD: folders[start as "home" | "project"],
        },
        folders[start as "home" | "project"],
        // A run that is not refused starts the interface, which has no terminal here and is stopped at the deadline.
        30_000,
      ),
    )

    const message = `Session ${sessions[running as "home" | "project"]} is running in the background service`
    if (refused) expect(run.stdout + run.stderr).toContain(message)
    else expect(run.stdout + run.stderr).not.toContain(message)
  },
  240_000,
)

// Core reads a relative {file:} against the folder it opens. A reference in the person's own value means the folder of
// the file that holds it, so a clone cannot answer it. The control is the person's own file being read.
test.each([
  ["--agents", "an agent's system", "agents.json", (token: string) => ({ a: { system: token, mode: "primary" } })],
  [
    "--mcp-config",
    "an MCP server's environment",
    "mcp.json",
    (token: string) => ({ servers: { s: { type: "local", command: ["fx"], environment: { K: token } } } }),
  ],
])(
  "%s: a relative {file:} in %s is read from the person's folder, not the opened one",
  async (flag, _, name, shape) => {
    const home = path.join(root, `file-home-${flag.slice(2)}`)
    const project = path.join(root, `file-project-${flag.slice(2)}`)
    await fs.mkdir(home, { recursive: true })
    await fs.mkdir(project, { recursive: true })
    await Bun.write(path.join(home, "prompt.md"), "FROM-HOME")
    await Bun.write(path.join(project, "prompt.md"), "FROM-CLONE")
    await Bun.write(path.join(home, name), JSON.stringify(shape("{file:./prompt.md}")))

    const { ConfigOverlay } = await import("../src/config-overlay")
    const content = await ConfigOverlay.build({
      mcpConfig: flag === "--mcp-config" ? [name] : [],
      agents: flag === "--agents" ? name : undefined,
      cwd: home,
    })

    // What core would read after the CLI has changed to the opened folder.
    const token = /\{file:([^}]+)\}/.exec(content!)![1]
    expect(await Bun.file(path.resolve(project, token)).text()).toBe("FROM-HOME")
  },
)

// A leftover or inherited ORBIT_CONFIG_CONTENT_FILE costs a server that has nothing to do with it one log line.
test("a command that starts a standalone server is not stopped by an ORBIT_CONFIG_CONTENT_FILE it inherited", async () => {
  const own = path.join(root, "my-own-config.json")
  await Bun.write(own, '{"model":"a/b"}')

  const run = await orb(["session", "list", "--standalone"], { ORBIT_CONFIG_CONTENT_FILE: own })

  expect(run.stderr).not.toContain("Standalone server exited before reporting readiness")
  expect(run.code).toBe(0)
  expect(await Bun.file(own).text()).toBe('{"model":"a/b"}')
}, 120_000)

// A path of the CLI's own shape that names nothing (a run that is over left the variable behind) is refused like any
// file that is not the CLI's. One that cannot be read stops the server, so a config is never silently dropped.
test.each([
  ["a file that is gone", "gone", 0],
  ["a folder", "folder", 1],
])(
  "a standalone server given an own-shaped ORBIT_CONFIG_CONTENT_FILE that is %s",
  async (_, kind, code) => {
    const folder = path.join(overlays, `overlay-${kind}`)
    const file = path.join(folder, `${crypto.randomUUID()}.json`)
    await fs.mkdir(kind === "folder" ? file : folder, { recursive: true })

    const run = await orb(["session", "list", "--standalone"], { ORBIT_CONFIG_CONTENT_FILE: file })

    expect(run.code).toBe(code)
    if (code !== 0) expect(run.stderr).toContain("Standalone server exited before reporting readiness")
  },
  120_000,
)

// release() runs once the private server is up, while the interface is still running. The interface needs a terminal,
// so the run is stopped at the deadline; the folder must be gone by then.
test("the run's overlay folder is removed while the interface is still up", async () => {
  const run = await orb(["--agents", '{"h": {"system": "x"}}'], { PWD: workspace }, workspace, 30_000)

  expect(run.stdout + run.stderr).not.toContain("not a file that exists")
  expect(await leftovers()).toEqual([])
}, 120_000)
