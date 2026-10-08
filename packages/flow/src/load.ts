import { pathToFileURL } from "node:url"
import type { EvalSuite } from "./eval.js"
import type { Workflow } from "./workflow.js"
import { compile, validate, type NodeSpec, type Spec } from "./yaml.js"

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

/**
 * The nodes of the YAML workflow in `file` whose agents have every action they ask permission for approved, once, where a
 * run rejects them unless it is told otherwise: an agent or verify node that sets `permissions` to `auto`, and each member
 * of a team that does, named `team/member`, with the value as written. That takes the answer to the user's own `ask`
 * rules out of the user's hands, as `--auto` does when the user passes it, so a file that brings it needs the same care
 * as a command. A value that is a template counts as well: `{{node.text}}` is filled in when the node starts, and the
 * reply of an agent can say `auto`. These are the only places `execute` in `yaml.ts` hands `permissions` on, and the runner
 * approves for `auto` and nothing else. Asked before `loadWorkflow` like `workflowCommands`, which it reads and validates
 * as that does, and for the same reason only a YAML file is read: what a module passes on is known only once it runs.
 */
export async function workflowApprovals(file: string) {
  if (!isYaml(file)) return []
  const nodes = validate((await read(file, "Workflow file")) as Spec, file)
  return [...nodes.values()].flatMap((node) => {
    const type = node.type ?? "agent"
    if (type === "agent" || type === "verify") return approving(node.id, node.permissions)
    if (type === "team")
      return members(node).flatMap(([name, member]) => approving(`${node.id}/${name}`, member?.permissions))
    return []
  })
}

/**
 * The agents that a run of the YAML workflow in `file` runs its nodes as, which are whichever of the user's agents the file
 * names: the `agent` of an agent or verify node, the `agent` of a verify node's `judge`, named `node/judge`, and the `agent`
 * of each member of a team, named `team/member`, each with the value as written. An agent's own rules are added after the
 * user's global rules, and the last match wins, so naming one chooses the rules a node runs under. A file can name an agent
 * whose rules allow what the user's own would ask about, and then the action is done without asking, where the run
 * rejects it for a node that names none: the choice takes the answer to the user's own `ask` rules out of the user's hands,
 * as `permissions: auto` does, so a file that brings it needs the same care. A value that is a template counts as well:
 * `{{node.text}}` is filled in when the node starts, and the reply of an agent can name one. These are the only places
 * where the runner reads an `agent` from what `execute` in `yaml.ts` hands it, and it sends any value that is not falsy to
 * the server as the agent of the session (see `attempt` in `agent.ts`). Asked before `loadWorkflow` like
 * `workflowCommands`, which it reads and validates as that does, and for the same reason only a YAML file is read: what a
 * module passes on is known only once it runs.
 */
export async function workflowAgents(file: string) {
  if (!isYaml(file)) return []
  const nodes = validate((await read(file, "Workflow file")) as Spec, file)
  return [...nodes.values()].flatMap((node) => {
    const type = node.type ?? "agent"
    if (type === "agent") return naming(node.id, node.agent)
    if (type === "verify") return [...naming(node.id, node.agent), ...judging(node.id, node.judge)]
    if (type === "team") return members(node).flatMap(([name, member]) => naming(`${node.id}/${name}`, member?.agent))
    return []
  })
}

/**
 * The agents that a run of the suite in `file` runs its tasks as: the `agent` of each task's `judge`, named `task/judge`
 * as the judge of a verify node is, because a suite runs each task as a verify node (see `evaluate` in `eval.ts`) and
 * hands it the task's `judge` and no `agent` of its own, so a task's own `agent` chooses nothing. Asked before
 * `loadSuite` like `workflowAgents`, and as there, a module has none to list, because it is stopped by `importsModule`
 * and never read here.
 */
export async function suiteAgents(file: string) {
  if (importsModule(file)) return []
  // `loadSuite` checks no more than the list, so a task may be anything. One that is not an object lists nothing here,
  // as `evaluate` fails on it before anything runs.
  return (await loadSuite(file)).tasks.flatMap((task) => judging(task?.id, task?.judge))
}

