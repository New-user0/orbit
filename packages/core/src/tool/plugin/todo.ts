export * as TodoTool from "./todo.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { Effect, Schema } from "effect"

export const name = "todo"

export const description = `Keep a short plan for the current task, shown to the user while you work.

- Use it for tasks with three or more steps; skip it for a single quick change or a question.
- Send the whole list every time: it replaces the previous one.
- Keep exactly one item in_progress while you work, and mark an item completed as soon as it is done.
- Write each item as a short imperative phrase, such as "Add a retry helper".`

export const Status = Schema.Literals(["pending", "in_progress", "completed"])

export const Item = Schema.Struct({
  content: Schema.String.annotate({ description: "The step, as a short imperative phrase" }),
  status: Status.annotate({ description: "pending, in_progress or completed" }),
})

export const Input = Schema.Struct({
  todos: Schema.Array(Item).annotate({ description: "The whole plan, in order" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(Item),
})

export const toModelContent = (todos: ReadonlyArray<typeof Item.Type>) => {
  const done = todos.filter((item) => item.status === "completed").length
  return `Plan updated: ${done} of ${todos.length} done.`
}

/** The plan lives in the tool call itself: clients show the input of the session's latest todo call. */
export const Plugin = {
  id: "orbit.tool.todo",
  effect: Effect.fn("TodoTool.Plugin")(function* (ctx: Context) {
    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          traits: { readOnly: false, concurrencySafe: false },
          description,
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.succeed({
              output: { todos: input.todos },
              content: toModelContent(input.todos),
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
