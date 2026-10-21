import { describe, expect, test } from "bun:test"
import { SessionEffort } from "@orbit/core/session/effort"

describe("SessionEffort.requested", () => {
  test.each([
    "ultrathink",
    "ULTRATHINK",
    "UltraThink",
    "Ultrathink.",
    "(ultrathink)",
    "ultrathink's",
    "über-ultrathink",
    "```\nultrathink\n```",
    "first line\r\nultrathink now\r\n",
    "a ultrathink b ultrathink c",
  ])("matches %j", (text) => {
    expect(SessionEffort.requested(text)).toBe(true)
  })

  test.each(["ultrathinking", "ultrathink_now", "xultrathink", "ultrathink2", "ultra think", ""])(
    "does not match %j",
    (text) => {
      expect(SessionEffort.requested(text)).toBe(false)
    },
  )
})
