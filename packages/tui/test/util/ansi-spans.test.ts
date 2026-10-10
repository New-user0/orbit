import { expect, test } from "bun:test"
import { TextAttributes } from "@opentui/core"
import { ansiSpans, ansiText } from "../../src/util/ansi-spans"

const summary = (input: string) => ansiSpans(input).map((span) => [span.text, span.fg, span.bg, span.attributes])

test("16-color, 256-color and truecolor foregrounds and backgrounds become spans", () => {
  expect(summary("\u001b[31ma\u001b[0m\u001b[92;44mb\u001b[0m")).toEqual([
    ["a", "#cd0000", undefined, 0],
    ["b", "#00ff00", "#0000ee", 0],
  ])
  expect(summary("\u001b[38;5;196ma\u001b[48;5;232mb\u001b[38;5;4mc")).toEqual([
    ["a", "#ff0000", undefined, 0],
    ["b", "#ff0000", "#080808", 0],
    ["c", "#0000ee", "#080808", 0],
  ])
  expect(summary("\u001b[38;2;1;2;255;48;2;16;32;48mx")).toEqual([["x", "#0102ff", "#102030", 0]])
})

test("bold, dim, italic and underline combine and reset", () => {
  expect(summary("\u001b[1;3mA\u001b[22mB\u001b[4;2mC\u001b[0mD")).toEqual([
    ["A", undefined, undefined, TextAttributes.BOLD | TextAttributes.ITALIC],
    ["B", undefined, undefined, TextAttributes.ITALIC],
    ["C", undefined, undefined, TextAttributes.ITALIC | TextAttributes.UNDERLINE | TextAttributes.DIM],
    ["D", undefined, undefined, 0],
  ])
})

test("a malformed color keeps the previous one and consumes only its own parameters", () => {
  expect(summary("\u001b[31m\u001b[38;2;300;0;0mx\u001b[38;5;999my")).toEqual([["xy", "#cd0000", undefined, 0]])
})

test.each([
  ["OSC title ended by BEL", "a\u001b]0;pwned\u0007b"],
  ["OSC 52 clipboard write ended by ST", "a\u001b]52;c;cGF5bG9hZA==\u001b\\b"],
  ["C1 OSC", "a\u009d0;pwned\u009cb"],
  ["cursor movement", "a\u001b[2J\u001b[10;10Hb"],
  ["C1 CSI", "a\u009b2Jb"],
  ["DCS string", "a\u001bPq#0;2;0;0;0\u001b\\b"],
  ["two-byte escape", "a\u001bcb"],
  ["private SGR-like sequence", "a\u001b[?25lb"],
])("%s is dropped", (_name, input) => {
  expect(ansiText(input)).toBe("ab")
})

test("an unterminated OSC drops the rest of the line", () => {
  expect(ansiText("a\u001b]0;pwned")).toBe("a")
})

test("remaining control characters are written out and tabs become a space", () => {
  expect(ansiText("a\u0007b\u0000c\td\u007fe")).toBe("a\u2407b\u2400c d\u2421e")
})
