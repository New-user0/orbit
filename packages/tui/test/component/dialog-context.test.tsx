import { expect, test } from "bun:test"
import type { SessionContextUsage } from "@orbit/schema/session-context-usage"
import { DialogContext } from "../../src/component/dialog-context"
import { json } from "../fixture/tui-client"
import { renderLocal, session } from "../fixture/local"

// clients-ux-23: `/context` draws the server's analysis of the session's context window as the reference draws its own:
// a square grid beside a legend, the lists of MCP tools, custom agents, instruction files and skills, and the suggestions.
// The real dialog, the real client and a fetch handler that answers the route; what is asserted is the drawn frame.

type Info = SessionContextUsage.Info
type Category = SessionContextUsage.Category

const FULL = "■"
const PARTIAL = "▪"
const FREE = "□"
const BUFFER = "▣"
const RUN = /[■▪□▣] [■▪□▣]/

const ROOT = "ses_root"
const CHILD = "ses_child"
const route = (id: string) => `/api/session/${id}/context/usage`

function fixture(overrides: Partial<Info> = {}): Info {
  return {
    model: { providerID: "provider", id: "model" } as Info["model"],
    window: 100_000,
    percentage: 18,
    threshold: 90_000,
    total: 17_700,
    measured: true,
    auto: true,
    // On a 10 by 10 grid one square is 1,000 tokens: 2.6 squares round to 3 with a partial last one, 0.3 round to the
    // one square every category gets, 4.8 round to 5 with a full last one.
    categories: [
      { kind: "system", tokens: 2_600 },
      { kind: "tools", tokens: 300 },
      { kind: "mcp-deferred", tokens: 5_000 },
      { kind: "messages", tokens: 4_800 },
      { kind: "auto-buffer", tokens: 10_000 },
      { kind: "free", tokens: 82_300 },
    ],
    files: [],
    mcp: [],
    agents: [],
    skills: [],
    systemTools: [],
    deferredTools: [],
    sections: [],
    messages: { toolCalls: 0, toolResults: 0, attachments: 0, assistant: 0, user: 0, tools: [], attachmentKinds: [] },
    ...overrides,
  }
}

/** Opens `/context` for `sessionID` with the route answered by `answer`, and returns what was asked and the frame. */
async function open(input: {
  readonly answer: (url: URL) => Response | Promise<Response>
  readonly width?: number
  readonly sessionID?: string
  readonly timeout?: number
  readonly done: (frame: string) => boolean
  readonly messages?: unknown[]
}) {
  const asked: string[] = []
  const setup = await renderLocal({
    width: input.width ?? 100,
    height: 90,
    sessions: [session(ROOT), { ...session(CHILD), parentID: ROOT }],
    fetch: async (url) => {
      if (url.pathname.endsWith("/context/usage")) {
        asked.push(url.pathname)
        return input.answer(url)
      }
      if (url.pathname === `/api/session/${ROOT}/message`) return json({ data: input.messages ?? [], cursor: {} })
    },
  })
  setup.dialog.replace(
    () => <DialogContext sessionID={input.sessionID ?? ROOT} timeout={input.timeout} />,
    undefined,
    { size: "large" },
  )
  // The answer arrives on its own time (a slow one only after the timeout), so the frame is drawn again until it shows.
  for (let attempt = 0; attempt < 200 && !input.done(setup.captureCharFrame()); attempt++) {
    await Bun.sleep(25)
    await setup.renderOnce()
  }
  await Bun.sleep(50)
  await setup.renderOnce()
  return { setup, asked, frame: setup.captureCharFrame() }
}

const answering = (info: Info) => () => json({ data: info })
const drawn = (frame: string) => frame.includes("Estimated usage by category")

/** The grid's rows, each as its squares without the spaces between them. */
function grid(frame: string) {
  const lines = frame.split("\n")
  const start = lines.findIndex((line) => RUN.test(line))
  if (start === -1) return []
  const column = lines[start]!.search(RUN)
  const rows: string[] = []
  for (const line of lines.slice(start)) {
    const run = /^(?:[■▪□▣] )*[■▪□▣]/.exec(line.slice(column))?.[0]
    if (run === undefined || run.length < 3) break
    rows.push(run.replaceAll(" ", ""))
  }
  return rows
}

const sizes = (rows: string[]) => ({ rows: rows.length, columns: [...new Set(rows.map((row) => row.length))] })

