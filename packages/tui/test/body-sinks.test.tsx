import { expect, setDefaultTimeout, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orbit/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

setDefaultTimeout(30_000)

// What a model, a tool or a stored prompt can put into a message body: a set-title sequence and a right-to-left override.
const hostile = "a\u001b]0;pwn\u0007b‮c"
const written = "a\\x1b]0;pwn\\x07b\\u{202e}c"

const session = {
  id: "ses_sinks",
  title: "Body sinks",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

function tool(name: string, state: Record<string, unknown>) {
  return {
    id: "assistant-0",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content: [
      {
        type: "tool",
        id: `call-${name}`,
        name,
        state: { status: "completed", input: {}, content: [], metadata: {}, ...state },
        time: { created: 1, completed: 2 },
      },
    ],
    time: { created: 1, completed: 2 },
  }
}

const user = { id: "user-0", type: "user", text: "Run it", time: { created: 0 } }

// Each row is one place a body is drawn. `show` is what the screen must contain; the raw ESC must never reach it.
const rows: {
  sink: string
  messages: unknown[]
  inbox?: unknown[]
  show: string[]
  wait?: string
}[] = [
  {
    sink: "question answers",
    messages: [
      user,
      tool("question", { input: { questions: [{ question: "Which?" }] }, metadata: { answers: [[hostile]] } }),
    ],
    show: [written],
  },
  {
    sink: "plan dock",
    messages: [
      user,
      tool("todo", { input: { todos: [{ content: hostile, status: "pending" }] } }),
    ],
    show: [written],
  },
  {
    sink: "shell completion notice",
    messages: [
      user,
      {
        id: "notice-0",
        type: "synthetic",
        text: "Shell finished",
        description: hostile,
        metadata: { source: "shell", state: "completed", shellID: "shell-1" },
        time: { created: 3 },
      },
    ],
    show: [written],
  },
  {
    sink: "subagent completion notice",
    messages: [
      user,
      {
        id: "notice-0",
        type: "synthetic",
        text: "Subagent result",
        description: hostile,
        metadata: { source: "subagent", childID: "ses_child", agent: "gen\u001b[2Kral", state: "completed" },
        time: { created: 3 },
      },
    ],
    show: [written, "Gen\\X1b[2Kral"],
  },
  {
    sink: "skill message",
    messages: [user, { id: "skill-0", type: "skill", name: hostile, time: { created: 3 } }],
    show: [written],
  },
  {
    sink: "skill tool",
    messages: [user, tool("skill", { input: { id: hostile } })],
    show: [written],
  },
  {
    sink: "read loaded path",
    messages: [user, tool("read", { input: { path: "a.ts" }, metadata: { loaded: [hostile] } })],
    show: [written],
  },
  {
    sink: "generic tool name and expanded error",
    messages: [user, tool("mcp_x" + hostile, { status: "error", error: { type: "unknown", message: hostile } })],
    show: [written],
  },
  {
    sink: "workflow card phase and agent",
    messages: [
      user,
      tool("workflow", {
        input: { description: hostile },
        metadata: {
          agents: [
            { sessionID: "ses_a", description: hostile, agent: "build", status: "running", phase: hostile },
          ],
        },
      }),
    ],
    show: [written],
  },
  {
    sink: "execute call summary",
    messages: [
      user,
      tool("execute", { input: { code: "x" }, metadata: { toolCalls: [{ tool: "t" + hostile, status: "completed" }] } }),
    ],
    show: [written],
  },
  {
    sink: "queued prompt dock",
    messages: [user],
    inbox: [{ id: "queued-0", type: "user", delivery: "queue", payload: { text: hostile }, time: { created: 5 } }],
    show: [written],
  },
]

async function screen(messages: unknown[], inbox: unknown[] = []) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 110, height: 40, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: inbox })
    if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" }, session: { grouping: "none" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Run it"))
    await setup.waitForVisualIdle()
    return setup.captureCharFrame()
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

test.each(rows)("draws the control characters of $sink written out", async (row) => {
  const frame = await screen(row.messages, row.inbox)
  for (const text of row.show) expect(frame).toContain(text)
  expect(frame).not.toContain("\u001b")
  expect(frame).not.toContain("‮")
})

test("draws a lone carriage return in program output as a line break", async () => {
  const frame = await screen([
    user,
    tool("shell", {
      input: { command: "git clone x" },
      content: [{ type: "text", text: "Receiving objects: 33%\rReceiving objects: 66%\rdone" }],
      metadata: {},
    }),
  ])
  expect(frame).toContain("Receiving objects: 33%")
  expect(frame).toContain("Receiving objects: 66%")
  expect(frame).not.toContain("\\x0d")
  expect(frame.split("\n").filter((row) => row.includes("Receiving objects"))).toHaveLength(2)
})

test("still writes a carriage return out of a command", async () => {
  const frame = await screen([user, tool("shell", { input: { command: "echo a\rb" } })])
  expect(frame).toContain("echo a\\x0db")
})
