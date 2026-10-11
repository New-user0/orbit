import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Orbit must only talk to the model provider it is configured with. Every proxy variable points at a trap that
// records each connection attempt; only loopback (the configured mock model and the local server) is exempt.
// A trapped attempt fails the test.
const idle = Number(process.env.ORBIT_EGRESS_IDLE_MS ?? 5_000)
const attempts: string[] = []
const requests: unknown[] = []
const script = { search: false }
const trap = net.createServer((socket) => {
  socket.once("data", (chunk) => {
    attempts.push(chunk.toString("latin1").split("\r\n")[0] ?? "")
    socket.destroy()
  })
})
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
      return new Response("Not found", { status: 404 })
    const body = await request.json().catch(() => undefined)
    requests.push(body)
    // A test that arms the script gets a WebSearch call as the answer to its first request.
    const text = script.search && offersSearch(body) && !hasToolResult(body) ? searchCall() : completion("ok")
    return new Response(text, { headers: { "content-type": "text/event-stream" } })
  },
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-egress-"))

beforeAll(async () => {
  await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve))
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.mkdir(path.join(root, "workspace"), { recursive: true })
  await Bun.write(path.join(root, "config", "orbit.json"), JSON.stringify(config()))
})

beforeEach(() => {
  attempts.length = 0
  requests.length = 0
})

afterAll(async () => {
  trap.close()
  await llm.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test(
  "a headless run reaches only the configured model",
  async () => {
    const child = spawn(["run", "--standalone", "--model", "test/test-model", "Reply with ok"])
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
    expect(requests.length).toBeGreaterThan(0)
    expect(attempts).toEqual([])
  },
  120_000,
)

// Web search sends the query to a third-party provider, so only a person can agree to it. Headless runs cancel the
// consent form, whatever the permission flag says, and an untrusted folder cannot select a provider for itself.
// The controls below select a provider in a trusted folder and must reach the trap, so a quiet trap in the other rows
// means the provider did not run.
const searchFlags = [[], ["--auto"], ["--dangerously-skip-permissions"]]
searchFlags.forEach((flags) => {
  test(
    `a headless run${flags.length ? ` with ${flags.join(" ")}` : ""} cannot search the web without consent`,
    async () => {
      const workspace = await fresh("trusted")
      const result = await run(workspace, flags, { ORBIT_TRUST_PROJECT: "1" })
      expect(result.stderr).not.toContain("is not trusted")
      expect(requests.length).toBeGreaterThanOrEqual(2)
      // The tool was offered, called and refused, so a missing attempt below is not because the call never happened.
      expect(requests.some((request) => offersSearch(request))).toBe(true)
      expect(requests.some((request) => JSON.stringify(request).includes("Web search is not enabled"))).toBe(true)
      expect(attempts).toEqual([])
      expect(consent({ databaseExists: true })).toBeUndefined()
    },
    120_000,
  )
})

// Stream input hands asks to a program, but the search consent is not one it may answer: the form is cancelled and
// never written as a form_request line.
test(
  "a stream-json input run cannot search the web without consent, and does not offer the form to its controller",
  async () => {
    const workspace = await fresh("stream-input")
    requests.length = 0
    attempts.length = 0
    script.search = true
    try {
      const child = spawn(
        [
          "-p",
          "--standalone",
          "--model",
          "test/test-model",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "Search the web",
        ],
        { PWD: workspace, ORBIT_TRUST_PROJECT: "1" },
        "pipe",
      )
      // The controller stays connected until the run has its result, so an ask that was offered to it would wait for it.
      const stdoutText = new Response(child.stdout).text()
      const seen = (async () => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const text = await Promise.race([stdoutText, Bun.sleep(200).then(() => undefined)])
          if (text !== undefined) return
          if (requests.some((request) => JSON.stringify(request).includes("Web search is not enabled"))) return
        }
      })()
      await seen
      await Bun.sleep(1_000)
      child.stdin?.end()
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        stdoutText,
        new Response(child.stderr).text(),
      ])
      expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
      const lines = stdout
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as { type: string })
      expect(lines.some((line) => line.type === "form_request")).toBe(false)
      expect(lines.at(-1)?.type).toBe("result")
      expect(requests.some((request) => offersSearch(request))).toBe(true)
      expect(requests.some((request) => JSON.stringify(request).includes("Web search is not enabled"))).toBe(true)
      expect(attempts).toEqual([])
      expect(consent({ databaseExists: true })).toBeUndefined()
    } finally {
      script.search = false
    }
  },
  120_000,
)

const controls = [
  ["firecrawl", "mcp.firecrawl.dev:443"],
  ["parallel", "search.parallel.ai:443"],
]
controls.forEach(([provider, host]) => {
  test(
    `control: a trusted folder that selects ${provider} reaches ${host}`,
    async () => {
      const workspace = await fresh(`control-${provider}`, { websearch: { provider } })
      await run(workspace, [], { ORBIT_TRUST_PROJECT: "1" })
      expect(attempts.some((attempt) => attempt.includes(host))).toBe(true)
    },
    120_000,
  )
})

test(
  "an untrusted repository that selects a search provider is refused before any work",
  async () => {
    const workspace = await fresh("untrusted", { websearch: { provider: "random" } })
    const result = await run(workspace, [], {})
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("is not trusted")
    expect(result.stderr).toContain("orbit.json")
    expect(result.stderr).toContain("network")
    expect(requests).toEqual([])
    expect(attempts).toEqual([])
    // The run stops at requireTrust, so the file may not exist yet, or may hold an earlier row's data.
    expect(consent({ databaseExists: false })).toBeUndefined()
  },
  120_000,
)

