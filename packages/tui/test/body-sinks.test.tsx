import { expect, setDefaultTimeout, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orbit/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"
import { normalizePath } from "../src/util/path"

setDefaultTimeout(30_000)

// What a model, a tool or a stored prompt can put into a message body: a set-title sequence and a right-to-left override.
const hostile = "a\u001b]0;pwn\u0007b\u202ec"
const written = "a\\x1b]0;pwn\\x07b\\u{202e}c"

// An agent name is title-cased before it is written out, so the letters around the controls are fixed.
const agentHostile = "gen\u001b[2Kral"

// Program output goes through strip-ansi first, which removes whole sequences. What it leaves is a lone ESC, BEL and BS,
// which is what a hostile program can still put on the screen.
const leftover = "a\u0007b\u0008c\u001b\u202ed"
const leftoverWritten = "a\\x07b\\x08c\\x1b\\u{202e}d"

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
    id: `assistant-${name}`,
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

function assistant(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: "assistant-0",
    type: "assistant",
    agent: "build",
    model: { providerID: "test", id: "test" },
    content,
    time: { created: 1, completed: 2 },
    ...extra,
  }
}

type App = Awaited<ReturnType<typeof createTestRenderer>> & { events: ReturnType<typeof createEventStream> }

// Click the first place `needle` is drawn.
async function click(app: App, needle: string) {
  const lines = app.captureCharFrame().split("\n")
  const y = lines.findIndex((line) => line.includes(needle))
  if (y < 0) throw new Error(`${needle} is not on the screen`)
  await app.mockMouse.click(lines[y].indexOf(needle) + 1, y)
}

// Each row is one place a body is drawn. `show` is what the screen must contain; the raw ESC must never reach it.
const rows: {
  sink: string
  messages: unknown[]
  inbox?: unknown[]
  show: string[]
  act?: (app: App, text: string) => Promise<void>
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
        metadata: { source: "subagent", childID: "ses_child", agent: agentHostile, state: "completed" },
        time: { created: 3 },
      },
    ],
    show: [written, "Gen\\x1b[2Kral"],
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
    sink: "inline tool name and expanded error",
    messages: [user, tool("mcp_x" + hostile, { status: "error", error: { type: "unknown", message: `err ${hostile}` } })],
    act: async (app) => {
      await click(app, "mcp_x")
      await app.waitForVisualIdle()
    },
    show: [written, `err ${written}`],
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
  {
    sink: "user message",
    messages: [{ ...user, text: `Run it ${hostile}` }],
    show: [`Run it ${written}`],
  },
  {
    sink: "assistant text",
    messages: [user, assistant([{ type: "text", text: hostile }])],
    show: [written],
  },
  {
    sink: "reasoning",
    messages: [user, assistant([{ type: "reasoning", text: hostile, time: { created: 1, completed: 2 } }])],
    act: async (app) => {
      await click(app, "Thought")
      await app.waitForFrame((frame) => /enign|pwn/.test(frame))
      await app.waitForVisualIdle()
    },
    show: [written],
  },
  {
    sink: "compaction summary",
    messages: [user, { id: "compaction-0", type: "compaction", status: "completed", summary: hostile, time: { created: 3 } }],
    show: [written],
  },
  {
    sink: "assistant error line",
    messages: [user, assistant([], { error: { type: "unknown", message: hostile } })],
    show: [`Error: ${written}`],
  },
  {
    sink: "assistant retry line",
    messages: [
      user,
      assistant([], { retry: { attempt: 2, at: 9_999_999_999_999, error: { type: "unknown", message: hostile } } }),
    ],
    show: [written],
  },
  {
    sink: "shell message command and output",
    messages: [
      user,
      {
        id: "shell-0",
        type: "shell",
        shellID: "shell-1",
        command: `echo ${hostile}`,
        status: "completed",
        exit: 0,
        output: { output: `out ${leftover}` },
        time: { created: 3 },
      },
    ],
    show: [`echo ${written}`, `out ${leftoverWritten}`],
  },
  {
    sink: "shell tool command and output",
    messages: [
      user,
      tool("shell", { input: { command: `echo ${hostile}` }, content: [{ type: "text", text: `out ${leftover}` }] }),
    ],
    show: [`echo ${written}`, `out ${leftoverWritten}`],
  },
  {
    sink: "execute output",
    messages: [
      user,
      tool("execute", {
        status: "error",
        input: { code: "x" },
        error: { type: "unknown", message: "failed" },
        content: [{ type: "text", text: leftover }],
        metadata: { error: true },
      }),
    ],
    show: [leftoverWritten],
  },
  {
    sink: "generic tool summary and expanded output",
    messages: [
      user,
      tool("mcp_x", { input: { q: "query" }, content: [{ type: "text", text: `out ${leftover}` }] }),
      tool("mcp_y" + hostile, { input: { q: hostile } }),
    ],
    act: async (app, text) => {
      await click(app, "mcp_x")
      await app.waitForVisualIdle()
    },
    show: [`out ${leftoverWritten}`, `mcp_y${written}`],
  },
  // A completed Write is drawn from the diff it recorded (what ran), not from the model's `content`: a new file shows its
  // whole text, a file that was there shows the diff.
  {
    sink: "write content",
    messages: [
      user,
      tool("write", {
        input: { path: "a.ts", content: "const a = 1" },
        metadata: {
          files: [
            {
              file: "a.ts",
              status: "added",
              patch: `--- a.ts\n+++ a.ts\n@@ -0,0 +1,1 @@\n+const a = "${hostile}"\n`,
              additions: 1,
              deletions: 0,
            },
          ],
        },
      }),
    ],
    show: [written],
  },
  {
    sink: "write diff",
    messages: [
      user,
      tool("write", {
        input: { path: "a.ts", content: "const a = 1" },
        metadata: {
          files: [
            {
              file: "a.ts",
              status: "modified",
              patch: `--- a.ts\n+++ a.ts\n@@ -1,1 +1,1 @@\n-const a = 0\n+const a = "${hostile}"\n`,
              additions: 1,
              deletions: 1,
            },
          ],
        },
      }),
    ],
    show: [written],
  },
  {
    sink: "block tool error",
    messages: [
      user,
      tool("shell", { status: "error", input: { command: "x" }, error: { type: "unknown", message: `err ${hostile}` } }),
    ],
    show: [`err ${written}`],
  },
  {
    sink: "edit diff, path and diagnostic",
    messages: [
      user,
      tool("edit", {
        input: { path: `a${hostile}.ts` },
        metadata: {
          files: [
            {
              file: `a${hostile}.ts`,
              type: "update",
              patch: `@@ -1 +1 @@\n-old\n+${hostile}`,
              additions: 1,
              deletions: 1,
            },
          ],
          diagnostics: {
            [normalizePath(`a${hostile}.ts`, process.platform)]: [
              { severity: 1, range: { start: { line: 0, character: 0 } }, message: `bad ${hostile}` },
            ],
          },
        },
      }),
    ],
    show: [`+ ${written}`, `a${written}.ts`, `bad ${written}`],
  },
  {
    sink: "patch diff and path",
    messages: [
      user,
      tool("apply_patch", {
        input: { patchText: "*** Begin Patch" },
        metadata: {
          files: [
            {
              file: `b${hostile}.ts`,
              type: "update",
              patch: `@@ -1 +1 @@\n-old\n+${hostile}`,
              additions: 1,
              deletions: 1,
            },
          ],
        },
      }),
    ],
    show: [`+ ${written}`, `b${written}.ts`],
  },
  {
    sink: "question text",
    messages: [user, tool("question", { input: { questions: [{ question: hostile }] }, metadata: { answers: [["x"]] } })],
    show: [written],
  },
  {
    sink: "Session failed toast",
    messages: [user],
    act: async (app, text) => {
      app.events.emit({
        id: "evt_failed",
        created: 2,
        type: "session.execution.failed",
        durable: { aggregateID: session.id, seq: 1, version: 1 },
        data: { sessionID: session.id, error: { type: "unknown", message: text } },
      })
      await app.waitForFrame((frame) => frame.includes("Session failed"))
    },
    show: [written],
  },
  {
    sink: "queued prompts dialog",
    messages: [user],
    inbox: [{ id: "queued-0", type: "user", delivery: "queue", payload: { text: hostile }, time: { created: 5 } }],
    act: async (app, text) => {
      await click(app, "1 queued")
      await app.waitForFrame((frame) => frame.includes("Queued prompts"))
    },
    show: [written, "Queued prompts"],
  },
]

