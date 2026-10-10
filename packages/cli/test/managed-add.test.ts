import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-managed-add-"))
const managed = path.join(root, "managed")
await Bun.write(
  path.join(managed, "managed-settings.json"),
  JSON.stringify({ managed: { mcp: { deny: ["blocked"] }, plugins: { block: ["@corp/blocked"] } } }),
)

// A registry that records every request, so "never contacted" is something the test can see.
const requests: string[] = []
const registry = Bun.serve({
  port: 0,
  fetch(request) {
    requests.push(new URL(request.url).pathname)
    return new Response("{}", { status: 404 })
  },
})

afterAll(async () => {
  await registry.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

// A second organization whose allow list names one server, so an unlisted one is refused for not being on it.
const allowing = path.join(root, "allowing")
await Bun.write(
  path.join(allowing, "managed-settings.json"),
  JSON.stringify({ managed: { mcp: { allow: [{ serverName: "listed" }] } } }),
)

async function orb(...args: string[]) {
  return run(managed, args)
}

async function run(directory: string, args: string[]) {
  const child = Bun.spawn([process.execPath, "run", path.join(import.meta.dir, "../src/index.ts"), ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      ORBIT_MANAGED_DIR: directory,
      npm_config_registry: `http://127.0.0.1:${registry.port}/`,
    }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode }
}

const configured = async () =>
  (await Bun.file(path.join(root, "config", "orbit.json")).text().catch(() => "")) as string

describe("orb mcp add under managed settings", () => {
  test("refuses a server the organization denies and writes nothing", async () => {
    const result = await orb("mcp", "add", "--global", "blocked", "--", "node", "server.js")
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("blocked by managed settings")
    expect(await configured()).not.toContain("blocked")
  })

  test("refuses a server that is not on the allow list and writes nothing", async () => {
    const before = await configured()
    const result = await run(allowing, ["mcp", "add", "--global", "unlisted", "--", "node", "server.js"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("not on the allow list in managed settings")
    expect(await configured()).toBe(before)
  })

  test("still adds a server the lists do not touch", async () => {
    const result = await orb("mcp", "add", "--global", "fine", "--", "node", "server.js")
    expect(result.exitCode).toBe(0)
    expect(await configured()).toContain('"fine"')
  })
})

describe("orb plugin add under managed settings", () => {
  test("refuses a blocked package before the registry is contacted", async () => {
    const before = requests.length
    const result = await orb("plugin", "add", "@corp/blocked@^1")
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("blocked by managed settings")
    expect(requests.length).toBe(before)
  })

  test("contacts the registry for a package the lists do not touch", async () => {
    const before = requests.length
    await orb("plugin", "add", "@corp/fine@^1")
    expect(requests.length).toBeGreaterThan(before)
  })
})
