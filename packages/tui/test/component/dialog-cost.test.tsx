import { expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@orbit/client"
import { CostView, DialogCost } from "../../src/component/dialog-cost"
import { costSummary } from "../../src/util/cost"
import { json } from "../fixture/tui-client"
import { model, renderLocal, session as sessionFixture } from "../fixture/local"

const usage = (input: number) => ({ input, output: input / 2, reasoning: 1, cache: { read: 10, write: 5 } })

// Only the fields /cost reads; the rest of a message is not its business.
const assistant = (
  id: string,
  modelID: string,
  input: number,
  cost: number | undefined,
  time: { created: number; streamed?: number; completed?: number } = { created: 0 },
) =>
  ({
    id,
    type: "assistant",
    model: { providerID: "provider", id: modelID },
    tokens: usage(input),
    cost,
    time,
  }) as unknown as SessionMessageInfo

const compaction = (id: string, modelID: string, input: number, cost: number) =>
  ({
    id,
    type: "compaction",
    status: "completed",
    model: { providerID: "provider", id: modelID },
    tokens: usage(input),
    cost,
    time: { created: 0 },
  }) as unknown as SessionMessageInfo

// A catalog entry with a price, and one with zero-valued prices; `model()` has none at all (the server records $0 for it).
const priced = (id: string): ModelInfo => ({
  ...model(id),
  cost: [{ input: 1, output: 2, cache: { read: 0, write: 0 } }] as unknown as ModelInfo["cost"],
})
const zeroPriced = (id: string): ModelInfo => ({
  ...model(id),
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }] as unknown as ModelInfo["cost"],
})

type Info = Parameters<typeof costSummary>[0]
const info = (cost: number, input: number) => ({ cost, tokens: usage(input), time: { created: 0 } }) as Info
const session = info(0.75, 300)

test("totals and per-model sums come from the assistant messages", () => {
  const summary = costSummary(
    session,
    [
      assistant("a", "big", 100, 0.5, { created: 1_000, streamed: 3_000, completed: 3_000 }),
      assistant("b", "big", 100, 0.25, { created: 4_000, streamed: 5_000, completed: 5_000 }),
      assistant("c", "small", 100, 0.0, { created: 6_000, streamed: 6_500, completed: 6_500 }),
    ],
    [priced("big"), zeroPriced("small")],
  )
  expect(summary.cost).toBe(0.75)
  expect(summary.partial).toBe(false)
  expect(summary.api).toBe(3_500)
  // From the session's creation, not the first loaded message.
  expect(summary.wall).toBe(6_500)
  expect(summary.models.map((row) => [row.modelID, row.responses, row.cost, row.tokens.input])).toEqual([
    ["big", 2, 0.75, 200],
    ["small", 1, 0, 100],
  ])
})

test("a session with no assistant messages has no models and no times", () => {
  const summary = costSummary(info(0, 0), [], undefined)
  expect(summary).toMatchObject({ cost: 0, wall: undefined, api: undefined, models: [] })
})

test("a model the catalog has no price for is unknown even though the server recorded $0", () => {
  const summary = costSummary(info(0, 100), [assistant("a", "local", 100, 0)], [model("local")])
  expect(summary.cost).toBeUndefined()
  expect(summary.models[0]).toMatchObject({ cost: undefined, unpriced: 1 })
  // Zero-valued catalog entries are priced: the figure stays $0.
  const free = costSummary(info(0, 100), [assistant("a", "free", 100, 0)], [zeroPriced("free")])
  expect(free.cost).toBe(0)
  expect(free.models[0]).toMatchObject({ cost: 0, unpriced: 0 })
})

test("without a catalog a message without a cost is unknown, and a mix says some is missing", () => {
  const summary = costSummary(info(0, 100), [assistant("a", "local", 100, undefined)], undefined)
  expect(summary.cost).toBeUndefined()
  const mixed = costSummary(
    session,
    [assistant("a", "big", 100, 0.5), assistant("b", "local", 100, undefined)],
    undefined,
  )
  expect(mixed).toMatchObject({ cost: 0.75, partial: true })
})

test("API time ends at the provider response, not at tool settlement", () => {
  const long = assistant("a", "big", 100, 0.5, { created: 0, streamed: 2_000, completed: 62_000 })
  const summary = costSummary(session, [long], [priced("big")])
  expect(summary.api).toBe(2_000)
  expect(summary.wall).toBe(62_000)
  // No `streamed` stamp: unknown, never `completed`.
  const unstamped = assistant("a", "big", 100, 0.5, { created: 0, completed: 62_000 })
  expect(costSummary(session, [unstamped], [priced("big")]).api).toBeUndefined()
})

