import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@orbit/core/session/message"
import { ReminderText } from "@orbit/core/session/reminder-text"
import { SessionReminders } from "@orbit/core/session/reminders"
import { Verification } from "@orbit/core/session/verification"
import { History } from "./lib/reminder-history"

const three = [
  ["Write the code", "completed"],
  ["Update the docs", "completed"],
  ["Tidy up", "completed"],
] as const

const where = (messages: ReadonlyArray<SessionMessage.Info>) => {
  const runs = ReminderText.runs(messages)
  return Verification.insertions({ messages }).map((insertion) => runs.findIndex((run) => run.anchor === insertion.after))
}

const closing = (...content: SessionMessage.AssistantContent[]) => [
  History.user("go"),
  History.assistant("build", ...content),
  History.user("next"),
]

describe("verification reminders", () => {
  test("fires in the run after a todo write that closes a list of three or more", () => {
    expect(where(closing(History.todoWrite(three)))).toEqual([1])
    expect(where(closing(History.todoWrite([...three, ["More", "completed"]])))).toEqual([1])
  })

  test("does not fire for two items, for an open item or for an item about checking", () => {
    expect(where(closing(History.todoWrite(three.slice(0, 2))))).toEqual([])
    expect(where(closing(History.todoWrite([...three.slice(0, 2), ["Last one", "pending"]])))).toEqual([])
    for (const word of ["Verify the build", "VERIFIED by hand", "Final verification"])
      expect(where(closing(History.todoWrite([...three.slice(0, 2), [word, "completed"]])))).toEqual([])
  })

  test("is not given to a child session", () => {
    const producer = SessionReminders.production.derived.find((item) => item.name === "verification")
    expect(producer?.scope).toBe("primary")
  })

  test("fires for a task update that completes the last open task", () => {
    expect(where(closing(History.taskUpdate("completed", three)))).toEqual([1])
    expect(where(closing(History.taskUpdate("completed", [...three.slice(0, 2), ["Tidy up", "pending"]])))).toEqual([])
  })

  test("does not fire for a delete, a create or a failed call", () => {
    expect(where(closing(History.taskUpdate("deleted", three)))).toEqual([])
    expect(where(closing(History.taskUpdate("completed", three, { name: "TaskCreate" })))).toEqual([])
    expect(where(closing(History.taskUpdate("completed", three, { failed: true })))).toEqual([])
    expect(where(closing(History.taskUpdate("completed", three, { name: "TaskList" })))).toEqual([])
  })

  test("fires again for a later closing call and once for two in one step", () => {
    const messages = [
      History.user("go"),
      History.assistant("build", History.todoWrite(three)),
      History.user("again"),
      History.assistant("build", History.todoWrite(three)),
      History.user("last"),
    ]
    expect(where(messages)).toEqual([1, 2])
    expect(where(closing(History.todoWrite(three), History.todoWrite(three)))).toEqual([1])
  })

  test("does not look at edits or shell calls", () => {
    expect(where(closing(History.tool("Read", { path: "a" }), History.todoWrite(three)))).toEqual([1])
    expect(where(closing(History.tool("Edit", { path: "a" }), History.tool("PowerShell"), History.todoWrite(three)))).toEqual([1])
  })

  test("reads the old tool names and keeps the insertion in its run as the conversation grows", () => {
    const base = closing(History.todoWrite(three, "todo"))
    expect(where(base)).toEqual([1])
    expect(where(closing(History.taskUpdate("completed", three, { name: "task_update" })))).toEqual([1])
    const first = Verification.insertions({ messages: base })
    const later = Verification.insertions({ messages: [...base, History.assistant("build", History.text())] })
    expect(first[0].after).toBe("tail")
    expect(later[0].after).not.toBe("tail")
    expect({ ...later[0], after: "x" }).toEqual({ ...first[0], after: "x" })
  })

  test("comes after the plan and todo producers in the production list", () => {
    expect(SessionReminders.production.derived.map((producer) => producer.name)).toEqual(["plan", "todo", "verification"])
  })
})
