import { afterAll, beforeAll, expect, test } from "bun:test"
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
    requests.push(await request.json().catch(() => undefined))
    return new Response(completion("ok"), { headers: { "content-type": "text/event-stream" } })
  },
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-egress-"))

beforeAll(async () => {
  await new Promise<void>((resolve) => trap.listen(0, "127.0.0.1", resolve))
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.mkdir(path.join(root, "workspace"), { recursive: true })
  await Bun.write(path.join(root, "config", "orbit.json"), JSON.stringify(config()))
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

function spawn(args: string[]) {
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
      http_proxy: proxy,
      https_proxy: proxy,
      ALL_PROXY: proxy,
      all_proxy: proxy,
      // Loopback covers the configured model and the CLI's own local server; everything else is trapped.
      NO_PROXY: "127.0.0.1,localhost,::1",
      no_proxy: "127.0.0.1,localhost,::1",
    }),
    stdin: "ignore",
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
