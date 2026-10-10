import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { NodeFileSystem } from "@effect/platform-node"
import { Orbit } from "@orbit/client/promise"
import { Global } from "@orbit/util/global"
import { Effect } from "effect"
import { ConfigOverlay } from "../src/config-overlay"
import { ServiceConfig } from "../src/services/service-config"
import { ORBIT_VERSION } from "../src/version"
import { ServerProcess } from "../src/server-process"

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-overlay-")))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const server = (extra: object = {}) => ({ type: "local", command: ["fx"], ...extra })

async function built(input: Partial<Parameters<typeof ConfigOverlay.build>[0]>) {
  const content = await ConfigOverlay.build({ mcpConfig: [], cwd: root, ...input })
  return content === undefined ? undefined : JSON.parse(content)
}

async function refused(input: Partial<Parameters<typeof ConfigOverlay.build>[0]>) {
  return ConfigOverlay.build({ mcpConfig: [], cwd: root, ...input }).then(
    () => "",
    (error: Error) => error.message,
  )
}

test("no flag builds nothing, so the run keeps the background service", async () => {
  expect(await ConfigOverlay.build({ mcpConfig: [], cwd: root, inherited: '{"model":"a/b"}' })).toBeUndefined()
})

test("a value that names a file is read from it, and any other value is the JSON itself", async () => {
  await Bun.write(path.join(root, "servers.json"), JSON.stringify({ servers: { fromfile: server() } }))

  const file = await built({ mcpConfig: ["servers.json"] })
  const inline = await built({
    mcpConfig: ['{"servers": {"inline": {"type": "local", "command": ["fx"],},},} // jsonc'],
  })

  expect(Object.keys(file.mcp.servers)).toEqual(["fromfile"])
  expect(Object.keys(inline.mcp.servers)).toEqual(["inline"])
  expect(await refused({ mcpConfig: ["missing.json"] })).toContain(
    "--mcp-config: missing.json is not a file that exists",
  )
})

test("layers merge in order: the inherited content, each --mcp-config, then --agents", async () => {
  const merged = await built({
    inherited: JSON.stringify({
      model: "a/b",
      mcp: { servers: { shared: server({ command: ["inherited"] }), kept: server() } },
      agents: { helper: { system: "inherited", description: "kept" } },
    }),
    mcpConfig: [
      JSON.stringify({ servers: { shared: server({ command: ["first"] }), one: server() } }),
      JSON.stringify({ servers: { shared: server({ command: ["second"] }) } }),
    ],
    agents: JSON.stringify({ helper: { system: "flag" }, extra: { system: "x" } }),
  })

  expect(merged.model).toBe("a/b")
  expect(Object.keys(merged.mcp.servers).sort()).toEqual(["kept", "one", "shared"])
  expect(merged.mcp.servers.shared.command).toEqual(["second"])
  expect(merged.agents.helper).toEqual({ system: "flag", description: "kept" })
  expect(Object.keys(merged.agents).sort()).toEqual(["extra", "helper"])
})

test.each([
  [
    "--mcp-config",
    { mcpConfig: [JSON.stringify({ servers: { a: { type: "local", command: "x" } } })] },
    "servers.a.command",
  ],
  ["--mcp-config", { mcpConfig: [JSON.stringify({ servers: { a: server({ bogus: 1 }) } })] }, "servers.a.bogus"],
  ["--mcp-config", { mcpConfig: [JSON.stringify({ extra: 1 })] }, "extra"],
  ["--agents", { agents: JSON.stringify({ helper: { prompt: "x" } }) }, "helper.prompt"],
  ["--agents", { agents: JSON.stringify({ helper: { steps: 0 } }) }, "helper.steps"],
  ["--agents", { agents: JSON.stringify({ helper: { mode: "boss" } }) }, "helper.mode"],
])("a value that does not fit names the flag %s and the path %j", async (flag, input, where) => {
  const message = await refused(input)

  expect(message).toContain(`${flag}: `)
  expect(message).toContain(` at ${where}`)
})

