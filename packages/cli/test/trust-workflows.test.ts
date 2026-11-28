// What a workflow or suite may pick (permissions, agents, models, judges) and files from another project's folder. The
// scripted model, the shared root and the helpers are in fixture/trust-harness.ts; every `orb` here runs without
// ORBIT_TRUST_PROJECT, so a folder is trusted only when a grant says so, and each test uses a repository of its own.
import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { quoted, refusal } from "../src/util/trust"
import {
  model,
  runs,
  toolAnswers,
  askedAs,
  askedFor,
  ollama,
  root,
  workflow,
  suite,
  user,
  quiet,
  bare,
  traced,
  noop,
  oneTask,
  marked,
  orb,
  spawned,
  succeeded,
  setShowDelay
} from "./fixture/trust-harness"

test.each([50, 250, 700])(
  "orb flow run --trust runs a permissions: auto workflow on its default model when /api/show takes %i ms",
  async (delay) => {
    // --trust reloads the location after the grant, which interrupts the first discovery of the local model server.
    const repository = await bare(`slow-discovery-${delay}`)
    const file = path.join(repository, "agent.yaml")
    await Bun.write(file, "name: agent\nnodes:\n  - id: work\n    prompt: say ok\n    permissions: auto\n")
    const before = runs
    setShowDelay(delay)
    try {
      succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", file]))
    } finally {
      setShowDelay(0)
    }
    expect(runs).toBeGreaterThan(before)
  },
  120_000,
)

test("a YAML workflow that sets permissions to auto is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("approvals")
  const files = [
    ["agent.yaml", `name: agent\nnodes:\n  - id: work\n    prompt: say ok\n    permissions: auto\n`, "work", "auto"],
    [
      "verify.yaml",
      `name: verifies\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    permissions: auto\n    checks: []\n`,
      "work",
      "auto",
    ],
    [
      "team.yaml",
      `name: crew\nnodes:\n  - id: crew\n    type: team\n    goal: say ok\n    members:\n      lead: { role: lead, permissions: auto }\n`,
      "crew/lead",
      "auto",
    ],
    // A template is filled in when the node starts, and the reply of an earlier agent can say auto.
    [
      "template.yaml",
      `name: templated\nnodes:\n  - id: plan\n    prompt: say ok\n  - id: work\n    needs: [plan]\n    prompt: say ok\n    permissions: "{{plan.text}}"\n`,
      "work",
      "{{plan.text}}",
    ],
  ] as const
  for (const [name, text] of files) await Bun.write(path.join(repository, name), text)
  const before = runs

  // Reading these files runs nothing, and the folder holds nothing back, but a run of each lets an agent's every request
  // for permission through, whatever the user's own rules say: a file that is not trusted could turn that on for itself.
  for (const [name, , id, value] of files) {
    const result = await orb(repository, ["flow", "run", "--standalone", path.join(repository, name)])

    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    // It says the command approves actions, names the file, lists the node with what it sets, and gives both ways to
    // trust the folder.
    expect(result.stderr).toContain("approves actions without asking you")
    expect(result.stderr).toContain(`${name} sets \`permissions\``)
    expect(result.stderr).toContain(`  ${id}  permissions: ${value}`)
    expect(result.stderr).toContain("`orb trust`")
    expect(result.stderr).toContain("--trust")
    // Nothing is held back, and the file defines no command, so neither is listed.
    expect(result.stderr).not.toContain("holds back")
    expect(result.stderr).not.toContain("shell commands")
  }
  // No agent did any work.
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: each file runs.
  for (const [name] of files)
    succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", path.join(repository, name)]))
  expect(runs).toBeGreaterThan(before)

  // A workflow whose nodes reject, or set nothing, approves nothing, but it still stops in a folder that is not trusted,
  // as every run does (trust-first), with or without the user's own --auto; it says nothing of approvals.
  const rejecting = path.join(repository, "rejecting.yaml")
  await Bun.write(
    rejecting,
    `name: rejecting\nnodes:\n  - id: work\n    prompt: say ok\n    permissions: reject\n  - id: other\n    prompt: say ok\n`,
  )
  for (const flags of [[], ["--auto"]]) {
    const plain = await orb(repository, ["flow", "run", ...flags, "--standalone", rejecting])
    expect({ flags, code: plain.code }).toEqual({ flags, code: 1 })
    expect(plain.stderr).toContain(`${repository} is not trusted`)
    expect(plain.stderr).not.toContain("approves actions without asking you")
  }
}, 480_000)

