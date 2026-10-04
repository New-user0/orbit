import { expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

test("truncates text from the right by terminal width", () => {
  expect(Locale.truncateWidth("abcdefgh", 5)).toBe("abcd…")
  expect(Locale.truncateWidth("ab界cd", 5)).toBe("ab界…")
  expect(Locale.truncateWidth("abcdefgh", 1)).toBe("…")
  expect(Locale.truncateWidth("abcdefgh", 0)).toBe("")
})

test("takes whole graphemes within terminal width", () => {
  expect(Locale.takeWidth("ab界cd", 4)).toBe("ab界")
  expect(Locale.graphemes("a👨‍👩‍👧‍👦b")).toEqual(["a", "👨‍👩‍👧‍👦", "b"])
})

test("ago names the largest whole unit", () => {
  const now = 10 * 24 * 3_600_000
  expect(Locale.ago(now - 30_000, now)).toBe("just now")
  expect(Locale.ago(now - 5 * 60_000, now)).toBe("5m ago")
  expect(Locale.ago(now - 2 * 3_600_000, now)).toBe("2h ago")
  expect(Locale.ago(now - 30 * 3_600_000, now)).toBe("yesterday")
  expect(Locale.ago(now - 3 * 24 * 3_600_000, now)).toBe("3d ago")
})