test("completed compactions count under their model and the remainder shows as other", () => {
  const summary = costSummary(
    info(1, 300),
    [assistant("a", "big", 100, 0.5), compaction("c", "big", 100, 0.25)],
    [priced("big")],
  )
  expect(summary.models[0]).toMatchObject({ responses: 2, cost: 0.75 })
  expect(summary.other).toBeCloseTo(0.25)
  expect(costSummary(session, [assistant("a", "big", 100, 0.75)], [priced("big")]).other).toBeUndefined()
})

test("a windowed history reports how many responses it covers and never claims unknown or other", () => {
  const summary = costSummary(info(5, 300), [assistant("a", "local", 100, 0)], [model("local")], true)
  expect(summary).toMatchObject({ cost: 5, loaded: 1, other: undefined, partial: true })
})

test("the dialog shows the figures, unknown prices and escaped model names", async () => {
  await using setup = await renderLocal()
  const summary = costSummary(
    info(0, 100),
    [assistant("a", "evil\u001b]0;pwned\u0007name", 100, undefined, { created: 0, streamed: 1000 })],
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
  setup.dialog.replace(() => <CostView summary={costSummary(info(0, 0), [], undefined)} />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Session cost"))
  expect(frame).toContain("$0.00")
  expect(frame).toMatch(/Wall-clock time\s+-/)
  expect(frame).toContain("No model response yet")
})

test("the dialog says when older responses are not loaded", async () => {
  await using setup = await renderLocal({
    sessions: [sessionFixture("windowed")],
    fetch: async (url) => {
      if (url.pathname !== "/api/session/windowed/message") return
      const loaded = assistant("a", "first", 100, 0.5, { created: 0, streamed: 1000 })
      return json({ data: [loaded], cursor: { next: "older" } })
    },
  })
  await setup.data.session.sync("windowed")
  await setup.data.session.message.sync("windowed")
  expect(setup.data.session.message.more("windowed")).toBe(true)
  setup.dialog.replace(() => <DialogCost sessionID="windowed" />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Session cost"))
  expect(frame.replace(/\s+/g, " ")).toContain("cover only the newest loaded response.")
})

test("a fork leaves out the messages it copied from its parent", () => {
  const fork = { ...info(0, 0), fork: { sessionID: "parent", boundary: {} }, time: { created: 10_000 } } as Info
  const copied = assistant("a", "big", 100, 1.5, { created: 1_000, streamed: 2_000, completed: 3_000 })
  expect(costSummary(fork, [copied], [priced("big")])).toMatchObject({
    cost: 0,
    models: [],
    api: undefined,
    wall: undefined,
  })
  const own = assistant("b", "big", 100, 0.5, { created: 11_000, streamed: 12_000, completed: 13_000 })
  const summary = costSummary({ ...fork, cost: 0.5 }, [copied, own], [priced("big")])
  expect(summary.models.map((row) => [row.responses, row.cost])).toEqual([[1, 0.5]])
  expect(summary).toMatchObject({ api: 1_000, wall: 3_000 })
})

test("a known amount is kept when no row is priced, and a recorded cost beats an empty catalog entry", () => {
  const titles = costSummary(info(0.01, 100), [assistant("a", "local", 100, undefined)], undefined)
  expect(titles).toMatchObject({ cost: 0.01, partial: true })
  const removed = costSummary(info(0.4, 100), [assistant("a", "big", 100, 0.4)], [model("big")])
  expect(removed.models[0]).toMatchObject({ cost: 0.4, unpriced: 0 })
})

test("a response that used no tokens is never counted as unpriced", () => {
  const idle = { ...assistant("a", "local", 0, 0), tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
  const summary = costSummary(info(0, 0), [idle as SessionMessageInfo], [model("local")])
  expect(summary.models[0]).toMatchObject({ responses: 1, unpriced: 0 })
})

test("the dialog counts several loaded responses in the plural", async () => {
  await using setup = await renderLocal()
  const summary = { ...costSummary(info(0, 0), [], undefined), loaded: 2 }
  setup.dialog.replace(() => <CostView summary={summary} />)
  const frame = await setup.waitForFrame((frame) => frame.includes("Session cost"))
  expect(frame.replace(/\s+/g, " ")).toContain("cover only the 2 newest loaded responses")
})
