import { expect, test } from "bun:test"
import type { ModelInfo } from "@orbit/client"
import type { SessionCost } from "@orbit/schema/session-cost"
import { costSummary, money, price } from "../../src/util/cost"

// clients-ux-23 part 2: the catalog step of /cost, on the summary itself (the dialog and `orb run "/cost"` both draw it).

const row = (modelID: string, overrides: Record<string, unknown> = {}, providerID = "p") =>
  ({
    providerID,
    modelID,
    responses: 1,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    unrecorded: 0,
    zero: 0,
    ...overrides,
  }) as unknown as SessionCost.Row
const info = (overrides: Record<string, unknown> = {}) =>
  ({ cost: 0, own: 0, subagents: 0, rows: [], ...overrides }) as unknown as SessionCost.Info
const listed = (providerID: string, id: string, name: string, priced: boolean) =>
  ({ providerID, id, name, cost: priced ? [{ input: 1, output: 1 }] : [] }) as unknown as ModelInfo

test("a row is named by the catalog entry of its own provider and model, else by its model ID", () => {
  const summary = costSummary(info({ cost: 1, rows: [row("m", { cost: 1 })] }), [
    listed("other", "m", "Wrong provider", true),
    listed("p", "m", "Right", true),
  ])
  expect(summary.models.map((model) => model.name)).toEqual(["Right"])
  expect(costSummary(info({ cost: 1, rows: [row("m", { cost: 1 })] }), [listed("other", "m", "Wrong", true)]).models[0]?.name).toBe("m")
  expect(costSummary(info({ cost: 1, rows: [row("m", { cost: 1 })] }), undefined).models[0]?.name).toBe("m")
})

test("rows run from the costliest down, and an unpriced row comes last", () => {
  const summary = costSummary(
    info({ cost: 6, rows: [row("cheap", { cost: 1 }), row("none", { unrecorded: 1 }), row("dear", { cost: 5 })] }),
    undefined,
  )
  expect(summary.models.map((model) => model.modelID)).toEqual(["dear", "cheap", "none"])
})

test("the total reads unknown only when there are rows, all unpriced, and nothing was recorded", () => {
  expect(costSummary(info({ rows: [row("a", { unrecorded: 1 })] }), undefined).cost).toBeUndefined()
  // No rows at all: a session that has not answered yet costs $0, not unknown.
  expect(Number(costSummary(info({ rows: [] }), undefined).cost)).toBe(0)
  // A recorded amount is known even when no row is priced.
  expect(Number(costSummary(info({ cost: 0.2, rows: [row("a", { unrecorded: 1 })] }), undefined).cost)).toBe(0.2)
})

test("the figure is flagged incomplete only when something was priced or recorded beside the unpriced rows", () => {
  expect(costSummary(info({ rows: [row("a", { unrecorded: 1 })] }), undefined).partial).toBe(false)
  expect(costSummary(info({ cost: 0.2, rows: [row("a", { unrecorded: 1 })] }), undefined).partial).toBe(true)
  expect(costSummary(info({ cost: 1, rows: [row("a", { cost: 1 }), row("b", { unrecorded: 1 })] }), undefined).partial).toBe(true)
  expect(costSummary(info({ cost: 1, rows: [row("a", { cost: 1 })] }), undefined).partial).toBe(false)
})

test("a recorded zero reads unpriced only for a model the catalog lists without a price", () => {
  const zero = info({ rows: [row("a", { zero: 1 })] })
  expect(costSummary(zero, [listed("p", "a", "A", false)]).models[0]).toMatchObject({ unpriced: 1, cost: undefined })
  expect(costSummary(zero, [listed("p", "a", "A", true)]).models[0]).toMatchObject({ unpriced: 0, cost: 0 })
  expect(costSummary(zero, undefined).models[0]).toMatchObject({ unpriced: 0, cost: 0 })
})

test("money and price round as the reference prints", () => {
  expect(money(0.5)).toBe("$0.5000")
  expect(money(0.5001)).toBe("$0.50")
  expect(price(undefined)).toBe("unknown")
  expect(price(1, true)).toBe("$1.00 + unpriced")
})

test("subagent spend is shown only above the rounding threshold", () => {
  expect(costSummary(info({ cost: 1, subagents: 0 }), undefined).subagents).toBeUndefined()
  expect(costSummary(info({ cost: 1, subagents: 0.00005 }), undefined).subagents).toBeUndefined()
  expect(Number(costSummary(info({ cost: 1, subagents: 0.0001 }), undefined).subagents)).toBe(0.0001)
})
