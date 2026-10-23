import { describe, expect, test } from "bun:test"
import { SessionContextWindow } from "@orbit/core/session/context-window"

// context-memory-1: the window keeps room for the summary call's output, automatic compaction starts a fixed buffer
// below that, and the warning and blocking points sit 20,000 and 3,000 tokens below their reference points.
describe("SessionContextWindow.thresholds", () => {
  test.each([
    {
      name: "keeps 20,000 for the summary and compacts 13,000 below the effective window",
      input: { limit: { context: 200_000, output: 32_000 } },
      expected: { window: 200_000, reserve: 20_000, effective: 180_000, threshold: 167_000, blocking: 177_000 },
    },
    {
      name: "uses the configured buffer in place of 13,000",
      input: { limit: { context: 200_000, output: 32_000 }, buffer: 3_000 },
      expected: { window: 200_000, reserve: 20_000, effective: 180_000, threshold: 177_000, blocking: 177_000 },
    },
    {
      name: "keeps only the output cap for the summary when the cap is lower",
      input: { limit: { context: 200_000, output: 32_000 }, outputTokenCap: 8_000 },
      expected: { window: 200_000, reserve: 8_000, effective: 192_000, threshold: 179_000, blocking: 189_000 },
    },
    {
      name: "keeps a small model output limit for the summary",
      input: { limit: { context: 200_000, output: 4_096 } },
      expected: { window: 200_000, reserve: 4_096, effective: 195_904, threshold: 182_904, blocking: 192_904 },
    },
    {
      name: "keeps 20,000 when the output limit is unknown",
      input: { limit: { context: 200_000, output: 0 } },
      expected: { window: 200_000, reserve: 20_000, effective: 180_000, threshold: 167_000, blocking: 177_000 },
    },
    {
      name: "measures the input limit when the model has one",
      input: { limit: { context: 400_000, input: 272_000, output: 128_000 } },
      expected: { window: 272_000, reserve: 20_000, effective: 252_000, threshold: 239_000, blocking: 249_000 },
    },
    {
      name: "never compacts below half the window",
      input: { limit: { context: 40_000, output: 32_000 } },
      expected: { window: 40_000, reserve: 20_000, effective: 20_000, threshold: 20_000, blocking: 17_000 },
    },
    {
      name: "floors a buffer that would compact below half the window",
      input: { limit: { context: 200_000, output: 32_000 }, buffer: 150_000 },
      expected: { window: 200_000, reserve: 20_000, effective: 180_000, threshold: 100_000, blocking: 177_000 },
    },
  ])("$name", ({ input, expected }) => {
    expect(SessionContextWindow.thresholds(input)).toEqual(expected)
  })

  test("has no thresholds when the window is unknown", () => {
    expect(SessionContextWindow.thresholds({ limit: { context: 0, output: 32_000 } })).toBeUndefined()
  })
})

describe("SessionContextWindow.state", () => {
  const thresholds = SessionContextWindow.thresholds({ limit: { context: 200_000, output: 32_000 } })
  if (!thresholds) throw new Error("A known window has thresholds")

  // With automatic compaction on, percentages count down to the threshold; with it off, to the effective window.
  test.each([
    { used: 140_000, auto: true, expected: { percentLeft: 16, state: "ok" } },
    { used: 150_000, auto: true, expected: { percentLeft: 10, state: "error" } },
    { used: 185_000, auto: true, expected: { percentLeft: 0, state: "error" } },
    { used: 150_000, auto: false, expected: { percentLeft: 17, state: "ok" } },
    { used: 165_000, auto: false, expected: { percentLeft: 8, state: "error" } },
  ])("$used tokens with automatic compaction $auto", ({ used, auto, expected }) => {
    expect(SessionContextWindow.state(used, thresholds, auto)).toEqual(expected)
  })
})
