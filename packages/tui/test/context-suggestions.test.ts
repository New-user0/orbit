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
    model: { providerID: "provider", id: "model" } as SessionContextUsage.Info["model"],
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

test("savings round down, as the reference's do", () => {
  const savings = (window: number, tools: ReadonlyArray<Tool>, files?: ReadonlyArray<number>) =>
    contextSuggestions(info({ window, tools, files })).map((item) => item.savings)
  // Half of 15,001 is 7,500.5; 30% of 10,005 is 3,001.5; 40% of 15,004 is 6,001.6; 20% of 20,003 is 4,000.6.
  expect(savings(100_000, [tool("Bash", 5_001, 10_000)])).toEqual([7_500])
  expect(savings(200_000, [tool("Read", 0, 10_005)])).toEqual([3_001])
  expect(savings(100_000, [tool("WebFetch", 5_004, 10_000)])).toEqual([6_001])
  expect(savings(100_000, [tool("Search", 5_003, 15_000)])).toEqual([4_000])
  // 30% of 5,005 instruction tokens is 1,501.5.
  expect(savings(100_000, [], [5_005])).toEqual([1_501])
})

test("the Read results and instruction files titles carry their share of the window, as the large tool title does", () => {
  const [read] = contextSuggestions(info({ window: 200_000, tools: [tool("Read", 0, 13_000)] }))
  expect(read!.title).toContain("(7%)")
  const [files] = contextSuggestions(info({ window: 100_000, files: [4_000, 2_400] }))
  expect(files!.title).toContain("(6%)")
  const [bash] = contextSuggestions(info({ window: 100_000, tools: [tool("Bash", 5_000, 12_000)] }))
  expect(bash!.title).toContain("(17%)")
})

test("instruction files are named by the path the view shows, escaped", () => {
  const found = contextSuggestions(info({ window: 100_000, files: [3_000, 2_000, 1_000] }), (path) =>
    path.replace("/repo/", "docs/\x1b[2K"),
  )
  expect(found[0]!.detail).toContain("docs/\\x1b[2Kfile-0.md (3")
  expect(found[0]!.detail).not.toContain("/repo/")
  expect(/\p{C}/u.test(found[0]!.detail)).toBe(false)
  // Without a display, the path is the payload's.
  expect(contextSuggestions(info({ window: 100_000, files: [3_000, 2_000, 1_000] }))[0]!.detail).toContain(
    "/repo/file-0.md",
  )
})

test("each piece of advice is Orbit's own wording", () => {
  const detail = (input: Parameters<typeof info>[0]) => contextSuggestions(info(input)).map((item) => item.detail)
  const advice = [
    ...detail({ window: 100_000, percentage: 80, auto: true }),
    ...detail({ window: 100_000, percentage: 80, auto: false }),
    ...detail({ window: 100_000, percentage: 50, auto: false }),
    ...["Bash", "Read", "Grep", "WebFetch", "Search"].flatMap((name) =>
      detail({ window: 100_000, tools: [tool(name, 5_000, 15_000)] }),
    ),
    ...detail({ window: 200_000, tools: [tool("Read", 0, 10_000)] }),
    ...detail({ window: 100_000, files: [1_000, 2_000, 1_500, 500] }),
  ]
  expect(advice).toEqual([
    "/compact runs it at a moment you pick; left alone, Orbit compacts the conversation by itself shortly.",
    "Turning automatic compaction back on, or running /compact yourself, keeps the window from filling up, since with the setting off nothing summarizes the conversation for you.",
    "A full window will not be summarized for you, so run /compact before it fills.",
    "Commands that print a lot fill the conversation. Cut their output down in the command itself, for example to the first or last lines or to the lines that match.",
    "Read a long file in pieces by giving an offset and a limit.",
    "Narrow what each search covers: a more exact pattern, a single folder or one file type.",
    "Whole web pages cost many tokens. Name the part of the page you are after in the request.",
    "Call Search with tighter inputs, or have each call return less.",
    "Read a long file in pieces by giving an offset and a limit.",
    "Most of it sits in /repo/file-1.md (2.0K), /repo/file-2.md (1.5K), /repo/file-0.md (1.0K), which /memory opens for trimming.",
  ])
  // The phrasings that the earlier rewrites still shared with the reference's sentences stay out.
  for (const text of advice)
    expect(text).not.toMatch(
      /Pipe|head, tail or grep|summary is close|run long|line ranges|Biggest:|will start soon|lets you choose when|Shorten them|is off, so a full window/,
    )
})

test("each suggestion's title is Orbit's own wording", () => {
  const title = (input: Parameters<typeof info>[0]) => contextSuggestions(info(input)).map((item) => item.title)
  expect([
    ...title({ window: 100_000, percentage: 80, auto: true }),
    ...title({ window: 100_000, percentage: 50, auto: false }),
    ...title({ window: 100_000, tools: [tool("Bash", 5_000, 15_000)] }),
    ...title({ window: 200_000, tools: [tool("Read", 0, 10_000)] }),
    ...title({ window: 100_000, files: [1_000, 2_000, 1_500, 500] }),
  ]).toEqual([
    "80% of the window is in use",
    "Auto-compaction is switched off",
    "Bash uses 20.0K tokens across its calls and results (20%)",
    "What Read returned holds 10.0K tokens (5%)",
    "Instructions hold 5.0K tokens (5%)",
  ])
})
