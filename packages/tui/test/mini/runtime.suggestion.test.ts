// clients-ux-37 part 2: Mini asks its server for a next-prompt suggestion when a turn of its own session ends well, and
// only while prompt.suggestions is on in the person's cli.json (class 8). A refusal, a failure or an answer of another
// shape draws nothing and leaves Mini running (classes 7 and 13).
import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { CliRenderer } from "@opentui/core"
import { createRuntimeLifecycle } from "../../src/mini/runtime.lifecycle"
import type { MiniHost } from "../../src/mini/types"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

const noop = () => () => {}
const suggestion = "run the tests"

function host(): MiniHost {
  return {
    version: "test",
    terminal: { stdin: process.stdin },
    platform: "linux",
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    files: { readText: async () => "" },
    editor: { open: async () => undefined },
    paths: { home: "/home" },
    signals: { sigint: { subscribe: noop }, sigusr2: { subscribe: noop } },
    startup: { showTiming: false, now: () => 0 },
    diagnostics: {},
    preferences: { resolveVariant: async () => undefined, saveVariant: async () => {} },
  }
}

async function start(input: { suggestions?: boolean; answer?: () => Promise<unknown> }) {
  const app = await createTestRenderer({
    width: 100,
    height: 24,
    screenMode: "split-footer",
    footerHeight: 4,
    externalOutputMode: "capture-stdout",
  })
  const asked: AbortSignal[] = []
  const sessions: string[] = []
  const lifecycle = await createRuntimeLifecycle({
    host: host(),
    createRenderer: async () => app.renderer as CliRenderer,
    getDirectory: () => "/project",
    findFiles: async () => [],
    agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
    references: [],
    sessionID: "ses_1",
    first: false,
    history: [],
    agent: "build",
    model: undefined,
    variant: undefined,
    tuiConfig: createTuiResolvedConfig({
      animations: false,
      ...(input.suggestions === undefined ? {} : { prompt: { suggestions: input.suggestions } }),
    }),
    onPermissionReply: () => {},
    onFormReply: () => {},
    onFormCancel: () => {},
    suggestion: (sessionID: string, signal: AbortSignal) => {
      sessions.push(sessionID)
      asked.push(signal)
      return input.answer ? input.answer() : Promise.resolve({ suggestion })
    },
  })
  return {
    app,
    lifecycle,
    asked,
    sessions,
    ended(sessionID = "ses_1") {
      lifecycle.observe?.({ type: "session.execution.succeeded", data: { sessionID } })
    },
    async frame() {
      await Bun.sleep(100)
      await app.renderOnce()
      return app.captureCharFrame()
    },
    [Symbol.dispose]() {
      lifecycle.footer.destroy()
      app.renderer.destroy()
    },
  }
}

test("Mini asks only with prompt.suggestions on", async () => {
  for (const row of [
    { value: undefined, count: 0 },
    { value: false, count: 0 },
    { value: true, count: 1 },
  ]) {
    using mini = await start({ suggestions: row.value })
    mini.ended()
    await Bun.sleep(100)
    expect({ value: row.value, count: mini.asked.length }).toEqual({ value: row.value, count: row.count })
    if (!row.count) continue
    expect(mini.sessions).toEqual(["ses_1"])
    expect(await mini.frame()).toContain(suggestion)
  }
})

test("a subagent's turn asks nothing", async () => {
  {
    using mini = await start({ suggestions: true })
    mini.ended("ses_child")
    await Bun.sleep(100)
    expect(mini.asked).toHaveLength(0)
  }
  {
    // Control: Mini's own session asks.
    using mini = await start({ suggestions: true })
    mini.ended()
    await Bun.sleep(100)
    expect(mini.asked).toHaveLength(1)
  }
})

test("a refused or failed request draws nothing", async () => {
  const rows = [
    { name: "403 UntrustedFolderError", answer: () => Promise.reject(new Error("UntrustedFolderError")), drawn: false },
    { name: "a bodiless 404 from an older server", answer: () => Promise.reject(new Error("404")), drawn: false },
    { name: "a body that is not JSON", answer: () => Promise.resolve("<html>not json</html>"), drawn: false },
    { name: "a number for the text", answer: () => Promise.resolve({ suggestion: 42 }), drawn: false },
    { name: "null with a reason", answer: () => Promise.resolve({ suggestion: null, reason: "busy" }), drawn: false },
    { name: "control: a suggestion", answer: () => Promise.resolve({ suggestion }), drawn: true },
  ]
  for (const row of rows) {
    using mini = await start({ suggestions: true, answer: row.answer })
    mini.ended()
    const frame = await mini.frame()
    expect({ name: row.name, asked: mini.asked.length }).toEqual({ name: row.name, asked: 1 })
    expect({ name: row.name, drawn: frame.includes(suggestion) }).toEqual({ name: row.name, drawn: row.drawn })
    for (const word of ["42", "busy", "not json", "UntrustedFolderError"])
      expect({ name: row.name, word, shown: frame.includes(word) }).toEqual({ name: row.name, word, shown: false })
    expect(mini.lifecycle.footer.isClosed).toBe(false)
  }
})
