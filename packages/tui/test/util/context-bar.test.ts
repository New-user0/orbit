import { expect, test } from "bun:test"
import { contextBar, contextBreakdown } from "../../src/util/session"

test("the context bar fills one cell per eighth of the window", () => {
  expect(contextBar(0)).toBe("▯▯▯▯▯▯▯▯ 0%")
  expect(contextBar(34)).toBe("▮▮▮▯▯▯▯▯ 34%")
  expect(contextBar(100)).toBe("▮▮▮▮▮▮▮▮ 100%")
  expect(contextBar(140)).toBe("▮▮▮▮▮▮▮▮ 140%")
})

test("the context breakdown estimates the conversation and attributes the rest to the prompt and tools", () => {
  const model = { providerID: "p", id: "m" }
  const messages = [
    { type: "user", id: "u1", time: { created: 1 }, text: "x".repeat(400) },
    {
      type: "assistant",
      id: "a1",
      model,
      time: { created: 2 },
      tokens: { input: 5_000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [
        { type: "text", text: "y".repeat(200) },
        {
          type: "tool",
          id: "t1",
          name: "read",
          state: { status: "completed", input: { path: "a" }, content: [{ type: "text", text: "z".repeat(800) }] },
        },
      ],
    },
  ] as unknown as Parameters<typeof contextBreakdown>[0]
  const breakdown = contextBreakdown(messages, [{ ...model, limit: { context: 10_000 } }] as unknown as Parameters<
    typeof contextBreakdown
  >[1])
  expect(breakdown?.total).toBe(5_100)
  expect(breakdown?.limit).toBe(10_000)
  expect(breakdown?.rows).toEqual([
    { label: "System prompt, tools and instructions", tokens: 5_100 - 100 - 50 - 203 },
    { label: "Your messages and reminders", tokens: 100 },
    { label: "Responses and reasoning", tokens: 50 },
    { label: "Tool calls and results", tokens: 203 },
  ])
})
