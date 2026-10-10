import { describe, expect, test } from "bun:test"
import { createNoticeTracker, notice } from "../src/notify"

describe("createNoticeTracker", () => {
  test("a pending permission notices once per id", () => {
    const tracker = createNoticeTracker()
    expect(tracker.permission({ id: "per_1" })).toBe("permission")
    expect(tracker.permission({ id: "per_1" })).toBeUndefined()
    expect(tracker.permission({ id: "per_2" })).toBe("permission")
  })

  test("only the end of a busy period notices", () => {
    const tracker = createNoticeTracker()
    expect(tracker.busy(false)).toBeUndefined()
    expect(tracker.busy(true)).toBeUndefined()
    expect(tracker.busy(false)).toBe("done")
    expect(tracker.busy(false)).toBeUndefined()
    expect(tracker.busy(true)).toBeUndefined()
    expect(tracker.busy(true)).toBeUndefined()
    expect(tracker.busy(false)).toBe("done")
  })
})

describe("notice", () => {
  test.each([
    { panelVisible: false, windowFocused: true, shows: true },
    { panelVisible: true, windowFocused: false, shows: true },
    { panelVisible: false, windowFocused: false, shows: true },
    { panelVisible: true, windowFocused: true, shows: false },
  ])("panel visible $panelVisible, window focused $windowFocused", ({ panelVisible, windowFocused, shows }) => {
    for (const event of ["permission", "done"] as const) {
      expect(notice({ event, enabled: true, panelVisible, windowFocused }) !== undefined).toBe(shows)
      expect(notice({ event, enabled: false, panelVisible, windowFocused })).toBeUndefined()
    }
  })

  test("a permission is a warning and the end of a turn is information, with fixed texts", () => {
    const hidden = { enabled: true, panelVisible: false, windowFocused: true }
    expect(notice({ event: "permission", ...hidden })).toEqual({ level: "warning", text: "Orbit needs your review" })
    expect(notice({ event: "done", ...hidden })).toEqual({ level: "info", text: "Orbit finished" })
  })
})
