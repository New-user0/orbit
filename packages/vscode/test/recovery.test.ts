import { expect, test } from "bun:test"
import { Orbit } from "@orbit/client"
import type { OrbitEvent } from "@orbit/client"
import { Controller } from "../src/controller"
import type { Item } from "../src/protocol"

// The controller folds events into chat items; these feed it the events of a run directly. The client points at a port
// nothing listens on, so no server is involved.
const session = "ses_recovery"
let count = 0

function chat() {
  const items = new Map<string, Item>()
  const controller = new Controller(
    Orbit.make({ baseUrl: "http://127.0.0.1:9" }),
    "/tmp/none",
    (update) => {
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    () => Promise.resolve("later"),
  )
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
  ["a plan-exit notice", { description: "Plan ready.", metadata: { notice: "plan-exit" } }, 1],
  ["no description", { metadata: { notice: "output-escalation" } }, 0],
  ["a blank description", { description: "  ", metadata: { notice: "fallback" } }, 0],
  ["no notice kind", { description: "Hello" }, 0],
  ["a notice that is not text", { description: "Hello", metadata: { notice: 3 } }, 0],
])("a synthetic with %s renders %d notes", (_name, data, expected) => {
  const { controller, send, notes } = chat()
  send("session.synthetic", { text: "x", ...data })
  expect(notes()).toHaveLength(expected)
  controller.dispose()
})
