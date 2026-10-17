export * as IdentityPlugin from "./identity.js"

import { SystemPart } from "@orbit/ai"
import { define } from "@orbit/plugin/effect/plugin"
import type { SessionHooks } from "@orbit/plugin/effect/session"
import { Model } from "@orbit/schema/model"
import { Effect } from "effect"

// A fixed table, so that the text never depends on the locale or the time zone of the machine.
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]

/** The cutoff as a month and a year, from the catalog's `YYYY-MM`. */
const cutoff = (knowledge: Model.Knowledge) => `${MONTHS[Number(knowledge.slice(5)) - 1]} ${knowledge.slice(0, 4)}`

export function identity(model: {
  readonly name: string
  readonly ref: Model.Ref
  readonly knowledge?: Model.Knowledge
}) {
  return [
    "# Your Model",
    `- Name: ${model.name}`,
    `- Provider ID: ${model.ref.providerID}`,
    `- Model ID: ${model.ref.id}`,
    ...(model.knowledge ? [`- Knowledge cutoff: ${cutoff(model.knowledge)}`] : []),
  ].join("\n")
}

export const Plugin = define({
  id: "orbit.prompt.identity",
  effect: Effect.fn("IdentityPlugin")(function* (ctx) {
    const hook = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        const listed = (yield* ctx.model.list()).data.find(
          (model) => model.providerID === event.model.providerID && model.id === event.model.id,
        )
        // A model the catalog does not list has no cutoff: the fallback entry says nothing about the model.
        const model = listed ?? Model.Info.default(event.model.providerID, event.model.id)
        event.system.splice(
          1,
          0,
          SystemPart.make(identity({ name: model.name, ref: event.model, knowledge: listed?.knowledge })),
        )
      }).pipe(Effect.catch(() => Effect.void))
    yield* ctx.session.hook("context", hook)
    yield* ctx.session.hook("compaction", hook)
    yield* ctx.session.hook("generate", hook)
  }),
})
