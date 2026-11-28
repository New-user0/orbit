export * as SessionCost from "./session-cost.js"

import { Option, Schema } from "effect"
import { Money } from "./money.js"
import { NonNegativeInt, optional } from "./schema.js"
import { TokenUsage } from "./token-usage.js"

// The provider and model IDs come from records and configuration: they are carried as they were read and used only as
// labels, never joined into a key a client parses. Each client writes them to its own output through its own escaping.

/** What one model spent in the session and its subagents. */
export const Row = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  /** Responses, completed compactions and side requests of this model. */
  responses: NonNegativeInt,
  tokens: TokenUsage.Info,
  /** The sum of the recorded costs. */
  cost: Money.USD,
  /** Responses that used tokens but recorded no cost, or failed with neither. Their spend is unknown. */
  unrecorded: NonNegativeInt,
  /** Responses that used tokens and recorded exactly 0: free, or a model the catalog has no price for. */
  zero: NonNegativeInt,
}).annotate({ identifier: "SessionCost.Row" })
export type Row = typeof Row.Type

export const Lines = Schema.Struct({
  added: NonNegativeInt,
  removed: NonNegativeInt,
}).annotate({ identifier: "SessionCost.Lines" })
export type Lines = typeof Lines.Type

export const Info = Schema.Struct({
  /** The session's spend and its subagents', as the sessions' own totals hold it. */
  cost: Money.USD,
  /** The session's own part of `cost`. */
  own: Money.USD,
  /** The subagents' part of `cost`. */
  subagents: Money.USD,
  /** Spend no row explains: responses a rewind removed, and records written before they named a model. */
  other: Money.USD.pipe(optional),
  /** Milliseconds the provider spent answering, over the session and its subagents. */
  api: Schema.Finite.pipe(optional),
  /** Milliseconds from the session's creation to its newest finished response. */
  wall: Schema.Finite.pipe(optional),
  /** Lines the edit tools changed; unset for a session from before they were counted. */
  lines: Lines.pipe(optional),
  rows: Schema.Array(Row),
}).annotate({ identifier: "SessionCost.Info" })
export type Info = typeof Info.Type

const Envelope = Schema.Struct({ ...Info.fields, rows: Schema.Array(Schema.Unknown) })

/**
 * Decodes a server's answer for a client. The summary's own fields must decode, else there is no answer (`undefined`).
 * Each row is decoded on its own, so a row this client cannot read costs only itself: it is left out, and `dropped`
 * names where it was (as `rows[2]`) for the caller to log once.
 */
export function decode(input: unknown): { readonly info: Info; readonly dropped: ReadonlyArray<string> } | undefined {
  const envelope = Schema.decodeUnknownOption(Envelope)(input)
  if (Option.isNone(envelope)) return undefined
  const dropped: string[] = []
  const rows = envelope.value.rows.flatMap((raw, index) =>
    Option.match(Schema.decodeUnknownOption(Row)(raw), {
      onNone: () => {
        dropped.push(`rows[${index}]`)
        return []
      },
      onSome: (value) => [value],
    }),
  )
  return { info: { ...envelope.value, rows }, dropped }
}
