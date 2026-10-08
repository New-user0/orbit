import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Headless runs against a local Tachyon stand-in, configured only through the TACHYON_* variables the Python SDK
// reads. The first agent step answers 401, which must trigger one fresh token exchange and a retry.
const tlsFixture = (name: string) => path.join(import.meta.dir, "..", "..", "util", "test", "fixture", "tls", name)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-tachyon-"))
const servers: Array<ReturnType<typeof Bun.serve>> = []

beforeAll(async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      model: "tachyon/claude-opus-4-5@20251101",
      providers: {
        tachyon: {
          name: "Tachyon",
          package: "@orbit/ai/providers/tachyon",
          models: {
            "claude-opus-4-5@20251101": {
              name: "Claude Opus 4.5",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0 },
              limit: { context: 200_000, output: 32_000 },
            },
          },
        },
      },
    }),
  )
})

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop(true)))
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("a headless run reaches Tachyon with the gateway headers and recovers from a 401", async () => {
  const mock = gateway()
  const result = await run(`http://127.0.0.1:${mock.server.port}`)

  expect({ code: result.code, stderr: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, stderr: "" })
  expect(result.stdout).toContain("ok")
  const steps = mock.calls.filter((call) => call.path === "/v1/chat/completions" && "tools" in JSON.parse(call.body))
  expect(steps).toHaveLength(2)
  expect(mock.calls.filter((call) => call.path === "/oauth/token")).toHaveLength(2)
  const [first, second] = steps
  expect(first?.headers.get("authorization")).toBe("Bearer token-1")
  expect(second?.headers.get("authorization")).toBe("Bearer token-2")
  expect(second?.headers.get("x-wf-api-key")).toBe("api-key")
  expect(second?.headers.get("x-wf-usecase-id")).toBe("usecase")
  const body = JSON.parse(second?.body ?? "{}")
  expect(body.model).toBe("claude-opus-4-5@20251101")
  expect(body).not.toHaveProperty("max_completion_tokens")
}, 120_000)

test("orb doctor reports Tachyon settings by name and probes the configured model", async () => {
  const mock = gateway({ rejectFirstStep: false })
  const origin = `http://127.0.0.1:${mock.server.port}`
  const local = await run(origin, {}, ["doctor"])
  expect(local.stdout).toMatch(/ok tachyon\s+set: TACHYON_CHAT_COMPLETION_BASE_URL/)
  expect(local.stdout).toMatch(/ok git\s+\S*git/)
  expect(local.stdout).not.toContain("api-key")
  expect(mock.calls).toEqual([])

  const probed = await run(origin, {}, ["doctor", "--standalone", "--model", "tachyon/claude-opus-4-5@20251101"])
  expect(probed.stdout).toMatch(/ok tachyon\/claude-opus-4-5@20251101\s+\d+ ms: ok/)
}, 120_000)

test("a gateway behind a private CA is reachable only once ORBIT_CA_CERTS trusts it", async () => {
  const mock = gateway({
    tls: {
      cert: await Bun.file(tlsFixture("server.pem")).text(),
      key: await Bun.file(tlsFixture("server.key")).text(),
    },
  })
  const origin = `https://127.0.0.1:${mock.server.port}`

  const started = Date.now()
  const untrusted = await run(origin)
  expect(untrusted.code).not.toBe(0)
  expect(untrusted.stderr).toMatch(/certificate/i)
  // The retry schedule runs for minutes; a failed certificate check must stop on the first attempt.
  expect(Date.now() - started).toBeLessThan(60_000)
  expect(mock.calls).toEqual([])

  const trusted = await run(origin, { ORBIT_CA_CERTS: tlsFixture("ca.pem") })
  expect({ code: trusted.code, stderr: trusted.code === 0 ? "" : trusted.stderr }).toEqual({ code: 0, stderr: "" })
  expect(mock.calls.some((call) => call.path === "/oauth/token")).toBe(true)
  expect(mock.calls.some((call) => call.path === "/v1/chat/completions")).toBe(true)
}, 120_000)

function gateway(options: { tls?: { cert: string; key: string }; rejectFirstStep?: boolean } = {}) {
  const calls: Array<{ path: string; headers: Headers; body: string }> = []
  const state = { tokens: 0, steps: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    ...(options.tls ? { tls: options.tls } : {}),
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const body = await request.text()
      calls.push({ path: pathname, headers: request.headers, body })
      if (pathname === "/oauth/token") {
        state.tokens++
        return Response.json({ token_type: "Bearer", access_token: `token-${state.tokens}`, expires_in: 86399 })
      }
      // Only the agent step carries tools; the session-title request does not, and its failures are not surfaced.
      if (options.rejectFirstStep !== false && "tools" in JSON.parse(body) && ++state.steps === 1)
        return Response.json({ errors: [{ code: "F-EAPIM-IGTWY-E40100", title: "Unauthorized" }] }, { status: 401 })
      const chunks = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } },
      ]
      return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  servers.push(server)
  return { server, calls }
}

const prompt = ["run", "--standalone", "--model", "tachyon/claude-opus-4-5@20251101", "Reply with ok"]

async function run(origin: string, env: Record<string, string> = {}, args = prompt) {
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, {
      USERPROFILE: root,
      ORBIT_CONFIG: undefined,
      ORBIT_CONFIG_CONTENT: undefined,
      // The default trust store must not include the private test CA from the environment either.
      NODE_EXTRA_CA_CERTS: undefined,
      ORBIT_CA_CERTS: undefined,
      TACHYON_CERT_PATH: undefined,
      TACHYON_CERT_B64: undefined,
      TACHYON_CHAT_COMPLETION_BASE_URL: `${origin}/v1`,
      TACHYON_APIGEE_URL: `${origin}/oauth/token`,
      TACHYON_CONSUMER_KEY: "consumer",
      TACHYON_CONSUMER_SECRET: "secret",
      TACHYON_API_KEY: "api-key",
      TACHYON_USECASE_ID: "usecase",
      TACHYON_USE_API_GATEWAY: undefined,
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
