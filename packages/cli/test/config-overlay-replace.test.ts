import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ConfigOverlay } from "../src/config-overlay"

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-overlay-replace-")))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const server = (extra: object = {}) => ({ type: "local", command: ["fx"], ...extra })

async function built(input: Partial<Parameters<typeof ConfigOverlay.build>[0]>) {
  const result = await ConfigOverlay.build({ mcpConfig: [], cwd: root, ...input })
  return result?.content === undefined ? undefined : JSON.parse(result.content)
}

// A same-named entry is replaced whole by a later layer (class 8: a credential must not follow a name to another
// host). Rows: url, headers, command and environment.
test.each([
  {
    name: "inherited remote with headers, then a flag with another url",
    inherited: {
      mcp: { servers: { x: { type: "remote", url: "https://a.example", headers: { Authorization: "Bearer a" } } } },
    },
    mcpConfig: [{ servers: { x: { type: "remote", url: "https://b.example" } } }],
    expected: { type: "remote", url: "https://b.example" },
  },
  {
    name: "two --mcp-config values, local with environment then remote",
    mcpConfig: [
      { servers: { x: { type: "local", command: ["fx"], environment: { TOKEN: "secret" } } } },
      { servers: { x: { type: "remote", url: "https://b.example" } } },
    ],
    expected: { type: "remote", url: "https://b.example" },
  },
  {
    name: "two --mcp-config values, remote with headers then another remote",
    mcpConfig: [
      { servers: { x: { type: "remote", url: "https://a.example", headers: { Authorization: "Bearer a" } } } },
      { servers: { x: { type: "remote", url: "https://b.example" } } },
    ],
    expected: { type: "remote", url: "https://b.example" },
  },
  {
    name: "inline --settings, then --mcp-config with a new command",
    settings: { mcp: { servers: { x: { type: "local", command: ["old"], environment: { TOKEN: "secret" } } } } },
    mcpConfig: [{ servers: { x: { type: "local", command: ["new"] } } }],
    expected: { type: "local", command: ["new"] },
  },
])("an mcp server is replaced whole: $name", async (row) => {
  const merged = await built({
    inherited: "inherited" in row ? JSON.stringify(row.inherited) : undefined,
    settings: "settings" in row ? [JSON.stringify(row.settings)] : undefined,
    mcpConfig: row.mcpConfig.map((value) => JSON.stringify(value)),
  })
  expect(merged.mcp.servers.x).toEqual(row.expected)
})

test("servers with other names stay, and agents still merge by key", async () => {
  const merged = await built({
    inherited: JSON.stringify({
      mcp: { servers: { x: server({ environment: { A: "1" } }), y: server() } },
      agents: { helper: { system: "inherited", description: "kept" } },
    }),
    mcpConfig: [JSON.stringify({ servers: { x: server() } })],
    agents: JSON.stringify({ helper: { system: "flag" } }),
  })
  expect(merged.mcp.servers.x).toEqual(server())
  expect(Object.keys(merged.mcp.servers).sort()).toEqual(["x", "y"])
  expect(merged.agents.helper).toEqual({ system: "flag", description: "kept" })
})

test.each([
  { name: "empty", values: [""], real: false },
  { name: "blank", values: ["   "], real: false },
  { name: "empty beside a real value", values: ["", JSON.stringify({ servers: { real: server() } })], real: true },
])("an $name --mcp-config value is skipped", async (row) => {
  const result = await ConfigOverlay.build({ mcpConfig: row.values, cwd: root })
  expect(result === undefined ? undefined : Object.keys(JSON.parse(result.content!).mcp.servers)).toEqual(
    row.real ? ["real"] : undefined,
  )
  expect(result?.named ?? false).toBe(row.real)
})

test.each(["", "  \t"])("an empty --agents value %j is skipped, and alone it starts nothing", async (agents) => {
  expect(await ConfigOverlay.build({ mcpConfig: [], agents, cwd: root })).toBeUndefined()
  expect(ConfigOverlay.given({ mcpConfig: [""], agents })).toEqual([])
  const merged = await built({ agents, mcpConfig: [JSON.stringify({ servers: { real: server() } })] })
  expect(merged.agents).toBeUndefined()
})

test("--settings that names MCP servers counts as naming them, inline or from a file", async () => {
  await Bun.write(path.join(root, "named-settings.json"), JSON.stringify({ mcp: { servers: { s: server() } } }))
  await Bun.write(path.join(root, "unnamed-settings.json"), JSON.stringify({ mcp: { servers: {} }, model: "a/b" }))
  const named = async (settings: string) => (await ConfigOverlay.build({ settings: [settings], cwd: root }))?.named
  expect(await named(JSON.stringify({ mcp: { servers: { s: server() } } }))).toBe(true)
  expect(await named("named-settings.json")).toBe(true)
  expect(await named(JSON.stringify({ model: "a/b" }))).toBe(false)
  expect(await named(JSON.stringify({ mcp: { servers: {} } }))).toBe(false)
  expect(await named("unnamed-settings.json")).toBe(false)
})
