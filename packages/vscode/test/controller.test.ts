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
                  function: { name: "Write", arguments: JSON.stringify({ file_path: "hello.txt", content: "hi\n" }) },
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
  const controller = new Controller(
    client,
    workspace,
    (update) => {
      if (update.type === "busy") return void busy.push(update.busy)
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    neverAsked,
  )
  // The event stream must be connected before the prompt so no event is missed.
  await Bun.sleep(500)

  await controller.send("Create hello.txt containing hi")
  const permission = await until(() => [...items.values()].find((item) => item.type === "permission"))
  expect(permission).toMatchObject({ action: "Edit", status: "pending", canSave: true })
  if (permission?.type !== "permission") throw new Error("Expected a permission")
  expect(permission.files[0]?.patch).toContain("+hi")

  await controller.reply(permission.id, "once")
  await until(() => (busy.at(-1) === false ? true : undefined))

  expect(await Bun.file(path.join(workspace, "hello.txt")).text()).toBe("hi\n")
  const tool = [...items.values()].find((item) => item.type === "tool")
  expect(tool).toMatchObject({ name: "Write", status: "completed", input: { file_path: "hello.txt" } })
  expect([...items.values()].find((item) => item.type === "text")).toMatchObject({ text: "Wrote hello.txt." })
  expect(items.get(permission.id)).toMatchObject({ status: "once" })

  // History lists the session, and opening it in another chat replays the same transcript.
  const sessions = await controller.sessions()
  expect(sessions).toHaveLength(1)
  const replayed = new Map<string, Item>()
  const other = new Controller(
    client,
    workspace,
    (update) => {
      if (update.type === "item") replayed.set(update.item.id, update.item)
    },
    neverAsked,
  )
  expect(await other.open(sessions[0]?.id ?? "")).toBe("build")
  expect([...replayed.values()].map((item) => item.type)).toEqual(["user", "tool", "text"])
  expect([...replayed.values()].find((item) => item.type === "tool")).toMatchObject({
    name: "Write",
    status: "completed",
    input: { file_path: "hello.txt", content: "hi\n" },
  })
  other.dispose()
  controller.dispose()
}, 90_000)

const editor = "<system-reminder>\nThe person has this file open: src/app.ts\n</system-reminder>"

function connect() {
  return Orbit.make({ baseUrl: server.url ?? "", headers: { authorization: `Basic ${btoa("orbit:secret")}` } })
}

