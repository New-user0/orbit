export * as TodoReminders from "./todo-reminders.js"

import { Option, Schema } from "effect"
import { ReminderText } from "../session/reminder-text.js"
import type { Derived, Input, Insertion } from "../session/reminders.js"
import type { SessionMessage } from "../session/message.js"
import { ToolNames } from "./names.js"

/**
 * A nudge to look at the todo or task list, derived from history. Assistant text and tool calls are counted one by one
 * (reasoning is not), and the nudge comes before a run once at least ten have passed since both the latest call that
 * changes the list and the latest nudge. A call counts however it ended. The count starts again after a compaction.
 *
 * Whether the nudge is wanted at all depends on the tools offered now, for every position, so a change in the tool set
 * moves earlier nudges. It is the one producer whose earlier runs read the tool names, because a session without a
 * list tool should never see one.
 */

const GAP = 10

export const producer: Derived = { name: "todo", run: (input) => insertions(input) }

export type Given = Pick<Input, "tools" | "messages">

const Items = Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String }))
const TodoInput = Schema.Struct({ todos: Items })
const Metadata = Schema.Struct({ todos: Items })

export type Item = (typeof Items.Type)[number]

type Part = SessionMessage.AssistantContent
export type Tool = Extract<Part, { type: "tool" }>

/** The items a completed `TodoWrite` call carried, or the list a completed task tool left in its metadata. */
export const itemsOf = (part: Tool): ReadonlyArray<Item> | undefined => {
  if (part.state.status !== "completed") return undefined
  if (ToolNames.canonical(part.name) === "TodoWrite")
    return Option.getOrUndefined(Schema.decodeUnknownOption(TodoInput)(part.state.input))?.todos
  return Option.getOrUndefined(Schema.decodeUnknownOption(Metadata)(part.state.metadata))?.todos
}

export const insertions = (input: Given): ReadonlyArray<Insertion> => {
  if (!input.tools.includes("TodoWrite") && !input.tools.includes("TaskUpdate")) return []
  const out: Insertion[] = []
  let sinceWrite = 0
  let sinceNudge = 0
  let family: "todo" | "task" | undefined
  let todos: ReadonlyArray<Item> = []
  let tasks: ReadonlyArray<Item> = []

  ReminderText.runs(input.messages).forEach((run) => {
    if (sinceWrite >= GAP && sinceNudge >= GAP) {
      sinceNudge = 0
      const variant = family ?? (input.tools.includes("TodoWrite") ? "todo" : "task")
      // The todo tool empties its list when a call completes every item, so a fully completed list shows nothing.
      const items =
        variant === "task" ? tasks : todos.every((item) => item.status === "completed") ? [] : todos
      out.push({
        after: run.anchor,
        kind: "todo",
        text: variant === "todo" ? todoText(items.length > 0) : taskText(items.length > 0),
        ...(items.length > 0
          ? {
              data: {
                label: variant === "todo" ? "Current todo list" : "Current task list",
                content: items.map((item, index) => `${index + 1}. [${item.status}] ${item.content}`).join("\n"),
              },
            }
          : {}),
      })
    }
    run.step?.content.forEach((part) => {
      if (part.type === "reasoning") return
      sinceNudge += 1
      if (part.type === "text") {
        sinceWrite += 1
        return
      }
      const name = ToolNames.canonical(part.name)
      if (name === "TodoWrite" || name === "TaskCreate" || name === "TaskUpdate") {
        sinceWrite = 0
        family = name === "TodoWrite" ? "todo" : "task"
      } else sinceWrite += 1
      const items = itemsOf(part)
      if (items === undefined) return
      if (name === "TodoWrite") todos = items
      if (name.startsWith("Task")) tasks = items
    })
  })
  return out
}

const todoText = (listed: boolean) =>
  `The todo list has not been touched for a while. If the work in front of you would benefit from tracking, update it with TodoWrite, and tidy a list that no longer matches what you are doing. Use it only when it fits; if it does not, carry on.${listed ? " The list as it stands follows." : ""}`

const taskText = (listed: boolean) =>
  `The task list has not been touched for a while. If the work in front of you would benefit from tracking, add tasks with TaskCreate and move them with TaskUpdate: in_progress when you start one, completed when it is done. Tidy tasks that no longer match what you are doing. Use the list only when it fits; if it does not, carry on.${listed ? " The tasks as they stand follow." : ""}`
