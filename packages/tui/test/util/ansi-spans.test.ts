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

test("colon sub-parameters are read as one parameter", () => {
  // The empty colour-space slot must not shift the channels, and the trailing 0 is a channel, not a reset.
  expect(summary("\u001b[38:2::255:0:0mx")).toEqual([["x", "#ff0000", undefined, 0]])
  expect(summary("\u001b[38:2:255:0:0mx")).toEqual([["x", "#ff0000", undefined, 0]])
  expect(summary("\u001b[48:5:196mx")).toEqual([["x", undefined, "#ff0000", 0]])
  // A curly underline is an underline, not italic; 4:0 turns it off.
  expect(summary("\u001b[4:3mx\u001b[4:0my")).toEqual([
    ["x", undefined, undefined, TextAttributes.UNDERLINE],
    ["y", undefined, undefined, 0],
  ])
})

// Class 9: format characters reorder or hide text, so each is written out, with an ordinary line as the trusted control.
test.each([
  ["U+202E right-to-left override", "\u202e", "\\u{202e}"],
  ["U+2066 isolate", "\u2066", "\\u{2066}"],
  ["U+2069 pop isolate", "\u2069", "\\u{2069}"],
  ["U+200E left-to-right mark", "\u200e", "\\u{200e}"],
  ["U+200F right-to-left mark", "\u200f", "\\u{200f}"],
  ["U+061C Arabic letter mark", "\u061c", "\\u{61c}"],
  ["U+200B zero-width space", "\u200b", "\\u{200b}"],
  ["U+0085 C1 control", "\u0085", "\ufffd"],
])("%s is written out in both color modes", (_name, char, written) => {
  expect(ansiText(`a${char}b`)).toBe(`a${written}b`)
  expect(summary(`\u001b[31ma${char}b`)).toEqual([[`a${written}b`, "#cd0000", undefined, 0]])
})

// The exceptions to the table above: Powerline and Nerd Font glyphs live in the Private Use Area and U+200D joins an emoji
// sequence; neither acts on the text around it, so both are drawn as they are.
test.each([
  ["U+E0A0 Powerline branch", "\u{e0a0}"],
  ["U+E0B0 Powerline arrow", "\u{e0b0}"],
  ["U+F0001 supplementary Private Use Area", "\u{f0001}"],
  ["emoji sequence with U+200D", "\u{1f468}\u{200d}\u{1f4bb}"],
])("%s is drawn unchanged in both color modes", (_name, glyph) => {
  expect(ansiText(`a${glyph}b`)).toBe(`a${glyph}b`)
  expect(summary(`\u001b[31ma${glyph}b`)).toEqual([[`a${glyph}b`, "#cd0000", undefined, 0]])
})

test("an ordinary line is unchanged", () => {
  expect(ansiText("main \u2713 \u65e5\u672c\u8a9e e\u0301")).toBe("main \u2713 \u65e5\u672c\u8a9e e\u0301")
})
