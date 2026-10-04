import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// A local Ollama model without native tool calling. Orbit describes its tools in the prompt and the model answers
// with a <tool_call> block in plain text, which must still create the file.
const agentRequests: Array<{ tools?: unknown; system: string }> = []
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    const details = {
      format: "gguf",
      family: "llama",
      families: ["llama"],
      parameter_size: "1B",
      quantization_level: "Q4_K_M",
    }
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "tiny:1b", model: "tiny:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
        ],
      })
    if (pathname === "/api/show")
      return Response.json({
        parameters: "",
        capabilities: ["completion"],
        model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
        details: { parent_model: "", ...details },
      })
    if (pathname === "/api/ps") return Response.json({ models: [] })
    const body = await request.json()
    const system = String(body.messages?.find((message: { role: string }) => message.role === "system")?.content ?? "")
    const agent = system.includes("### write")
    if (agent) agentRequests.push({ tools: body.tools, system })
    const text = !agent
      ? "Hello file"
      : agentRequests.length === 1
        ? 'Creating it.\n<tool_call>\n{"name": "write", "arguments": {"path": "hello.py", "content": "print(\\"hi\\")\\n"}}\n</tool_call>'
        : "Created hello.py."
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-text-tools-"))

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("a model without native tool calling creates a file through text tool calls", async () => {
  const workspace = path.join(root, "workspace")
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/index.ts",
      "run",
      "--standalone",
      "--auto",
      "--model",
      "ollama/tiny:1b",
      "create hello.py",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, {
        USERPROFILE: root,
        PWD: workspace,
        ORBIT_CONFIG: undefined,
        ORBIT_CONFIG_CONTENT: undefined,
        OLLAMA_CONTEXT_LENGTH: undefined,
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])

  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" })
  expect(await Bun.file(path.join(workspace, "hello.py")).text()).toBe('print("hi")\n')
  expect(stdout).toContain("Created hello.py.")
  expect(agentRequests).toHaveLength(2)
  expect(agentRequests[0]?.tools).toBeUndefined()
  expect(agentRequests[0]?.system).toContain("<tool_call>")
}, 120_000)
