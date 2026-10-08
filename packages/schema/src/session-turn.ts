export * as SessionTurn from "./session-turn.js"

import { Schema } from "effect"
import { Model } from "./model.js"
import { Money } from "./money.js"
import { optional, PositiveInt } from "./schema.js"

export interface Options extends Schema.Schema.Type<typeof Options> {}
export const Options = Schema.Struct({
  maxSteps: PositiveInt.pipe(optional),
  maxCost: Money.USD.check(Schema.isGreaterThan(0)).pipe(optional),
  maxTokens: PositiveInt.pipe(optional),
  fallbackModel: Model.Ref.pipe(optional),
}).annotate({
  identifier: "Session.Turn.Options",
  description:
    "Limits and a fallback model that a prompt asks for on the turn it belongs to. They are recorded with the prompt, and a field left out asks for nothing.",
})
