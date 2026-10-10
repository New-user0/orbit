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

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-overlay-")))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// Where the CLI keeps its overlays: per user, and not the temporary folder that every agent may write to.
const overlays = path.join(Global.Path.state, "overlays")

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
  expect(path.dirname(path.dirname(written.file))).toBe(overlays)

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

// ORBIT_CONFIG_CONTENT_FILE can be inherited from anywhere, so a file the CLI did not write is never read for its
// content or deleted: not a person's own config, not a valid envelope kept elsewhere, not one that sits deeper or
// shallower in the overlays folder than the CLI writes.
test("the server leaves alone every file it was pointed at that the CLI did not write", async () => {
  await fs.mkdir(overlays, { recursive: true })
  const folder = await fs.mkdtemp(path.join(overlays, "overlay-"))
  const envelope = JSON.stringify({ version: 1, content: "{}" })
  const survivors = [
    ["a config of the person's in the project folder", path.join(root, "my-config.json"), '{"model":"a/b"}'],
    ["a valid envelope outside the overlays folder", path.join(root, "envelope.json"), envelope],
    ["a file in the overlay folder that is not an envelope", path.join(folder, "mine.json"), '{"model":"a/b"}'],
    ["a valid envelope straight in the overlays folder", path.join(overlays, "loose.json"), envelope],
    ["a valid envelope in a folder with another name", path.join(root, "overlay-x", "e.json"), envelope],
    ["a file that is not a json file", path.join(folder, "e.txt"), envelope],
  ] as const
  try {
    for (const [name, file, text] of survivors) {
      await Bun.write(file, text)
      await expect(ConfigOverlay.consume(file)).rejects.toThrow("version 1 overlay")
      expect({ name, kept: await Bun.file(file).text() }).toEqual({ name, kept: text })
    }
  } finally {
    await fs.rm(folder, { recursive: true, force: true })
    await fs.rm(path.join(overlays, "loose.json"), { force: true })
  }
})

