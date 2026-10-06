import { afterAll, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { evaluate } from "../src/eval"
import { loadWorkflow, suiteAgents, workflowAgents } from "../src/load"
import { run } from "../src/runner"

// Before anything runs, a caller asks which agents a workflow or suite names (`workflowAgents`, `suiteAgents`), and the
// runner sends an agent to the server for each session it opens. These run the real runner against a client that only
// records the agent of every session it is asked to create, and hold the two to each other: every agent that is sent is
// one that the file was listed with, so a file cannot choose one that the gate did not name.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-agents-"))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// A client that opens sessions and answers each prompt by what it asks: a reviewer approves, a team's lead hands work to
// `coder` and finishes once nobody has anything pending, and everyone else says ok. `sent` is the agent of every session
// it was asked to open, in order, and nothing for a session that asked for none.
function recording() {
  const sent: string[] = []
  const prompts = new Map<string, string>()
  let sessions = 0
  let replies = 0
  const reply = (prompt: string) => {
    if (prompt.includes("Review a change another agent made")) return "APPROVED"
    if (prompt.includes("You lead.")) return '<message to="coder">go</message>'
    if (prompt.includes("Nobody on the team has anything pending")) return "<done>finished</done>"
    return "ok"
  }
  const client = {
    session: {
      create: async (input: { readonly agent?: string }) => {
        if (input.agent !== undefined) sent.push(input.agent)
        return { id: `ses_${++sessions}` }
      },
      prompt: async (input: { readonly sessionID: string; readonly text: string }) => {
        prompts.set(input.sessionID, input.text)
      },
      wait: async () => ({}),
      get: async () => undefined,
    },
    // Every call answers with a message of its own, so a session that continues sees the reply to its latest prompt as new.
    message: {
      list: async (input: { readonly sessionID: string }) => ({
        data: [
          {
            id: `msg_${replies++}`,
            type: "assistant",
            content: [{ type: "text", text: reply(prompts.get(input.sessionID) ?? "") }],
            tokens: {},
            cost: 0,
          },
        ],
      }),
    },
    model: { list: async () => ({ data: [{ providerID: "ollama", id: "a" }] }) },
    event: { subscribe: async function* () {} },
  } as unknown as OrbitClient
  return { client, sent }
}

test("every agent that a run of a workflow sends to the server is one that workflowAgents listed", async () => {
  const file = path.join(root, "workflow.yaml")
  await Bun.write(
    file,
    [
      "name: roles",
      "nodes:",
      "  - id: planned",
      "    prompt: say ok",
      "    agent: planner",
      "  - id: unnamed",
      "    prompt: say ok",
      "  - id: author",
      "    type: verify",
      "    needs: [planned]",
      "    prompt: say ok",
      "    agent: builder",
      "    checks: []",
      "    judge: { agent: reviewer }",
      "  - id: crew",
      "    type: team",
      "    needs: [author]",
      "    goal: say ok",
      "    members:",
      "      lead: { role: lead, agent: captain }",
      "      coder: { role: code, agent: coder }",
      "      tester: { role: test, agent: tester }",
      "",
    ].join("\n"),
  )
  const { client, sent } = recording()

  const result = await run({ client, workflow: await loadWorkflow(file), file, directory: root })
  const listed = (await workflowAgents(file)).map((item) => item.agent)

  expect(result).toMatchObject({ status: "succeeded" })
  // A node, the author of a verify node and its judge, and the members of a team that took a turn: the lead, which hands
  // the work to the coder. The tester never took one, so no session was opened for it.
  expect(sent.toSorted()).toEqual(["builder", "captain", "coder", "planner", "reviewer"])
  // The file is listed with every agent that it names, those that were never asked included.
  expect(listed.toSorted()).toEqual(["builder", "captain", "coder", "planner", "reviewer", "tester"])
  for (const agent of sent) expect(listed).toContain(agent)
})

test("every agent that an eval sends to the server is one that suiteAgents listed, and a task's own agent is neither", async () => {
  const file = path.join(root, "suite.json")
  const suite = {
    name: "judged",
    models: ["ollama/a"],
    tasks: [
      { id: "reviewed", prompt: "say ok", checks: [], judge: { agent: "reviewer" } },
      // `evaluate` hands the verify node of a task its `judge` and no agent of its own, so this one chooses nothing.
      { id: "own", prompt: "say ok", checks: [], agent: "captain" },
      { id: "plain", prompt: "say ok", checks: [], judge: true },
    ],
  }
  await Bun.write(file, JSON.stringify(suite))
  const { client, sent } = recording()

  const result = await evaluate({ client, suite, file, directory: root })
  const listed = (await suiteAgents(file)).map((item) => item.agent)

  expect(result.scores?.map((score) => [score.task, score.passed])).toEqual([
    ["reviewed", true],
    ["own", true],
    ["plain", true],
  ])
  expect(sent).toEqual(["reviewer"])
  expect(listed).toEqual(["reviewer"])
})
