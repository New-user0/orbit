import { expect, test } from "bun:test"
import { SessionContextUsage } from "../src/session-context-usage.js"

// clients-ux-23, class 7: a client decodes `/context`'s payload entry by entry, so one entry it cannot read (a category
// kind from a newer server, a malformed file or tool row) costs only that entry, and a payload whose own fields do not
// decode is no answer at all.

const valid = {
  model: { providerID: "provider", id: "model" },
  window: 100_000,
  percentage: 18,
  threshold: 90_000,
  total: 17_700,
  measured: true,
  auto: true,
  categories: [
    { kind: "system", tokens: 2_600 },
    { kind: "messages", tokens: 4_800 },
  ],
  files: [{ path: "/repo/ORBIT.md", type: "file", tokens: 1_200 }],
  mcp: [{ name: "docs_search", server: "docs", tokens: 2_000, deferred: false }],
  agents: [{ id: "reviewer", scope: "project", tokens: 600 }],
  skills: [{ id: "release", tokens: 700 }],
  systemTools: [{ name: "Read", tokens: 1_400 }],
  deferredTools: [{ name: "Later", tokens: 300 }],
  sections: [{ name: "Environment", tokens: 1_100 }],
  messages: {
    toolCalls: 1,
    toolResults: 2,
    attachments: 3,
    assistant: 4,
    user: 5,
    tools: [{ name: "Bash", calls: 10, results: 20 }],
    attachmentKinds: [{ name: "todo", tokens: 6 }],
  },
}

test("a whole payload decodes with nothing dropped", () => {
  const decoded = SessionContextUsage.decode(valid)
  expect(decoded?.dropped).toEqual([])
  expect(decoded?.info).toEqual(valid as unknown as SessionContextUsage.Info)
})

test("an entry that does not decode is left out, named, and its siblings stay", () => {
  const decoded = SessionContextUsage.decode({
    ...valid,
    categories: [{ kind: "system", tokens: 2_600 }, { kind: "newer-kind", tokens: 900 }, { kind: "messages", tokens: 4_800 }],
    files: [{ path: 7 }, ...valid.files],
    mcp: [...valid.mcp, { name: "broken" }],
    agents: [null, ...valid.agents],
    skills: [{ id: "release", tokens: -1 }, ...valid.skills],
    systemTools: ["Read", ...valid.systemTools],
    deferredTools: [{}, ...valid.deferredTools],
    sections: [{ name: 1, tokens: 1 }, ...valid.sections],
    messages: {
      ...valid.messages,
      tools: [{ name: "Grep" }, ...valid.messages.tools],
      attachmentKinds: [...valid.messages.attachmentKinds, { tokens: 1 }],
    },
  })

  expect(decoded?.info).toEqual(valid as unknown as SessionContextUsage.Info)
  expect(decoded?.dropped).toEqual([
    "categories[1]",
    "files[0]",
    "mcp[1]",
    "agents[0]",
    "skills[0]",
    "systemTools[0]",
    "deferredTools[0]",
    "sections[0]",
    "messages.tools[0]",
    "messages.attachmentKinds[1]",
  ])
})

test("a payload whose own fields do not decode is no answer", () => {
  expect(SessionContextUsage.decode({ nope: true })).toBeUndefined()
  expect(SessionContextUsage.decode({ ...valid, model: "not a model" })).toBeUndefined()
  expect(SessionContextUsage.decode({ ...valid, categories: "not a list" })).toBeUndefined()
  expect(SessionContextUsage.decode({ ...valid, messages: { ...valid.messages, user: -1 } })).toBeUndefined()
  expect(SessionContextUsage.decode(undefined)).toBeUndefined()
})