test("a recorded run whose agents were set to approve is not run again by resume in an untrusted folder, and a trusted replay asks no model", async () => {
  const repository = await bare("recorded-approvals")
  const file = path.join(repository, "workflow.yaml")
  await Bun.write(file, `name: recorded\nnodes:\n  - id: work\n    prompt: say ok\n    permissions: auto\n`)
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", file]))
  // The run store, which sits in the repository, names the file that a resume loads.
  const id: string = JSON.parse((await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  const before = runs

  const resumed = await orb(repository, ["flow", "resume", "--standalone", id])

  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  // A replay answers every node from the recording and asks no model, so nothing of it is ever approved, even with the
  // folder trusted. (It exits with 1 all the same, because an agent's replayed result is marked as reused and so differs
  // from what was recorded.)
  const replayed = await orb(repository, ["flow", "replay", "--trust", "--standalone", id])
  expect(replayed.stderr).toContain("= work (replayed)")
  expect(replayed.stderr).not.toContain("is not trusted")
  expect(runs).toBe(before)

  succeeded(await orb(repository, ["flow", "resume", "--trust", "--standalone", id]))
}, 360_000)

test("a YAML workflow that names an agent is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("agent-named")
  const named = path.join(repository, "named.yaml")
  const plain = path.join(repository, "plain.yaml")
  const written = path.join(repository, "blocked.txt")
  // The same node, which asks the model to write a file, with the agent that the user's rules let edit and without it.
  await Bun.write(named, `name: named\nnodes:\n  - id: work\n    prompt: write blocked.txt\n    agent: autopilot\n`)
  await Bun.write(plain, `name: plain\nnodes:\n  - id: work\n    prompt: write blocked.txt\n`)

  // Without an agent the node runs as the default one, and the run rejects the write that the user's rules ask about. The
  // file chooses nothing; the folder is trusted for this run only because no run starts in an untrusted one.
  const answered = toolAnswers.length
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", plain], user))
  expect(toolAnswers.slice(answered).join("")).toContain("does not approve actions that need permission")
  expect(await Bun.file(written).exists()).toBe(false)
  const before = runs

  // As the agent whose rules allow the edit the node would get it done with no question, and the run's rejection would
  // never come into play. So the file is stopped, before anything runs.
  const refused = await orb(repository, ["flow", "run", "--standalone", named], user)

  expect(refused.code).toBe(1)
  expect(refused.stdout).toBe("")
  expect(refused.stderr).toContain(`${repository} is not trusted`)
  // It says the command lets the file choose the agents, names the file, lists the node with its agent, and gives both
  // ways to trust the folder.
  expect(refused.stderr).toContain("lets the file choose which of your agents run its nodes")
  expect(refused.stderr).toContain("named.yaml names an `agent`")
  expect(refused.stderr).toContain("  work  agent: autopilot")
  expect(refused.stderr).toContain("`orb trust`")
  expect(refused.stderr).toContain("--trust")
  // Nothing is held back, and the file defines no command or approval, so none is listed.
  expect(refused.stderr).not.toContain("holds back")
  expect(refused.stderr).not.toContain("shell commands")
  expect(refused.stderr).not.toContain("approves actions")
  expect(runs).toBe(before)
  expect(await Bun.file(written).exists()).toBe(false)

  // --trust is the explicit grant for one run: the node runs as the agent, which edits without being asked, so the run's
  // rejection never comes into play.
  askedAs.clear()
  const granted = toolAnswers.length
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", named], user))
  expect([...askedAs]).toEqual(["autopilot"])
  expect(toolAnswers.length).toBeGreaterThan(granted)
  expect(toolAnswers.slice(granted).join("")).not.toContain("does not approve actions that need permission")
  expect(await Bun.file(written).exists()).toBe(true)

  // A resumed run goes on from the repository's run store, so the untrusted folder stops it before the file is read.
  await fs.rm(written)
  const recorded: Array<{ id: string; workflow: string }> = JSON.parse(
    (await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout,
  )
  const id = recorded.find((run) => run.workflow === "named")?.id
  expect(id).toBeString()
  const settled = runs
  const resumed = await orb(repository, ["flow", "resume", "--standalone", String(id)], user)
  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  // A replay answers every node from the recording and opens no session, so even in a trusted folder no agent runs under
  // rules that the file chose. (It exits with 1 all the same, because an agent's replayed result is marked as reused and
  // so differs from what was recorded.)
  const replayed = await orb(repository, ["flow", "replay", "--trust", "--standalone", String(id)], user)
  expect(replayed.stderr).toContain("= work (replayed)")
  expect(replayed.stderr).not.toContain("is not trusted")
  expect(runs).toBe(settled)
  expect(await Bun.file(written).exists()).toBe(false)
}, 480_000)

// A file in a clone that picks a model replaces the --model the person passed, so a folder that holds nothing back must
// not run it before it is trusted: the clone would choose what the person's money is spent on.
test("a workflow or suite that picks a model or a limit on attempts is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const pricey = "ollama/pricey:70b"
  const repository = await bare("model-choices")
  const files = [
    [
      "node.yaml",
      `name: m\nnodes:\n  - id: work\n    prompt: say ok\n    model: ${pricey}\n`,
      `  work  model: ${pricey}`,
    ],
    [
      "fallback.yaml",
      `name: m\nnodes:\n  - id: work\n    prompt: say ok\n    retry: { fallbackModels: [${pricey}] }\n`,
      `  work  retry.fallbackModels: ["${pricey}"]`,
    ],
    [
      "attempts.yaml",
      `name: m\nnodes:\n  - id: work\n    prompt: say ok\n    retry: { maxAttempts: 50 }\n`,
      "  work  retry.maxAttempts: 50",
    ],
    [
      "judge.yaml",
      `name: m\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    checks: []\n    judge: { model: ${pricey} }\n`,
      `  work/judge  model: ${pricey}`,
    ],
    [
      "team.yaml",
      `name: m\nnodes:\n  - id: crew\n    type: team\n    goal: say ok\n    members:\n      lead: { role: lead, model: ${pricey} }\n`,
      `  crew/lead  model: ${pricey}`,
    ],
  ] as const
  for (const [name, text] of files) await Bun.write(path.join(repository, name), text)
  await Bun.write(
    path.join(repository, "suite.json"),
    JSON.stringify({ name: "m", models: [pricey], tasks: [{ id: "task", prompt: "say ok", checks: [] }] }),
  )
  const before = runs
  const asked = askedFor.length

  // One after the other: the private servers share a database.
  const refusals: Array<readonly [Awaited<ReturnType<typeof orb>>, string]> = []
  for (const [name, , row] of files)
    refusals.push([await orb(repository, ["flow", "run", "--standalone", "--model", model, name]), row])
  refusals.push([await orb(repository, ["eval", "--standalone", "suite.json"]), `  suite  models: ["${pricey}"]`])

  for (const [result, row] of refusals) {
    expect({ row, code: result.code }).toEqual({ row, code: 1 })
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${repository} is not trusted`)
    expect(result.stderr).toContain("lets the file choose which of your models run its nodes")
    expect(result.stderr).toContain(row)
    expect(result.stderr).toContain("--trust")
  }
  // No model was asked, the person's or the file's.
  expect(runs).toBe(before)
  expect(askedFor.length).toBe(asked)

  // The control: with --trust the file's model is the one that is asked, over the person's own --model.
  succeeded(await orb(repository, ["flow", "run", "--trust", "--model", model, "node.yaml"]))
  expect(askedFor.slice(asked)).toEqual(["pricey:70b"])
}, 480_000)

test("every agent that a run of a workflow is made as is one that the refusal lists, whichever node or member names it", async () => {
  const repository = await bare("agent-roles")
  const file = path.join(repository, "roles.yaml")
  await Bun.write(
    file,
    [
      "name: roles",
      "nodes:",
      "  - id: author",
      "    type: verify",
      "    prompt: say ok",
      "    agent: autopilot",
      "    checks: []",
      "    judge: { agent: reviewer }",
      "  - id: crew",
      "    type: team",
      "    needs: [author]",
      "    goal: say ok",
      "    members:",
      `      lead: { role: lead, agent: captain }`,
      // The lead finishes the team on its first turn, so this member never takes one, and it is listed all the same.
      `      coder: { role: code, agent: coder }`,
      "",
    ].join("\n"),
  )
  const before = runs

  const refused = await orb(repository, ["flow", "run", "--standalone", file], user)

  expect(refused.code).toBe(1)
  expect(runs).toBe(before)
  const listed = [...refused.stderr.matchAll(/^ {2}(\S+)\s+agent: (\S+)$/gm)].map((match) => [match[1], match[2]])
  expect(listed).toEqual([
    ["author", "autopilot"],
    ["author/judge", "reviewer"],
    ["crew/lead", "captain"],
    ["crew/coder", "coder"],
  ])

  // The author, the reviewer of its work and the lead of the team each made requests of the model as the agent that the
  // file names for it, and each is among the ones that were listed.
  askedAs.clear()
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", file], user))
  expect([...askedAs].toSorted()).toEqual(["autopilot", "captain", "reviewer"])
  for (const agent of askedAs) expect(listed.map((item) => item[1])).toContain(agent)
}, 360_000)

test("a suite whose task has a judge that names an agent is not run in an untrusted folder that holds nothing back, and runs with --trust", async () => {
  const repository = await bare("agent-judges")
  const suiteFile = path.join(repository, "suite.json")
  const plainFile = path.join(repository, "plain.json")
  await Bun.write(
    suiteFile,
    JSON.stringify({
      name: "judged",
      tasks: [
        { id: "reviewed", prompt: "say ok", checks: [], judge: { agent: "reviewer" } },
        // `evaluate` passes a task's `judge` on and no agent of the task's own, so this one chooses nothing.
        { id: "own", prompt: "say ok", checks: [], agent: "captain" },
      ],
    }),
  )
  await Bun.write(
    plainFile,
    JSON.stringify({
      name: "plain",
      tasks: [{ id: "reviewed", prompt: "say ok", checks: [], judge: true }],
    }),
  )

  // A judge that names no agent runs as the default one, so the file chooses nothing; the folder is trusted for this run
  // only because no run starts in an untrusted one.
  succeeded(await orb(repository, ["eval", plainFile, "--trust", "--standalone"], user))
  const before = runs

  const refused = await orb(repository, ["eval", suiteFile, "--standalone"], user)

  expect(refused.code).toBe(1)
  expect(refused.stdout).toBe("")
  expect(refused.stderr).toContain(`${repository} is not trusted`)
  expect(refused.stderr).toContain("lets the file choose which of your agents run its nodes")
  expect(refused.stderr).toContain("suite.json names an `agent`")
  // The judge of a task is listed as it is for a verify node of a workflow, and a task's own agent is not.
  expect(refused.stderr).toContain("  reviewed/judge  agent: reviewer")
  expect(refused.stderr).not.toContain("captain")
  expect(refused.stderr).toContain("`orb trust`")
  expect(refused.stderr).toContain("--trust")
  expect(refused.stderr).not.toContain("holds back")
  expect(refused.stderr).not.toContain("shell commands")
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run: each task is made as its author, and the reviewer as the agent named. The
  // task's own agent is never made as, which is why it needs no listing.
  askedAs.clear()
  succeeded(await orb(repository, ["eval", suiteFile, "--trust", "--standalone"], user))
  expect([...askedAs]).toEqual(["reviewer"])
  expect(runs).toBeGreaterThan(before)

  // A resumed eval goes on from the run store, so the untrusted folder stops it before the suite is read.
  const recorded: Array<{ id: string; workflow: string }> = JSON.parse(
    (await orb(repository, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout,
  )
  const evalRun = recorded.find((run) => run.workflow === "eval:judged")?.id
  expect(evalRun).toBeString()
  const resumed = await orb(repository, ["eval", suiteFile, "--resume", String(evalRun), "--standalone"], user)
  expect(resumed.code).toBe(1)
  expect(resumed.stderr).toContain(`${repository} is not trusted`)
  expect(resumed.stderr).toContain("goes on from a run that the folder's run store")
}, 480_000)

test("a YAML workflow or a suite whose checks are empty defines no command, and keeps the check that orb run has", async () => {
  const empty = await bare("no-commands")
  const flowFile = path.join(empty, "workflow.yaml")
  const suiteFile = path.join(empty, "suite.json")
  await Bun.write(flowFile, `name: empty\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    checks: []\n`)
  await Bun.write(suiteFile, JSON.stringify({ name: "empty", tasks: [{ id: "task", prompt: "say ok", checks: [] }] }))
  const before = runs

  // No shell command is defined, but the folder is not trusted, so both stop as orb run does (trust-first), and say
  // nothing of shell commands.
  for (const args of [
    ["flow", "run", "--standalone", flowFile],
    ["eval", suiteFile, "--standalone"],
  ]) {
    const refused = await orb(empty, args)
    expect({ args, code: refused.code }).toEqual({ args, code: 1 })
    expect(refused.stderr).toContain(`${empty} is not trusted`)
    expect(refused.stderr).not.toContain("shell commands")
  }
  expect(runs).toBe(before)

  // The control: with --trust both run.
  succeeded(await orb(empty, ["flow", "run", "--trust", "--standalone", flowFile]))
  succeeded(await orb(empty, ["eval", suiteFile, "--trust", "--standalone"]))
  expect(runs).toBeGreaterThan(before)
}, 360_000)

// The code, the commands, the approvals and the agents are the file's, and the file can sit in a folder that the command
// does not run in: a clone beside the repository, a download, a submodule. Each project is trusted on its own, so the
// folder that holds the file is asked after the folder the command runs in, which is trusted for good here.
async function trustedFolder(name: string) {
  const directory = await bare(name)
  succeeded(await orb(directory, ["trust", "--standalone"]))
  return directory
}

test("a workflow or suite module from another project's folder is not imported by a command that runs in a trusted one, and runs with --trust", async () => {
  const home = await trustedFolder("holder-modules-run")
  const away = await bare("holder-modules-files")
  const flowModule = await traced(away, "workflow.ts", noop)
  const suiteModule = await traced(away, "suite.ts", oneTask)
  const before = runs

  const started = await orb(home, ["flow", "run", "--standalone", flowModule.file])
  const evaluated = await orb(home, ["eval", suiteModule.file, "--standalone"])

  for (const [result, module] of [
    [started, flowModule],
    [evaluated, suiteModule],
  ] as const) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    // It is the folder that holds the file that is not trusted, and the command that trusts that one is named in full: a
    // plain `orb trust` would trust the folder that the command runs in, which is trusted already.
    expect(result.stderr).toContain(`${away} is not trusted`)
    expect(result.stderr).not.toContain(`${home} is not trusted`)
    expect(result.stderr).toContain("runs code from the folder")
    expect(result.stderr).toContain(`it imports ${path.basename(module.file)},`)
    expect(result.stderr).toContain(`\`orb trust ${quoted(away)}\``)
    expect(result.stderr).toContain("--trust")
    // The code in the file never ran.
    expect(await Bun.file(module.marker).exists()).toBe(false)
  }
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run, for the folder that holds the file too: the modules are imported and run.
  succeeded(await orb(home, ["flow", "run", "--trust", "--standalone", flowModule.file]))
  expect(await Bun.file(flowModule.marker).exists()).toBe(true)
  succeeded(await orb(home, ["eval", suiteModule.file, "--trust", "--standalone"]))
  expect(await Bun.file(suiteModule.marker).exists()).toBe(true)
  expect(runs).toBeGreaterThan(before)

  // Nothing was stored, so the next plain run stops again, until the folder is trusted as the refusal says.
  const listed = await orb(home, ["trust", "--standalone", "--list"])
  succeeded(listed)
  expect(listed.stdout).not.toContain(away)
  await fs.rm(flowModule.marker)
  const again = await orb(home, ["flow", "run", "--standalone", flowModule.file])
  expect(again.code).toBe(1)
  expect(again.stderr).toContain(`${away} is not trusted`)
  expect(await Bun.file(flowModule.marker).exists()).toBe(false)
  succeeded(await orb(home, ["trust", "--standalone", away]))
  succeeded(await orb(home, ["flow", "run", "--standalone", flowModule.file]))
  expect(await Bun.file(flowModule.marker).exists()).toBe(true)
}, 480_000)

