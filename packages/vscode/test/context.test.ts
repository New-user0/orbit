import { describe, expect, test } from "bun:test"
import { ask, explain, fix, reference, review } from "../src/context"
import { proposed } from "../src/patch"
import { createTwoFilesPatch } from "diff"

const selection = { file: "src/app.ts", language: "typescript", startLine: 3, endLine: 5, text: "const a = 1\n" }

describe("context prompts", () => {
  test("reference a single line or a range", () => {
    expect(reference({ file: "a.ts", startLine: 2, endLine: 2 })).toBe("a.ts (line 2)")
    expect(reference(selection)).toBe("src/app.ts (lines 3-5)")
  })

  test("quote the selection in a fence longer than any backticks it contains", () => {
    expect(ask(selection, " Why? ")).toBe("Why?\n\nContext, src/app.ts (lines 3-5):\n```typescript\nconst a = 1\n```")
    expect(ask({ ...selection, text: "x = ```code```" }, "Q")).toContain("````typescript\nx = ```code```\n````")
    expect(explain(selection)).toStartWith("Explain what this code does")
  })

  test("list diagnostics by line with their first message line", () => {
    expect(
      fix("src/app.ts", [
        { line: 9, severity: "warning", message: "unused" },
        { line: 2, severity: "error", message: "Type error\nmore detail", source: "ts" },
      ]),
    ).toBe(
      "Fix these problems in src/app.ts. Read the file first and keep unrelated code unchanged.\n\n" +
        "- line 2, error (ts): Type error\n- line 9, warning: unused",
    )
  })

  test("review reads the uncommitted diff without editing", () => {
    expect(review()).toContain("git diff")
    expect(review()).toContain("Do not edit anything")
  })
})

describe("proposed changes", () => {
  test("apply the agent's patch to the current file", () => {
    const patch = createTwoFilesPatch("a.txt", "a.txt", "one\ntwo\n", "one\n2\n")
    expect(proposed("one\ntwo\n", patch)).toBe("one\n2\n")
  })

  test("report a patch that no longer applies", () => {
    const patch = createTwoFilesPatch("a.txt", "a.txt", "one\ntwo\n", "one\n2\n")
    expect(proposed("something else\n", patch)).toBeUndefined()
  })
})
