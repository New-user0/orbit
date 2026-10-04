import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// A local Ollama stand-in whose server runs the model with a 4k window, far below what an agent turn needs.
const discovery = { delay: 0 }
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags") await Bun.sleep(discovery.delay)
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          {
            name: "qwen3.8:27b",
            model: "qwen3.8:27b",
            modified_at: "2026-01-01T00:00:00Z",
            size: 1,
            digest: "digest",
            details: {
              format: "gguf",
              family: "qwen3",
              families: ["qwen3"],
              parameter_size: "27B",
              quantization_level: "Q4_K_M",
            },
          },
        ],
      })
    if (pathname === "/api/show")
      return Response.json({
        parameters: "temperature 0.7",
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "qwen3", "qwen3.context_length": 262_144 },
        details: {
          parent_model: "",
          format: "gguf",
          family: "qwen3",
          families: ["qwen3"],
          parameter_size: "27B",
          quantization_level: "Q4_K_M",
        },
      })
    if (pathname === "/api/ps") return Response.json({ models: [{ name: "qwen3.8:27b", context_length: 4096 }] })
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-ollama-"))

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("orb doctor warns when Ollama serves a context window too small for the agent", async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
  const child = Bun.spawn(
    [process.execPath, "run", "src/index.ts", "doctor", "--standalone", "--model", "ollama/qwen3.8:27b"],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, {
        USERPROFILE: root,
        ORBIT_CONFIG: undefined,
        ORBIT_CONFIG_CONTENT: undefined,
        OLLAMA_CONTEXT_LENGTH: undefined,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])

  expect(stdout).toMatch(/ok ollama\/qwen3\.8:27b\s+\d+ ms: ok/)
  expect(stdout).toMatch(/!! ollama context\s+qwen3\.8:27b: 4096 tokens; .*OLLAMA_CONTEXT_LENGTH=32768/)
  expect(code).toBe(1)
}, 120_000)

test("orb models waits for Ollama models that a fresh server has not discovered yet", async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
  discovery.delay = 700
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "models", "--standalone"], {
    cwd: path.join(import.meta.dir, ".."),
    env: isolatedEnv(root, { USERPROFILE: root, ORBIT_CONFIG: undefined, ORBIT_CONFIG_CONTENT: undefined }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()])
  discovery.delay = 0

  expect(code).toBe(0)
  expect(stdout.split("\n")).toContain("ollama/qwen3.8:27b")
}, 60_000)
