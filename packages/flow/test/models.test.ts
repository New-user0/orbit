import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadWorkflow, suiteModels, workflowModels } from "../src/load"
import type { Context } from "../src/workflow"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-models-"))
// The top-level code of a module leaves this behind when the module is imported, as the code of any module can.
const marker = path.join(root, "imported.marker")

afterAll(() => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))

// Every field that picks a model or how much a node spends, one node apiece, with what the listing says about it.
const workflowRows = [
  ["a node model", ["  - id: n", "    prompt: go", "    model: acme/pricey#max"], [["n", "model: acme/pricey#max"]]],
  [
    "fallback models",
    ["  - id: n", "    prompt: go", "    retry: { fallbackModels: [acme/a, acme/b] }"],
    [["n", 'retry.fallbackModels: ["acme/a","acme/b"]']],
  ],
  ["attempts", ["  - id: n", "    prompt: go", "    retry: { maxAttempts: 50 }"], [["n", "retry.maxAttempts: 50"]]],
  [
    "a verify node's model, fallbacks, attempts and iterations",
    [
      "  - id: n",
      "    type: verify",
      "    prompt: go",
      "    model: acme/author",
      "    retry: { fallbackModels: [acme/a], maxAttempts: 9 }",
      "    maxIterations: 40",
    ],
    [
      ["n", "model: acme/author"],
      ["n", 'retry.fallbackModels: ["acme/a"]'],
      ["n", "retry.maxAttempts: 9"],
      ["n", "maxIterations: 40"],
    ],
  ],
  [
    "a judge model",
    ["  - id: n", "    type: verify", "    prompt: go", "    judge: { model: acme/judge }"],
    [["n/judge", "model: acme/judge"]],
  ],
  [
    "a team's rounds and its members' models",
    [
      "  - id: n",
      "    type: team",
      "    goal: ship",
      "    maxRounds: 99",
      "    members:",
      "      lead: { role: lead, model: acme/lead }",
      "      coder: { role: code }",
    ],
    [
      ["n", "maxRounds: 99"],
      ["n/lead", "model: acme/lead"],
    ],
  ],
  ["a template", ["  - id: n", "    prompt: go", '    model: "{{input.model}}"'], [["n", "model: {{input.model}}"]]],
] as const

for (const [name, lines, expected] of workflowRows) {
  test(`workflowModels lists ${name}`, async () => {
    const file = path.join(root, `${expected[0][1].length}-${name.length}.yaml`)
    await Bun.write(file, ["name: models", "nodes:", ...lines, ""].join("\n"))

    expect(await workflowModels(file)).toEqual(expected.map(([id, choice]) => ({ id, choice })))
  })
}

test("workflowModels lists nothing for a workflow that picks no model and sets no limit, or only empty values", async () => {
  const file = path.join(root, "quiet.yaml")
  await Bun.write(
    file,
    [
      "name: quiet",
      "nodes:",
      "  - id: plain",
      "    prompt: go",
      "    retry: { backoff: { initial: 10 }, retryOn: [timeout] }",
      "  - id: empty",
      "    prompt: go",
      '    model: ""',
      "    retry: { fallbackModels: [] }",
      "  - id: judged",
      "    type: verify",
      "    prompt: go",
      "    judge: { agent: review, criteria: strict }",
      "  - id: boolean",
      "    type: verify",
      "    prompt: go",
      "    judge: true",
      "  - id: tests",
      "    type: check",
      "    command: npm test",
      "    model: ignored",
      "  - id: crew",
      "    type: team",
      "    goal: ship",
      "    model: ignored",
      "    members:",
      "      lead: { role: lead }",
      "      odd: null",
      "",
    ].join("\n"),
  )

  expect(await workflowModels(file)).toEqual([])
})

test("a workflow that is not valid fails workflowModels as it fails loadWorkflow", async () => {
  const file = path.join(root, "invalid.yaml")
  await Bun.write(file, "name: invalid\nnodes:\n  - id: a\n    needs: [missing]\n    prompt: go\n    model: acme/x\n")

  const loading = await loadWorkflow(file).then(
    () => undefined,
    (error: Error) => error.message,
  )

  expect(loading).toBeDefined()
  await expect(workflowModels(file)).rejects.toThrow(loading!)
})

