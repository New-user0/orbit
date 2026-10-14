import { describe, expect, test } from "bun:test"
import path from "path"

// Class 15: docs/follow-ups.md is the one register of follow-ups, and a table cell that is cut mid-sentence, a placeholder
// that Markdown reads as HTML, or a duplicate that points at a row that is not there loses what the register is for.
const register = await Bun.file(path.join(import.meta.dir, "../../../docs/follow-ups.md")).text()
// A default Windows checkout (core.autocrlf) has CRLF, which would leave a \r on every line and match no heading.
const lines = register.split(/\r?\n/)

// The text of a line without its code spans, which is what Markdown reads as prose.
const prose = (line: string) => line.replace(/`[^`]*`/g, "")
const rows = lines.filter((line) => line.startsWith("| FU-"))
const duplicates = lines.slice(lines.indexOf("## Duplicates"), lines.indexOf("## Counts")).filter((line) => line.startsWith("- "))

// A cell that was cut at a length ends in " ..." before the next pipe or the end of the line.
const cut = (line: string) => /\s\.\.\.(\s\||$)/.test(line)
// Raw HTML, emphasis, strike-through or an escape outside a code span.
const loose = (line: string) => /[<*~\\]/.test(prose(line).replace(/\\\|/g, ""))

describe("the follow-up register", () => {
  test("every table row has a different id", () => {
    const ids = rows.map((line) => line.split("|")[1].trim())
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([])
  })

  test("the duplicates list is found, so the checks on it do not pass on nothing", () => {
    expect(duplicates.length).toBeGreaterThan(0)
  })

  test("every duplicate points at a row that has a table entry", () => {
    const ids = new Set(rows.map((line) => line.split("|")[1].trim()))
    const missing = duplicates.filter((line) => !ids.has(line.slice(line.lastIndexOf("-> ") + 3).trim()))
    expect(missing).toEqual([])
  })

  test("no cell is cut mid-sentence", () => {
    expect([...rows, ...duplicates].filter(cut)).toEqual([])
  })

  test("what Markdown would read as HTML, emphasis or an escape is in a code span", () => {
    expect([...rows, ...duplicates].filter(loose)).toEqual([])
  })

  test("each section's heading counts its rows", () => {
    const headings = lines.flatMap((line, index) => {
      const match = line.match(/^### .* \((\d+)\)$/)
      return match ? [{ index, count: Number(match[1]) }] : []
    })
    expect(headings.length).toBeGreaterThan(0)
    expect(
      headings.flatMap((heading, position) => {
        const end = headings[position + 1]?.index ?? lines.indexOf("## Fixed")
        const found = lines.slice(heading.index, end).filter((line) => line.startsWith("| FU-")).length
        return found === heading.count ? [] : [`${lines[heading.index]} has ${found}`]
      }),
    ).toEqual([])
  })

  test("the checks find what they are meant to find (control)", () => {
    expect(cut("| FU-M3-001 | a title cut ... | 8 |")).toBe(true)
    expect(cut("| FU-M3-001 | a whole sentence | 8 |")).toBe(false)
    expect(cut("| FU-M3-001 | spreads `...tool` in add | 8 |")).toBe(false)
    expect(loose("| FU-M3-001 | git -C <dir> | 8 |")).toBe(true)
    expect(loose("| FU-M3-001 | git -C `<dir>` | 8 |")).toBe(false)
    expect(loose("| FU-M3-001 | cat `*/x`, cat do*/x | 8 |")).toBe(true)
    expect(loose("| FU-M3-001 | `a \\| b` and a\\|b | 8 |")).toBe(false)
  })
})
