import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Config } from "@orbit/schema/config"
import { Effect, Schema } from "effect"
import { withEnv } from "../../core/test/fixture/env"
import { tmpdir, tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"
import { AbsolutePath } from "@orbit/schema/schema"

it.live("returns ordered config entries for the requested directory", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-config-endpoint-")))
    const global = path.join(tmp.path, "global")
    const project = path.join(tmp.path, "project")
    const config = path.join(project, "orbit.json")
    yield* Effect.promise(() =>
      Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
    )
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        JSON.stringify({
          permissions: [
            { action: "shell", resource: "*", effect: "ask" },
            { action: "shell", resource: "git status", effect: "allow" },
          ],
          mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
        }),
      ),
    )
    const server = yield* startServer(global)
    const url = new URL("/api/config", server.base)
    url.searchParams.set("location[directory]", project)
    const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
    const body: unknown = yield* Effect.promise(() => response.json())
    const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(body)

    expect(response.status).toBe(200)
    expect(Array.isArray(entries)).toBe(true)
    const document = entries.find(
      (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
    )
    expect(document?.info.permissions).toEqual([
      { action: "shell", resource: "*", effect: "ask" },
      { action: "shell", resource: "git status", effect: "allow" },
    ])
    expect(document?.path).toBe(AbsolutePath.make(config))
    // Every entry names the scope it was loaded from.
    expect(document?.scope).toBe("project")
    if (!Array.isArray(body)) throw new Error("Expected a config entry array")
    const raw = body.find((entry) => isRecord(entry) && entry["type"] === "document" && entry["path"] === config)
    if (!isRecord(raw) || !isRecord(raw["info"])) throw new Error("Expected a config document")
    expect(raw["scope"]).toBe("project")
    expect(body.filter((entry) => isRecord(entry) && entry["scope"] === undefined)).toEqual([])
    expect(raw["info"]).not.toHaveProperty("default_agent")
    expect(raw["info"]).not.toHaveProperty("model")
    const mcp = raw["info"]["mcp"]
    if (!isRecord(mcp) || !isRecord(mcp["servers"]) || !isRecord(mcp["servers"]["docs"]))
      throw new Error("Expected an MCP server config")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("headers")
    expect(mcp["servers"]["docs"]).not.toHaveProperty("oauth")
  }),
)

for (const scenario of [
  { name: "withholds a project's executable config on a server with implicit trust off", trust: { implicit: false } },
  { name: "applies a project's executable config on a server with implicit trust on", trust: { implicit: true } },
  // The variable is for `orb` to read, for the servers it starts. A host that leaves the option unset trusts nothing.
  {
    name: "withholds a project's executable config on a server that leaves implicit trust unset, whatever the environment says",
    trust: {},
    environment: "1",
  },
]) {
  const implicit = scenario.trust.implicit === true
  it.live(scenario.name, () =>
    withEnv({ ORBIT_TRUST_PROJECT: scenario.environment }, () =>
      Effect.gen(function* () {
        const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-config-trust-")))
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const config = path.join(project, "orbit.json")
        yield* Effect.promise(() =>
          Promise.all([fs.mkdir(global, { recursive: true }), fs.mkdir(project, { recursive: true })]),
        )
        yield* Effect.promise(() =>
          fs.writeFile(
            config,
            JSON.stringify({
              username: "dev",
              permissions: [
                { action: "shell", resource: "*", effect: "allow" },
                { action: "shell", resource: "rm *", effect: "deny" },
              ],
              mcp: { servers: { docs: { type: "remote", url: "https://example.com/mcp" } } },
            }),
          ),
        )
        const server = yield* startServer(global, { trust: scenario.trust })
        const url = new URL("/api/config", server.base)
        url.searchParams.set("location[directory]", project)
        const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
        const entries = Schema.decodeUnknownSync(Schema.Array(Config.Entry))(
          yield* Effect.promise(() => response.json()),
        )
        const document = entries.find(
          (entry): entry is Config.Document => entry.type === "document" && entry.path === config,
        )

        expect(response.status).toBe(200)
        expect(document?.scope).toBe("project")
        expect(document?.info.username).toBeDefined()
        if (implicit) {
          expect(document).not.toHaveProperty("trusted")
          expect(document?.info.mcp?.servers?.docs).toBeDefined()
          expect(document?.info.permissions).toHaveLength(2)
          return
        }
        // The same file, as an untrusted server reports it: what it may not supply is gone, and the entry says so.
        expect(document?.trusted).toBe(false)
        expect(document?.withheld).toEqual(["mcp", "permissions"])
        expect(document?.info.mcp).toBeUndefined()
        expect(document?.info.permissions).toEqual([{ action: "shell", resource: "rm *", effect: "deny" }])
      }),
    ),
  )
}