async function screen(messages: unknown[], inbox: unknown[] = [], act?: (app: App, text: string) => Promise<void>, text = hostile, until?: string) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width: 110, height: 40, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname === `/api/session/${session.id}/inbox`) return json({ data: inbox })
    if (url.pathname === `/api/session/${session.id}/permission`) return json({ data: [] })
    return undefined
  }, events)
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
    await act?.(Object.assign(setup, { events }), text)
    if (until) await setup.waitForFrame((frame) => frame.includes(until), { maxPasses: 100 })
    await setup.waitForVisualIdle()
    return setup.captureCharFrame()
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
}

test.each(rows)("draws the control characters of $sink written out", async (row) => {
  const frame = await screen(row.messages, row.inbox, row.act, hostile, row.show[0])
  for (const text of row.show) expect(frame).toContain(text)
  expect(frame).not.toContain("\u001b")
  expect(frame).not.toContain("\u0007")
  expect(frame).not.toContain("\u202e")
})

// The trusted control: the same rows with ordinary text show it unchanged and write nothing out, so a row above cannot
// pass only because the screen holds a written-out sequence for another reason.
const benign = "abenignc"
test.each(rows)("draws ordinary text of $sink unchanged", async (row) => {
  const swap = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(hostile).slice(1, -1), benign).replaceAll(JSON.stringify(leftover).slice(1, -1), benign).replaceAll(JSON.stringify(agentHostile).slice(1, -1), "gen"))
  const frame = await screen(swap(row.messages), swap(row.inbox ?? []), row.act, benign, benign)
  expect(frame).toContain(benign)
  expect(frame).not.toContain("\\x1b")
  expect(frame).not.toContain("\\x07")
  expect(frame).not.toContain("\\u{202e}")
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
