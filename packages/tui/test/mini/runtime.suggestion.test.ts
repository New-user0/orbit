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

function host(traces?: unknown[]): MiniHost {
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
    diagnostics: traces ? { trace: { write: (type, data) => traces.push({ type, data }) } } : {},
    preferences: { resolveVariant: async () => undefined, saveVariant: async () => {} },
  }
}

async function start(input: {
  suggestions?: boolean
  answer?: () => Promise<unknown>
  /** The session Mini starts with, and how it reads its own session later; the default is ses_1 throughout. */
  sessionID?: string
  getSessionID?: () => string
  /** Collects what Mini writes to its trace. */
  traces?: unknown[]
}) {
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
    host: host(input.traces),
    createRenderer: async () => app.renderer as CliRenderer,
    getDirectory: () => "/project",
    findFiles: async () => [],
    agents: [{ id: "build", name: "Build", mode: "primary", hidden: false }],
    references: [],
    sessionID: input.sessionID ?? "ses_1",
    getSessionID: input.getSessionID,
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
    async type(text: string) {
      await app.mockInput.typeText(text)
      await Bun.sleep(30)
      await app.renderOnce()
    },
    async erase(count: number) {
      for (const _ of Array.from({ length: count })) app.mockInput.pressBackspace()
      await Bun.sleep(30)
      await app.renderOnce()
    },
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

test("a turn starting in Mini's own session ends its suggestion, and a subagent's turn does not", async () => {
  using mini = await start({ suggestions: true })
  mini.ended()
  expect(await mini.frame()).toContain(suggestion)
  mini.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_child" } })
  expect(await mini.frame()).toContain(suggestion)
  mini.lifecycle.observe?.({ type: "session.execution.started", data: { sessionID: "ses_1" } })
  expect(await mini.frame()).not.toContain(suggestion)
})

test("closing Mini cancels a suggestion request that is still out", async () => {
  using mini = await start({ suggestions: true, answer: () => new Promise(() => {}) })
  mini.ended()
  await Bun.sleep(50)
  expect(mini.asked).toHaveLength(1)
  expect(mini.asked[0]!.aborted).toBe(false)
  await mini.lifecycle.close({ showExit: false })
  expect(mini.asked[0]!.aborted).toBe(true)
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

// Mini learns its session after its footer mounts (the real runtime starts with none) and moves to another on /new, so
// whether its prompt could draw an answer is judged for the session it has when the answer comes.
test("an answer that comes while Mini's input holds text is dropped, whichever session Mini has come to", async () => {
  const rows = [
    { name: "the session became known after the footer mounted", first: "", draft: true, drawn: false },
    { name: "/new moved Mini to another session", first: "ses_0", draft: true, drawn: false },
    { name: "control: the input is empty when the answer comes", first: "", draft: false, drawn: true },
  ]
  for (const row of rows) {
    const gate = Promise.withResolvers<void>()
    let current = row.first
    using mini = await start({
      suggestions: true,
      sessionID: row.first,
      getSessionID: () => current,
      answer: async () => {
        await gate.promise
        return { suggestion }
      },
    })
    current = "ses_1"
    if (row.draft) {
      await mini.type("draft")
      expect(await mini.frame()).toContain("draft")
    }
    mini.ended()
    await Bun.sleep(50)
    expect({ name: row.name, asked: mini.sessions }).toEqual({ name: row.name, asked: ["ses_1"] })
    gate.resolve()
    await Bun.sleep(50)
    if (row.draft) await mini.erase("draft".length)
    const frame = await mini.frame()
    expect({ name: row.name, draft: frame.includes("draft") }).toEqual({ name: row.name, draft: false })
    expect({ name: row.name, drawn: frame.includes(suggestion) }).toEqual({ name: row.name, drawn: row.drawn })
  }
})

// Mini's prompt goes with its footer, which can end before Mini itself closes. An answer that comes in between is no
// longer judged by that prompt: like a session with no prompt in view, it is kept rather than dropped as one that could
// not be drawn.
test("an answer that comes after Mini's prompt is gone is not judged by that prompt", async () => {
  const rows = [
    { name: "the prompt is gone", destroy: true, dropped: false },
    { name: "control: the prompt in view holds text", destroy: false, dropped: true },
  ]
  for (const row of rows) {
    const gate = Promise.withResolvers<void>()
    const traces: unknown[] = []
    using mini = await start({
      suggestions: true,
      traces,
      answer: async () => {
        await gate.promise
        return { suggestion }
      },
    })
    await mini.type("draft")
    mini.ended()
    await Bun.sleep(50)
    expect({ name: row.name, asked: mini.asked.length }).toEqual({ name: row.name, asked: 1 })
    if (row.destroy) mini.app.renderer.destroy()
    gate.resolve()
    await Bun.sleep(50)
    const dropped = traces.some((trace) => JSON.stringify(trace).includes("could not be drawn"))
    expect({ name: row.name, dropped }).toEqual({ name: row.name, dropped: row.dropped })
  }
})
