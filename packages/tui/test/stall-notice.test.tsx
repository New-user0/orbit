import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect, FileSystem } from "effect"
import { Global } from "@orbit/util/global"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { tmpdir } from "./fixture/fixture"

// The tail of a stalled command is script output. The row shows the command and the state, and nothing in it is raw.
test.each([40, 120])("a waiting shell notice reads as waiting, never finished, at width %s", async (width) => {
  await using state = await tmpdir()
  const setup = await createTestRenderer({ width, height: 36, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const session = {
    id: "ses_stall",
    title: "Stall notice",
    projectID: "project",
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
  }
  const tail = "\u001b]0;pwned\u0007\u001b[2KProceed (y/n) \rOVERWRITTEN"
  const messages = [
    { id: "user-0", type: "user", text: "Run it", time: { created: 0 } },
    {
      id: "notice-0",
      type: "synthetic",
      text: `<shell id="sh_1" state="waiting" command="x">\nThe output ends with:\n${tail}\n</shell>`,
      description: "npm init \u001b]0;title\u0007\u001b[2K\rbad",
      metadata: { source: "shell", state: "waiting", shellID: "sh_1" },
      time: { created: 1 },
    },
  ]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
    if (url.pathname === `/api/session/${session.id}`) return json({ data: session })
    if (url.pathname === `/api/session/${session.id}/message`) return json({ data: messages.toReversed(), cursor: {} })
    if (url.pathname.endsWith("/inbox") || url.pathname.endsWith("/permission")) return json({ data: [] })
    return undefined
  }, createEventStream())
  const server = Bun.serve({ port: 0, idleTimeout: 0, fetch: (request) => calls.fetch(request) })
  const { run } = await import("../src/app")
  const task = Effect.runPromise(
    run({
      app: { name: "test", version: "test", channel: "test" },
      server: { endpoint: { url: server.url.toString() } },
      config: {
        get: async () => ({ animations: false, tabs: { mode: "off" } }),
        update: async () => ({}),
      },
      packages: { prepare: async () => ({ directory: "" }) },
      args: { sessionID: session.id },
      terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: () => {} }),
      log: () => {},
    }).pipe(Effect.provide(Global.layerWith({ state: state.path })), Effect.provide(FileSystem.layerNoop({}))),
  )
  try {
    await setup.waitForFrame((frame) => frame.includes("Shell waiting"))
    await setup.waitForVisualIdle()
    const frame = setup.captureCharFrame()
    expect(frame).not.toContain("Shell finished")
    expect(frame).not.toContain("OVERWRITTEN")
    expect(frame).not.toContain("pwned")
    expect(frame).not.toContain("\u001b")
    expect(frame).not.toContain("\r")
  } finally {
    setup.renderer.destroy()
    await task
    await server.stop()
  }
})
