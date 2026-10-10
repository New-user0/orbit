import { describe, expect, test } from "bun:test"
import { notice } from "../src/notify"

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
