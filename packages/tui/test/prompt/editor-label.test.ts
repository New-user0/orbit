import { expect, test } from "bun:test"
import { getEditorRangeLabel } from "../../src/component/prompt"

const range = (start: [number, number], end: [number, number]) => ({
  text: "x",
  selection: { start: { line: start[0], character: start[1] }, end: { line: end[0], character: end[1] } },
})

test("labels the lines a selection covers, counting from 1", () => {
  expect(getEditorRangeLabel(range([5, 3], [5, 9]))).toBe("#5")
  expect(getEditorRangeLabel(range([5, 3], [7, 2]))).toBe("#5-7")
})

test("does not count a later line that the selection only reaches the start of", () => {
  // From the start of line 5 to the start of line 8 covers lines 5 to 7.
  expect(getEditorRangeLabel(range([5, 1], [8, 1]))).toBe("#5-7")
  // The start of the next line, reached from the middle of this one, covers this line alone.
  expect(getEditorRangeLabel(range([5, 4], [6, 1]))).toBe("#5")
})

test("labels a cursor, which selects nothing, with nothing", () => {
  expect(getEditorRangeLabel(range([5, 3], [5, 3]))).toBeUndefined()
})