// TD1: the reference's grid sizes, narrow from below 80 columns.
test("a window under 1M draws 10 by 10 squares at 80 columns or more and 5 by 5 below", async () => {
  for (const [width, expected] of [
    [100, { rows: 10, columns: [10] }],
    [80, { rows: 10, columns: [10] }],
    [79, { rows: 5, columns: [5] }],
  ] as Array<[number, { rows: number; columns: number[] }]>) {
    const result = await open({ answer: answering(fixture()), width, done: drawn })
    await using _ = result.setup
    expect({ width, size: sizes(grid(result.frame)) }).toEqual({ width, size: expected })
  }
})

// TD2: a window of a million tokens or more gets twice the columns, and twice the rows when narrow.
test("a window of 1M or more draws 20 by 10, and 5 by 10 below 80 columns", async () => {
  const large = fixture({
    window: 1_000_000,
    percentage: 2,
    categories: [
      { kind: "system", tokens: 26_000 },
      { kind: "messages", tokens: 48_000 },
      { kind: "auto-buffer", tokens: 33_000 },
      { kind: "free", tokens: 893_000 },
    ],
  })
  for (const [width, expected] of [
    [80, { rows: 10, columns: [20] }],
    [79, { rows: 10, columns: [5] }],
  ] as Array<[number, { rows: number; columns: number[] }]>) {
    const result = await open({ answer: answering(large), width, done: drawn })
    await using _ = result.setup
    expect({ width, size: sizes(grid(result.frame)) }).toEqual({ width, size: expected })
  }
})

// TD3: squares in category order; every counted category gets one at least; a last square filled below 0.7 is the lighter
// glyph; free space fills the middle and the reserve takes the end.
test("each counted category gets at least one square in order, a partial last square uses the lighter glyph below 0.7, free space fills the middle and the reserve sits at the end", async () => {
  const result = await open({ answer: answering(fixture()), done: drawn })
  await using _ = result.setup

  expect(grid(result.frame).join("")).toBe(
    `${FULL}${FULL}${PARTIAL}` + PARTIAL + FULL.repeat(5) + FREE.repeat(81) + BUFFER.repeat(10),
  )
})

// TD4: a deferred row is listed, with N/A for its share, and takes no square.
test("deferred rows are listed with N/A and take no square", async () => {
  const result = await open({ answer: answering(fixture()), done: drawn })
  await using _ = result.setup

  expect(result.frame).toContain("MCP tools (deferred): 5.0K tokens (N/A)")
  expect(grid(result.frame).join("").length).toBe(100)
  expect(grid(result.frame).join("").split(FREE).length - 1).toBe(81)
})

// TD5: the legend, and the compact buffer listed as a category when automatic compaction is off.
test("the legend shows the model, total of window and percent, each category to one decimal, free space and the autocompact buffer, and the compact buffer as a category when auto compaction is off", async () => {
  const auto = await open({ answer: answering(fixture()), done: drawn })
  await using _ = auto.setup
  const lines = auto.frame.split("\n")
  const at = (text: string) => lines.findIndex((line) => line.includes(text))
  const legend = [
    "provider/model · 17.7K/100.0K tokens (18%)",
    "Estimated usage by category",
    "System prompt: 2.6K tokens (2.6%)",
    "System tools: 300 tokens (0.3%)",
    "MCP tools (deferred): 5.0K tokens (N/A)",
    "Messages: 4.8K tokens (4.8%)",
    "Free space: 82.3K tokens (82.3%)",
    "Autocompact buffer: 10.0K tokens (10.0%)",
  ].map(at)
  expect(legend.every((index) => index >= 0)).toBe(true)
  expect(legend).toEqual(legend.toSorted((a, b) => a - b))

  const manual = await open({
    answer: answering(
      fixture({
        auto: false,
        categories: [
          { kind: "system", tokens: 2_600 },
          { kind: "messages", tokens: 4_800 },
          { kind: "compact-buffer", tokens: 3_000 },
          { kind: "free", tokens: 89_600 },
        ],
      }),
    ),
    done: drawn,
  })
  await using __ = manual.setup
  const manualLines = manual.frame.split("\n")
  const compact = manualLines.findIndex((line) => line.includes("Compact buffer: 3.0K tokens (3.0%)"))
  const free = manualLines.findIndex((line) => line.includes("Free space: 89.6K tokens (89.6%)"))
  expect(compact).toBeGreaterThanOrEqual(0)
  expect(free).toBeGreaterThan(compact)
  expect(manual.frame).not.toContain("Autocompact buffer")
  // Drawn like a category: full squares at the end, after free space.
  expect(grid(manual.frame).join("")).toBe(`${FULL}${FULL}${PARTIAL}` + FULL.repeat(5) + FREE.repeat(89) + FULL.repeat(3))
})

