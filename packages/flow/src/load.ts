import { pathToFileURL } from "node:url"
import type { EvalSuite } from "./eval.js"
import type { Workflow } from "./workflow.js"
import { compile, validate, type Spec } from "./yaml.js"

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

/**
 * Whether loading `file` imports it as a module, which runs its top-level code before anything else can look at it.
 * Only YAML and JSON are read as data. A caller that has to decide whether the file may run, such as one that asks
 * whether its folder is trusted, asks this before it calls `loadWorkflow` or `loadSuite`, which import it without asking.
 */
export function importsModule(file: string) {
  return !isYaml(file) && !isJson(file)
}

/**
 * The shell commands that a run of the YAML workflow in `file` executes, which the runner hands to the platform shell
 * with no Orbit permission step in front: the command of each `check` node and every entry of each `verify` node's
 * `checks`, named by their node. The node types are a closed set that `validate` enforces, and these two are the only
 * ones that reach that shell (see `execute` in `yaml.ts`), so this is all that the workflow runs on its own account.
 * Asked before `loadWorkflow`, as `importsModule` is, it reads and validates the file as `loadWorkflow` does and fails
 * with what it fails with. Only YAML is read: a module's commands are not known until its code runs, which
 * `importsModule` already stops, and `loadWorkflow` reads no other file as data.
 */
export async function workflowCommands(file: string) {
  if (!isYaml(file)) return []
  const nodes = validate((await read(file, "Workflow file")) as Spec, file)
  return [...nodes.values()].flatMap((node) => {
    const type = node.type ?? "agent"
    if (type === "check") return [{ id: node.id, command: String(node.command) }]
    if (type === "verify") return listed(node.id, node.checks)
    return []
  })
}

/**
 * The shell commands that a run of the suite in `file` executes: every entry of each task's `checks`, named by the
 * task, because a suite runs each task as a verify node. Asked before `loadSuite` like `workflowCommands`, and as
 * there, a module has none to list, because it is stopped by `importsModule` and never read here.
 */
export async function suiteCommands(file: string) {
  if (importsModule(file)) return []
  // `loadSuite` checks no more than the list, so a task may be anything. One that is not an object lists nothing here,
  // as `evaluate` fails on it before anything runs.
  return (await loadSuite(file)).tasks.flatMap((task) => listed(task?.id, task?.checks))
}

// The entries of a `checks` list. A list that is not an array makes `verify` fail before it runs anything, and every
// entry of an array goes to the shell however it is written, so each counts, and a malformed one shows as what runs.
function listed(id: unknown, checks: unknown) {
  if (!Array.isArray(checks)) return []
  return (checks as ReadonlyArray<string | { readonly command?: unknown } | null>).map((item) => ({
    id: String(id),
    command: String(typeof item === "string" ? item : item?.command),
  }))
}

async function read(file: string, kind: string): Promise<unknown> {
  const handle = Bun.file(file)
  if (!(await handle.exists())) throw new Error(`${kind} not found: ${file}`)
  if (isYaml(file)) return Bun.YAML.parse(await handle.text())
  if (isJson(file)) return handle.json()
  return (await import(pathToFileURL(file).href)).default
}

function isYaml(file: string) {
  return /\.ya?ml$/i.test(file)
}

function isJson(file: string) {
  return file.toLowerCase().endsWith(".json")
}
