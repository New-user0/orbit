import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { importsModule, loadSuite, loadWorkflow } from "../src/load"

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