// TD6, D5 and D6: the sections the reference shows, and not the ones it keeps for its report.
test("MCP tools (loaded and available), custom agents by scope, instruction files and skills are listed, and system tools, prompt sections and the message breakdown are not", async () => {
  const result = await open({
    answer: answering(
      fixture({
        files: [{ path: `${session(ROOT).location.directory}/ORBIT.md`, type: "file", tokens: 1_200 }],
        mcp: [
          { name: "docs_search", server: "docs", tokens: 2_000, deferred: false },
          { name: "docs_fetch", server: "docs", tokens: 1_500, deferred: true },
        ],
        agents: [
          { id: "helper", scope: "user", tokens: 300 },
          { id: "reviewer", scope: "project", tokens: 600 },
        ],
        skills: [{ id: "release", tokens: 700 }],
        systemTools: [{ name: "SysToolZed", tokens: 12_000 }],
        sections: [{ name: "SectionQuux", tokens: 4_000 }],
        messages: {
          toolCalls: 10,
          toolResults: 10,
          attachments: 10,
          assistant: 10,
          user: 10,
          tools: [{ name: "ToolBreakX", calls: 10, results: 10 }],
          attachmentKinds: [{ name: "AttachKindY", tokens: 10 }],
        },
      }),
    ),
    done: (frame) => frame.includes("release"),
  })
  await using _ = result.setup
  const lines = result.frame.split("\n")
  const at = (text: string) => lines.findIndex((line) => line.includes(text))
  const order = [
    "MCP tools · /mcps",
    "Loaded",
    "docs_search",
    "Available",
    "docs_fetch",
    "Custom agents · /agents",
    "Project",
    "reviewer",
    "User",
    "helper",
    "Instruction files · /memory",
    "ORBIT.md",
    "Skills · /skills",
    "release",
  ].map(at)
  expect(order.every((index) => index >= 0)).toBe(true)
  expect(order).toEqual(order.toSorted((a, b) => a - b))
  expect(lines[at("docs_search")]).toContain("2.0K")
  expect(lines[at("ORBIT.md")]).toContain("1.2K")
  for (const hidden of ["SysToolZed", "SectionQuux", "ToolBreakX", "AttachKindY"]) expect(result.frame).not.toContain(hidden)
})

// TD7: the suggestions, under everything else, warnings first, each with its saving.
test("suggestions are drawn under the view, warnings first, with their savings", async () => {
  const result = await open({
    answer: answering(
      fixture({
        percentage: 85,
        total: 85_000,
        skills: [{ id: "release", tokens: 700 }],
        messages: {
          toolCalls: 0,
          toolResults: 0,
          attachments: 0,
          assistant: 0,
          user: 0,
          tools: [
            { name: "Read", calls: 10_000, results: 20_000 },
            { name: "Bash", calls: 5_000, results: 11_000 },
          ],
          attachmentKinds: [],
        },
      }),
    ),
    done: (frame) => frame.includes("Suggestions"),
  })
  await using _ = result.setup
  const lines = result.frame.split("\n")
  const at = (text: string) => lines.findIndex((line) => line.includes(text))
  const heading = at("Suggestions")
  const bash = lines.findIndex((line) => line.includes("Bash") && line.includes("8.0K"))
  const read = lines.findIndex((line) => line.includes("Read") && line.includes("9.0K"))
  expect(heading).toBeGreaterThan(at("release"))
  expect(bash).toBeGreaterThan(heading)
  expect(read).toBeGreaterThan(bash)
  expect(lines[bash]).toContain("!")
})

// TD8, D1 and D10: the figure is the payload's, not one worked out from the messages the store holds.
test("a measured total and percent come from the payload, not from the messages in the store", async () => {
  const result = await open({
    answer: answering(fixture()),
    done: drawn,
    messages: [
      {
        id: "msg_0001",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "first" },
        time: { created: 1, streamed: 2, completed: 3 },
        finish: "stop",
        cost: 0,
        tokens: { input: 1_000, output: 90_000, reasoning: 0, cache: { read: 0, write: 0 } },
        content: [{ type: "text", text: "Answer" }],
      },
    ],
  })
  await using _ = result.setup

  expect(result.frame).toContain("17.7K/100.0K tokens (18%)")
  expect(result.frame).not.toContain("91")
})