test("a value that is not JSON, or not an object, names the flag", async () => {
  expect(await refused({ agents: "{" })).toContain("--agents: invalid JSON")
  expect(await refused({ mcpConfig: ["{ nope }"] })).toContain("--mcp-config: invalid JSON")
  expect(await refused({ agents: "[]" })).toContain("--agents")
  expect(await refused({ agents: "{}", inherited: "{" })).toContain("ORBIT_CONFIG_CONTENT: invalid JSON")
})

test("another product's mcpServers map is refused with a hint", async () => {
  const message = await refused({ mcpConfig: [JSON.stringify({ mcpServers: { a: { command: "x", args: [] } } })] })

  expect(message).toContain("--mcp-config")
  expect(message).toContain('"mcpServers" is another product\'s shape')
  expect(message).toContain('"servers"')
})

test("relative program and cwd paths in a file mean the folder of that file, and an inline value means the start folder", async () => {
  await fs.mkdir(path.join(root, "nested"), { recursive: true })
  await Bun.write(
    path.join(root, "nested", "relative.json"),
    JSON.stringify({
      servers: {
        dotted: server({ command: ["./bin/run", "./arg"], cwd: "work" }),
        bare: server({ command: ["node", "./arg"] }),
        absolute: server({ command: [path.join(root, "abs")], cwd: root }),
      },
    }),
  )

  const file = await built({ mcpConfig: [path.join("nested", "relative.json")] })
  const inline = await built({
    mcpConfig: [JSON.stringify({ servers: { dotted: server({ command: ["./bin/run"] }) } })],
  })

  expect(file.mcp.servers.dotted.command).toEqual([path.join(root, "nested", "bin", "run"), "./arg"])
  expect(file.mcp.servers.dotted.cwd).toBe(path.join(root, "nested", "work"))
  expect(file.mcp.servers.bare.command).toEqual(["node", "./arg"])
  expect(file.mcp.servers.absolute).toMatchObject({ command: [path.join(root, "abs")], cwd: root })
  expect(inline.mcp.servers.dotted.command).toEqual([path.join(root, "bin", "run")])
})

test("the overlay cannot be combined with --server", () => {
  expect(
    ConfigOverlay.conflict({ server: "http://x", flags: ConfigOverlay.given({ mcpConfig: ["a"], agents: "{}" }) }),
  ).toBe(
    "--mcp-config and --agents cannot be combined with --server: the config belongs to a private server started for this run",
  )
  expect(ConfigOverlay.conflict({ server: undefined, flags: ["--agents"] })).toBeUndefined()
  expect(ConfigOverlay.conflict({ server: "http://x", flags: [] })).toBeUndefined()
})

test("a merged document over 4 MiB is refused before anything starts", async () => {
  const big = JSON.stringify({ helper: { system: "x".repeat(ConfigOverlay.MAX_BYTES) } })

  expect(await refused({ agents: big })).toContain("the most one run takes is 4194304")
  const fits = await built({ agents: JSON.stringify({ helper: { system: "x".repeat(100_000) } }) })
  expect(fits.agents.helper.system).toHaveLength(100_000)
})

test("the envelope is versioned, only its file is removed when read, and the server cannot be pointed at another shape", async () => {
  const written = await ConfigOverlay.write('{"agents":{}}')
  expect(JSON.parse(await Bun.file(written.file).text())).toEqual({ version: 1, content: '{"agents":{}}' })
  if (process.platform !== "win32") expect((await fs.stat(written.file)).mode & 0o777).toBe(0o600)
  expect(path.dirname(path.dirname(written.file))).toBe(Global.Path.tmp)

  expect(await ConfigOverlay.consume(written.file)).toBe('{"agents":{}}')
  expect(await Bun.file(written.file).exists()).toBe(false)
  expect((await fs.stat(path.dirname(written.file))).isDirectory()).toBe(true)
  await written.remove()
  expect(await Bun.file(path.dirname(written.file)).exists()).toBe(false)

  const other = path.join(root, "other.json")
  for (const text of ['{"version":2,"content":"{}"}', '{"content":"{}"}', "not json", '{"version":1,"content":1}']) {
    await Bun.write(other, text)
    await expect(ConfigOverlay.consume(other)).rejects.toThrow("version 1 overlay")
  }
})

