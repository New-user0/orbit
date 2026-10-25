// context-memory-3: a clearing leaves old tool results out of what the model is sent, never out of what a person sees.
// The marker is a row of the stored history; the session route draws the full stored output and nothing for the marker.
import { expect, setDefaultTimeout, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orbit/util/global"
import { createEventStream, createFetch, directory, json } from "../fixture/tui-client"
import { tmpdir } from "../fixture/fixture"

setDefaultTimeout(30_000)

const session = {
  id: "ses_cleared",
  title: "Cleared",
  projectID: "project",
  location: { directory },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
}

const user = { id: "user-0", type: "user", text: "Run it", time: { created: 0 } }
const output = "the full output of the cleared call"
const assistant = {
  id: "assistant-0",
  type: "assistant",
  agent: "build",
  model: { providerID: "test", id: "test" },
  content: [
    {
      type: "tool",
      id: "call-0",
      name: "shell",
      state: {
        status: "completed",
        input: { command: "cat notes.txt" },
        content: [{ type: "text", text: output }],
        metadata: {},
      },
      time: { created: 1, completed: 2 },
    },
  ],
  time: { created: 1, completed: 2 },
}
const marker = {
  id: "cleared-0",
  type: "context-cleared",
  trigger: "idle",
  tools: [{ assistantMessageID: "assistant-0", id: "call-0" }],
  time: { created: 3 },
}

async function screen(messages: unknown[], width: number) {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width, height: 40, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const events = createEventStream()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../../src/app")
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

test.each([
  ["narrow", 60],
  ["wide", 120],
] as const)("draws a cleared read's output and nothing for the marker (%s)", async (_, width) => {
  const withMarker = await screen([user, assistant, marker], width)
  // The stored output is still on the screen, whole.
  expect(withMarker).toContain("cat notes.txt")
  expect(withMarker).toContain(output)
  // Nothing says that an output was cleared: neither the placeholder the model is sent nor the marker's own fields.
  expect(withMarker).not.toContain("cleared to free")
  expect(withMarker).not.toContain("context-cleared")
  expect(withMarker).not.toContain("idle")
  // Control: the same history without the marker draws the same screen, so the marker adds no row at all.
  expect(withMarker).toBe(await screen([user, assistant], width))
})
