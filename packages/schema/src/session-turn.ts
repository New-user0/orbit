export * as SessionTurn from "./session-turn.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { optional, PositiveInt } from "./schema.js"

/** The name of the tool that hands in the answer of a turn that asked for `output`; clients read the answer from its calls. */
export const OUTPUT_TOOL = "StructuredOutput"
/** The most attempts a turn may allow for a structured answer. */
export const MAX_OUTPUT_ATTEMPTS = 20
/** The attempts a turn allows for a structured answer when the prompt names none. */
export const DEFAULT_OUTPUT_ATTEMPTS = 5

export interface Output extends Schema.Schema.Type<typeof Output> {}
export const Output = Schema.Struct({
  schema: Schema.Record(Schema.String, Schema.Json).annotate({
    description:
      "A JSON Schema whose root declares type object. The server checks it when the prompt is admitted and refuses a schema it cannot enforce.",
  }),
  attempts: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_OUTPUT_ATTEMPTS)).pipe(optional),
}).annotate({
  identifier: "Session.Turn.Output",
  description:
    "Asks that the turn end with an answer shaped by a JSON Schema, handed in through a tool. `attempts` is how many responses may hand in a non-matching answer before the turn fails; it defaults to 5 and is at most 20.",
})

export interface Options extends Schema.Schema.Type<typeof Options> {}
export const Options = Schema.Struct({
  maxSteps: PositiveInt.pipe(optional),
  maxCost: Money.USD.check(Schema.isGreaterThan(0)).pipe(optional),
  maxTokens: PositiveInt.pipe(optional),
  fallbackModel: Model.Ref.pipe(optional),
  output: Output.pipe(optional),
}).annotate({
  identifier: "Session.Turn.Options",
  description:
    "Limits and a fallback model that a prompt asks for on the turn it belongs to. They are recorded with the prompt, and a field left out asks for nothing.",
})

/**
 * The `turn` field of a request body. A key that `Options` does not define is refused instead of dropped, because a
 * dropped key admits the prompt with fewer limits than it asked for: `max_steps` alone would read as no limit, and
 * `max_cost` beside a valid `maxSteps` would lose the cost limit. Options with nothing left in them also lift the limits
 * set earlier in the turn. Stored messages keep decoding with `Options`, which ignores keys that another version may
 * have added.
 */
export const RequestField = Options.pipe(optional, Schema.annotate({ parseOptions: { onExcessProperty: "error" } }))