test("a folder left by a run that died is swept, a fresh one is not", async () => {
  await fs.mkdir(Global.Path.tmp, { recursive: true })
  const stale = await fs.mkdtemp(path.join(Global.Path.tmp, "overlay-"))
  const fresh = await fs.mkdtemp(path.join(Global.Path.tmp, "overlay-"))
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
  await fs.utimes(stale, old, old)

  const written = await ConfigOverlay.write("{}")

  expect(await fs.stat(stale).catch(() => undefined)).toBeUndefined()
  expect((await fs.stat(fresh)).isDirectory()).toBe(true)
  await written.remove()
  await fs.rm(fresh, { recursive: true })
})

// A background service that is registered and healthy, answering session.active from `active`, and a private server
// whose newest session is `newest`; both are real HTTP servers, reached the way the CLI reaches them.
async function guarded(input: {
  registered: boolean
  active: (request: Request) => Response
  session?: string
  continue?: boolean
  newest?: string
}) {
  const state = await fs.mkdtemp(path.join(root, "state-"))
  const service = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/session/active"
        ? input.active(request)
        : Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] }),
  })
  const priv = Bun.serve({
    port: 0,
    fetch: () => Response.json({ data: input.newest ? [{ id: input.newest }] : [], cursor: {} }),
  })
  try {
    if (input.registered) {
      await fs.mkdir(path.join(state, "state"), { recursive: true })
      await Bun.write(
        path.join(state, "state", ServiceConfig.filename()),
        JSON.stringify({ id: "overlay-guard", version: ORBIT_VERSION, url: service.url.toString(), pid: process.pid }),
      )
    }
    const layer = Global.layerWith({ config: path.join(state, "config"), state: path.join(state, "state") })
    return await Effect.runPromise(
      ConfigOverlay.refuseActive({
        client: Orbit.make({ baseUrl: priv.url.toString() }),
        session: input.session,
        continue: input.continue ?? false,
        directory: root,
      }).pipe(
        Effect.map(() => "allowed"),
        Effect.catch((error) => Effect.succeed(error.message)),
        Effect.provide(layer),
        Effect.provide(NodeFileSystem.layer),
        Effect.scoped,
      ),
    )
  } finally {
    await service.stop(true)
    await priv.stop(true)
  }
}

const running = (id: string) => () => Response.json({ data: { [id]: { type: "running" } } })

test.each([
  [
    "--session of a session the service is running",
    { session: "ses_busy", active: running("ses_busy") },
    "ses_busy is running",
  ],
  [
    "--session of a session the service is not running",
    { session: "ses_idle", active: running("ses_busy") },
    "allowed",
  ],
  [
    "--continue when the newest session is running there",
    { continue: true, newest: "ses_busy", active: running("ses_busy") },
    "ses_busy is running",
  ],
  ["--continue with no session yet", { continue: true, active: running("ses_busy") }, "allowed"],
  ["a new session", { active: running("ses_busy") }, "allowed"],
  ["no service registered", { registered: false, session: "ses_busy", active: running("ses_busy") }, "allowed"],
  [
    "a service that cannot answer",
    { session: "ses_busy", active: () => new Response("no", { status: 500 }) },
    "Could not ask the background service",
  ],
])("the private server shares no session with the background service: %s", async (_, input, expected) => {
  const result = await guarded({ registered: true, ...input })

  expect(result).toContain(expected)
})

test("the private server that carries an overlay trusts a folder only when asked to", () => {
  const env = { ORBIT_CONFIG_CONTENT_FILE: "/overlay.json" }

  expect(ServerProcess.trustOptions("stdio", env)).toEqual({ implicit: false })
  expect(ServerProcess.trustOptions("stdio", { ...env, ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: true })
  expect(ServerProcess.trustOptions("service", { ...env, ORBIT_TRUST_PROJECT: "1" })).toEqual({ implicit: false })
})
