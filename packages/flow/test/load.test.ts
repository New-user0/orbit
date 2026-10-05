import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { importsModule, loadSuite, loadWorkflow, suiteCommands, workflowApprovals, workflowCommands } from "../src/load"
import type { Context } from "../src/workflow"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-load-"))
// The top-level code of a module leaves this behind when the module is imported, as the code of any module can.
const marker = path.join(root, "imported.marker")

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

const traced = (body: string) =>
  `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "imported")\n${body}\n`
const workflow = `export default { name: "traced", run: () => "done" }`
const suite = `export default { name: "traced", tasks: [] }`
const yaml = "name: data\nnodes:\n  - id: a\n    prompt: say ok\n"
const json = JSON.stringify({ name: "data", tasks: [] })

test("only YAML and JSON files are read as data, and every other file is imported as a module", () => {
  for (const file of [
    "flow.ts",
    "flow.js",
    "flow.mjs",
    "flow.cjs",
    "flow.mts",
    "flow.tsx",
    "FLOW.TS",
    "flow",
    "flow.yaml.ts",
  ])
    expect(importsModule(file)).toBe(true)
  for (const file of ["flow.yaml", "flow.yml", "FLOW.YAML", "suite.json", "SUITE.JSON", path.join("a.b", "suite.json")])
    expect(importsModule(file)).toBe(false)
})

test("loading a workflow or a suite imports the file exactly when importsModule says it does", async () => {
  // Each file has a name of its own: a module is imported once, and Bun takes `a.js` for the `a.ts` beside it.
  const files: ReadonlyArray<readonly [string, string, typeof loadWorkflow | typeof loadSuite]> = [
    ["ts-flow.ts", traced(workflow), loadWorkflow],
    ["js-flow.js", traced(workflow), loadWorkflow],
    ["mjs-flow.mjs", traced(workflow), loadWorkflow],
    ["yaml-flow.yaml", yaml, loadWorkflow],
    ["yml-flow.yml", yaml, loadWorkflow],
    ["ts-suite.ts", traced(suite), loadSuite],
    ["js-suite.js", traced(suite), loadSuite],
    ["json-suite.json", json, loadSuite],
    ["yaml-suite.yaml", "name: data\ntasks: []\n", loadSuite],
  ]

  for (const [name, source, load] of files) {
    const file = path.join(root, name)
    await Bun.write(file, source)
    await fs.rm(marker, { force: true })

    await load(file)

    expect({ name, imported: await Bun.file(marker).exists() }).toEqual({ name, imported: importsModule(file) })
  }
})

// A workflow with a node of every type: only the check node and the verify node that has checks start a command.
const everyType = [
  "name: commands",
  "nodes:",
  "  - id: plan",
  "    prompt: say ok",
  "  - id: tests",
  "    type: check",
  "    needs: [plan]",
  "    in: plan",
  "    command: npm test",
  "  - id: api",
  "    type: verify",
  "    prompt: build the api",
  "    checks:",
  "      - npm run build",
  "      - { command: npm run lint, timeout: 5000 }",
  "  - id: unchecked",
  "    type: verify",
  "    prompt: build the ui",
  "    checks: []",
  "  - id: unlisted",
  "    type: verify",
  "    prompt: build the docs",
  "  - id: crew",
  "    type: team",
  "    goal: ship it",
  "    members: { lead: { role: lead } }",
  "  - id: ask",
  "    type: gate",
  "    needs: [tests]",
  "    message: Go on?",
  "  - id: merge",
  "    type: merge",
  "    needs: [ask]",
  "    branches: [tests]",
  "",
]

test("workflowCommands lists the command of each check node and every entry of each verify node's checks", async () => {
  const file = path.join(root, "commands.yaml")
  await Bun.write(file, everyType.join("\n"))

  expect(await workflowCommands(file)).toEqual([
    { id: "tests", command: "npm test" },
    { id: "api", command: "npm run build" },
    { id: "api", command: "npm run lint" },
  ])
})

test("workflowCommands lists nothing for a workflow whose nodes start no command", async () => {
  const file = path.join(root, "quiet.yaml")
  await Bun.write(
    file,
    [
      "name: quiet",
      "nodes:",
      "  - id: plan",
      "    prompt: say ok",
      "  - id: unchecked",
      "    type: verify",
      "    prompt: build the ui",
      "    checks: []",
      "  - id: unlisted",
      "    type: verify",
      "    prompt: build the docs",
      "  - id: crew",
      "    type: team",
      "    goal: ship it",
      "    members: { lead: { role: lead } }",
      "  - id: ask",
      "    type: gate",
      "    needs: [plan]",
      "    message: Go on?",
      "  - id: merge",
      "    type: merge",
      "    needs: [ask]",
      "    branches: [plan]",
      "",
    ].join("\n"),
  )

  expect(await workflowCommands(file)).toEqual([])
})

