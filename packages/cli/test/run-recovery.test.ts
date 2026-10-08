import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// `orb run` against a real private server and a model whose first answer stops short, as a connection that drops does.
// The runner continues after it and the run ends with an answer, so the step that failed is not the failure of the run.
// The unit tests of `runNonInteractivePrompt` feed it events; this one shows what the server really does with them,
// which includes answering the wait for an idle session before the events of the last steps have arrived.
const details = {
  format: "gguf",
  family: "llama",
  families: ["llama"],
  parameter_size: "1B",
  quantization_level: "Q4",
}
// How many requests with tools the model has been asked, which are the requests of the run and not of its title.
let asked = 0
const model = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/tags")
      return Response.json({
        models: [
          { name: "cut:1b", model: "cut:1b", modified_at: "2026-01-01T00:00:00Z", size: 1, digest: "d", details },
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
    const body: { tools?: unknown } = await request.json()
    if (!body.tools) return stream([content("Cut")])
    asked++
    // The first answer is one piece of text and then the end of the connection, with no finish reason.
    if (asked === 1) return stream([content("The answer is forty-tw")], false)
    return stream([content("o."), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }])
  },
})

function content(text: string) {
  return { choices: [{ index: 0, delta: { role: "assistant", content: text } }] }
}

function stream(events: unknown[], finished = true) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(finished ? `${text}data: [DONE]\n\n` : text, { headers: { "content-type": "text/event-stream" } })
}

// Real, because the server names a folder by its real path.
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "orbit-recovery-")))

beforeAll(async () => {
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({ providers: { ollama: { settings: { baseURL: `http://127.0.0.1:${model.port}/v1` } } } }),
  )
  await fs.mkdir(path.join(root, "work"), { recursive: true })
})

afterAll(async () => {
  await model.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("orb run does not report a step that failed when the runner continued after it", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/index.ts",
      "run",
      "--standalone",
      "--format",
      "stream-json",
      "--model",
      "ollama/cut:1b",
      "go",
    ],
    {
      cwd: path.join(import.meta.dir, ".."),
      env: isolatedEnv(root, { USERPROFILE: root, PWD: path.join(root, "work"), OLLAMA_CONTEXT_LENGTH: undefined }),
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
  const lines = stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))

  // The model was asked twice, so the run did go through a failed step and a continuation.
  expect(asked).toBe(2)
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  expect(lines.filter((line) => line.type === "error")).toEqual([])
  expect(lines.filter((line) => line.type === "text").map((line) => line.part.text)).toEqual([
    "The answer is forty-tw",
    "o.",
  ])
}, 60_000)