test("a workflow or suite that defines commands, approvals or agents in another project's folder is not run by a command that runs in a trusted one, and runs with --trust", async () => {
  const home = await trustedFolder("holder-defines-run")
  const away = await bare("holder-defines-files")
  const check = marked("holder-check")
  const task = marked("holder-task")
  const flowing = (file: string, flags: string[] = []) => ["flow", "run", "--standalone", ...flags, file]
  const evaluating = (file: string, flags: string[] = []) => ["eval", file, "--standalone", ...flags]
  const files = [
    {
      file: path.join(away, "check.yaml"),
      text: `name: check\nnodes:\n  - id: tests\n    type: check\n    command: ${check.quoted}\n`,
      command: flowing,
      says: "runs shell commands from the folder",
      row: `  tests  ${check.command}`,
    },
    {
      file: path.join(away, "auto.yaml"),
      text: `name: auto\nnodes:\n  - id: work\n    prompt: say ok\n    permissions: auto\n`,
      command: flowing,
      says: "approves actions without asking you",
      row: "  work  permissions: auto",
    },
    {
      file: path.join(away, "agent.yaml"),
      text: `name: agent\nnodes:\n  - id: work\n    prompt: say ok\n    agent: autopilot\n`,
      command: flowing,
      says: "lets the file choose which of your agents run its nodes",
      row: "  work  agent: autopilot",
    },
    {
      file: path.join(away, "suite.json"),
      text: JSON.stringify({
        name: "away",
        tasks: [{ id: "task", prompt: "say ok", checks: [task.command] }],
      }),
      command: evaluating,
      says: "runs shell commands from the folder",
      row: `  task  ${task.command}`,
    },
    {
      file: path.join(away, "judge.json"),
      text: JSON.stringify({
        name: "judge",
        tasks: [{ id: "task", prompt: "say ok", checks: [], judge: { agent: "reviewer" } }],
      }),
      command: evaluating,
      says: "lets the file choose which of your agents run its nodes",
      row: "  task/judge  agent: reviewer",
    },
  ]
  for (const item of files) await Bun.write(item.file, item.text)
  const before = runs

  // Reading these files runs nothing, and the folder that the command runs in is trusted, but a run of each carries out
  // what the file defines, from a folder that no one has trusted.
  for (const item of files) {
    const result = await orb(home, item.command(item.file), user)

    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${away} is not trusted`)
    expect(result.stderr).not.toContain(`${home} is not trusted`)
    expect(result.stderr).toContain(item.says)
    expect(result.stderr).toContain(`${path.basename(item.file)} `)
    expect(result.stderr).toContain(item.row)
    expect(result.stderr).toContain(`\`orb trust ${quoted(away)}\``)
    expect(result.stderr).toContain("--trust")
  }
  // No command ran and no agent did any work.
  for (const command of [check, task]) expect(await Bun.file(command.marker).exists()).toBe(false)
  expect(runs).toBe(before)

  // --trust is the explicit grant for one run, for the folder that holds the file too.
  for (const item of files) succeeded(await orb(home, item.command(item.file, ["--trust"]), user))
  for (const command of [check, task]) expect(await Bun.file(command.marker).exists()).toBe(true)
  expect(runs).toBeGreaterThan(before)

  // A file that defines none of these is only read, so it keeps the check that the folder of the run gets, here a pass.
  const plain = path.join(away, "plain.yaml")
  await Bun.write(plain, `name: plain\nnodes:\n  - id: work\n    type: verify\n    prompt: say ok\n    checks: []\n`)
  succeeded(await orb(home, flowing(plain), user))
}, 600_000)

