import { expect, test } from "bun:test"
import { agentsOf, describe, duration, excerpt, phases, segments, tokens } from "../src/webview/present"

test("reads, searches and edits read as a verb and a path from the workspace folder", () => {
  expect(
    describe(
      {
        type: "tool",
        id: "1",
        name: "read",
        status: "completed",
        input: { path: "/home/me/harness/src/a.ts" },
        output: "1\n2\n3",
      },
      "harness",
    ),
  ).toEqual({ verb: "Read", target: "src/a.ts", meta: "3 lines" })
  expect(
    describe(
      {
        type: "tool",
        id: "2",
        name: "grep",
        status: "completed",
        input: { pattern: "connect(" },
        output: "a.ts:1\nb.ts:2",
      },
      "harness",
    ),
  ).toEqual({ verb: "Search", target: "connect(", meta: "2 results" })
  expect(
    describe(
      {
        type: "tool",
        id: "3",
        name: "edit",
        status: "completed",
        input: { path: "src/a.ts" },
        files: [{ file: "src/a.ts", patch: "", additions: 10, deletions: 3 }],
      },
      "harness",
    ),
  ).toEqual({ verb: "Edit", target: "src/a.ts", add: "+10", del: "−3" })
  expect(
    describe(
      {
        type: "tool",
        id: "3b",
        name: "notebook_edit",
        status: "completed",
        input: { path: "notes/analysis.ipynb" },
        files: [{ file: "notes/analysis.ipynb", patch: "", additions: 2, deletions: 1 }],
      },
      "harness",
    ),
  ).toEqual({ verb: "Edit", target: "notes/analysis.ipynb", add: "+2", del: "−1" })
})

test("a new file is created, and a failing command shows its exit code", () => {
  expect(
    describe(
      {
        type: "tool",
        id: "4",
        name: "write",
        status: "completed",
        input: { path: "src/retry.ts" },
        files: [{ file: "src/retry.ts", patch: "", status: "added", additions: 28 }],
      },
      "harness",
    ),
  ).toMatchObject({ verb: "Create", add: "+28" })
  expect(
    describe(
      {
        type: "tool",
        id: "6",
        name: "write",
        status: "completed",
        input: { path: "hello.txt", content: "hi\nthere\n" },
        output: "Created file successfully: hello.txt",
      },
      "x",
    ),
  ).toMatchObject({ verb: "Create", add: "+2" })
  expect(
    describe(
      { type: "tool", id: "5", name: "shell", status: "completed", input: { command: "bun test\nmore" }, exit: 1 },
      "x",
    ),
  ).toEqual({ verb: "Run", target: "bun test", meta: "exit 1", failed: true })
})

test("background command tools name the command they act on", () => {
  expect(
    describe(
      { type: "tool", id: "7", name: "shell_watch", status: "completed", input: { shellID: "sh_1", pattern: "ready" } },
      "x",
    ),
  ).toEqual({ verb: "Watch", target: "sh_1 for ready" })
  expect(
    describe({ type: "tool", id: "8", name: "shell_stop", status: "completed", input: { shellID: "sh_1" } }, "x"),
  ).toEqual({
    verb: "Stop",
    target: "sh_1",
  })
})

test("a patch excerpt keeps only changed lines", () => {
  const patch = "--- a\n+++ b\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n+more"
  expect(excerpt(patch, 2)).toEqual([
    { kind: "del", text: "old" },
    { kind: "add", text: "new" },
  ])
})

test("inline code and bold are the only markup", () => {
  expect(segments("Use `retry()` **now**, not <b>later</b>")).toEqual([
    { kind: "text", text: "Use " },
    { kind: "code", text: "retry()" },
    { kind: "text", text: " " },
    { kind: "strong", text: "now" },
    { kind: "text", text: ", not <b>later</b>" },
  ])
})

test("a chat's agents come from its workflows and subagent calls, grouped by phase", () => {
  const agents = agentsOf([
    { type: "user", id: "u", text: "go" },
    {
      type: "tool",
      id: "w",
      name: "workflow",
      status: "running",
      agents: [
        {
          sessionID: "a",
          description: "Map",
          agent: "explore",
          status: "completed",
          phase: "Discover",
          started: 0,
          ended: 4000,
          tokens: 1200,
        },
        { sessionID: "b", description: "Fix", agent: "general", status: "running", phase: "Build", started: 1000 },
        {
          sessionID: "c",
          description: "Scan",
          agent: "explore",
          status: "completed",
          phase: "Discover",
          started: 0,
          ended: 2000,
          tokens: 800,
        },
      ],
    },
    { type: "tool", id: "s", name: "subagent", status: "error", input: { description: "Audit", agent: "explore" } },
  ])
  expect(agents.map((agent) => [agent.description, agent.status])).toEqual([
    ["Map", "completed"],
    ["Fix", "running"],
    ["Scan", "completed"],
    ["Audit", "failed"],
  ])
  expect(phases(agents.slice(0, 3)).map((phase) => [phase.name, phase.agents.length])).toEqual([
    ["Discover", 2],
    ["Build", 1],
  ])
  expect(tokens(agents)).toBe(2000)
  expect(duration(agents.slice(0, 3), 75_000)).toBe("1m 15s")
  expect(duration([agents[0]!, agents[2]!], 75_000)).toBe("4s")
})
