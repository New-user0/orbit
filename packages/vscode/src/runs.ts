import { plain } from "@orbit/flow/plain"
import { launch } from "./program.js"

// The Runs view reads Orbit Flow runs through the `orb flow` commands' JSON, so the extension needs no database
// driver and always agrees with the CLI. Nothing here imports vscode, so it is tested against the real CLI.

export interface Run {
  readonly id: string
  readonly workflow: string
  readonly status: "running" | "waiting" | "succeeded" | "failed"
  readonly updated: number
}

export interface Node {
  readonly id: string
  readonly status: "running" | "waiting" | "succeeded" | "failed"
  readonly attempts: number
  readonly message?: string
  readonly result?: { readonly usage?: { readonly input?: number; readonly output?: number; readonly cost?: number } }
  readonly error?: { readonly message?: string }
  readonly started: number
  readonly ended?: number
}

/** What the tree shows for a run or a node; `context` drives which actions VS Code offers on it. */
export interface Item {
  readonly label: string
  readonly description: string
  readonly tooltip: string
  /** A codicon id. */
  readonly icon: string
  readonly context: string
}

export function orb(executable: string, directory: string, args: ReadonlyArray<string>, timeout = 60_000) {
  // orb takes the working directory from PWD, which VS Code's own environment would otherwise supply.
  return launch(executable, args, { cwd: directory, env: { ...process.env, PWD: directory }, timeout })
}

// The run store is a file a clone can ship, so what `orb flow` prints from it is decoded here once: strings and finite
// numbers are kept, anything else is dropped, and an entry without an id costs only itself.
export async function runs(executable: string, directory: string) {
  return decodeRuns(JSON.parse(await orb(executable, directory, ["flow", "ls", "--format", "json"])))
}

export function decodeRuns(parsed: unknown): Run[] {
  return list(parsed).flatMap((entry) =>
    typeof entry.id === "string"
      ? [
          {
            id: entry.id,
            workflow: text(entry.workflow) ?? "",
            status: status(entry.status),
            updated: number(entry.updated) ?? 0,
          },
        ]
      : [],
  )
}

export async function nodes(executable: string, directory: string, run: string) {
  return decodeNodes(JSON.parse(await orb(executable, directory, ["flow", "show", run, "--format", "json"])))
}

export function decodeNodes(parsed: unknown): Node[] {
  return list(record(parsed)?.nodes).flatMap((entry) => {
    if (typeof entry.id !== "string") return []
    const usage = record(record(entry.result)?.usage)
    const message = text(record(entry.error)?.message)
    return [
      {
        id: entry.id,
        status: status(entry.status),
        attempts: number(entry.attempts) ?? 1,
        ...(text(entry.message) === undefined ? {} : { message: text(entry.message) }),
        ...(usage
          ? { result: { usage: { input: number(usage.input), output: number(usage.output), cost: number(usage.cost) } } }
          : {}),
        ...(message === undefined ? {} : { error: { message } }),
        started: number(entry.started) ?? 0,
        ...(number(entry.ended) === undefined ? {} : { ended: number(entry.ended) }),
      },
    ]
  })
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function list(value: unknown) {
  return Array.isArray(value)
    ? value.flatMap((entry: unknown) => {
        const found = record(entry)
        return found ? [found] : []
      })
    : []
}

function text(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function status(value: unknown): Run["status"] {
  return value === "running" || value === "waiting" || value === "succeeded" ? value : "failed"
}

export function decide(
  executable: string,
  directory: string,
  input: { readonly run: string; readonly gate: string; readonly approve: boolean; readonly note?: string },
) {
  return orb(executable, directory, [
    "flow",
    "approve",
    input.run,
    input.gate,
    ...(input.approve ? [] : ["--reject"]),
    ...(input.note ? ["--note", input.note] : []),
  ])
}

const icons = { running: "sync~spin", waiting: "question", succeeded: "pass", failed: "error" }

export function runItem(run: Run): Item {
  return {
    label: plain(run.workflow),
    description: `${plain(run.status)} · ${new Date(run.updated).toLocaleString()}`,
    tooltip: `${plain(run.id)}\n${plain(run.workflow)}: ${plain(run.status)}`,
    icon: icons[run.status],
    context: `run-${run.status}`,
  }
}

/** The words shown around a gate's name in the decision prompts. The name is the run store's, so it is written out. */
export function decisionText(approve: boolean, node: string, run: string) {
  const verb = approve ? "Approve" : "Reject"
  const name = plain(node)
  return {
    title: `${verb} ${name}`,
    failure: `Could not decide ${name}`,
    done: `${approve ? "Approved" : "Rejected"} ${name}. Resume ${plain(run)} now?`,
  }
}

export function nodeItem(node: Node): Item {
  const usage = node.result?.usage
  const seconds = node.ended ? Math.round((node.ended - node.started) / 100) / 10 : undefined
  const details = [
    ...(node.status === "waiting" ? ["waiting for a decision"] : []),
    ...(node.attempts > 1 ? [`${node.attempts} attempts`] : []),
    ...(usage ? [`${(usage.input ?? 0) + (usage.output ?? 0)} tokens`] : []),
    ...(usage?.cost ? [`$${usage.cost.toFixed(4)}`] : []),
    ...(seconds !== undefined ? [`${seconds}s`] : []),
  ]
  return {
    label: plain(node.id),
    description: details.join(" · "),
    tooltip: [node.id, node.message, node.error?.message].flatMap((text) => (text ? [plain(text)] : [])).join("\n\n"),
    icon: icons[node.status],
    context: node.status === "waiting" ? "gate" : "node",
  }
}
