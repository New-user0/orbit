import type { AgentResult, Context, Workflow } from "./workflow.js"

// A YAML workflow is a list of nodes with `needs`. Each node starts as soon as everything it needs has finished, so
// independent branches run in parallel. `{{input.key}}` and `{{node.field}}` in strings are replaced with the run's
// input and the results of nodes the node depends on.
//
//   name: feature
//   nodes:
//     - id: plan
//       prompt: "Plan: {{input.task}}"
//       worktree: false
//     - id: api
//       needs: [plan]
//       prompt: "Implement the API part of:\n{{plan.text}}"
//     - id: tests
//       type: check
//       needs: [api]
//       command: npm test
//       in: api
//     - id: merge
//       type: merge
//       needs: [tests]
//       branches: [api]

export type NodeType = "agent" | "verify" | "team" | "check" | "gate" | "merge"

export interface Spec {
  readonly name: string
  readonly description?: string
  readonly budget?: Workflow["budget"]
  readonly nodes: ReadonlyArray<NodeSpec>
  /** The node whose result is the run's output; every node's result by id when omitted. */
  readonly output?: string
}

export interface NodeSpec {
  readonly id: string
  readonly type?: NodeType
  readonly needs?: ReadonlyArray<string>
  readonly [option: string]: unknown
}

const TYPES = new Set<NodeType>(["agent", "verify", "team", "check", "gate", "merge"])

export function compile(spec: Spec, file: string): Workflow {
  const nodes = validate(spec, file)
  return {
    name: spec.name,
    description: spec.description,
    budget: spec.budget,
    async run(ctx) {
      const results = new Map<string, Promise<unknown>>()
      // A rejected gate skips everything that depends on it; `undefined` marks a skipped node.
      const start = (node: NodeSpec): Promise<unknown> => {
        const existing = results.get(node.id)
        if (existing) return existing
        const started = Promise.all((node.needs ?? []).map((need) => start(nodes.get(need)!))).then(async (needed) => {
          if (needed.some((value) => value === undefined || isRejected(value))) return undefined
          // Templates may name any upstream node, and all of them have finished by now.
          const values = Object.fromEntries(
            await Promise.all([...ancestors(nodes, node.id)].map(async (id) => [id, await results.get(id)] as const)),
          )
          return execute(ctx, node, values)
        })
        results.set(node.id, started)
        return started
      }
      // Every node settles before a failure is raised, so no branch is left running unrecorded.
      const settled = await Promise.allSettled([...nodes.values()].map(start))
      const failed = settled.find((item): item is PromiseRejectedResult => item.status === "rejected")
      if (failed) throw failed.reason
      const values = Object.fromEntries(
        [...nodes.keys()].map((id, index) => [id, (settled[index] as PromiseFulfilledResult<unknown>).value ?? null]),
      )
      return spec.output ? values[spec.output] : values
    },
  }
}

function isRejected(value: unknown) {
  return typeof value === "object" && value !== null && "approved" in value && value.approved === false
}

// `check` and `verify` are the types that start commands of the file's own. `workflowCommands` in load.ts lists them
// for the callers that ask whether the folder is trusted before the run, so a type added here that runs one is added
// there. `workflowApprovals` lists the options that approve what an agent asks permission for, which are the
// `permissions` of `agent` and `verify` and of each member of a `team`, so an option added here that does the same is
// added there too. `workflowAgents` lists the options that choose which of the user's agents a node runs as, which are
// the `agent` of `agent` and `verify`, the `agent` of the `judge` of a `verify`, and the `agent` of each member of a
// `team`, so an option added here that does the same is added there too. `workflowModels` lists the options that choose a
// model or how much a node spends: the `model`, `retry.fallbackModels` and `retry.maxAttempts` of `agent` and `verify`,
// the `maxIterations` of `verify` and the `model` of its `judge`, and the `model` of each `team` member and the
// `maxRounds` of the team, so an option added here that does the same is added there too.
function execute(ctx: Context, node: NodeSpec, needed: Readonly<Record<string, unknown>>) {
  const options = fill(
    Object.fromEntries(Object.entries(node).filter(([key]) => !["id", "type", "needs"].includes(key))),
    ctx.input,
    needed,
  ) as Record<string, unknown>
  const type = node.type ?? "agent"
  if (type === "agent") return ctx.agent(node.id, options as unknown as Parameters<Context["agent"]>[1])
  if (type === "verify") return ctx.verify(node.id, options as unknown as Parameters<Context["verify"]>[1])
  if (type === "team") return ctx.team(node.id, options as unknown as Parameters<Context["team"]>[1])
  if (type === "gate") return ctx.gate(node.id, { message: String(options.message ?? `Continue after ${node.id}?`) })
  // `in` and `branches` name nodes; they become those nodes' results.
  if (type === "check")
    return ctx.check(node.id, {
      command: String(options.command),
      ...(typeof node.in === "string" ? { in: needed[node.in] as AgentResult } : {}),
      ...(options.timeout ? { timeout: Number(options.timeout) } : {}),
    })
  return ctx.merge(
    node.id,
    ((node.branches as string[] | undefined) ?? []).map((id) => needed[id] as AgentResult),
  )
}