it.live("updates the global shell without replacing unrelated JSONC", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("orbit-config-shells-")))
    const global = path.join(tmp.path, "global")
    const config = path.join(global, "orbit.jsonc")
    yield* Effect.promise(() => fs.mkdir(global, { recursive: true }))
    yield* Effect.promise(() =>
      fs.writeFile(
        config,
        `{
  // keep this comment
  "model": "provider/model",
  "shell": "bash"
}
`,
      ),
    )
    const server = yield* startServer(global)
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ shell: "/bin/zsh" }),
      }),
    )

    expect(response.status).toBe(204)
    const text = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(text).toContain("// keep this comment")
    expect(text).toContain('"model": "provider/model"')
    expect(text).toContain('"shell": "/bin/zsh"')

    // A patch changes only the keys it names; null removes one.
    const styled = yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ output_style: "explanatory" }),
      }),
    )
    expect(styled.status).toBe(204)
    const withStyle = yield* Effect.promise(() => fs.readFile(config, "utf8"))
    expect(withStyle).toContain('"output_style": "explanatory"')
    expect(withStyle).toContain('"shell": "/bin/zsh"')
    yield* Effect.promise(() =>
      fetch(new URL("/api/experimental/config", server.base), {
        method: "PATCH",
        headers: { ...server.headers, "content-type": "application/json" },
        body: JSON.stringify({ output_style: null }),
      }),
    )
    expect(yield* Effect.promise(() => fs.readFile(config, "utf8"))).not.toContain("output_style")

    const shells = yield* Effect.promise(() =>
      fetch(new URL("/api/config/shell", server.base), { headers: server.headers }),
    )
    expect(shells.status).toBe(200)
    expect(Array.isArray(yield* Effect.promise(() => shells.json()))).toBe(true)
  }),
)

// Sets environment variables for the rest of the test's scope, where undefined removes one.
const environment = (values: Record<string, string | undefined>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]))
      assign(values)
      return previous
    }),
    (previous) => Effect.sync(() => assign(previous)),
  )

function assign(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
}

// What the server reports as the effective configuration of a project, given the config files each scope holds. The
// home directory is a fresh one, so the developer's own ~/.orbit cannot decide the outcome.
const effective = (
  files: { user?: unknown; project?: unknown; local?: unknown } = {},
  env: Record<string, string | undefined> = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped("orbit-config-effective-")
      const home = path.join(tmp.path, "home")
      const global = path.join(tmp.path, "global")
      const project = path.join(tmp.path, "project")
      yield* Effect.promise(() =>
        Promise.all([home, global, project].map((directory) => fs.mkdir(directory, { recursive: true }))),
      )
      const write = (file: string, value: unknown) =>
        value === undefined ? Effect.void : Effect.promise(() => fs.writeFile(file, JSON.stringify(value)))
      yield* Effect.all([
        write(path.join(global, "orbit.json"), files.user),
        write(path.join(project, "orbit.json"), files.project),
        write(path.join(project, "orbit.local.json"), files.local),
      ])
      yield* environment({ ORBIT_TEST_HOME: home, ORBIT_DISABLE_COMPAT: undefined, ...env })
      const server = yield* startServer(global)
      const url = new URL("/api/config/effective", server.base)
      url.searchParams.set("location[directory]", project)
      const response = yield* Effect.promise(() => fetch(url, { headers: server.headers }))
      expect(response.status).toBe(200)
      const body: unknown = yield* Effect.promise(() => response.json())
      expect(Object.keys(isRecord(body) ? body : {})).toEqual(["compatibility"])
      return Schema.decodeUnknownSync(Config.Effective)(body)
    }),
  )

const off = { compatibility: { enabled: false } }
const on = { compatibility: { enabled: true } }

it.live("reports compatibility as on unless something that may turn it off says so", () =>
  Effect.gen(function* () {
    expect(yield* effective()).toEqual({ compatibility: true })
    expect(yield* effective({ user: on })).toEqual({ compatibility: true })
  }),
)

it.live("reports the compatibility switch the user's config sets, whatever the project says", () =>
  Effect.gen(function* () {
    expect(yield* effective({ user: off })).toEqual({ compatibility: false })
    expect(yield* effective({ user: off, project: on, local: on })).toEqual({ compatibility: false })
  }),
)

it.live("ignores a compatibility switch in the project's own files", () =>
  Effect.gen(function* () {
    expect(yield* effective({ project: off })).toEqual({ compatibility: true })
    expect(yield* effective({ local: off })).toEqual({ compatibility: true })
    expect(yield* effective({ user: on, project: off, local: off })).toEqual({ compatibility: true })
  }),
)

it.live("reports compatibility as off when the server's environment disables it", () =>
  Effect.gen(function* () {
    expect(yield* effective({}, { ORBIT_DISABLE_COMPAT: "1" })).toEqual({ compatibility: false })
    // The environment outranks a user config that turns it on.
    expect(yield* effective({ user: on }, { ORBIT_DISABLE_COMPAT: "true" })).toEqual({ compatibility: false })
  }),
)

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
