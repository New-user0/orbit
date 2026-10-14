import { afterAll, expect, test } from "bun:test"
import type { OrbitClient } from "@orbit/client"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { evaluate } from "../src/eval"
import { Git } from "../src/git"
import { loadWorkflow, suiteAgents, workflowAgents } from "../src/load"
import { run } from "../src/runner"

// Before anything runs, a caller asks which agents a workflow or suite names (`workflowAgents`, `suiteAgents`), and the
// runner sends an agent to the server for each session it opens. These run the real runner against a client that only
// records the agent of every session it is asked to create, and hold the two to each other: every agent that is sent is
// one that the file was listed with, so a file cannot choose one that the gate did not name. The same client records the
// title of each session, and can write a file as an agent does, so that the last two tests hold what the runner leaves
// behind from the text of a file, a session title and a commit message, to what a terminal can show.

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-agents-"))

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// A client that opens sessions and answers each prompt by what it asks: a reviewer approves, a team's lead hands work to
// `coder` and finishes once nobody has anything pending, and everyone else says ok. `sent` is the agent of every session
// it was asked to open, in order, and nothing for a session that asked for none. `titles` is the title of every one. When
// `edit` is given, each prompt calls it with the directory of its session, as an agent that writes a file does.
function recording(edit?: (directory: string) => Promise<unknown>) {
  const sent: string[] = []
  const titles: string[] = []
  const directories = new Map<string, string>()
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
    config: { effective: async () => ({ permissions: { bypass: true } }) },
    session: {
      create: async (input: {
        readonly agent?: string
        readonly title: string
        readonly location: { readonly directory: string }
      }) => {
        titles.push(input.title)
        if (input.agent !== undefined) sent.push(input.agent)
        const id = `ses_${++sessions}`
        directories.set(id, input.location.directory)
        return { id }
      },
      prompt: async (input: { readonly sessionID: string; readonly text: string }) => {
        prompts.set(input.sessionID, input.text)
        await edit?.(directories.get(input.sessionID) ?? "")
      },
      wait: async () => ({}),
      get: async () => undefined,
    },
    // Every call answers with a message of its own, so a session that continues sees the reply to its latest prompt as new.
    shell: { list: async () => ({ data: [] }) },
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
  return { client, sent, titles }
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

// The title stays in the user's session database, and `orb session list` and the terminal UI show it, so what a clone's
// workflow puts in its name and node IDs must not reach a session as it is.
test("the title of every session that a run opens has the control characters of the name and node IDs written out", async () => {
  // A set-title sequence, one that erases the line, a right-to-left override and a C1 control sequence introducer.
  const evil = "\u001b]0;pwned\u0007\u001b[2K\u{202e}\u009b"
  const shown = "\\x1b]0;pwned\\x07\\x1b[2K\\u{202e}\\x9b"
  const file = path.join(root, "titles.yaml")
  await Bun.write(
    file,
    [
      `name: ${JSON.stringify(`flow${evil}`)}`,
      "nodes:",
      `  - id: ${JSON.stringify(`plan${evil}`)}`,
      "    prompt: say ok",
      `  - id: ${JSON.stringify(`crew${evil}`)}`,
      "    type: team",
      `    needs: [${JSON.stringify(`plan${evil}`)}]`,
      "    goal: say ok",
      "    members:",
      `      ${JSON.stringify(`lead${evil}`)}: { role: lead }`,
      "",
    ].join("\n"),
  )
  const { client, titles } = recording()

  const result = await run({ client, workflow: await loadWorkflow(file), file, directory: root })

  expect(result).toMatchObject({ status: "succeeded" })
  // The agent node opens one session, and the member of the team a session for its first turn.
  expect(titles[0]).toBe(`flow${shown} · plan${shown}`)
  expect(titles[1]).toBe(`flow${shown} · crew${shown}/lead${shown}#1`)
  expect(titles.filter((title) => /\p{C}/u.test(title))).toEqual([])
})

// The runner commits what an agent or a team changed in its worktree, with a message that names the node. That message
// stays in the user's repository, and `git log` prints it as it is.
test("the commit that records the work of an agent and of a team has the control characters of the node ID written out", async () => {
  const directory = path.join(root, "commits")
  await Bun.write(path.join(directory, "readme.md"), "fixture\n")
  for (const args of [
    ["init", "-q", "-b", "main"],
    ["add", "-A"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"],
  ])
    await Git.git(directory, args)
  const evil = "\u001b]0;pwned\u0007\u001b[2K\u{202e}\u009b"
  const shown = "\\x1b]0;pwned\\x07\\x1b[2K\\u{202e}\\x9b"
  const file = path.join(root, "commits.yaml")
  await Bun.write(
    file,
    [
      "name: commits",
      "nodes:",
      `  - id: ${JSON.stringify(`work${evil}`)}`,
      "    prompt: say ok",
      `  - id: ${JSON.stringify(`crew${evil}`)}`,
      "    type: team",
      `    needs: [${JSON.stringify(`work${evil}`)}]`,
      "    goal: say ok",
      "    members:",
      "      lead: { role: lead }",
      "",
    ].join("\n"),
  )
  // Each agent writes a file in its own worktree, so there is a change to commit.
  const { client } = recording((worktree) => Bun.write(path.join(worktree, "out.txt"), "x\n"))

  const result = await run({ client, workflow: await loadWorkflow(file), file, directory })

  expect(result).toMatchObject({ status: "succeeded" })
  const subjects = (await Git.git(directory, ["log", "--all", "--format=%s"])).stdout.split(/\r?\n/)
  expect(subjects).toContain(`orbit ${result.id}: work${shown}`)
  expect(subjects).toContain(`orbit ${result.id}: crew${shown}`)
  expect(subjects.filter((subject) => /\p{C}/u.test(subject))).toEqual([])
})