test("a workflow that is not valid fails workflowCommands as it fails loadWorkflow, and no other node type starts a command", async () => {
  // The node types are a closed set, so a node that tries to name another way to run a command is not a workflow.
  const file = path.join(root, "shell.yaml")
  await Bun.write(file, "name: shell\nnodes:\n  - id: tests\n    type: shell\n    command: npm test\n")
  const problem = `${file} is not a valid workflow:\n- tests: unknown type shell`

  await expect(workflowCommands(file)).rejects.toThrow(problem)
  await expect(workflowApprovals(file)).rejects.toThrow(problem)
  await expect(loadWorkflow(file)).rejects.toThrow(problem)
})

// A workflow with a node of every type that also sets `permissions` on each of them: only an agent node, a verify node
// and a member of a team hand it to the runner.
const approving = [
  "name: approvals",
  "nodes:",
  "  - id: plan",
  "    prompt: say ok",
  "    permissions: auto",
  "  - id: default",
  "    prompt: say ok",
  "  - id: rejecting",
  "    prompt: say ok",
  "    permissions: reject",
  "  - id: api",
  "    type: verify",
  "    prompt: build the api",
  "    permissions: auto",
  "    checks: []",
  "  - id: ui",
  "    type: verify",
  "    prompt: build the ui",
  "    checks: []",
  "  - id: crew",
  "    type: team",
  "    goal: ship it",
  "    permissions: auto",
  "    members:",
  "      lead: { role: lead }",
  "      coder: { role: code, permissions: auto }",
  "      tester: { role: test, permissions: reject }",
  "  - id: tests",
  "    type: check",
  "    needs: [plan]",
  "    command: npm test",
  "    permissions: auto",
  "  - id: ask",
  "    type: gate",
  "    needs: [tests]",
  "    message: Go on?",
  "    permissions: auto",
  "  - id: merge",
  "    type: merge",
  "    needs: [ask]",
  "    branches: [tests]",
  "    permissions: auto",
  "",
]

test("workflowApprovals lists the agent and verify nodes and the team members that set permissions to auto", async () => {
  const file = path.join(root, "approvals.yaml")
  await Bun.write(file, approving.join("\n"))

  // The check, gate and merge nodes pass no `permissions` on, and neither does a team itself: only its members do.
  expect(await workflowApprovals(file)).toEqual([
    { id: "plan", permissions: "auto" },
    { id: "api", permissions: "auto" },
    { id: "crew/coder", permissions: "auto" },
  ])
})

test("workflowApprovals lists a template that can fill in as auto, because a reply can say it", async () => {
  const file = path.join(root, "templated.yaml")
  await Bun.write(
    file,
    [
      "name: templated",
      "nodes:",
      "  - id: plan",
      "    prompt: reply with the word auto",
      "  - id: later",
      "    needs: [plan]",
      "    prompt: go on",
      '    permissions: "{{plan.text}}"',
      "  - id: chosen",
      "    prompt: go on",
      '    permissions: "{{ input.permissions }}"',
      "  - id: crew",
      "    type: team",
      "    needs: [plan]",
      "    goal: ship it",
      "    members:",
      '      lead: { role: lead, permissions: "{{plan.text}}" }',
      "  - id: worded",
      "    needs: [plan]",
      '    prompt: "{{plan.text}} is the plan"',
      "",
    ].join("\n"),
  )

  // A template in the prompt is only text. One in `permissions` is what the node hands the runner.
  expect(await workflowApprovals(file)).toEqual([
    { id: "later", permissions: "{{plan.text}}" },
    { id: "chosen", permissions: "{{ input.permissions }}" },
    { id: "crew/lead", permissions: "{{plan.text}}" },
  ])
})

