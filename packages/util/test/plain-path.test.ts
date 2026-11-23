// m5-link-warning: a path in an approval holds nothing blank that could pad it out into a line of Orbit's own (class 9).
import { expect, test } from "bun:test"
import { plainPath } from "../src/plain.js"

const rows: Array<[string, string, string]> = [
  ["an ordinary path", "/work/My Files/ä/中/a.txt", "/work/My Files/ä/中/a.txt"],
  ["a Windows path", "C:\\Users\\Om\\.orbit\\a.txt", "C:\\Users\\Om\\.orbit\\a.txt"],
  ["a line feed", "a\nb", "a\\nb"],
  ["CR and LF", "a\r\nb", "a\\nb"],
  ["a carriage return", "a\rb", "a\\x0db"],
  ["a tab", "a\tb", "a\\x09b"],
  ["an escape", "a\u001bb", "a\\x1bb"],
  ["next line", "a\u0085b", "a\\x85b"],
  ["a bidi override", "a\u202eb", "a\\u{202e}b"],
  ["a line separator", "a\u2028b", "a\\u{2028}b"],
  ["a paragraph separator", "a\u2029b", "a\\u{2029}b"],
  ["a run of spaces", "a  b", "a\\x20\\x20b"],
  ["a space at the start", " a", "\\x20a"],
  ["a space at the end", "a ", "a\\x20"],
  ["a no-break space", "a\u00a0b", "a\\xa0b"],
  ["a figure space", "a\u2007b", "a\\u{2007}b"],
  ["a narrow no-break space", "a\u202fb", "a\\u{202f}b"],
  ["an ideographic space", "a\u3000b", "a\\u{3000}b"],
  ["an Ogham space", "a\u1680b", "a\\u{1680}b"],
  ["a Hangul filler", "a\u3164b", "a\\u{3164}b"],
  ["a blank Braille pattern", "a\u2800b", "a\\u{2800}b"],
]

for (const [name, value, shown] of rows)
  test(`plainPath writes out ${name}, or leaves what is not blank`, () => {
    expect(plainPath(value)).toBe(shown)
  })

test("plainPath writes out every space there is but one between two words", () => {
  for (let code = 0; code <= 0xffff; code++) {
    const space = String.fromCharCode(code)
    if (code === 0x20 || !/\s/.test(space)) continue
    expect([code, /\s/.test(plainPath(`a${space}b`))]).toEqual([code, false])
  }
})
