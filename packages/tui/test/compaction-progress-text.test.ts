import { describe, expect, test } from "bun:test"
import { compactionProgress } from "../src/routes/session/compaction-progress"

// "Compaction · 31.0s · ↓ 1.2K tokens" is 34 cells wide; the row needs 6 more for its spinner, gaps and rule.
const wide = 40
const time = (width: number, elapsed = 31_000, characters = 4800) => compactionProgress({ elapsed, characters, width })

describe("compactionProgress", () => {
  test("shows nothing before 30 seconds, whatever the count", () => {
    expect(time(120, 29_999)).toBeUndefined()
    expect(time(120, 0, 0)).toBeUndefined()
  })

  test("shows the elapsed seconds and characters / 4 as tokens from 30 seconds on", () => {
    expect(time(120, 30_000)).toBe("· 30.0s · ↓ 1.2K tokens")
    expect(time(120, 31_999)).toBe("· 31.0s · ↓ 1.2K tokens")
    expect(time(120, 31_000, 4)).toBe("· 31.0s · ↓ 1 tokens")
  })

  test("a count that rounds to no token shows the time alone", () => {
    expect(time(120, 31_000, 0)).toBe("· 31.0s")
    expect(time(120, 31_000, 1)).toBe("· 31.0s")
  })

  test("drops the token figure first, then the time, as the width shrinks", () => {
    expect(time(wide)).toBe("· 31.0s · ↓ 1.2K tokens")
    expect(time(wide - 1)).toBe("· 31.0s")
    expect(time(24)).toBe("· 31.0s")
    expect(time(23)).toBeUndefined()
  })
})