test("workflowApprovals lists nothing for a value that the runner takes for a rejection", async () => {
  const file = path.join(root, "rejections.yaml")
  await Bun.write(
    file,
    [
      "name: rejections",
      "nodes:",
      // The runner approves for exactly the string auto: any other value is answered as a rejection.
      ...["AUTO", "' auto'", "yes", "true", "1", "[auto]", "{ policy: auto }", "reject", "''", "null"].flatMap(
        (value, index) => [`  - id: node${index}`, "    prompt: say ok", `    permissions: ${value}`],
      ),
      "  - id: unset",
      "    prompt: say ok",
      "    permissions:",
      "",
    ].join("\n"),
  )

  expect(await workflowApprovals(file)).toEqual([])
})

test("workflowApprovals takes the members of a team as validate does, and fails on none of them", async () => {
  const list = path.join(root, "member-list.yaml")
  const odd = path.join(root, "member-odd.yaml")
  const none = path.join(root, "member-none.yaml")
  // `validate` takes any object for the members, so a list works as members named by their position.
  await Bun.write(
    list,
    "name: list\nnodes:\n  - id: crew\n    type: team\n    goal: ship it\n    members:\n      - { role: lead, permissions: auto }\n      - { role: code }\n",
  )
  // A member that is not an object has no `permissions` to hand on, and does not hide the members around it.
  await Bun.write(
    odd,
    "name: odd\nnodes:\n  - id: crew\n    type: team\n    goal: ship it\n    members:\n      text: lead\n      empty:\n      number: 7\n      real: { role: code, permissions: auto }\n",
  )
  await Bun.write(none, "name: none\nnodes:\n  - id: crew\n    type: team\n    goal: ship it\n    members:\n")

  expect(await workflowApprovals(list)).toEqual([{ id: "crew/0", permissions: "auto" }])
  expect(await workflowApprovals(odd)).toEqual([{ id: "crew/real", permissions: "auto" }])
  // The run fails when it reaches the team, with no one to lead it, before it asks anything.
  expect(await workflowApprovals(none)).toEqual([])
  await expect(loadWorkflow(none)).resolves.toMatchObject({ name: "none" })
})

test("every node that the workflow hands an auto to is one that workflowApprovals lists", async () => {
  const file = path.join(root, "handed.yaml")
  await Bun.write(
    file,
    [
      "name: handed",
      "nodes:",
      "  - id: plan",
      "    prompt: reply with the word auto",
      "  - id: literal",
      "    needs: [plan]",
      "    prompt: go on",
      "    permissions: auto",
      "  - id: filled",
      "    needs: [plan]",
      "    prompt: go on",
      '    permissions: "{{plan.text}}"',
      "  - id: verified",
      "    needs: [plan]",
      "    type: verify",
      "    prompt: go on",
      '    permissions: "{{plan.text}}"',
      "  - id: crew",
      "    needs: [plan]",
      "    type: team",
      "    goal: ship it",
      "    permissions: auto",
      "    members:",
      '      lead: { role: lead, permissions: "{{plan.text}}" }',
      "      coder: { role: code, permissions: auto }",
      "      tester: { role: test }",
      "  - id: refused",
      "    needs: [plan]",
      "    prompt: go on",
      "    permissions: reject",
      "  - id: tests",
      "    type: check",
      "    needs: [plan]",
      "    command: npm test",
      "    permissions: auto",
      "",
    ].join("\n"),
  )
  const handed: string[] = []
  // What each node of the file passes to the runner. Every agent replies with the word auto, so a template that names
  // one fills in as auto.
  const reply = (id: string) => ({ id, status: "succeeded", text: "auto", sessions: [], attempts: 1 })
  const ctx = {
    input: {},
    run: { id: "run", directory: root },
    agent: async (id: string, options: { readonly permissions?: unknown }) => {
      if (options.permissions === "auto") handed.push(id)
      return reply(id)
    },
    verify: async (id: string, options: { readonly permissions?: unknown }) => {
      if (options.permissions === "auto") handed.push(id)
      return reply(id)
    },
    // The runner reads the `permissions` of each member, and none of the team itself.
    team: async (id: string, options: { readonly members: Record<string, { readonly permissions?: unknown }> }) => {
      for (const [name, member] of Object.entries(options.members))
        if (member.permissions === "auto") handed.push(`${id}/${name}`)
      return reply(id)
    },
    check: async (id: string) => ({ id, command: "npm test", ok: true, code: 0, output: "" }),
  } as unknown as Context

  await (await loadWorkflow(file)).run(ctx)

  expect(handed.toSorted()).toEqual(["crew/coder", "crew/lead", "filled", "literal", "verified"])
  expect((await workflowApprovals(file)).map((item) => item.id)).toEqual(expect.arrayContaining(handed))
})

