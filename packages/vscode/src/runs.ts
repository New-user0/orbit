import { execFile } from "node:child_process"

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
  return new Promise<string>((resolve, reject) =>
    execFile(
      executable,
      [...args],
      // orb takes the working directory from PWD, which VS Code's own environment would otherwise supply.
      { cwd: directory, env: { ...process.env, PWD: directory }, timeout, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(stderr.trim() || error.message))
        resolve(stdout)
      },
    ),
  )
}

export async function runs(executable: string, directory: string): Promise<Run[]> {
  return JSON.parse(await orb(executable, directory, ["flow", "ls", "--format", "json"]))
}

export async function nodes(executable: string, directory: string, run: string): Promise<Node[]> {
  return JSON.parse(await orb(executable, directory, ["flow", "show", run, "--format", "json"])).nodes
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
    label: run.workflow,
    description: `${run.status} · ${new Date(run.updated).toLocaleString()}`,
    tooltip: `${run.id}\n${run.workflow}: ${run.status}`,
    icon: icons[run.status],
    context: `run-${run.status}`,
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
    label: node.id,
    description: details.join(" · "),
    tooltip: [node.id, node.message, node.error?.message].filter(Boolean).join("\n\n"),
    icon: icons[node.status],
    context: node.status === "waiting" ? "gate" : "node",
  }
}