test("a folder left by a run that died is swept, a fresh one is not", async () => {
  await fs.mkdir(overlays, { recursive: true })
  const stale = await fs.mkdtemp(path.join(overlays, "overlay-"))
  const fresh = await fs.mkdtemp(path.join(overlays, "overlay-"))
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
  registered: boolean | "dead"
  /** The service is registered but its health check fails, as when it is starting or stuck. */
  broken?: boolean
  fork?: boolean
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
        : input.broken
          ? new Response("stuck", { status: 500 })
          : Response.json({ version: ORBIT_VERSION, pid: process.pid, urls: [] }),
  })
  const priv = Bun.serve({
    port: 0,
    fetch: (request) =>
      new URL(request.url).pathname === "/api/location"
        ? Response.json({ directory: root })
        : Response.json({
            data: input.newest ? [{ id: input.newest, location: { directory: root } }] : [],
            cursor: {},
          }),
  })
  try {
    if (input.registered) {
      await fs.mkdir(path.join(state, "state"), { recursive: true })
      await Bun.write(
        path.join(state, "state", ServiceConfig.filename()),
        JSON.stringify({
          id: "overlay-guard",
          version: ORBIT_VERSION,
          url: service.url.toString(),
          pid: input.registered === "dead" ? await deadPid() : process.pid,
        }),
      )
    }
    const layer = Global.layerWith({ config: path.join(state, "config"), state: path.join(state, "state") })
    return await Effect.runPromise(
      ConfigOverlay.refuseActive({
        client: Orbit.make({ baseUrl: priv.url.toString() }),
        session: input.session,
        continue: input.continue ?? false,
        fork: input.fork,
        directory: root,
      }).pipe(
        Effect.map((target) => `allowed ${target ?? ""}`.trim()),
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

// The ID of a process that has exited, so nothing alive answers to it.
async function deadPid() {
  const child = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore", stderr: "ignore" })
  await child.exited
  return child.pid
}

const running = (id: string) => () => Response.json({ data: { [id]: { type: "running" } } })

test.each<[string, Omit<Parameters<typeof guarded>[0], "registered"> & { registered?: boolean | "dead" }, string]>([
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
    "--continue with a fork, which copies the session and never drains it",
    { continue: true, fork: true, newest: "ses_busy", active: running("ses_busy") },
    "allowed ses_busy",
  ],
  [
    "a registered service that is alive but whose health check fails",
    { session: "ses_busy", broken: true, active: running("ses_busy") },
    "Could not ask the background service",
  ],
  [
    "a registered service whose process has exited",
    { registered: "dead", broken: true, session: "ses_busy", active: running("ses_busy") },
    "allowed ses_busy",
  ],
  [
    "a service that cannot answer",
    { session: "ses_busy", active: () => new Response("no", { status: 500 }) },
    "Could not ask the background service",
  ],
])("the private server shares no session with the background service: %s", async (_, input, expected) => {
  const result = await guarded({ registered: true, ...input })

  expect(result).toContain(expected)
})

test("an agent's rules in a flag add to the inherited rules of the same agent, and never replace them", async () => {
  const deny = { action: "bash", resource: "*", effect: "deny" }
  const allow = { action: "read", resource: "*", effect: "allow" }

  const merged = await built({
    inherited: JSON.stringify({ agents: { helper: { permissions: [deny], system: "inherited" } } }),
    agents: JSON.stringify({ helper: { permissions: [allow] }, other: { permissions: [allow] } }),
  })

  expect(merged.agents.helper).toEqual({ permissions: [deny, allow], system: "inherited" })
  expect(merged.agents.other.permissions).toEqual([allow])
})

test("a value is a file when the file exists, whatever it starts with, and inline JSONC may start with a comment", async () => {
  const inline = await built({
    agents: '// the helper\n{"helper": {"system": "from a comment"}}',
  })
  await fs.mkdir(path.join(root, "comment"), { recursive: true })
  await Bun.write(path.join(root, "comment", "agents.json"), '/* kept */ {"filed": {"system": "from a file"}}')

  const filed = await built({ agents: path.join("comment", "agents.json") })

  expect(inline.agents.helper.system).toBe("from a comment")
  expect(filed.agents.filed.system).toBe("from a file")
})

test("a file over the cap is refused from its size, before it is read", async () => {
  const big = path.join(root, "huge.json")
  await Bun.write(big, " ".repeat(ConfigOverlay.MAX_BYTES + 1))

  const message = await refused({ agents: big })

  expect(message).toContain("--agents: ")
  expect(message).toContain(
    `is ${ConfigOverlay.MAX_BYTES + 1} bytes; the most one run takes is ${ConfigOverlay.MAX_BYTES}`,
  )
})

// Errors echo what the value said: the value itself, and keys from inside it. Neither may reach a terminal raw.
test.each([
  ["a key of an agent", { agents: JSON.stringify({ "bad\u001b[31mkey": { steps: 0 } }) }],
  ["an unknown field name", { agents: JSON.stringify({ helper: { "bad\u001b]0;title\u0007field": 1 } }) }],
  ["an unknown server field", { mcpConfig: [JSON.stringify({ servers: { a: server({ "bad\u202efield": 1 }) } })] }],
  ["a value that is not a file", { agents: "bad\u001b[2Jvalue" }],
])("control characters in %s are written out in the error", async (_, input) => {
  const message = await refused(input)

  expect(message.length).toBeGreaterThan(0)
  expect(message).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f\u202e]/)
})

