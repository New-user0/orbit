import { expect, test } from "bun:test"
import { workflowAgents, workflowPhases } from "../../src/util/tool-display"

test("workflow agents are read from tool metadata, skipping malformed entries", () => {
  expect(
    workflowAgents([
      { sessionID: "ses_1", description: "Write feature", agent: "general", status: "completed" },
      { sessionID: "ses_2", description: "Review", agent: "explore", status: "running" },
      { sessionID: "ses_3", description: "Bad status", agent: "general", status: "done" },
      { description: "No session", agent: "general", status: "failed" },
      "nonsense",
    ]),
  ).toEqual([
    { sessionID: "ses_1", description: "Write feature", agent: "general", status: "completed" },
    { sessionID: "ses_2", description: "Review", agent: "explore", status: "running" },
  ])
  expect(workflowAgents(undefined)).toEqual([])
})

test("phases, models, timing and tokens are kept, and agents group by phase in order", () => {
  const agents = workflowAgents([
    {
      sessionID: "a",
      description: "Map",
      agent: "explore",
      status: "completed",
      phase: "Discover",
      model: "m",
      started: 1,
      ended: 3,
      tokens: 1200,
    },
    { sessionID: "b", description: "Fix", agent: "general", status: "running", phase: "Build", started: "soon" },
    { sessionID: "c", description: "Scan", agent: "explore", status: "running", phase: "Discover" },
  ])
  expect(agents[0]).toEqual({
    sessionID: "a",
    description: "Map",
    agent: "explore",
    status: "completed",
    phase: "Discover",
    model: "m",
    started: 1,
    ended: 3,
    tokens: 1200,
  })
  expect(agents[1]).not.toHaveProperty("started")
  expect(workflowPhases(agents).map((phase) => [phase.name, phase.agents.map((agent) => agent.sessionID)])).toEqual([
    ["Discover", ["a", "c"]],
    ["Build", ["b"]],
  ])
})