/**
 * What the YAML workflow in `file` chooses for the models its nodes run on, or for how much they spend: the `model` of an
 * agent or verify node and of each team member, the `retry.fallbackModels` and `retry.maxAttempts` of an agent or verify
 * node, the `model` of a verify node's `judge` (named `node/judge`), and the `maxIterations` of a verify node and
 * `maxRounds` of a team, each with the value as written. A node's `model` replaces the `--model` the person passed (see
 * `attempt` in `runner.ts`, `requested.model ?? defaultModel`), and the rest add models and attempts to a run, so a file
 * from an untrusted folder that sets any of them picks what the person's money is spent on. A template counts as well,
 * because it is filled in when the node starts. A value that is empty, or a list with nothing in it, chooses nothing. Asked
 * before `loadWorkflow` like `workflowCommands`, which it reads and validates as that does, and for the same reason only a
 * YAML file is read: what a module passes on is known only once it runs.
 */
export async function workflowModels(file: string) {
  if (!isYaml(file)) return []
  const nodes = validate((await read(file, "Workflow file")) as Spec, file)
  return [...nodes.values()].flatMap((node) => {
    const type = node.type ?? "agent"
    if (type === "agent") return choosing(node.id, node, AGENT_CHOICES)
    if (type === "verify")
      return [
        ...choosing(node.id, node, [...AGENT_CHOICES, "maxIterations"]),
        ...choosing(`${node.id}/judge`, node.judge, ["model"]),
      ]
    if (type === "team")
      return [
        ...choosing(node.id, node, ["maxRounds"]),
        ...members(node).flatMap(([name, member]) => choosing(`${node.id}/${name}`, member, ["model"])),
      ]
    return []
  })
}

/**
 * What the suite in `file` chooses the same way: its `models`, which an eval runs every task on when `--models` is not
 * given, and the `model` of each task's `judge` (named `task/judge`) and its `maxIterations`. A suite runs each task as a
 * verify node (see `evaluate` in `eval.ts`) and hands it no `retry` of its own, so a task's `retry` chooses nothing.
 * Asked before `loadSuite` like `workflowModels`, and as there, a module has none to list.
 */
export async function suiteModels(file: string) {
  if (importsModule(file)) return []
  const suite = await loadSuite(file)
  return [
    ...choosing("suite", suite, ["models"]),
    ...suite.tasks.flatMap((task) => [
      ...choosing(task?.id, task, ["maxIterations"]),
      ...choosing(`${String(task?.id)}/judge`, task?.judge, ["model"]),
    ]),
  ]
}

const AGENT_CHOICES = ["model", "retry.fallbackModels", "retry.maxAttempts"] as const

// The fields of `source`, named by path, that hold a value. A source that is not an object holds none, as the runner reads
// nothing off it.
function choosing(id: unknown, source: unknown, fields: ReadonlyArray<string>) {
  return fields.flatMap((field) => {
    const value = field
      .split(".")
      .reduce<unknown>(
        (current, key) =>
          current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
        source,
      )
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) return []
    return [{ id: String(id), choice: `${field}: ${typeof value === "string" ? value : JSON.stringify(value)}` }]
  })
}

// `auto`, or a string with a template in it, which `fill` may turn into `auto` once the run reaches the node. Any other
// value is a rejection to the runner.
function approving(id: string, permissions: unknown) {
  if (typeof permissions !== "string") return []
  return permissions === "auto" || permissions.includes("{{") ? [{ id, permissions }] : []
}

// An agent the runner hands to the server: `attempt` sends any value that is not falsy as the agent of the session, so
// each counts, and a value that is not text, which the server rejects, shows as written.
function naming(id: unknown, agent: unknown) {
  if (!agent) return []
  return [{ id: String(id), agent: typeof agent === "object" ? JSON.stringify(agent) : String(agent) }]
}

// The runner reads `agent` off whatever the `judge` is: `true`, text, `null` and a list name none, and only an object that
// has one names it.
function judging(id: unknown, judge: unknown) {
  return naming(`${String(id)}/judge`, (judge as { readonly agent?: unknown } | null | undefined)?.agent)
}

// `validate` takes any object for the members, an array and null included, and a member can be any value. Only one that is
// an object has options to hand on.
function members(node: NodeSpec) {
  return Object.entries(
    (node.members ?? {}) as Record<string, { readonly agent?: unknown; readonly permissions?: unknown } | null>,
  )
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
