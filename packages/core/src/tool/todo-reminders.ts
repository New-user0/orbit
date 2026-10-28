export * as TodoReminders from "./todo-reminders.js"

import { Option, Schema } from "effect"
import { ReminderText } from "../session/reminder-text.js"
import type { Derived, Input, Insertion } from "../session/reminders.js"
import type { SessionMessage } from "../session/message.js"
import { ToolNames } from "./names.js"

/**
 * A nudge to look at the todo or task list, derived from history. Assistant text and tool calls are counted one by one
 * (reasoning is not), and the nudge comes before a run once at least ten have passed since both the latest call that
 * changes the list and the latest nudge. A call counts however it ended. The count starts again after a compaction,
 * while the lists themselves cross it in the compaction's rehydration row (`current`), as the reference keeps them in
 * its app state.
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
const FamilyName = Schema.Literals(["todo", "task"])

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
  return walk(input.messages, input.tools.includes("TodoWrite") ? "todo" : "task").out
}

/**
 * The lists as the producer's scan leaves them at the end of the epoch: the newest todo list, the newest task list, and
 * the family of the newest call that changed a list. A compaction carries them in its rehydration row.
 */
export const current = (messages: ReadonlyArray<SessionMessage.Info>) => walk(messages).lists

export interface Lists {
  readonly todos: ReadonlyArray<Item>
  readonly tasks: ReadonlyArray<Item>
  readonly family?: typeof FamilyName.Type
}

// Folds the epoch's runs in order. With `fallback`, the wording when no list call named a family, it also places the
// nudges.
const walk = (messages: ReadonlyArray<SessionMessage.Info>, fallback?: typeof FamilyName.Type) => {
  const out: Insertion[] = []
  let sinceWrite = 0
  let sinceNudge = 0
  let lists: Lists = { todos: [], tasks: [] }

  ReminderText.runs(messages).forEach((run) => {
    // A rehydration row sets the lists it carries and leaves both counts as they are.
    run.messages.forEach((message) => {
      const found = carried(message)
      if (found === undefined) return
      lists = {
        todos: found.todos ?? lists.todos,
        tasks: found.tasks ?? lists.tasks,
        family: found.family ?? lists.family,
      }
    })
    if (fallback !== undefined && sinceWrite >= GAP && sinceNudge >= GAP) {
      sinceNudge = 0
      const variant = lists.family ?? fallback
      // The todo tool empties its list when a call completes every item, so a fully completed list shows nothing.
      const items =
        variant === "task" ? lists.tasks : lists.todos.every((item) => item.status === "completed") ? [] : lists.todos
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
        lists = { ...lists, family: name === "TodoWrite" ? "todo" : "task" }
      } else sinceWrite += 1
      const items = itemsOf(part)
      if (items === undefined) return
      if (name === "TodoWrite") lists = { ...lists, todos: items }
      if (name === "TaskCreate" || name === "TaskUpdate" || name === "TaskList") lists = { ...lists, tasks: items }
    })
  })
  return { out, lists }
}

// The lists a rehydration row carries. The row is stored session data, which an import can supply (class 5), so each
// list is decoded on its own and a malformed one costs only itself (class 7).
const carried = (message: SessionMessage.Info) => {
  if (message.type !== "synthetic") return undefined
  const rehydration = message.metadata?.rehydration
  if (typeof rehydration !== "object" || rehydration === null) return undefined
  const field = (key: string) => (rehydration as Record<string, unknown>)[key]
  return {
    todos: Option.getOrUndefined(Schema.decodeUnknownOption(Items)(field("todos"))),
    tasks: Option.getOrUndefined(Schema.decodeUnknownOption(Items)(field("tasks"))),
    family: Option.getOrUndefined(Schema.decodeUnknownOption(FamilyName)(field("family"))),
  }
}

const todoText = (listed: boolean) =>
  `The todo list has sat unchanged for several steps and may no longer match the work. If the work has several steps, bring it up to date with TodoWrite and drop entries that went stale.${listed ? " The list as it stands follows." : ""}`

const taskText = (listed: boolean) =>
  `The task list has sat unchanged for several steps and may no longer match the work. If the work has several steps, record new tasks with TaskCreate and update existing ones with TaskUpdate: in_progress when a task starts, completed when it ends. Remove tasks that went stale.${listed ? " The tasks as they stand follow." : ""}`
