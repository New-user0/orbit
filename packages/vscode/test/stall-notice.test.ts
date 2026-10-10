import { expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import { Controller } from "../src/controller"
import type { Item } from "../src/protocol"

// The text of a stalled command's notice quotes the command's output, which a repository script controls. The chat
// shows no waiting notice at all; a notice that names its kind is shown, escaped, as the control run.
const hostile = "\u001b]0;pwned\u0007\u001b[2KProceed (y/n) \rOVERWRITTEN"
const waiting = {
  id: "msg_wait",
  type: "synthetic" as const,
  text: `<shell id="sh_1" state="waiting" command="x">\nThe output ends with:\n${hostile}\n</shell>`,
  description: "npm init \u001b]0;title\u0007\u001b[2K\rbad",
  metadata: { source: "shell", state: "waiting", shellID: "sh_1" },
  time: { created: 1 },
}
const named = { ...waiting, id: "msg_named", metadata: { notice: "fallback" } }

function controller(messages: unknown[], items: Map<string, Item>) {
  const client = {
    event: { subscribe: () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) }) },
    location: { trust: { get: () => new Promise<never>(() => {}) } },
    session: { get: async () => ({ title: "", agent: "build" }) },
    message: { list: async () => ({ data: messages, cursor: {} }) },
  } as unknown as OrbitClient
  return new Controller(
    client,
    "/work",
    (update) => {
      if (update.type === "item") items.set(update.item.id, update.item)
    },
    () => {
      throw new Error("No trust question expected")
    },
  )
}

const notes = (items: Map<string, Item>) => [...items.values()].flatMap((item) => (item.type === "note" ? [item] : []))

test("a waiting shell notice adds no note when a session is opened, and a named notice adds a clean one", async () => {
  const items = new Map<string, Item>()
  const chat = controller([waiting, named], items)
  await chat.open("ses_1")
  chat.dispose()
  expect(notes(items).map((item) => item.id)).toEqual(["notice:msg_named"])
  const text = notes(items)[0]?.text ?? ""
  expect(text).not.toContain("\u001b")
  expect(text).not.toContain("\r")
})

test("a waiting shell notice adds no note when it arrives as an event", () => {
  const items = new Map<string, Item>()
  const chat = controller([], items)
  const event = (id: string, metadata: Record<string, unknown>) =>
    ({
      id,
      created: 0,
      type: "session.synthetic",
      durable: { aggregateID: "ses_1", seq: 1, version: 1 },
      data: { sessionID: "ses_1", text: waiting.text, description: waiting.description, metadata },
    }) as unknown as Parameters<Controller["handle"]>[0]
  chat.handle(event("evt_wait", waiting.metadata))
  chat.handle(event("evt_named", { notice: "fallback" }))
  chat.dispose()
  expect(notes(items).map((item) => item.id)).toEqual(["notice:evt_named"])
  const text = notes(items)[0]?.text ?? ""
  expect(text).not.toContain("\u001b")
  expect(text).not.toContain("\r")
})