test("suiteCommands lists every entry of each task's checks in JSON and YAML suites", async () => {
  const json = path.join(root, "commands.json")
  const yaml = path.join(root, "commands-suite.yaml")
  await Bun.write(
    json,
    JSON.stringify({
      name: "commands",
      tasks: [
        { id: "pagination", prompt: "paginate", checks: ["npm test", { command: "npm run lint", timeout: 5000 }] },
        { id: "unchecked", prompt: "nothing to check", checks: [] },
        { id: "unlisted", prompt: "no checks key" },
        { id: "limits", prompt: "limit", checks: ["npm test -- limits"] },
      ],
    }),
  )
  await Bun.write(
    yaml,
    [
      "name: commands",
      "tasks:",
      "  - id: pagination",
      "    prompt: paginate",
      "    checks:",
      "      - npm test",
      "      - { command: npm run lint, timeout: 5000 }",
      "  - id: unchecked",
      "    prompt: nothing to check",
      "    checks: []",
      "  - id: limits",
      "    prompt: limit",
      "    checks: [npm test -- limits]",
      "",
    ].join("\n"),
  )
  const expected = [
    { id: "pagination", command: "npm test" },
    { id: "pagination", command: "npm run lint" },
    { id: "limits", command: "npm test -- limits" },
  ]

  expect(await suiteCommands(json)).toEqual(expected)
  expect(await suiteCommands(yaml)).toEqual(expected)
})

test("a check entry that is not written as a command is still counted, because the runner hands it to the shell", async () => {
  const file = path.join(root, "odd.json")
  await Bun.write(
    file,
    JSON.stringify({ name: "odd", tasks: [{ id: "odd", prompt: "odd", checks: [{ timeout: 1 }, null, 7] }] }),
  )

  expect((await suiteCommands(file)).map((item) => item.id)).toEqual(["odd", "odd", "odd"])
})

test("a task that is not an object lists nothing, and does not hide the commands of the tasks around it", async () => {
  const file = path.join(root, "odd-tasks.json")
  await Bun.write(
    file,
    JSON.stringify({
      name: "odd",
      tasks: [null, "task", 7, { id: "real", prompt: "real", checks: ["npm test"] }],
    }),
  )

  expect(await suiteCommands(file)).toEqual([{ id: "real", command: "npm test" }])
})

test("a suite that is not valid fails suiteCommands as it fails loadSuite", async () => {
  const file = path.join(root, "invalid-suite.json")
  await Bun.write(file, JSON.stringify({ name: "no tasks" }))
  const problem = `${file} must define { name, tasks: [{ id, prompt, checks }] }`

  await expect(suiteCommands(file)).rejects.toThrow(problem)
  await expect(loadSuite(file)).rejects.toThrow(problem)
})

test("asking for the commands or approvals of a module imports nothing and lists none, because its code can do anything once imported", async () => {
  const files: ReadonlyArray<
    readonly [string, string, typeof workflowCommands | typeof suiteCommands | typeof workflowApprovals]
  > = [
    ["ask-flow.ts", traced(workflow), workflowCommands],
    ["ask-flow.js", traced(workflow), workflowCommands],
    ["ask-approvals.ts", traced(workflow), workflowApprovals],
    ["ask-approvals.mjs", traced(workflow), workflowApprovals],
    ["ask-suite.ts", traced(suite), suiteCommands],
    ["ask-suite.mjs", traced(suite), suiteCommands],
  ]

  for (const [name, source, commands] of files) {
    const file = path.join(root, name)
    await Bun.write(file, source)
    await fs.rm(marker, { force: true })

    expect(await commands(file)).toEqual([])
    expect({ name, imported: await Bun.file(marker).exists() }).toEqual({ name, imported: false })
  }
})

test("a JSON file is no workflow, as loadWorkflow cannot load one, so workflowCommands and workflowApprovals list none for it", async () => {
  const file = path.join(root, "workflow.json")
  await Bun.write(
    file,
    JSON.stringify({
      name: "json",
      nodes: [
        { id: "tests", type: "check", command: "npm test" },
        { id: "plan", prompt: "say ok", permissions: "auto" },
      ],
    }),
  )

  expect(await workflowCommands(file)).toEqual([])
  expect(await workflowApprovals(file)).toEqual([])
  await expect(loadWorkflow(file)).rejects.toThrow("must export default { name, run(ctx) }")
})
