import { pathToFileURL } from "node:url"
import type { EvalSuite } from "./eval.js"
import type { Workflow } from "./workflow.js"
import { compile, type Spec } from "./yaml.js"

// Workflows and eval suites are TypeScript or JavaScript modules with a default export, or YAML (and suites JSON).

export async function loadWorkflow(file: string): Promise<Workflow> {
  const value = await read(file, "Workflow file")
  if (isYaml(file)) return compile(value as Spec, file)
  const workflow = value as Partial<Workflow> | undefined
  if (!workflow || typeof workflow.name !== "string" || typeof workflow.run !== "function")
    throw new Error(`${file} must export default { name, run(ctx) }`)
  return workflow as Workflow
}

export async function loadSuite(file: string): Promise<EvalSuite> {
  const suite = (await read(file, "Eval suite")) as Partial<EvalSuite> | undefined
  if (!suite || typeof suite.name !== "string" || !Array.isArray(suite.tasks))
    throw new Error(`${file} must define { name, tasks: [{ id, prompt, checks }] }`)
  return suite as EvalSuite
}

async function read(file: string, kind: string): Promise<unknown> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) throw new Error(`${kind} not found: ${file}`)
  if (isYaml(file)) return Bun.YAML.parse(await handle.text())
  if (file.toLowerCase().endsWith(".json")) return handle.json()
  return (await import(pathToFileURL(file).href)).default
}

function isYaml(file: string) {
  return /\.ya?ml$/i.test(file)
}