test("resume and replay do not import a module from another project's folder, that the run store or --file names, until that folder is trusted", async () => {
  const home = await trustedFolder("holder-recorded-run")
  const away = await bare("holder-recorded-files")
  const recorded = await traced(away, "workflow.ts", noop)
  const copy = await traced(away, "copy.ts", noop)
  succeeded(await orb(home, ["flow", "run", "--trust", "--standalone", recorded.file]))
  // The run store, which sits in the folder of the run, names the module in the other folder.
  const id: string = JSON.parse((await orb(home, ["flow", "ls", "--standalone", "--trust", "--format", "json"])).stdout)[0].id
  await fs.rm(recorded.marker)

  const resumed = await orb(home, ["flow", "resume", "--standalone", id])
  const replayed = await orb(home, ["flow", "replay", "--standalone", id])
  const named = await orb(home, ["flow", "replay", "--standalone", id, "--file", copy.file])

  for (const result of [resumed, replayed, named]) {
    expect(result.code).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(`${away} is not trusted`)
    expect(result.stderr).not.toContain(`${home} is not trusted`)
    expect(result.stderr).toContain("runs code from the folder")
    expect(result.stderr).toContain(`\`orb trust ${quoted(away)}\``)
  }
  expect(await Bun.file(recorded.marker).exists()).toBe(false)
  expect(await Bun.file(copy.marker).exists()).toBe(false)

  succeeded(await orb(home, ["flow", "resume", "--trust", "--standalone", id]))
  expect(await Bun.file(recorded.marker).exists()).toBe(true)
  const trustedReplay = await orb(home, ["flow", "replay", "--trust", "--standalone", id, "--file", copy.file])
  succeeded(trustedReplay)
  expect(trustedReplay.stderr).toContain(`replay matches the recorded output of ${id}`)
  expect(await Bun.file(copy.marker).exists()).toBe(true)
}, 480_000)

