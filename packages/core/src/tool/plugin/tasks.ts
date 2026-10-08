export * as TaskTools from "./tasks.js"

import { ToolFailure } from "@orbit/ai"
import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect, Option, Schema } from "effect"
import { KV } from "../../kv.js"

/**
 * A session's task list with ids and dependencies, for work too large for the flat todo plan. Tasks are kept in the
 * key-value store so they outlive the conversation's context window, and every call reports the whole list in the
 * todo shape so clients can show it as the session's plan.
 */

export const Status = Schema.Literals(["pending", "in_progress", "completed"])

export const Task = Schema.Struct({
  id: Schema.String,
  subject: Schema.String,
  description: Schema.optionalKey(Schema.String),
  status: Status,
  blockedBy: Schema.Array(Schema.String),
})
export type Task = typeof Task.Type

const Tasks = Schema.Array(Task)
const Output = Schema.Struct({ tasks: Tasks })
const decodeTasks = Schema.decodeUnknownOption(Tasks)

export const CreateInput = Schema.Struct({
  subject: Schema.String.check(Schema.isMinLength(1)).annotate({
    description: "The task, as a short imperative phrase",
  }),
  description: Schema.optionalKey(Schema.String).annotate({ description: "What done looks like, and any details" }),
  blockedBy: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Ids of tasks that must be completed first",
  }),
})

export const UpdateInput = Schema.Struct({
  id: Schema.String.annotate({ description: "Id of the task to change" }),
  status: Schema.optionalKey(Schema.Literals(["pending", "in_progress", "completed", "deleted"])).annotate({
    description: '"deleted" removes the task and its use as a dependency',
  }),
  subject: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  addBlockedBy: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "Ids of further tasks that must be completed first",
  }),
})

export const Plugin = {
  id: "orbit.tool.tasks",
  effect: Effect.fn("TaskTools.Plugin")(function* (ctx: Context) {
    const kv = yield* KV.Service
    const key = (sessionID: string) => `session-tasks:${sessionID}`
    const load = (sessionID: string) =>
      kv.get(key(sessionID)).pipe(Effect.map((value) => Option.getOrElse(decodeTasks(value ?? []), () => [])))
    const save = (sessionID: string, tasks: readonly Task[]) =>
      kv.set(key(sessionID), Schema.encodeSync(Tasks)(tasks) as KV.Value)

    const respond = (tasks: readonly Task[], summary: string) => ({
      output: { tasks },
      content: `${summary}\n\n${render(tasks)}`,
      metadata: { todos: tasks.map((task) => ({ content: task.subject, status: task.status })) },
    })

    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "task_create",
        options: { authorizes: true, codemode: false },
        traits: { readOnly: false, concurrencySafe: false },
        description:
          "Add a task to this session's task list. Use the task tools instead of todo when work has many steps or steps that depend on each other; use blockedBy to record what must finish first.",
        input: CreateInput,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            const tasks = yield* load(context.sessionID)
            yield* unknownIds(tasks, input.blockedBy ?? [])
            const id = String(Math.max(0, ...tasks.map((task) => Number(task.id) || 0)) + 1)
            const next = [
              ...tasks,
              {
                id,
                subject: input.subject,
                ...(input.description ? { description: input.description } : {}),
                status: "pending" as const,
                blockedBy: [...(input.blockedBy ?? [])],
              },
            ]
            yield* save(context.sessionID, next)
            return respond(next, `Created task #${id}.`)
          }),
      })
      editor.add({
        name: "task_update",
        options: { authorizes: true, codemode: false },
        traits: { readOnly: false, concurrencySafe: false },
        description:
          "Change a task: set its status as you start and finish it, edit its subject or description, add dependencies, or delete it. Mark a task completed only when it is fully done.",
        input: UpdateInput,
        output: Output,
        execute: (input, context) =>
          Effect.gen(function* () {
            const tasks = yield* load(context.sessionID)
            const current = tasks.find((task) => task.id === input.id)
            if (!current) return yield* new ToolFailure({ message: `There is no task #${input.id}.` })
            yield* unknownIds(tasks, input.addBlockedBy ?? [])
            if ((input.addBlockedBy ?? []).includes(input.id))
              return yield* new ToolFailure({ message: "A task cannot depend on itself." })
            if (input.status === "deleted") {
              const next = tasks
                .filter((task) => task.id !== input.id)
                .map((task) => ({ ...task, blockedBy: task.blockedBy.filter((id) => id !== input.id) }))
              yield* save(context.sessionID, next)
              return respond(next, `Deleted task #${input.id}.`)
            }
            const updated: Task = {
              ...current,
              ...(input.subject ? { subject: input.subject } : {}),
              ...(input.description !== undefined ? { description: input.description } : {}),
              ...(input.status ? { status: input.status } : {}),
              blockedBy: [...new Set([...current.blockedBy, ...(input.addBlockedBy ?? [])])],
            }
            const next = tasks.map((task) => (task.id === input.id ? updated : task))
            yield* save(context.sessionID, next)
            const waiting = open(next, updated)
            return respond(
              next,
              updated.status === "in_progress" && waiting.length > 0
                ? `Updated task #${input.id}. Note: it is still blocked by ${waiting.map((id) => `#${id}`).join(", ")}.`
                : `Updated task #${input.id}.`,
            )
          }),
      })
      editor.add({
        name: "task_list",
        options: { authorizes: true, codemode: false },
        traits: { readOnly: true, concurrencySafe: true },
        description:
          "Show this session's tasks with their status and dependencies. A task is ready when every task it depends on is completed.",
        input: Schema.Struct({}),
        output: Output,
        execute: (_input, context) =>
          load(context.sessionID).pipe(
            Effect.map((tasks) => respond(tasks, tasks.length === 0 ? "No tasks yet." : `${tasks.length} tasks.`)),
          ),
      })
    })
  }),
}

const unknownIds = (tasks: readonly Task[], ids: readonly string[]) => {
  const missing = ids.filter((id) => !tasks.some((task) => task.id === id))
  return missing.length === 0
    ? Effect.void
    : Effect.fail(new ToolFailure({ message: `Unknown task ids: ${missing.map((id) => `#${id}`).join(", ")}.` }))
}

/** Dependencies of a task that are not completed yet. */
const open = (tasks: readonly Task[], task: Task) =>
  task.blockedBy.filter((id) => tasks.find((other) => other.id === id)?.status !== "completed")

function render(tasks: readonly Task[]) {
  return tasks
    .map((task) => {
      const waiting = open(tasks, task)
      const blocked = waiting.length > 0 ? ` (blocked by ${waiting.map((id) => `#${id}`).join(", ")})` : ""
      return `#${task.id} [${task.status}] ${task.subject}${blocked}`
    })
    .join("\n")
}
