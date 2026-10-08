import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@orbit/client"
import { CostView } from "../../src/component/dialog-cost"
import { costSummary } from "../../src/util/cost"
import { model, renderLocal } from "../fixture/local"

const usage = (input: number) => ({ input, output: input / 2, reasoning: 1, cache: { read: 10, write: 5 } })

// Only the fields /cost reads; the rest of a message is not its business.
const assistant = (id: string, modelID: string, input: number, cost: number | undefined, span?: [number, number]) =>
  ({
    id,
    type: "assistant",
    model: { providerID: "provider", id: modelID },
    tokens: usage(input),
    cost,
    time: span ? { created: span[0], completed: span[1] } : { created: 0 },
  }) as unknown as SessionMessageInfo

type Info = Parameters<typeof costSummary>[0]
const session = { cost: 0.75, tokens: usage(300) } as Info

test("totals and per-model sums come from the assistant messages", () => {
  const summary = costSummary(
    session,
    [
      assistant("a", "big", 100, 0.5, [1_000, 3_000]),
      assistant("b", "big", 100, 0.25, [4_000, 5_000]),
      assistant("c", "small", 100, 0.0, [6_000, 6_500]),
    ],
    [model("big"), model("small")],
  )
  expect(summary.cost).toBe(0.75)
  expect(summary.partial).toBe(false)
  expect(summary.api).toBe(3_500)
  expect(summary.wall).toBe(5_500)
  expect(summary.models.map((row) => [row.modelID, row.responses, row.cost, row.tokens.input])).toEqual([
    ["big", 2, 0.75, 200],
    ["small", 1, 0, 100],
  ])
})

test("a session with no assistant messages has no models and no times", () => {
  const summary = costSummary({ cost: 0, tokens: usage(0) } as Info, [], undefined)
  expect(summary).toMatchObject({ cost: 0, wall: undefined, api: undefined, models: [] })
})

test("a price the server did not report is unknown, never zero", () => {
  const summary = costSummary({ cost: 0, tokens: usage(100) } as Info, [assistant("a", "local", 100, undefined)], undefined)
  expect(summary.cost).toBeUndefined()
  expect(summary.models[0]).toMatchObject({ cost: undefined, unpriced: 1 })
  // A mix keeps the known part and says that some is missing.
  const mixed = costSummary(session, [assistant("a", "big", 100, 0.5), assistant("b", "local", 100, undefined)], undefined)
  expect(mixed).toMatchObject({ cost: 0.75, partial: true })
})

test("the dialog shows the figures, unknown prices and escaped model names", async () => {
  await using setup = await renderLocal()
  const summary = costSummary(
    { cost: 0, tokens: usage(100) } as Info,
    [assistant("a", "evil\u001b]0;pwned\u0007name", 100, undefined, [0, 1000])],
    undefined,
  )
  setup.dialog.replace(() => <CostView summary={summary} />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Session cost"))
  expect(frame).toContain("unknown")
  expect(frame).toContain("Input tokens")
  expect(frame).toContain("API time")
  expect(frame).not.toContain("$0")
  expect(frame.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
})

test("an empty session shows zeros and a dash for missing times", async () => {
  await using setup = await renderLocal()
  const summary = costSummary({ cost: 0, tokens: usage(0) } as Info, [], undefined)
  setup.dialog.replace(() => <CostView summary={summary} />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Session cost"))
  expect(frame).toContain("$0.00")
  expect(frame).toMatch(/Wall-clock time\s+-/)
  expect(frame).toContain("No model response yet")
})
