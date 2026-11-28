import { describe, expect, test } from "bun:test"
import { SessionCost } from "../src/session-cost.js"

const row = (modelID: string) => ({
  providerID: "p",
  modelID,
  responses: 1,
  tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  cost: 0.5,
  unrecorded: 0,
  zero: 0,
})
const summary = (rows: ReadonlyArray<unknown>) => ({ cost: 1, own: 0.5, subagents: 0.5, rows })

describe("SessionCost.decode", () => {
  test("decodes a whole answer and drops nothing", () => {
    const answer = SessionCost.decode(summary([row("a"), row("b")]))
    expect(answer?.dropped).toEqual([])
    expect(answer?.info.rows.map((item) => item.modelID)).toEqual(["a", "b"])
  })

  test("a row this client cannot read costs only itself, and is named by its position", () => {
    const answer = SessionCost.decode(summary([row("a"), { providerID: "p" }, row("c"), "text"]))
    expect(answer?.info.rows.map((item) => item.modelID)).toEqual(["a", "c"])
    expect(answer?.dropped).toEqual(["rows[1]", "rows[3]"])
  })

  test("a row with a count that is negative or not whole is dropped, field by field", () => {
    const bad: ReadonlyArray<readonly [string, unknown]> = [
      ["responses", { ...row("x"), responses: -1 }],
      ["responses", { ...row("x"), responses: 1.5 }],
      ["unrecorded", { ...row("x"), unrecorded: -1 }],
      ["zero", { ...row("x"), zero: -1 }],
      ["zero", { ...row("x"), zero: 0.5 }],
      ["cost", { ...row("x"), cost: "1" }],
    ]
    bad.forEach(([field, item]) => {
      const answer = SessionCost.decode(summary([row("a"), item]))
      expect(answer?.info.rows.map((kept) => kept.modelID), field).toEqual(["a"])
      expect(answer?.dropped, field).toEqual(["rows[1]"])
    })
  })

  test("an answer whose own fields do not decode is no answer", () => {
    expect(SessionCost.decode({ rows: [] })).toBeUndefined()
    expect(SessionCost.decode(undefined)).toBeUndefined()
  })
})
