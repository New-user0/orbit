import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"
import { ConfigAgent } from "../src/config/agent.js"

test("Agent.Info round-trips the definition fields, and an empty allow list stays apart from none", () => {
  const base = Agent.Info.default(Agent.ID.make("reviewer"))
  const full = {
    ...base,
    modelTier: "small",
    effort: "high",
    tools: { allow: [], deny: ["shell"] },
    permissionMode: "accept-edits",
    mcpServers: ["docs", { local: { type: "local", command: ["server"] } }],
    skills: ["deploy"],
    initialPrompt: "Start here.",
    memory: "project",
    background: true,
    isolation: "worktree",
    context: { instructions: false, git_status: false },
    source: { scope: "project", path: "/repo/.orbit/agents/reviewer.md" },
  }
  const decode = Schema.decodeUnknownSync(Agent.Info)
  const encode = Schema.encodeSync(Agent.Info)
  expect(decode(JSON.parse(JSON.stringify(encode(decode(full)))))).toEqual(decode(full))
  expect(decode(full).tools?.allow).toEqual([])
  expect(decode({ ...full, tools: { deny: ["shell"] } }).tools?.allow).toBeUndefined()
  expect(decode(base).source).toBeUndefined()
})

test.each([
  ["reviewer", true],
  ["team/helper", true],
  ["a.b_c-d", true],
  ["9lives", true],
  ["", false],
  ["..", false],
  [".hidden", false],
  ["a/../b", false],
  ["a//b", false],
  ["a\\b", false],
  ["a:b", false],
  ["a b", false],
  ["foo.", false],
  ["nul", false],
  ["CON", false],
  ["con.txt", false],
  ["Com1", false],
  ["lpt9.log", false],
  ["com10", true],
  ["a\u0000b", false],
  ["x".repeat(64), true],
  ["x".repeat(65), false],
])("ConfigAgent.isName(%p) is %p", (name, plain) => {
  expect(ConfigAgent.isName(name)).toBe(plain)
})

test.each([
  ["read, grep", ["read", "grep"]],
  ["read grep", ["read", "grep"]],
  ["  read ,, grep  ", ["read", "grep"]],
  ["shell(git status:*) read", ["shell(git status:*)", "read"]],
  ["shell(a, b), read", ["shell(a, b)", "read"]],
  ["", []],
])("ConfigAgent.splitList(%p)", (input, expected) => {
  expect(ConfigAgent.splitList(input)).toEqual(expected)
})

test("ConfigAgent.Info reads the definition keys and rejects the bad ones", () => {
  const decode = Schema.decodeUnknownSync(ConfigAgent.Info)
  expect(decode({ model: " Large ", max_turns: "4", background: "true", tools: "read, grep" })).toMatchObject({
    model: "large",
    max_turns: 4,
    background: true,
    tools: ["read", "grep"],
  })
  for (const bad of [{ model: "fast" }, { max_turns: 0 }, { memory: "global" }, { isolation: "remote" }, { effort: "a#b" }])
    expect(() => decode(bad)).toThrow()
})

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})
