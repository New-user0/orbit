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

// A third organization that runs only the MCP servers it defines, and also denies a name, so the wording shows which wins.
const only = path.join(root, "only")
await Bun.write(
  path.join(only, "managed-settings.json"),
  JSON.stringify({ managed: { organization: "Acme", mcp: { managed_only: true, deny: ["denied"] } } }),
)

async function orb(...args: string[]) {
  return run(managed, args)
}

// Runs from a temporary folder unless told otherwise, so a project-form add can only ever write there. The package's
// bunfig preloads by name, which resolves from the folder the run starts in, so a copy with the absolute path is used.
const bunfig = path.join(root, "bunfig.toml")
await Bun.write(
  bunfig,
  `preload = [${JSON.stringify(Bun.resolveSync("@opentui/solid/preload", path.join(import.meta.dir, "..")))}]
`,
)

async function run(directory: string, args: string[], cwd = path.join(root, "project")) {
  const pkg = path.join(import.meta.dir, "..")
  await fs.mkdir(cwd, { recursive: true })
  const child = Bun.spawn([process.execPath, `--config=${bunfig}`, "run", path.join(pkg, "src/index.ts"), ...args], {
    cwd,
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
  (await Bun.file(path.join(root, "config", "orbit.json"))
    .text()
    .catch(() => "")) as string

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

describe("orb mcp add when managed settings run only their own servers", () => {
  const forms = [
    { name: "a command", args: ["--", "node", "server.js"] },
    { name: "a URL", args: ["--url", "https://example.com/mcp"] },
  ]
  for (const form of forms) {
    for (const global of [true, false]) {
      test(`refuses ${form.name} ${global ? "with --global" : "in a project"} and writes nothing`, async () => {
        const scope = global ? ["--global"] : []
        const project = path.join(root, "project", "orbit.json")
        await fs.rm(project, { force: true })
        // The control: the same command in an organization with no such rule writes the file, so the refusal below is
        // the rule and not a command that cannot write.
        const control = await run(managed, ["mcp", "add", ...scope, "fresh", ...form.args])
        expect(control.stdout + control.stderr).toContain("added to")
        expect(control.exitCode).toBe(0)
        if (!global) expect(await Bun.file(project).text()).toContain('"fresh"')
        await fs.rm(project, { force: true })
        const before = await configured()

        const result = await run(only, ["mcp", "add", ...scope, "extra", ...form.args])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout + result.stderr).toContain("Acme's managed settings allow only the MCP servers they define")
        expect(await configured()).toBe(before)
        expect(await Bun.file(project).exists()).toBe(false)
      })
    }
  }

  test("says managed-only, not denied, for a name that is also on the deny list", async () => {
    const result = await run(only, ["mcp", "add", "--global", "denied", "--", "node", "server.js"])
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout + result.stderr).toContain("allow only the MCP servers they define")
    expect(result.stdout + result.stderr).not.toContain("blocked by managed settings")
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
