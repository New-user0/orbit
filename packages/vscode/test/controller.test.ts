import { afterAll, beforeAll, expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "../../cli/test/fixture/environment"
import { Controller } from "../src/controller"
import type { Item } from "../src/protocol"

// A real `orb serve` with a scripted OpenAI-compatible model: the first agent step writes a file, the second replies.
const steps: unknown[] = []
const llm = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const body = await request.json()
    if (!body.tools) return sse([{ delta: { content: "Title" } }], "stop")
    steps.push(body)
    if (steps.length === 1)
      return sse(
        [
          {
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  type: "function",
                  function: { name: "write", arguments: JSON.stringify({ path: "hello.txt", content: "hi\n" }) },
                },
              ],
            },
          },
        ],
        "tool_calls",
      )
    return sse([{ delta: { content: "Wrote " } }, { delta: { content: "hello.txt." } }], "stop")
  },
})
const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-vscode-"))
const workspace = path.join(root, "workspace")
const server: { process?: ReturnType<typeof Bun.spawn>; url?: string } = {}

beforeAll(async () => {
  await fs.mkdir(path.join(root, "config"), { recursive: true })
  await fs.mkdir(workspace, { recursive: true })
  await Bun.write(
    path.join(root, "config", "orbit.json"),
    JSON.stringify({
      model: "test/test-model",
      // Edits inside the workspace are allowed by default; ask, so the chat shows the approval with its diff.
      permissions: [{ action: "edit", resource: "*", effect: "ask" }],
      providers: {
        test: {
          name: "Test",
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { apiKey: "test", baseURL: `http://127.0.0.1:${llm.port}/v1` },
          models: {
            "test-model": {
              name: "Test Model",
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              cost: { input: 0, output: 0 },
              limit: { context: 100_000, output: 10_000 },
            },
          },
        },
      },
    }),
  )
  const child = Bun.spawn([process.execPath, "run", "src/index.ts", "serve", "--port", "0"], {
    cwd: path.join(import.meta.dir, "..", "..", "cli"),
    env: isolatedEnv(root, { ORBIT_PASSWORD: "secret", ORBIT_CONFIG: undefined, ORBIT_CONFIG_CONTENT: undefined }),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  server.process = child
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let output = ""
  while (!server.url) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`orb serve exited: ${output}`)
    output += decoder.decode(chunk.value)
    server.url = /server listening on (\S+)/.exec(output)?.[1]
  }
  reader.releaseLock()
}, 60_000)

afterAll(async () => {
  server.process?.kill()
  await server.process?.exited
  await llm.stop(true)
  await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test("a chat shows the reply, surfaces the edit with its patch, and applies it once approved", async () => {
  const client = Orbit.make({
    baseUrl: server.url ?? "",
    headers: { authorization: `Basic ${btoa("orbit:secret")}` },
  })
  const items = new Map<string, Item>()
  const busy: boolean[] = []
  const controller = new Controller(client, workspace, (update) => {
    if (update.type === "busy") return void busy.push(update.busy)
    if (update.type === "item") items.set(update.item.id, update.item)
  })
  // The event stream must be connected before the prompt so no event is missed.
  await Bun.sleep(500)

  await controller.send("Create hello.txt containing hi")
  const permission = await until(() => [...items.values()].find((item) => item.type === "permission"))
  expect(permission).toMatchObject({ action: "edit", status: "pending" })
  if (permission?.type !== "permission") throw new Error("Expected a permission")
  expect(permission.files[0]?.patch).toContain("+hi")

  await controller.reply(permission.id, "once")
  await until(() => (busy.at(-1) === false ? true : undefined))

  expect(await Bun.file(path.join(workspace, "hello.txt")).text()).toBe("hi\n")
  const tool = [...items.values()].find((item) => item.type === "tool")
  expect(tool).toMatchObject({ name: "write", status: "completed", input: { path: "hello.txt" } })
  expect([...items.values()].find((item) => item.type === "text")).toMatchObject({ text: "Wrote hello.txt." })
  expect(items.get(permission.id)).toMatchObject({ status: "once" })

  // History lists the session, and opening it in another chat replays the same transcript.
  const sessions = await controller.sessions()
  expect(sessions).toHaveLength(1)
  const replayed = new Map<string, Item>()
  const other = new Controller(client, workspace, (update) => {
    if (update.type === "item") replayed.set(update.item.id, update.item)
  })
  expect(await other.open(sessions[0]?.id ?? "")).toBe("build")
  expect([...replayed.values()].map((item) => item.type)).toEqual(["user", "tool", "text"])
  expect([...replayed.values()].find((item) => item.type === "tool")).toMatchObject({
    name: "write",
    status: "completed",
    input: { path: "hello.txt", content: "hi\n" },
  })
  other.dispose()
  controller.dispose()
}, 90_000)

async function until<T>(read: () => T | undefined, timeout = 30_000): Promise<T | undefined> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await Bun.sleep(50)
  }
  return undefined
}

function sse(deltas: Array<{ delta: Record<string, unknown> }>, finish: string) {
  const chunks = [
    ...deltas.map((item) => ({ choices: [{ index: 0, delta: item.delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] },
  ]
  return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  })
}
