import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// The main agent delegates through the workflow tool: a writer, then a reviewer and a bug hunter in parallel, then a
// fixer that gets both reports. Only the program's return value may reach the main agent.
const script = `
const draft = await tools.agent({ description: "Write feature", prompt: "ROLE writer: create feature.txt" })
const [review, bugs] = await Promise.all([
  tools.agent({ description: "Review feature", prompt: "ROLE reviewer: review this. " + draft }),
  tools.agent({ description: "Hunt bugs", phase: "Review", prompt: "ROLE bugs: find bugs in feature.txt" }),
])
const fix = await tools.agent({ description: "Fix findings", prompt: "ROLE fixer: fix " + review + " and " + bugs })
return { draft, review, bugs, fix }
`
const roles: string[] = []
const mainRequests: Array<{ tools: string[]; result?: string }> = []
const childTools: string[][] = []
let inflight = 0
let concurrent = 0

const ollama = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
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
        capabilities: ["completion", "tools"],
        model_info: { "general.architecture": "llama", "llama.context_length": 32_768 },
        details: { parent_model: "", ...details },
      })
    if (pathname === "/api/ps") return Response.json({ models: [] })
    const body = await request.json()
    if (!body.tools) return reply("Workflow task")
    const tools: string[] = body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    const messages: Array<{ role: string; content?: unknown }> = body.messages
    const users = JSON.stringify(messages.filter((message) => message.role === "user"))
    const role = users.match(/ROLE (\w+)/)?.[1]
    const last = messages.at(-1)
    if (!role) {
      mainRequests.push({ tools, result: last?.role === "tool" ? String(last.content) : undefined })
      if (last?.role === "tool") return reply("All done.")
      return call("Workflow", { description: "Build and review feature", script })
    }
    childTools.push(tools)
    if (role === "writer" && last?.role !== "tool") {
      roles.push(role)
      return call("Write", { file_path: "feature.txt", content: "feature v1\n" })
    }
    if (role !== "writer") roles.push(role)
    inflight++
    concurrent = Math.max(concurrent, inflight)
    await Bun.sleep(role === "reviewer" || role === "bugs" ? 400 : 0)
    inflight--
    if (role === "writer") return reply("Created feature.txt with one line. Internal notes: long draft transcript.")
    if (role === "reviewer") return reply("REVIEW-1: add a trailing summary line")
    if (role === "bugs") return reply("BUG-1: no header")
    return reply(`Fixed: ${users.includes("REVIEW-1") && users.includes("BUG-1") ? "both findings" : "nothing"}`)
  },
})

function reply(text: string) {
  return stream([{ role: "assistant", content: text }], "stop")
}

function call(name: string, args: unknown) {
  return stream(
    [
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${name}_${roles.length}`,
            type: "function",
            function: { name, arguments: JSON.stringify(args) },
          },
        ],
      },
    ],
    "tool_calls",
  )
}

function stream(deltas: unknown[], finish: string) {
  const events = [
    ...deltas.map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ]
  return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-workflow-tool-"))

afterAll(async () => {
  await ollama.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("the workflow tool delegates to subagents and returns only the program's result", async () => {
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
      "build the feature with a review",
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
  expect(stdout).toContain("All done.")
  expect(await Bun.file(path.join(workspace, "feature.txt")).text()).toBe("feature v1\n")
  expect(roles[0]).toBe("writer")
  expect(roles.slice(1, 3).toSorted()).toEqual(["bugs", "reviewer"])
  expect(roles[3]).toBe("fixer")
  expect(concurrent).toBe(2)
  // The main agent sees the workflow tool; subagents do not, so they cannot nest workflows.
  expect(mainRequests[0]?.tools).toContain("Workflow")
  expect(childTools.every((tools) => !tools.includes("Workflow") && !tools.includes("Agent"))).toBe(true)
  const result = mainRequests.at(-1)?.result ?? ""
  expect(result).toContain("REVIEW-1: add a trailing summary line")
  expect(result).toContain("Fixed: both findings")
  expect(result).toContain("[Review] Hunt bugs (general, completed")
  // Child transcripts (prompts, tool calls) stay in the child sessions.
  expect(result).not.toContain("ROLE writer")
  expect(result).not.toContain("feature v1")
}, 180_000)