test("a run with no flag drops an inherited ORBIT_CONFIG_CONTENT_FILE, and a run with a flag replaces it", async () => {
  const before = process.env.ORBIT_CONFIG_CONTENT_FILE
  try {
    process.env.ORBIT_CONFIG_CONTENT_FILE = path.join(root, "someones-own.json")
    await Effect.runPromise(ConfigOverlay.apply({ mcpConfig: [], server: undefined }).pipe(Effect.scoped))
    expect(process.env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()

    process.env.ORBIT_CONFIG_CONTENT_FILE = path.join(root, "someones-own.json")
    const inside = await Effect.runPromise(
      ConfigOverlay.apply({ mcpConfig: [], agents: "{}", server: undefined }).pipe(
        Effect.flatMap(() => Effect.sync(() => process.env.ORBIT_CONFIG_CONTENT_FILE)),
        Effect.scoped,
      ),
    )
    expect(inside).not.toBe(path.join(root, "someones-own.json"))
    expect(path.dirname(path.dirname(inside!))).toBe(overlays)
    expect(process.env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
  } finally {
    if (before === undefined) delete process.env.ORBIT_CONFIG_CONTENT_FILE
    else process.env.ORBIT_CONFIG_CONTENT_FILE = before
  }
})

// Core resolves a relative {file:} against the folder it opens, which may be a clone. Every value the person wrote
// means the folder of the file that holds it, or the start folder for an inline value; ~/ and absolute stay as typed.
test.each([
  ["an agent's system, from a file", "agents", "file"],
  ["an agent's system, inline", "agents", "inline"],
  ["an MCP server's environment, from a file", "mcp", "file"],
  ["an MCP server's environment, inline", "mcp", "inline"],
])("a relative {file:} in %s is taken from the folder the person's value is in", async (_, flag, form) => {
  const where = path.join(root, `anchor-${flag}-${form}`, "home", "sub")
  await fs.mkdir(where, { recursive: true })
  const document =
    flag === "agents"
      ? JSON.stringify({ a: { system: "{file:./prompt.md}", description: "{file:~/x.md}" } })
      : JSON.stringify({
          servers: {
            s: { type: "local", command: ["fx"], environment: { K: "{file:../prompt.md}", L: "{file:/abs/p.md}" } },
          },
        })
  const value = form === "file" ? path.join(where, "v.json") : document
  if (form === "file") await Bun.write(value, document)

  const content = await ConfigOverlay.build({
    mcpConfig: flag === "mcp" ? [value] : [],
    agents: flag === "agents" ? value : undefined,
    cwd: form === "file" ? path.join(root, "elsewhere") : where,
  })

  const parsed = JSON.parse(content!)
  const resolved =
    flag === "agents"
      ? [parsed.agents.a.system, parsed.agents.a.description]
      : [parsed.mcp.servers.s.environment.K, parsed.mcp.servers.s.environment.L]
  const expected = flag === "agents" ? path.join(where, "prompt.md") : path.join(path.dirname(where), "prompt.md")
  expect(path.normalize(resolved[0].replace(/^\{file:|\}$/g, ""))).toBe(path.normalize(expected))
  expect(resolved[1]).toBe(flag === "agents" ? "{file:~/x.md}" : "{file:/abs/p.md}")
})

test("release removes the variable and the run's folder, and leaves a file that is not the CLI's", async () => {
  const before = process.env.ORBIT_CONFIG_CONTENT_FILE
  try {
    const written = await ConfigOverlay.write("{}")
    process.env.ORBIT_CONFIG_CONTENT_FILE = written.file
    await ConfigOverlay.release()
    expect(process.env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
    expect(await fs.stat(path.dirname(written.file)).catch(() => undefined)).toBeUndefined()

    const own = path.join(root, "release-own", "mine.json")
    await Bun.write(own, "{}")
    process.env.ORBIT_CONFIG_CONTENT_FILE = own
    await ConfigOverlay.release()
    expect(process.env.ORBIT_CONFIG_CONTENT_FILE).toBeUndefined()
    expect(await Bun.file(own).exists()).toBe(true)
  } finally {
    if (before === undefined) delete process.env.ORBIT_CONFIG_CONTENT_FILE
    else process.env.ORBIT_CONFIG_CONTENT_FILE = before
  }
})

test("the overlay folder is in no folder that agents may write without asking", async () => {
  const written = await ConfigOverlay.write("{}")
  try {
    for (const allowed of [Global.Path.tmp, Global.Path.data, Global.Path.config]) {
      const relative = path.relative(allowed, written.file)
      expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true)
    }
  } finally {
    await written.remove()
  }
})