test(
  "control C1: a provider selected in the user's own config reaches the search service",
  async () => {
    const file = path.join(root, "config", "orbit.json")
    const original = await Bun.file(file).text()
    await Bun.write(file, JSON.stringify({ ...config(), websearch: { provider: "random" } }))
    try {
      await run(await fresh("control-user"), [], { ORBIT_TRUST_PROJECT: "1" })
    } finally {
      await Bun.write(file, original)
    }
    // "random" picks one keyless provider per query and a dropped connection does not fall over to another, so any
    // of their hosts counts as reaching the search service.
    const hosts = ["mcp.exa.ai", "mcp.firecrawl.dev", "search.parallel.ai", "api.tavily.com", "agent.tinyfish.ai"]
    expect(attempts.some((attempt) => hosts.some((host) => attempt.includes(`${host}:443`)))).toBe(true)
  },
  120_000,
)

test(
  "control C2: --trust on a repository that selects firecrawl is the user's grant, so the selection applies",
  async () => {
    const workspace = await fresh("control-trust", { websearch: { provider: "firecrawl" } })
    const result = await run(workspace, ["--trust"], {})
    expect(result.code).toBe(0)
    expect(attempts.some((attempt) => attempt.includes("mcp.firecrawl.dev:443"))).toBe(true)
  },
  120_000,
)

test(
  "an idle server makes no outbound connections",
  async () => {
    const child = spawn(["serve", "--port", "0"])
    await Bun.sleep(idle)
    child.kill()
    await child.exited
    expect(attempts).toEqual([])
  },
  idle + 60_000,
)

// A git repository of its own, with the given project config; the run's folder comes from PWD.
async function fresh(name: string, project?: object) {
  const directory = path.join(root, "work", name)
  await fs.mkdir(directory, { recursive: true })
  expect(Bun.spawnSync(["git", "init", "--quiet", directory]).exitCode).toBe(0)
  if (project) await Bun.write(path.join(directory, "orbit.json"), JSON.stringify(project))
  return directory
}

async function run(directory: string, flags: string[], env: Record<string, string | undefined>) {
  requests.length = 0
  attempts.length = 0
  script.search = true
  try {
    const child = spawn(["run", "--standalone", "--model", "test/test-model", ...flags, "Search the web"], {
      PWD: directory,
      ORBIT_TRUST_PROJECT: undefined,
      ...env,
    })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    return { code, stderr }
  } finally {
    script.search = false
  }
}

function toolNames(request: unknown) {
  const tools = (request as { tools?: { function?: { name?: string } }[] } | undefined)?.tools ?? []
  return tools.map((tool) => tool.function?.name)
}

// The consent value, read straight from the database the run used.
// A query error fails the test. A missing file is accepted only where the run may stop before it opens the database.
function consent(options: { databaseExists: boolean }) {
  const file = path.join(root, "orbit.db")
  if (options.databaseExists) expect(existsSync(file)).toBe(true)
  if (!existsSync(file)) return undefined
  const db = new Database(file, { readonly: true })
  try {
    return (db.query("select value from kv where key = 'websearch:provider'").get() as { value: string } | null)?.value
  } finally {
    db.close()
  }
}

function searchCall() {
  const call = { index: 0, id: "call_search", type: "function", function: { name: "WebSearch", arguments: JSON.stringify({ query: "orbit release notes" }) } }
  const chunks = [
    { choices: [{ delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }], usage: null },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
}

function spawn(
  args: string[],
  overrides: Record<string, string | undefined> = {},
  stdin: "ignore" | "pipe" = "ignore",
) {
  const proxy = `http://127.0.0.1:${(trap.address() as net.AddressInfo).port}`
  return Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      // Exercise the real defaults rather than the test environment's opt-outs.
      ORBIT_DISABLE_MODELS_FETCH: undefined,
      ORBIT_DISABLE_AUTOUPDATE: undefined,
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      // Loopback covers the configured model and the CLI's own local server; everything else is trapped.
      NO_PROXY: "127.0.0.1,localhost,::1",
      // On Windows, passing both spellings of a variable drops them from the CLI's environment, and the server it
      // starts then connects directly. One spelling per variable there keeps the trap in the path.
      ...(process.platform === "win32"
        ? {}
        : { http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, no_proxy: "127.0.0.1,localhost,::1" }),
      ...overrides,
    }),
    stdin,
    stdout: "pipe",
    stderr: "pipe",
  })
}

function config() {
  const model = {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: { input: 0, output: 0 },
    limit: { context: 100_000, output: 10_000 },
  }
  return {
    model: "test/test-model",
    providers: {
      test: {
        name: "Test",
        package: "aisdk:@ai-sdk/openai-compatible",
        settings: { apiKey: "test-key", baseURL: `http://127.0.0.1:${llm.port}/v1` },
        models: { "test-model": { ...model, name: "Test Model" } },
      },
    },
  }
}

function completion(text: string) {
  const chunks = [
    { choices: [{ delta: { role: "assistant" }, finish_reason: null }], usage: null },
    { choices: [{ delta: { content: text }, finish_reason: null }], usage: null },
    { choices: [{ delta: {}, finish_reason: "stop" }], usage: null },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
  ]
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`
}

function offersSearch(request: unknown) {
  return toolNames(request).includes("WebSearch")
}

function hasToolResult(request: unknown) {
  return ((request as { messages?: { role?: string }[] } | undefined)?.messages ?? []).some((message) => message.role === "tool")
}
