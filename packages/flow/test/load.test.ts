import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { importsModule, loadSuite, loadWorkflow, suiteCommands, workflowCommands } from "../src/load"

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
  await expect(loadWorkflow(file)).rejects.toThrow(problem)
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

test("asking for the commands of a module imports nothing and lists none, because its code can run anything once imported", async () => {
  const files: ReadonlyArray<readonly [string, string, typeof workflowCommands | typeof suiteCommands]> = [
    ["ask-flow.ts", traced(workflow), workflowCommands],
    ["ask-flow.js", traced(workflow), workflowCommands],
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

test("a JSON file is no workflow, as loadWorkflow cannot load one, so workflowCommands lists none for it", async () => {
  const file = path.join(root, "workflow.json")
  await Bun.write(file, JSON.stringify({ name: "json", nodes: [{ id: "tests", type: "check", command: "npm test" }] }))

  expect(await workflowCommands(file)).toEqual([])
  await expect(loadWorkflow(file)).rejects.toThrow("must export default { name, run(ctx) }")
})
