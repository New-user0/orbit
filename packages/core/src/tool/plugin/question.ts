export * as QuestionTool from "./question.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolFailure } from "@orbit/ai"
import { Effect, Schema } from "effect"
import { Form } from "../../form.js"
import { Permission } from "../../permission.js"
import { Question } from "@orbit/schema/question"

export const name = "AskUserQuestion"

export const description = `Ask the user one to four questions while you work, then continue with their answers.

Reach for it to learn preferences or requirements, to resolve an ambiguous instruction, to settle an implementation decision, or to let the user pick a direction.

How questions are shaped:
- Send 1 to 4 questions per call. Question texts must differ from each other.
- Give every question 2 to 4 options with labels that differ within that question. Keep each label short and use the description for what the option means or costs.
- Do not add an option for a free-form reply. A "Type your own answer" row is always added for you.
- Set \`multiple: true\` when the choices are not mutually exclusive.
- To recommend an option, list it first and end its label with "(Recommended)".

Previews:
- An option may carry a \`preview\`: markdown that the user sees while that option is focused. It is drawn in a fixed-width box, so multi-line text such as a sketch of a layout, two competing code snippets or a configuration sample works well.
- Use a preview only when the user has to compare concrete artifacts. When the label and description are enough, leave it out.
- Previews are for single-select questions. On a \`multiple: true\` question they are ignored.

Planning:
- While planning, use this tool to pin down requirements or to choose between approaches before you finish the plan.
- Never use it to ask whether the plan is ready or whether to go ahead. Present the plan with ExitPlanMode instead.
- The user cannot see your plan until ExitPlanMode shows it, so do not word a question as if they had read it.`

export const Input = Schema.Struct({
  questions: Schema.Array(Question.Prompt)
    .check(
      Schema.isMinLength(1),
      Schema.isMaxLength(4),
      Schema.makeFilter((questions) =>
        new Set(questions.map((question) => question.question)).size === questions.length
          ? undefined
          : "Question texts must be different within a call",
      ),
    )
    .annotate({ description: "Questions to ask (1-4)" }),
})

export const Output = Schema.Struct({
  answers: Schema.Array(Question.Answer),
})
export type Output = typeof Output.Type

export class CancelledError extends Schema.TaggedError<CancelledError>()("QuestionTool.CancelledError", {}) {
  override get message() {
    return "The user dismissed this question"
  }
}

export const toModelContent = (questions: ReadonlyArray<Question.Prompt>, answers: ReadonlyArray<Question.Answer>) => {
  const formatted = questions
    .map((question, index) => {
      const answer = answers[index]
      const entry = `"${question.question}"="${answer?.length ? answer.join(", ") : "Unanswered"}"`
      const preview =
        question.multiple === true || answer?.length !== 1
          ? undefined
          : question.options.find((option) => option.label === answer[0])?.preview
      return preview ? `${entry} (preview of the chosen option:\n${preview}\n)` : entry
    })
    .join(", ")
  return `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`
}

export const Plugin = {
  id: "orbit.tool.question",
  effect: Effect.fn("QuestionTool.Plugin")(function* (ctx: Context) {
    const forms = yield* Form.Service
    const permission = yield* Permission.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { authorizes: true, codemode: false },
          traits: { requiresUserInteraction: true, interruptBehavior: "cancel", maxResultChars: 100_000 },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Permission denied: question", error })),
                Effect.andThen(
                  forms
                    .ask({
                      sessionID: context.sessionID,
                      title: "Questions",
                      metadata: {
                        kind: "question",
                        tool: { messageID: context.messageID, id: context.id },
                      },
                      fields: [
                        toField(input.questions[0], 0),
                        ...input.questions.slice(1).map((question, index) => toField(question, index + 1)),
                      ],
                    })
                    .pipe(Effect.orDie),
                ),
                Effect.flatMap((state) => {
                  // Deliberate defect tunnel (see Permission.assert): a dismissal must dodge
                  // leaf `mapError` blankets so it never becomes model-facing tool output; it
                  // resurfaces as a typed failure at SessionModelRequest.executeTool.
                  // A dismissal with a message (e.g. from a non-interactive client) is ordinary
                  // model-facing feedback: the model continues instead of the step ending.
                  if (state.status === "cancelled" && state.message !== undefined)
                    return Effect.fail(new ToolFailure({ message: state.message }))
                  if (state.status === "cancelled") return Effect.die(new CancelledError())
                  const output = {
                    answers: input.questions.map((_, index): Question.Answer => {
                      const value = state.answer[`q${index}`]
                      if (value === undefined) return []
                      if (typeof value === "object") return Array.from(value)
                      return [String(value)]
                    }),
                  }
                  return Effect.succeed({
                    output,
                    content: toModelContent(input.questions, output.answers),
                    metadata: { answers: output.answers },
                  })
                }),
              ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function toField(question: Question.Prompt, index: number): Form.Field {
  return {
    key: `q${index}`,
    title: question.header,
    description: question.question,
    type: question.multiple === true ? "multiselect" : "string",
    options: question.options.map((option) => ({
      value: option.label,
      label: option.label,
      description: option.description,
      // Previews are single-select only; dropping them here keeps every client from special-casing multiselect.
      ...(question.multiple !== true && option.preview ? { preview: option.preview } : {}),
    })),
    custom: true,
  }
}
