import { expect, test } from "bun:test"
import type { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { contextMarkdown, contextUsageLine } from "../../src/run/context-report"

// clients-ux-23: the Markdown report `orb run "/context"` and `orb -p "/context"` print, and the JSON line of the JSON
// formats. The report has the reference's sections, every one of them for everyone (the reference keeps some for its own
// staff); every string from the payload is a file's, a config's or a server's, so each cell goes through `plain` and a
// pipe is escaped so it cannot add a column (classes 5 and 9).

type Info = SessionContextUsage.Info

function fixture(input: { readonly auto: boolean; readonly window?: number; readonly name?: string }): Info {
  const name = (text: string) => (input.name === undefined ? text : `${text}${input.name}`)
  const reserve = input.auto
    ? { kind: "auto-buffer" as const, tokens: 33_000 }
    : { kind: "compact-buffer" as const, tokens: 3_000 }
  const known = input.window !== undefined
  return {
    model: { providerID: name("provider"), id: name("model") },
    ...(known ? { window: input.window, percentage: 25, threshold: 167_000 } : {}),
    total: 50_000,
    measured: true,
    auto: input.auto,
    categories: [
      { kind: "system", tokens: 4_000 },
      { kind: "tools", tokens: 12_000 },
      { kind: "mcp", tokens: 2_000 },
      { kind: "mcp-deferred", tokens: 1_500 },
      { kind: "tools-deferred", tokens: 900 },
      { kind: "agents", tokens: 600 },
      { kind: "instructions", tokens: 3_400 },
      { kind: "skills", tokens: 700 },
      { kind: "messages", tokens: 27_400 },
      ...(known ? [reserve, { kind: "free" as const, tokens: 200_000 - 50_000 - reserve.tokens }] : []),
    ],
    files: [{ path: name("/repo/ORBIT.md"), type: name("file"), tokens: 3_400 }],
    mcp: [
      { name: name("docs_search"), server: name("docs"), tokens: 2_000, deferred: false },
      { name: name("docs_fetch"), server: name("docs"), tokens: 1_500, deferred: true },
    ],
    agents: [{ id: name("reviewer"), scope: name("project"), tokens: 600 }],
    skills: [{ id: name("release"), tokens: 700 }],
    systemTools: [{ name: name("Read"), tokens: 12_000 }],
    deferredTools: [{ name: name("lsp.hover"), tokens: 900 }],
    sections: [{ name: name("Environment"), tokens: 4_000 }],
    messages: {
      toolCalls: 3_000,
      toolResults: 15_000,
      attachments: 2_000,
      assistant: 4_000,
      user: 3_300,
      tools: [{ name: name("Bash"), calls: 2_000, results: 10_000 }],
      attachmentKinds: [{ name: name("todo"), tokens: 2_000 }],
    },
  }
}

const lines = (text: string) => text.split("\n")
const at = (text: string, line: string) => lines(text).findIndex((item) => item.startsWith(line))

// A table row's cells, split as a GitHub Markdown table splits them: a backslash keeps the character after it in the cell.
function cells(row: string) {
  let count = 0
  for (let index = 0; index < row.length; index++) {
    if (row[index] === "\\") index++
    else if (row[index] === "|") count++
  }
  return count - 1
}

// Each table: its header row, the line under it and its rows, until the first line that is not a row.
function tables(text: string) {
  const all = lines(text)
  return all.flatMap((line, index) =>
    line.startsWith("|") && all[index + 1]?.startsWith("|-") && !all[index - 1]?.startsWith("|")
      ? [all.slice(index, index + 2 + all.slice(index + 2).findIndex((next) => !next.startsWith("|")))]
      : [],
  )
}

// CR1: the reference's report, top to bottom, with every section shown to everyone and no suggestions.
test("the report has the reference's sections in order, every one for everyone", () => {
  const auto = contextMarkdown(fixture({ auto: true, window: 200_000 }))
  const order = [
    "## Context usage",
    "**Model:** provider/model",
    "**Tokens:** 50,000 / 200,000 (25%)",
    "### Usage by category",
    "### MCP tools",
    "### System tools",
    "### System prompt sections",
    "### Custom agents",
    "### Instruction files",
    "### Skills",
    "### Message breakdown",
    "### Top tools",
    "### Top attachments",
  ].map((line) => at(auto, line))
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual(order.toSorted((a, b) => a - b))
  expect(auto.toLowerCase()).not.toContain("suggestion")

  // The category table: every counted row, deferred ones with their percentage, then free space, then the autocompact
  // buffer.
  const categories = tables(auto)[0]!.slice(2)
  expect(categories.map((row) => row.split("|")[1]!.trim())).toEqual([
    "System prompt",
    "System tools",
    "MCP tools",
    "MCP tools (deferred)",
    "System tools (deferred)",
    "Custom agents",
    "Instruction files",
    "Skills",
    "Messages",
    "Free space",
    "Autocompact buffer",
  ])
  expect(categories[3]).toBe("| MCP tools (deferred) | 1,500 | 0.8% |")
  expect(categories[8]).toBe("| Messages | 27,400 | 13.7% |")

  // With automatic compaction off the reserve is a category like the others, before free space.
  const manual = tables(contextMarkdown(fixture({ auto: false, window: 200_000 })))[0]!.slice(2)
  expect(manual.map((row) => row.split("|")[1]!.trim()).slice(-2)).toEqual(["Compact buffer", "Free space"])

  // Each section's rows.
  expect(auto).toContain("| docs_search | docs | 2,000 |")
  expect(auto).toContain("| docs_fetch | docs | 1,500 (deferred) |")
  expect(auto).toContain("| Read | 12,000 |")
  expect(auto).toContain("| lsp.hover | 900 (deferred) |")
  expect(auto).toContain("| Environment | 4,000 |")
  expect(auto).toContain("| reviewer | project | 600 |")
  expect(auto).toContain("| file | /repo/ORBIT.md | 3,400 |")
  expect(auto).toContain("| release | 700 |")
  expect(auto).toContain("| Tool calls | 3,000 |")
  expect(auto).toContain("| Tool results | 15,000 |")
  expect(auto).toContain("| Attachments | 2,000 |")
  expect(auto).toContain("| Assistant text | 4,000 |")
  expect(auto).toContain("| User text | 3,300 |")
  expect(auto).toContain("| Bash | 2,000 | 10,000 |")
  expect(auto).toContain("| todo | 2,000 |")
})

// CR2, classes 5 and 9: every string is a label, written through `plain`, and a pipe (with or without a backslash before
// it) stays inside its cell.
test("every cell is escaped and a pipe cannot add a column", () => {
  const hostile = "a|b\\|c\x1b]0;x\x07\x1b[2K\u009b\u202ed\ne"
  const text = contextMarkdown(fixture({ auto: true, window: 200_000, name: hostile }))

  expect(/\p{C}/u.test(text.replaceAll("\n", ""))).toBe(false)
  expect(text).not.toContain("\x1b")
  const found = tables(text)
  expect(found.length).toBe(10)
  for (const table of found) {
    const columns = cells(table[0]!)
    for (const row of table) expect({ row, columns: cells(row) }).toEqual({ row, columns })
  }
  // Every name reached the report, escaped.
  for (const label of ["docs_search", "docs_fetch", "reviewer", "release", "Read", "lsp.hover", "Environment", "Bash", "todo", "ORBIT.md"])
    expect(text).toContain(`${label}a\\|b`)
})

// CR3: with no window, nothing is a share of it.
test("an unknown window prints no percentage", () => {
  const text = contextMarkdown(fixture({ auto: true }))

  expect(text).not.toContain("%")
  expect(text).toContain("**Tokens:** 50,000\n")
  expect(text).not.toContain("Free space")
  expect(text).not.toContain("Autocompact buffer")
  expect(tables(text)[0]![0]).toBe("| Category | Tokens |")
})

// CR4, class 9: the JSON line keeps every string as it came, and holds no raw control or line separator character.
test("the JSON line keeps every string and has no raw control or line-separator character", () => {
  const info = fixture({ auto: true, window: 200_000, name: "a\x1b]0;x\x07\u009b\u202e\u2028\u2029\nb" })
  const line = contextUsageLine("ses_context", info)

  expect(/[\p{C}\u2028\u2029]/u.test(line)).toBe(false)
  expect(JSON.parse(line)).toEqual({ type: "context_usage", sessionID: "ses_context", usage: info })
})
