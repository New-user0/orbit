import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseInterval } from "../src/commands/handlers/loop"
import { isolatedEnv } from "./fixture/environment"

// A scripted Ollama that answers every prompt with how many user messages it has seen, so repeated loop runs in one
// session show up as a growing count.
const counts: number[] = []
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "loop:1b", model: "loop:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
        ],
      })
    if (pathname === "/api/show")
      return Response.json({
        parameters: "",
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
        details: { parent_model: "", ...details },
      })
    if (pathname === "/api/ps") return Response.json({ models: [] })
    const body: { tools?: unknown; messages: { role: string }[] } = await request.json()
    const users = body.messages.filter((message) => message.role === "user").length
    if (body.tools) counts.push(users)
    const text = body.tools ? `seen ${users}` : "Loop"
    const events = [
      { choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ]
    return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-loop-"))

beforeAll(async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.mkdir(path.join(root, "work"), { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${ollama.port}/v1` } } } }),
  )
})

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("intervals take seconds, minutes or hours, and at least ten seconds", () => {
  expect(parseInterval("30s")).toBe(30_000)
  expect(parseInterval("10m")).toBe(600_000)
  expect(parseInterval("2h")).toBe(7_200_000)
  expect(parseInterval("5s")).toBeUndefined()
  expect(parseInterval("10 minutes")).toBeUndefined()
})

test("orb loop sends the message to one session on each run", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/index.ts",
      "loop",
      "10s",
      "check the build",
      "--times",
      "2",
      "--model",
      "ollama/loop:1b",
      "--standalone",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, {
        USERPROFILE: root,
        PWD: path.join(root, "work"),
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
  expect(stdout).toContain("seen 1")
  expect(stdout).toContain("seen 2")
  expect(stderr).toContain("Loop run 2 of 2")
  expect(counts).toEqual([1, 2])
}, 60_000)
