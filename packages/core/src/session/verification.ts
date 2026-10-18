export * as Verification from "./verification.js"

import { ToolNames } from "../tool/names.js"
import { TodoReminders } from "../tool/todo-reminders.js"
import { ReminderText } from "./reminder-text.js"
import type { SessionMessage } from "./message.js"
import type { Derived, Input, Insertion } from "./reminders.js"

/**
 * A nudge to check the work, derived from history. When a step closes out a list of at least three items (every item
 * completed, none about verifying) the run that follows its tool results gets the nudge, at most once. A closing call
 * of either list tool fires it each time, with no limit per prompt and no regard to what was edited.
 */

const MIN_ITEMS = 3

export const producer: Derived = { name: "verification", scope: "primary", run: (input) => insertions(input) }

export const insertions = (input: Pick<Input, "messages">): ReadonlyArray<Insertion> => {
  const runs = ReminderText.runs(input.messages)
  return runs.flatMap((run, index) =>
    index > 0 && runs[index - 1].step?.content.some(closesList)
      ? [{ after: run.anchor, kind: "verification", text: TEXT }]
      : [],
  )
}

const closesList = (tool: SessionMessage.AssistantContent) => {
  if (tool.type !== "tool") return false
  const name = ToolNames.canonical(tool.name)
  if (name !== "TodoWrite" && name !== "TaskUpdate") return false
  if (name === "TaskUpdate" && tool.state.status === "completed" && tool.state.input.status !== "completed")
    return false
  const items = TodoReminders.itemsOf(tool)
  return (
    items !== undefined &&
    items.length >= MIN_ITEMS &&
    items.every((item) => item.status === "completed" && !/verif/i.test(item.content))
  )
}

const TEXT =
  "A list of three or more items has just been marked done, and none of its items was about checking the work. Before you report back, check what you changed: run the project's relevant tests, type check or build. In your report, say plainly anything you did not check."
