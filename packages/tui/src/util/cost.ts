import type { ModelInfo } from "@orbit/client"
import type { SessionCost } from "@orbit/schema/session-cost"

type Tokens = SessionCost.Row["tokens"]

/** Spend below this is rounding, not a figure to show. */
const EPSILON = 0.00005

/** Cents above $0.50 and four places below it, as the reference prints it. A price that is not known reads "unknown". */
export const money = (value: number) => `$${value > 0.5 ? value.toFixed(2) : value.toFixed(4)}`
export const price = (value: number | undefined, partial = false) =>
  value === undefined ? "unknown" : `${money(value)}${partial ? " + unpriced" : ""}`

/** A model the catalog has no price for is `undefined`, never zero: the server records $0 for it, which is not a free model. */
export type ModelCost = {
  providerID: string
  modelID: string
  name: string
  tokens: Tokens
  /** The sum of the recorded costs; undefined when every response of this model was unpriced. */
  cost: number | undefined
  /** Responses that used tokens but whose model has no price. */
  unpriced: number
}

/**
 * What /cost shows, from the server's summary of the whole session and its subagents. The catalog step stays here: a
 * response is unpriced when the server recorded no cost for it, or recorded $0 for a model the catalog lists without a
 * price (the server records $0 for it). Free models and models.dev models without a price both have zero-valued
 * catalog entries, so those two cannot be told apart. A model the catalog does not list keeps its recorded $0.
 */
export function costSummary(info: SessionCost.Info, models: ReadonlyArray<ModelInfo> | undefined) {
  const rows = info.rows
    .map((row): ModelCost => {
      const listed = models?.find((model) => model.providerID === row.providerID && model.id === row.modelID)
      const unpriced = row.unrecorded + (listed?.cost.length === 0 ? row.zero : 0)
      return {
        providerID: row.providerID,
        modelID: row.modelID,
        name: listed?.name ?? row.modelID,
        tokens: row.tokens,
        cost: unpriced >= row.responses ? undefined : row.cost,
        unpriced,
      }
    })
    .toSorted((left, right) => (right.cost ?? -1) - (left.cost ?? -1))
  const priced = rows.some((row) => row.cost !== undefined)
  // Everything was unpriced and nothing is recorded: the cost is unknown, not zero. A recorded amount above zero is
  // known even when no row is priced (for example title generation on a priced model).
  const unknown = !priced && rows.length > 0 && info.cost === 0

  return {
    cost: unknown ? undefined : info.cost,
    subagents: info.subagents > EPSILON ? info.subagents : undefined,
    partial: rows.some((row) => row.unpriced > 0) && (priced || info.cost > 0),
    wall: info.wall,
    api: info.api,
    lines: info.lines,
    models: rows,
    /** Spend the rows do not itemize: responses a rewind removed, and records from before they named a model. */
    other: info.other,
  }
}

export type CostSummary = ReturnType<typeof costSummary>
