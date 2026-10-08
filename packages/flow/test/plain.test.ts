import { expect, test } from "bun:test"
import { json, jsonLine, plain, progress } from "../src/plain"

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

// What JSON.stringify leaves as it is, and what a terminal or a reader can act on: DEL, the C1 controls (CSI, ST and OSC
// among them), a right-to-left override, a zero-width space, and a tag character outside the Basic Multilingual Plane,
// which takes two UTF-16 units.
const raw = "\u007f\u009b\u009c\u009d\u{202e}\u{200b}\u{e0001}"
const written = "\\u007f\\u009b\\u009c\\u009d\\u202e\\u200b\\udb40\\udc01"

test("json writes out the characters that JSON.stringify leaves raw, one escape for each UTF-16 unit", () => {
  expect(json({ id: `a${raw}b` })).toBe(`{\n  "id": "a${written}b"\n}`)
  expect(json(`${raw}`)).toBe(`"${written}"`)
})

test("json parses back to the value it was given, and keeps the indentation of JSON.stringify", () => {
  const value = {
    [`key${raw}`]: [`text${raw}`, { id: `id${raw}`, count: 1.5, ok: true, none: null }],
    quote: 'say "hi"\\\n\t\u001b',
    // Already escaped by JSON.stringify: a lone surrogate.
    lone: "\ud800",
    // Not category C, so left as it is.
    kept: "ü — 日本 😀",
  }

  const text = json(value)

  expect(JSON.parse(text)).toEqual(value)
  expect(text.split("\n").length).toBe(JSON.stringify(value, null, 2).split("\n").length)
  // The line breaks that remain are the indentation, and nothing else of category C.
  expect(text.replaceAll("\n", "")).not.toMatch(/\p{C}/u)
  expect(text).toContain('"kept": "ü — 日本 😀"')
})

test("json leaves JSON that has nothing to write out as JSON.stringify makes it", () => {
  const value = { a: [1, "x", { b: null }], c: "ü", d: {}, e: [] }
  expect(json(value)).toBe(JSON.stringify(value, null, 2))
  expect(json("plain")).toBe('"plain"')
  expect(json(null)).toBe("null")
})

test("json prints a value that has no JSON form as undefined, as the template it replaces did", () => {
  expect(json(() => 1)).toBe("undefined")
})

test("jsonLine writes out the characters that json does, and the two line separators that a reader splits lines at", () => {
  expect(jsonLine({ id: `a${raw}b` })).toBe(`{"id":"a${written}b"}`)
  expect(jsonLine(`${raw}`)).toBe(`"${written}"`)
  expect(jsonLine("a\u{2028}b\u{2029}c")).toBe('"a\\u2028b\\u2029c"')
})

test("jsonLine is one line that parses back to the value it was given", () => {
  const value = {
    [`key${raw}`]: [`text${raw}`, { id: `id${raw}`, count: 1.5, ok: true, none: null }],
    // Line breaks and an escape, which JSON.stringify writes out, and the C1 line break, which it leaves raw.
    quote: 'say "hi"\\\n\t\r\u001b\u0085',
    lone: "\ud800",
    kept: "ü — 日本 😀",
  }

  const text = jsonLine(value)

  expect(JSON.parse(text)).toEqual(value)
  expect(text).not.toMatch(/\p{C}|\p{Zl}|\p{Zp}/u)
  expect(text).toContain('"kept":"ü — 日本 😀"')
})

test("jsonLine leaves JSON that has nothing to write out as JSON.stringify makes it", () => {
  const value = { a: [1, "x", { b: null }], c: "ü", d: {}, e: [] }
  expect(jsonLine(value)).toBe(JSON.stringify(value))
  expect(jsonLine(null)).toBe("null")
})