test("a workflow in another folder of the trusted project, or in the home directory, is held to the trust of the project it is in", async () => {
  // A git repository shares one decision between its folders, so a workflow in a folder of it needs nothing more.
  const repository = await bare("holder-same-project")
  // A run starts from the commit that is checked out, so the repository has one.
  for (const args of [
    ["init", "--quiet"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "--allow-empty", "--quiet", "-m", "init"],
  ])
    expect((await spawned(["git", ...args], repository)).code).toBe(0)
  succeeded(await orb(repository, ["trust", "--standalone"]))
  const inside = await traced(path.join(repository, "flows"), "workflow.ts", noop)
  succeeded(await orb(repository, ["flow", "run", "--standalone", inside.file]))
  expect(await Bun.file(inside.marker).exists()).toBe(true)

  // The home directory is never trusted for good, so a file in it needs --trust each time, and the refusal says so.
  const refused = await orb(repository, ["flow", "run", "--standalone", workflow])
  expect(refused.code).toBe(1)
  expect(refused.stderr).toContain(`${root} is not trusted`)
  expect(refused.stderr).toContain("home directory or a filesystem root")
  expect(refused.stderr).toContain("--trust")
  expect(refused.stderr).not.toContain("Look the file over")
  succeeded(await orb(repository, ["flow", "run", "--trust", "--standalone", workflow]))
}, 360_000)