/** Replace `{{input.key}}` and `{{node.path}}` in every string of `value`. */
function fill(
  value: unknown,
  input: Readonly<Record<string, unknown>>,
  needed: Readonly<Record<string, unknown>>,
): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, path: string) => {
      const [head, ...rest] = path.split(".")
      const root = head === "input" ? input : needed[head]
      const found = rest.reduce<unknown>(
        (current, key) =>
          current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined,
        root,
      )
      return found === undefined ? "" : typeof found === "string" ? found : JSON.stringify(found)
    })
  }
  if (Array.isArray(value)) return value.map((item) => fill(item, input, needed))
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, input, needed)]))
  return value
}

function ancestors(nodes: ReadonlyMap<string, NodeSpec>, id: string, seen = new Set<string>()): Set<string> {
  for (const need of nodes.get(id)?.needs ?? []) {
    if (seen.has(need)) continue
    seen.add(need)
    ancestors(nodes, need, seen)
  }
  return seen
}

/** Check the graph before anything runs: known types, unique ids, existing needs, no cycles, upstream references. */
export function validate(spec: Spec, file: string) {
  const problems: string[] = []
  if (!spec || typeof spec.name !== "string" || !Array.isArray(spec.nodes))
    throw new Error(`${file} must have a name and a list of nodes`)
  const nodes = new Map<string, NodeSpec>()
  for (const node of spec.nodes) {
    if (!node || typeof node.id !== "string") problems.push("every node needs an id")
    else if (nodes.has(node.id)) problems.push(`node id ${node.id} is used twice`)
    else nodes.set(node.id, node)
    if (node?.type && !TYPES.has(node.type)) problems.push(`${node.id}: unknown type ${node.type}`)
  }
  for (const node of nodes.values()) {
    for (const need of node.needs ?? [])
      if (!nodes.has(need)) problems.push(`${node.id} needs ${need}, which is not a node`)
    const type = node.type ?? "agent"
    if ((type === "agent" || type === "verify") && typeof node.prompt !== "string")
      problems.push(`${node.id}: needs a prompt`)
    if (type === "check" && typeof node.command !== "string") problems.push(`${node.id}: needs a command`)
    if (type === "team" && (typeof node.goal !== "string" || typeof node.members !== "object"))
      problems.push(`${node.id}: needs a goal and members`)
    if (type === "merge" && !Array.isArray(node.branches))
      problems.push(`${node.id}: needs branches, a list of node ids`)
  }
  const visiting = new Set<string>()
  const done = new Set<string>()
  const visit = (id: string, path: string[]) => {
    if (done.has(id)) return
    if (visiting.has(id)) return problems.push(`cycle: ${[...path, id].join(" → ")}`)
    visiting.add(id)
    for (const need of nodes.get(id)?.needs ?? []) if (nodes.has(need)) visit(need, [...path, id])
    visiting.delete(id)
    done.add(id)
  }
  for (const id of nodes.keys()) visit(id, [])
  if (problems.length === 0)
    for (const node of nodes.values()) {
      const upstream = ancestors(nodes, node.id)
      const referenced = [...JSON.stringify(node).matchAll(/\{\{\s*([\w-]+)[\w.-]*\s*\}\}/g)].map((match) => match[1])
      const named = [node.in, ...(Array.isArray(node.branches) ? node.branches : [])].filter(
        (item): item is string => typeof item === "string",
      )
      for (const reference of [...referenced, ...named])
        if (reference !== "input" && !upstream.has(reference))
          problems.push(`${node.id} uses ${reference}, which is not among the nodes it needs`)
    }
  if (spec.output && !nodes.has(spec.output)) problems.push(`output ${spec.output} is not a node`)
  if (problems.length > 0) throw new Error(`${file} is not a valid workflow:\n- ${problems.join("\n- ")}`)
  return nodes
}
