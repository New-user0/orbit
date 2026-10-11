export * as Question from "./question.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

const Option = Schema.Struct({
  label: Schema.String.annotate({ description: "Display text (1-5 words, concise)" }),
  description: Schema.String.annotate({ description: "Explanation of choice" }),
  // Annotate the inner schema: an annotation on the optional() wrapper never reaches the JSON Schema.
  preview: optional(
    Schema.String.annotate({
      description:
        "Optional markdown that a client may show while this option is focused. Single-select questions only; ignored when multiple is true.",
    }),
  ),
})

const base = {
  question: Schema.String.annotate({ description: "Complete question" }),
  header: Schema.String.annotate({ description: "Very short label (max 12 chars)" }),
  options: Schema.Array(Option)
    .annotate({ description: "Available choices (2-4)" })
    .check(
      Schema.isMinLength(2),
      Schema.isMaxLength(4),
      Schema.makeFilter<ReadonlyArray<{ readonly label: string }>>(
        (options) =>
          new Set(options.map((option) => option.label)).size === options.length
            ? undefined
            : "Option labels must be different within a question",
        // The client generator serializes every check, so a custom filter must describe itself.
        // The runtime string is never emitted: only `.Type` of this representation is consumed.
        {
          representation: { id: "orbit/question/uniqueLabels", payload: null },
          toCode: () => ({ runtime: "Schema.makeFilter(() => undefined)" }),
        },
      ),
    ),
  multiple: optional(Schema.Boolean.annotate({ description: "Allow selecting multiple choices" })),
}

export const Prompt = Schema.Struct(base).annotate({ identifier: "Question.Prompt" })
export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}

export const Answer = Schema.Array(Schema.String).annotate({ identifier: "Question.Answer" })
export type Answer = typeof Answer.Type