// TD9, class 9: every string of the payload is drawn through `plain`.
test("every string from the payload is escaped in the frame", async () => {
  const hostile = "\x1b]0;x\x07\x1b[2K\u009b\u202e"
  const result = await open({
    answer: answering(
      fixture({
        model: { providerID: `provider${hostile}`, id: `model${hostile}` } as Info["model"],
        files: [{ path: `/elsewhere/file${hostile}.md`, type: "file", tokens: 1_200 }],
        mcp: [
          { name: `tool${hostile}`, server: `server${hostile}`, tokens: 2_000, deferred: false },
          { name: `later${hostile}`, server: `server${hostile}`, tokens: 1_500, deferred: true },
        ],
        agents: [{ id: `agent${hostile}`, scope: `scope${hostile}`, tokens: 300 }],
        skills: [{ id: `skill${hostile}`, tokens: 700 }],
        messages: {
          toolCalls: 0,
          toolResults: 0,
          attachments: 0,
          assistant: 0,
          user: 0,
          tools: [{ name: `shell${hostile}`, calls: 10_000, results: 15_000 }],
          attachmentKinds: [],
        },
      }),
    ),
    done: (frame) => frame.includes("Suggestions") && frame.includes("skill"),
  })
  await using _ = result.setup

  expect(/\p{C}/u.test(result.frame.replaceAll("\n", ""))).toBe(false)
  for (const name of ["provider", "file", "tool", "later", "server", "agent", "scope", "skill", "shell"])
    expect(result.frame).toContain(`${name}\\x1b]0;x`)
})

// TD10, D9: with no window there is nothing to be a share of.
test("an unknown window shows rows and the total without a grid, percentages, reserve, free space or suggestions", async () => {
  const result = await open({
    answer: answering(
      fixture({
        window: undefined,
        percentage: undefined,
        threshold: undefined,
        total: 7_700,
        categories: [
          { kind: "system", tokens: 2_600 },
          { kind: "tools", tokens: 300 },
          { kind: "messages", tokens: 4_800 },
        ],
        messages: {
          toolCalls: 0,
          toolResults: 0,
          attachments: 0,
          assistant: 0,
          user: 0,
          tools: [{ name: "Bash", calls: 50_000, results: 50_000 }],
          attachmentKinds: [],
        },
      }),
    ),
    done: drawn,
  })
  await using _ = result.setup

  expect(result.frame).toContain("provider/model · 7.7K tokens")
  expect(result.frame).toContain("System prompt: 2.6K tokens")
  expect(result.frame).toContain("Messages: 4.8K tokens")
  expect(grid(result.frame)).toEqual([])
  expect(result.frame).not.toContain("%")
  for (const missing of ["Free space", "buffer", "Suggestions"]) expect(result.frame).not.toContain(missing)
})

// TD11, classes 7 and 13: each failure is one line, and the server's own message is escaped.
test("a refusal, a missing session, an old server, a body that does not decode and a timeout each draw one line", async () => {
  const rows: ReadonlyArray<{ name: string; answer: () => Response | Promise<Response>; line: string }> = [
    {
      name: "untrusted",
      answer: () =>
        json(
          {
            _tag: "UntrustedFolderError",
            directory: "/repo",
            persistent: true,
            message: "/repo\x1b[2K is not trusted. Trust it with `orb trust`.",
          },
          { status: 403 },
        ),
      line: "/repo\\x1b[2K is not trusted.",
    },
    {
      name: "missing session",
      answer: () => json({ _tag: "SessionNotFoundError", sessionID: ROOT, message: `Session not found: ${ROOT}` }, { status: 404 }),
      line: `Session not found: ${ROOT}`,
    },
    { name: "old server", answer: () => new Response(null, { status: 404 }), line: "older than this client" },
    { name: "bad body", answer: () => json({ data: { nope: true } }), line: "could not be read" },
    {
      name: "timeout",
      answer: async () => {
        await Bun.sleep(3_000)
        return json({ data: fixture() })
      },
      line: "did not answer in time",
    },
  ]
  for (const row of rows) {
    const result = await open({ answer: row.answer, timeout: 50, done: (frame) => frame.includes(row.line) })
    await using _ = result.setup
    expect({ name: row.name, shown: result.frame.includes(row.line) }).toEqual({ name: row.name, shown: true })
    expect(/\p{C}/u.test(result.frame.replaceAll("\n", ""))).toBe(false)
    expect(grid(result.frame)).toEqual([])
    expect(result.frame).not.toContain("Estimated usage")
  }
})

// TD12, D8: a child session's context is its root's, so the dialog asks for the root.
test("viewing a child session asks for its root", async () => {
  const result = await open({ answer: answering(fixture()), sessionID: CHILD, done: drawn })
  await using _ = result.setup

  expect(result.asked).toEqual([route(ROOT)])
  expect(result.frame).toContain("17.7K/100.0K tokens (18%)")
})
