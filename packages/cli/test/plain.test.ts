import { expect, test } from "bun:test"
import { plain, progress } from "../src/util/plain"

// A set-title sequence, one that erases the line, a right-to-left override and a line break: what a file that is not
// trusted yet can put into a name or a message.
const evil = "\u001b]0;pwned\u0007a\u001b[2K\u{202e}b\r\nc"
const shown = "\\x1b]0;pwned\\x07a\\x1b[2K\\u{202e}b\\nc"

test("plain writes out what acts on a terminal and puts the text on one line", () => {
  expect(plain(`  ${evil}  `)).toBe(shown)
  expect(plain("a\rb")).toBe("a\\x0db")
})

test("progress writes out the same and keeps the indentation of a line", () => {
  expect(progress(evil)).toBe(shown)
  expect(progress(`  lead → coder: ${evil}`)).toBe(`  lead → coder: ${shown}`)
})

test("progress leaves the lines that a run prints as they are", () => {
  for (const line of [
    "started run_20260101000000_0a1b2c",
    "> ollama/good:1b.answer#1",
    "✓ answer verified in 2 iteration(s)",
    "! k: skipping ollama/tiny:1b, which failed 3 times in the last minute",
    "  lead → coder: do it…",
    "= a (recorded)",
  ])
    expect(progress(line)).toBe(line)
})

test("progress takes what a workflow passes to ctx.log, which is not always text", () => {
  expect([progress(42), progress(undefined), progress({})]).toEqual(["42", "undefined", "[object Object]"])
})