test("every model and limit that the workflow hands the runner is one that workflowModels lists", async () => {
  const file = path.join(root, "handed.yaml")
  await Bun.write(
    file,
    [
      "name: handed",
      "nodes:",
      "  - id: plan",
      "    prompt: go",
      "    model: acme/plan",
      "    retry: { fallbackModels: [acme/backup], maxAttempts: 7 }",
      "  - id: verified",
      "    needs: [plan]",
      "    type: verify",
      "    prompt: go",
      "    judge: { model: acme/judge }",
      "    maxIterations: 5",
      "  - id: crew",
      "    needs: [plan]",
      "    type: team",
      "    goal: ship",
      "    maxRounds: 4",
      "    members:",
      "      lead: { role: lead, model: acme/lead }",
      "      tester: { role: test }",
      "  - id: unnamed",
      "    needs: [plan]",
      "    prompt: go",
      "  - id: tests",
      "    type: check",
      "    needs: [plan]",
      "    command: npm test",
      "",
    ].join("\n"),
  )
  const handed: string[] = []
  const reply = (id: string) => ({ id, status: "succeeded", text: "ok", sessions: [], attempts: 1 })
  type Options = {
    readonly model?: unknown
    readonly retry?: { readonly fallbackModels?: unknown; readonly maxAttempts?: unknown }
    readonly maxIterations?: unknown
    readonly maxRounds?: unknown
    readonly judge?: { readonly model?: unknown }
    readonly members?: Record<string, { readonly model?: unknown }>
  }
  const record = (id: string, options: Options) => {
    if (options.model) handed.push(id)
    if (options.retry?.fallbackModels) handed.push(id)
    if (options.retry?.maxAttempts) handed.push(id)
    if (options.maxIterations) handed.push(id)
    if (options.maxRounds) handed.push(id)
    if (options.judge?.model) handed.push(`${id}/judge`)
    for (const [name, member] of Object.entries(options.members ?? {})) if (member.model) handed.push(`${id}/${name}`)
  }
  const ctx = {
    input: {},
    run: { id: "run", directory: root },
    agent: async (id: string, options: Options) => (record(id, options), reply(id)),
    verify: async (id: string, options: Options) => (record(id, options), reply(id)),
    team: async (id: string, options: Options) => (record(id, options), reply(id)),
    check: async (id: string) => ({ id, command: "npm test", ok: true, code: 0, output: "" }),
  } as unknown as Context

  await (await loadWorkflow(file)).run(ctx)

  // The runner reads the same fields off the same nodes, one entry for each field it finds a value in.
  expect(handed.toSorted()).toEqual((await workflowModels(file)).map((item) => item.id).toSorted())
  expect(new Set(handed)).toEqual(new Set(["plan", "verified", "verified/judge", "crew", "crew/lead"]))
})

test("suiteModels lists the suite's models, its judges' models and its iteration limits in JSON and YAML suites", async () => {
  const json = path.join(root, "suite-models.json")
  const yaml = path.join(root, "suite-models.yaml")
  await Bun.write(
    json,
    JSON.stringify({
      name: "models",
      models: ["acme/a", "acme/b"],
      tasks: [
        { id: "judged", prompt: "p", checks: [], judge: { model: "acme/judge" }, maxIterations: 12 },
        { id: "plain", prompt: "p", checks: [] },
        { id: "boolean", prompt: "p", checks: [], judge: true },
        // A suite hands each task no `retry`, so this chooses nothing.
        { id: "retrying", prompt: "p", checks: [], retry: { maxAttempts: 9 } },
      ],
    }),
  )
  await Bun.write(
    yaml,
    [
      "name: models",
      "models: [acme/a, acme/b]",
      "tasks:",
      "  - { id: judged, prompt: p, checks: [], judge: { model: acme/judge }, maxIterations: 12 }",
      "  - { id: plain, prompt: p, checks: [] }",
      "  - { id: boolean, prompt: p, checks: [], judge: true }",
      "  - { id: retrying, prompt: p, checks: [], retry: { maxAttempts: 9 } }",
      "",
    ].join("\n"),
  )

  for (const file of [json, yaml])
    expect(await suiteModels(file)).toEqual([
      { id: "suite", choice: 'models: ["acme/a","acme/b"]' },
      { id: "judged", choice: "maxIterations: 12" },
      { id: "judged/judge", choice: "model: acme/judge" },
    ])
})

test("asking a module what it picks imports nothing and lists none, because its code can do anything once imported", async () => {
  for (const name of ["ask-models.ts", "ask-models.mjs"]) {
    const file = path.join(root, name)
    await Bun.write(
      file,
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "imported")\nexport default { name: "traced", tasks: [], run: () => "done" }\n`,
    )
    await fs.rm(marker, { force: true })

    expect(await workflowModels(file)).toEqual([])
    expect(await suiteModels(file)).toEqual([])
    expect({ name, imported: await Bun.file(marker).exists() }).toEqual({ name, imported: false })
  }
})
