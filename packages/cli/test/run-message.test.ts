import { expect, test } from "bun:test"
import { formatMessage } from "../src/run/run"

test("a single prompt argument is sent as typed", () => {
  expect(formatMessage(["create hello.py that prints hi, then run it"])).toBe(
    "create hello.py that prints hi, then run it",
  )
})

test("several arguments keep their word boundaries", () => {
  expect(formatMessage(["fix", "the bug in x"])).toBe('fix "the bug in x"')
  expect(formatMessage([])).toBeUndefined()
})
