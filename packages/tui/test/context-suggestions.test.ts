import { expect, test } from "bun:test"
import type { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { contextSuggestions } from "../src/util/context-suggestions"

// clients-ux-23: the five suggestions the reference draws under its context view, computed in the terminal UI from the
// payload alone (the server returns none, as the reference's report carries none). Each rule fires at its threshold and
// not one step below it.

type Tool = SessionContextUsage.Breakdown["tools"][number]

function info(input: {
  readonly window?: number
  readonly percentage?: number
  readonly auto?: boolean
  readonly tools?: ReadonlyArray<Tool>
  readonly files?: ReadonlyArray<number>
}): SessionContextUsage.Info {
  const known = input.window !== undefined
  return {
    model: { providerID: "provider", id: "model" },
    ...(known ? { window: input.window, percentage: input.percentage ?? 10, threshold: input.window! - 10_000 } : {}),
    total: 1_000,
    measured: true,
    auto: input.auto ?? true,
    categories: [],
    files: (input.files ?? []).map((tokens, index) => ({ path: `/repo/file-${index}.md`, type: "file", tokens })),
    mcp: [],
    agents: [],
    skills: [],
    systemTools: [],
    deferredTools: [],
    sections: [],
    messages: {
      toolCalls: 0,
      toolResults: 0,
      attachments: 0,
      assistant: 0,
      user: 0,
      tools: input.tools ?? [],
      attachmentKinds: [],
    },
  }
}

const tool = (name: string, calls: number, results: number): Tool => ({ name, calls, results })
const shape = (found: ReturnType<typeof contextSuggestions>) =>
  found.map((item) => ({ severity: item.severity, savings: item.savings }))

test("the five rules fire at their thresholds and not below", () => {
  // Near capacity: 80% and up is a warning, in two wordings by whether automatic compaction is on.
  expect(contextSuggestions(info({ window: 100_000, percentage: 79 }))).toEqual([])
  const nearOn = contextSuggestions(info({ window: 100_000, percentage: 80, auto: true }))
  const nearOff = contextSuggestions(info({ window: 100_000, percentage: 80, auto: false }))
  expect(shape(nearOn)).toEqual([{ severity: "warning", savings: undefined }])
  expect(shape(nearOff)).toEqual([{ severity: "warning", savings: undefined }])
  expect(nearOn[0]!.detail).not.toBe(nearOff[0]!.detail)

  // A shell tool at 15% of the window and 10,000 tokens is a warning that saves half; 14.9% or 9,999 tokens is nothing.
  expect(shape(contextSuggestions(info({ window: 100_000, tools: [tool("Bash", 5_000, 10_000)] })))).toEqual([
    { severity: "warning", savings: 7_500 },
  ])
  expect(contextSuggestions(info({ window: 100_000, tools: [tool("Bash", 4_900, 10_000)] }))).toEqual([])
  expect(contextSuggestions(info({ window: 60_000, tools: [tool("Bash", 4_999, 5_000)] }))).toEqual([])
  expect(shape(contextSuggestions(info({ window: 60_000, tools: [tool("Bash", 5_000, 5_000)] })))).toEqual([
    { severity: "warning", savings: 5_000 },
  ])

  // Read, Grep and WebFetch at 15% are information, saving 30%, 30% and 40%.
  for (const [name, savings] of [
    ["Read", 4_500],
    ["Grep", 4_500],
    ["WebFetch", 6_000],
  ] as const)
    expect({ name, found: shape(contextSuggestions(info({ window: 100_000, tools: [tool(name, 5_000, 10_000)] }))) }).toEqual({
      name,
      found: [{ severity: "info", savings }],
    })

  // Any other tool needs 20%, and saves 20%; PowerShell is one of those, as the reference's own PowerShell tool is.
  for (const name of ["Search", "PowerShell"]) {
    expect(contextSuggestions(info({ window: 100_000, tools: [tool(name, 5_000, 10_000)] }))).toEqual([])
    expect(contextSuggestions(info({ window: 100_000, tools: [tool(name, 5_000, 14_999)] }))).toEqual([])
    expect(shape(contextSuggestions(info({ window: 100_000, tools: [tool(name, 5_000, 15_000)] })))).toEqual([
      { severity: "info", savings: 4_000 },
    ])
  }

  // Read results at 5% and 10,000 tokens when the 15% rule did not fire save 30% of the results; when it fired, nothing
  // more is said about Read.
  expect(shape(contextSuggestions(info({ window: 200_000, tools: [tool("Read", 0, 10_000)] })))).toEqual([
    { severity: "info", savings: 3_000 },
  ])
  expect(contextSuggestions(info({ window: 200_000, tools: [tool("Read", 0, 9_999)] }))).toEqual([])
  expect(contextSuggestions(info({ window: 201_000, tools: [tool("Read", 0, 10_000)] }))).toEqual([])
  expect(contextSuggestions(info({ window: 100_000, tools: [tool("Read", 5_000, 10_000)] }))).toHaveLength(1)

  // Instruction files at 5% and 5,000 tokens name the three largest of them and save 30%.
  const files = contextSuggestions(info({ window: 100_000, files: [1_000, 2_000, 1_500, 500] }))
  expect(shape(files)).toEqual([{ severity: "info", savings: 1_500 }])
  expect(files[0]!.detail).toContain("file-1.md")
  expect(files[0]!.detail).toContain("file-2.md")
  expect(files[0]!.detail).toContain("file-0.md")
  expect(files[0]!.detail).not.toContain("file-3.md")
  expect(contextSuggestions(info({ window: 100_000, files: [1_000, 2_000, 1_500, 499] }))).toEqual([])
  expect(contextSuggestions(info({ window: 100_001, files: [1_000, 2_000, 1_500, 500] }))).toEqual([])
  expect(contextSuggestions(info({ window: 50_000, files: [1_000, 2_000, 1_499, 500] }))).toEqual([])

  // Automatic compaction off between 50% and 80% is information with no saving; at 80% the warning takes its place.
  expect(contextSuggestions(info({ window: 100_000, percentage: 49, auto: false }))).toEqual([])
  expect(shape(contextSuggestions(info({ window: 100_000, percentage: 50, auto: false })))).toEqual([
    { severity: "info", savings: undefined },
  ])
  expect(shape(contextSuggestions(info({ window: 100_000, percentage: 79, auto: false })))).toEqual([
    { severity: "info", savings: undefined },
  ])
  expect(shape(contextSuggestions(info({ window: 100_000, percentage: 80, auto: false })))).toEqual([
    { severity: "warning", savings: undefined },
  ])
  expect(contextSuggestions(info({ window: 100_000, percentage: 60, auto: true }))).toEqual([])

  // With no window there is nothing to be a share of.
  expect(
    contextSuggestions(info({ tools: [tool("Bash", 50_000, 50_000)], files: [50_000], auto: false })),
  ).toEqual([])
})

test("warnings come first, then savings largest first", () => {
  const found = contextSuggestions(
    info({
      window: 100_000,
      percentage: 85,
      tools: [tool("Read", 10_000, 20_000), tool("WebFetch", 5_000, 10_000), tool("Bash", 5_000, 11_000)],
      files: [6_000],
    }),
  )

  expect(shape(found)).toEqual([
    { severity: "warning", savings: 8_000 },
    { severity: "warning", savings: undefined },
    { severity: "info", savings: 9_000 },
    { severity: "info", savings: 6_000 },
    { severity: "info", savings: 1_800 },
  ])
  // The titles name their tool.
  expect(found.map((item) => item.title).join("\n")).toContain("Bash")
  expect(found[2]!.title).toContain("Read")
})
