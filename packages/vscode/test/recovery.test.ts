import { afterEach, expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import type { OrbitEvent } from "@orbit/client"
import { Controller } from "../src/controller"
import type { Item } from "../src/protocol"

// The controller folds events into chat items; these feed it the events of a run directly. The client points at a port
// nothing listens on, so no server is involved.
const session = "ses_recovery"
let count = 0

const opened: Controller[] = []

// A failed expect must not leave a reconnect loop running.
afterEach(() => {
  for (const controller of opened.splice(0)) controller.dispose()
})

function chat(baseUrl = "http://127.0.0.1:9") {
  const items = new Map<string, Item>()
  const controller = new Controller(
    Orbit.make({ baseUrl }),
    "/tmp/none",
    (update) => {
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    () => Promise.resolve("later"),
  )
  opened.push(controller)
  controller["session"] = session
  const send = (type: string, data: Record<string, unknown> = {}) =>
    controller.handle({
      id: `evt_${count++}`,
      type,
      created: Date.now(),
      data: { sessionID: session, ...data },
    } as unknown as OrbitEvent)
  const notes = () => [...items.values()].filter((item) => item.type === "note")
  return { controller, send, notes }
}

const failure = { error: { type: "unknown", message: "The provider response ended unexpectedly." } }

test("a step failure that a later step recovers from shows no error", () => {
  const { controller, send, notes } = chat()
  send("session.step.failed", failure)
  expect(notes()).toEqual([])
  send("session.step.started")
  send("session.execution.succeeded")
  expect(notes()).toEqual([])
  controller.dispose()
})

test("a step failure that ends the run shows once, and the run's own failure replaces it", () => {
  const ended = chat()
  ended.send("session.step.failed", failure)
  ended.send("session.execution.succeeded")
  expect(ended.notes()).toMatchObject([{ tone: "error", text: failure.error.message }])
  ended.controller.dispose()

  const failed = chat()
  failed.send("session.step.failed", failure)
  failed.send("session.execution.failed", { error: { type: "unknown", message: "Out of retries." } })
  expect(failed.notes()).toMatchObject([{ tone: "error", text: "Out of retries." }])
  failed.controller.dispose()
})

test("a loop notice with a description is one muted note, escaped", () => {
  const { controller, send, notes } = chat()
  send("session.synthetic", {
    text: "x",
    description: "Switched to \u001b]0;x\u0007 model‮",
    metadata: { notice: "fallback" },
  })
  const found = notes()
  expect(found).toHaveLength(1)
  expect(found[0]).toMatchObject({ tone: "muted", text: "Switched to \\x1b]0;x\\x07 model\\u{202e}" })
  controller.dispose()
})

test.each([
  ["a plan-exit notice", 1, { description: "Plan ready.", metadata: { notice: "plan-exit" } }],
  ["no description", 0, { metadata: { notice: "output-escalation" } }],
  ["a blank description", 0, { description: "  ", metadata: { notice: "fallback" } }],
  ["no notice kind", 0, { description: "Hello" }],
  ["a notice that is not text", 0, { description: "Hello", metadata: { notice: 3 } }],
])("a synthetic with %s renders %d notes", (_name, expected, data) => {
  const { controller, send, notes } = chat()
  send("session.synthetic", { text: "x", ...data })
  expect(notes()).toHaveLength(expected)
  controller.dispose()
})

test.each([
  ["user", false],
  ["shutdown", true],
  ["superseded", true],
  ["inactivity", true],
] as const)("a stop with reason %s shows the held failure: %p", (reason, shown) => {
  const { send, notes } = chat()
  send("session.step.failed", failure)
  send("session.execution.interrupted", { reason })
  expect(notes()).toMatchObject([
    ...(shown ? [{ tone: "error", text: failure.error.message }] : []),
    { tone: "muted", text: "Stopped." },
  ])
})

test("a failure that the run's own failure replaced does not come back at a later stop", () => {
  const { send, notes } = chat()
  send("session.step.failed", failure)
  send("session.execution.failed", { error: { type: "unknown", message: "Out of retries." } })
  send("session.execution.interrupted", { reason: "shutdown" })
  expect(notes()).toMatchObject([{ text: "Out of retries." }, { text: "Stopped." }])
})

test("starting over drops a held failure", () => {
  const { controller, send, notes } = chat()
  send("session.step.failed", failure)
  controller.reset()
  controller["session"] = session
  send("session.execution.succeeded")
  expect(notes()).toEqual([])
})

test("opening a session replays the notices that have a description and skips the rest", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/session/ses_old") return Response.json({ data: { id: "ses_old", title: "Earlier" } })
      if (url.pathname === "/api/session/ses_old/message")
        return Response.json({
          data: [
            { type: "synthetic", id: "msg_a", text: "x", description: "Switched model\u001b", metadata: { notice: "fallback" } },
            { type: "synthetic", id: "msg_b", text: "x", metadata: { notice: "fallback" } },
          ],
          cursor: {},
        })
      return new Response("not found", { status: 404 })
    },
  })
  try {
    const { controller, notes } = chat(`http://127.0.0.1:${server.port}`)
    await controller.open("ses_old")
    expect(notes()).toMatchObject([{ id: "notice:msg_a", tone: "muted", text: "Switched model\\x1b" }])
  } finally {
    await server.stop(true)
  }
})

test.each([
  ["a clean end", false],
  ["an errored end", true],
] as const)("a held failure does not outlive the event stream after %s", async (_name, errored) => {
  let connections = 0
  // The controller listens from construction; events are held back until the session is open so that belongs() accepts them.
  const opened = Promise.withResolvers<void>()
  const frame = (type: string, data: Record<string, unknown>) =>
    `data: ${JSON.stringify({ id: `evt_${type}_${connections}`, type, created: Date.now(), data: { sessionID: "ses_old", ...data } })}\n\n`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === "/api/session/ses_old") return Response.json({ data: { id: "ses_old", title: "Earlier" } })
      if (url.pathname === "/api/session/ses_old/message") return Response.json({ data: [], cursor: {} })
      if (url.pathname !== "/api/event") return new Response("not found", { status: 404 })
      connections++
      const first = connections === 1
      return new Response(
        new ReadableStream({
          async start(stream) {
            await opened.promise
            stream.enqueue(
              new TextEncoder().encode(
                first
                  ? frame("session.step.failed", failure)
                  : frame("session.execution.interrupted", { reason: "shutdown" }),
              ),
            )
            if (!first) return
            await Bun.sleep(50)
            if (errored) stream.error(new Error("cut"))
            else stream.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const { controller, notes } = chat(`http://127.0.0.1:${server.port}`)
    await controller.open("ses_old")
    opened.resolve()
    const deadline = Date.now() + 8000
    while (notes().length === 0 && Date.now() < deadline) await Bun.sleep(50)
    expect(notes()).toMatchObject([{ tone: "muted", text: "Stopped." }])
  } finally {
    await server.stop(true)
  }
})