// A chat on a client; `until` ends when the reply has finished.
async function chat(client: ReturnType<typeof connect>) {
  const items = new Map<string, Item>()
  const logs: string[] = []
  const busy: boolean[] = []
  const controller = new Controller(
    client,
    workspace,
    (update) => {
      if (update.type === "busy") return void busy.push(update.busy)
      if (update.type === "log") return void logs.push(update.text)
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    neverAsked,
  )
  await Bun.sleep(500)
  return { controller, items, logs, busy }
}

test("editor context is admitted as a hidden message before the prompt, and replays as nothing", async () => {
  const client = connect()
  const first = steps.length
  const { controller, items, busy } = await chat(client)

  await controller.send("What does this do?", editor, "2 lines selected in src/app.ts")
  await until(() => (busy.at(-1) === false && steps.length > first ? true : undefined))

  const sessionID = (await controller.sessions())[0]?.id ?? ""
  const history = (await client.message.list({ sessionID, limit: 50, order: "asc" })).data
  const kinds = history.map((message) => message.type)
  // The context is a durable synthetic message with no description, and it comes first.
  expect(kinds.indexOf("synthetic")).toBeGreaterThanOrEqual(0)
  expect(kinds.indexOf("synthetic")).toBeLessThan(kinds.indexOf("user"))
  const synthetic = history.find((message) => message.type === "synthetic")
  expect(synthetic).toMatchObject({ text: editor, metadata: { context: "editor" } })
  expect(synthetic).not.toHaveProperty("description")
  // The person's message is exactly what they typed, with the line about what went with it.
  expect([...items.values()].find((item) => item.type === "user")).toMatchObject({
    text: "What does this do?",
    context: "2 lines selected in src/app.ts",
  })

  // The model reads the context in the user turn right before the prompt.
  const messages = (steps[first] as { messages: Array<{ role: string; content: unknown }> }).messages
  const prompt = messages.findLastIndex((message) => JSON.stringify(message.content).includes("What does this do?"))
  expect(prompt).toBeGreaterThan(0)
  const before = messages.slice(0, prompt).findLast((message) => message.role === "user")
  expect(JSON.stringify(before?.content ?? messages[prompt]?.content)).toContain("The person has this file open")

  // Opening the session in another chat shows the user message and the reply, and nothing for the context.
  const replayed = new Map<string, Item>()
  const other = new Controller(
    client,
    workspace,
    (update) => {
      if (update.type === "item") replayed.set(update.item.id, update.item)
    },
    neverAsked,
  )
  await other.open(sessionID)
  expect([...replayed.values()].map((item) => item.type)).toEqual(["user", "text"])
  other.dispose()
  controller.dispose()
}, 60_000)

test("the context does not start a step by itself: no step begins before the prompt is admitted", async () => {
  const real = connect()
  const first = steps.length
  let before = -1
  // The prompt is held back; a context admitted with resume would start a step in the meantime.
  const client: typeof real = {
    ...real,
    session: {
      ...real.session,
      prompt: async (...args: Parameters<typeof real.session.prompt>) => {
        await Bun.sleep(2_000)
        before = steps.length
        return real.session.prompt(...args)
      },
    },
  }
  const { controller, busy } = await chat(client)

  await controller.send("Wait for me", editor)
  await until(() => (busy.at(-1) === false && steps.length > first ? true : undefined))

  expect(before).toBe(first)
  controller.dispose()
}, 60_000)

test("a context that the server is too slow to admit is dropped after the time limit, and the prompt still goes", async () => {
  const real = connect()
  const first = steps.length
  // A synthetic route that only ends when the caller gives up.
  const client: typeof real = {
    ...real,
    session: {
      ...real.session,
      synthetic: (_input: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<never>((_, reject) =>
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        ),
    } as typeof real.session,
  }
  const items = new Map<string, Item>()
  const logs: string[] = []
  const busy: boolean[] = []
  const controller = new Controller(
    client,
    workspace,
    (update) => {
      if (update.type === "busy") return void busy.push(update.busy)
      if (update.type === "log") return void logs.push(update.text)
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    neverAsked,
    { read: 300, grant: 10_000 },
  )
  await Bun.sleep(500)

  await controller.send("Slow context", editor)
  await until(() => (busy.at(-1) === false && steps.length > first ? true : undefined))

  expect(logs.filter((line) => line.includes("Editor context was not sent"))).toHaveLength(1)
  expect([...items.values()].find((item) => item.type === "user")).toMatchObject({ text: "Slow context" })
  controller.dispose()
}, 60_000)

test("a message with no editor context admits no synthetic message", async () => {
  const client = connect()
  const first = steps.length
  const { controller, busy } = await chat(client)

  await controller.send("Just a question")
  await until(() => (busy.at(-1) === false && steps.length > first ? true : undefined))

  const sessionID = (await controller.sessions())[0]?.id ?? ""
  const history = (await client.message.list({ sessionID, limit: 50, order: "asc" })).data
  expect(history.map((message) => message.type)).not.toContain("synthetic")
  controller.dispose()
}, 60_000)

test("a context the server will not admit costs only itself: one log line, and the prompt still goes", async () => {
  const real = connect()
  const first = steps.length
  // A client whose synthetic route rejects.
  const client: typeof real = {
    ...real,
    session: { ...real.session, synthetic: () => Promise.reject(new Error("no synthetic")) },
  }
  const { controller, items, logs, busy } = await chat(client)

  await controller.send("Still sent", editor)
  await until(() => (busy.at(-1) === false && steps.length > first ? true : undefined))

  expect(logs).toEqual([expect.stringContaining("Editor context was not sent")])
  expect([...items.values()].find((item) => item.type === "user")).toMatchObject({ text: "Still sent" })
  const sessionID = (await controller.sessions())[0]?.id ?? ""
  const history = (await real.message.list({ sessionID, limit: 50, order: "asc" })).data
  expect(history.map((message) => message.type)).toContain("user")
  expect(history.map((message) => message.type)).not.toContain("synthetic")
  controller.dispose()
}, 60_000)

// The server of this file trusts every folder (ORBIT_TRUST_PROJECT in `isolatedEnv`), so nothing may ask about trust.
function neverAsked(): never {
  throw new Error("A trusted folder was asked about trust")
}

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
