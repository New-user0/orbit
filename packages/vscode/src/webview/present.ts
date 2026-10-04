import type { Item, WorkflowAgent } from "../protocol.js"

// How chat items read on one line. Pure functions, shared by the webview and its tests.

export interface Shown {
  readonly verb: string
  readonly target: string
  readonly meta?: string
  readonly add?: string
  readonly del?: string
  readonly failed?: boolean
}

/** A tool call as `verb target  +add −del  meta`, with paths shown from the workspace folder down. */
export function describe(item: Extract<Item, { type: "tool" }>, folder: string): Shown {
  const input = item.input ?? {}
  const text = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "")
  const lines = (item.output ?? "").split("\n").filter((line) => line.trim()).length
  const additions = item.files?.reduce((total, file) => total + (file.additions ?? 0), 0) ?? 0
  const deletions = item.files?.reduce((total, file) => total + (file.deletions ?? 0), 0) ?? 0
  const changes = {
    add: additions ? `+${additions}` : undefined,
    del: deletions ? `−${deletions}` : undefined,
  }
  const failed = item.status === "error" ? { meta: "failed", failed: true } : {}
  switch (item.name) {
    case "read":
      return {
        verb: "Read",
        target: relative(text("path"), folder),
        meta: lines ? `${lines} lines` : undefined,
        ...failed,
      }
    case "grep":
      return {
        verb: "Search",
        target: [text("pattern"), text("path") && `in ${relative(text("path"), folder)}`].filter(Boolean).join(" "),
        meta: item.status === "completed" ? count(item.output, "result") : undefined,
        ...failed,
      }
    case "glob":
      return {
        verb: "Find",
        target: text("pattern"),
        meta: item.status === "completed" ? count(item.output, "file") : undefined,
        ...failed,
      }
    case "write": {
      // The write result carries no diff; a new file's lines all count as added.
      const created = item.files?.[0]?.status === "added" || (item.output ?? "").startsWith("Created")
      const written = text("content")
        .split("\n")
        .filter((line, index, all) => line || index < all.length - 1).length
      return {
        verb: created ? "Create" : "Write",
        target: relative(text("path"), folder),
        add: changes.add ?? (created && written ? `+${written}` : undefined),
        del: changes.del,
        ...failed,
      }
    }
    case "edit":
    case "notebook_edit":
      return { verb: "Edit", target: relative(text("path"), folder), ...changes, ...failed }
    case "patch":
      return {
        verb: "Edit",
        target: item.files?.map((file) => relative(file.file, folder)).join(", ") || "files",
        ...changes,
        ...failed,
      }
    case "shell":
      return {
        verb: "Run",
        target: text("command").split("\n")[0] ?? "",
        meta: item.exit !== undefined && item.exit !== 0 ? `exit ${item.exit}` : undefined,
        failed: item.status === "error" || (item.exit !== undefined && item.exit !== 0),
      }
    case "shell_output":
      return { verb: "Output", target: text("shellID"), ...failed }
    case "shell_watch":
      return { verb: "Watch", target: `${text("shellID")} for ${text("pattern")}`, ...failed }
    case "shell_stop":
      return { verb: "Stop", target: text("shellID"), ...failed }
    case "webfetch":
      return { verb: "Fetch", target: text("url"), ...failed }
    case "websearch":
      return { verb: "Search", target: text("query"), meta: "web", ...failed }
    case "subagent":
      return { verb: "Agent", target: text("description") || text("prompt").slice(0, 80), ...failed }
    case "workflow":
      return { verb: "Workflow", target: text("description") || "script", ...failed }
    case "skill":
      return { verb: "Skill", target: text("name"), ...failed }
    case "enter_plan_mode":
      return { verb: "Plan", target: text("reason") || "switching to Plan mode", ...failed }
    case "exit_plan_mode":
      return { verb: "Plan", target: "ready for review", ...failed }
    case "task_create":
      return { verb: "Task", target: text("subject"), ...failed }
    case "task_update":
      return { verb: "Task", target: `#${text("id")} ${text("status") || "updated"}`, ...failed }
    case "task_list":
      return { verb: "Tasks", target: "list", ...failed }
    case "question":
      return { verb: "Ask", target: "questions for you", ...failed }
    default:
      return { verb: item.name, target: firstString(input), ...failed }
  }
}

/** The first changed lines of a unified diff, for a compact preview. */
export function excerpt(patch: string, limit: number) {
  return patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line))
    .slice(0, limit)
    .map((line) => ({ kind: line.startsWith("+") ? ("add" as const) : ("del" as const), text: line.slice(1) }))
}

/** Inline `code` and **bold** spans of a paragraph; everything else is plain text. */
export function segments(text: string) {
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)
    .filter((part) => part !== "")
    .map((part) =>
      part.startsWith("`") && part.endsWith("`") && part.length > 2
        ? { kind: "code" as const, text: part.slice(1, -1) }
        : part.startsWith("**") && part.endsWith("**") && part.length > 4
          ? { kind: "strong" as const, text: part.slice(2, -2) }
          : { kind: "text" as const, text: part },
    )
}

function relative(file: string, folder: string) {
  if (!file) return ""
  const parts = file.split(/[\\/]/)
  const index = folder ? parts.lastIndexOf(folder) : -1
  return index === -1 ? file : parts.slice(index + 1).join("/")
}

function count(output: string | undefined, noun: string) {
  const lines = (output ?? "")
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("(") && !/^No \w+ found/.test(line))
  return `${lines.length} ${noun}${lines.length === 1 ? "" : "s"}`
}

function firstString(input: Readonly<Record<string, unknown>>) {
  const value = Object.values(input).find((item) => typeof item === "string")
  return typeof value === "string" ? value.slice(0, 80) : ""
}

/** Every agent a chat started: each workflow's agents and each subagent call, in order. */
export function agentsOf(items: ReadonlyArray<Item>): WorkflowAgent[] {
  return items.flatMap((item): WorkflowAgent[] => {
    if (item.type !== "tool") return []
    if (item.name === "workflow") return [...(item.agents ?? [])]
    if (item.name !== "subagent") return []
    const description = item.input?.description
    const agent = item.input?.agent
    return [
      {
        sessionID: item.id,
        description: typeof description === "string" ? description : "Subagent",
        agent: typeof agent === "string" ? agent : "general",
        status: item.status === "error" ? "failed" : item.status,
      },
    ]
  })
}

/** Agents grouped by phase in order of first appearance; agents without one share an unnamed group. */
export function phases(agents: ReadonlyArray<WorkflowAgent>) {
  const names = [...new Set(agents.map((agent) => agent.phase ?? ""))]
  return names.map((name) => ({ name, agents: agents.filter((agent) => (agent.phase ?? "") === name) }))
}

export function tokens(agents: ReadonlyArray<WorkflowAgent>) {
  return agents.reduce((total, agent) => total + (agent.tokens ?? 0), 0)
}

/** From the first start to the last end, or to now while any agent runs: "11s", "2m 5s". */
export function duration(agents: ReadonlyArray<WorkflowAgent>, now: number) {
  const starts = agents.flatMap((agent) => (agent.started === undefined ? [] : [agent.started]))
  if (starts.length === 0) return ""
  const end = agents.some((agent) => agent.status === "running")
    ? now
    : Math.max(...agents.map((agent) => agent.ended ?? agent.started ?? now))
  const total = Math.max(0, Math.round((end - Math.min(...starts)) / 1000))
  return total < 60 ? `${total}s` : `${Math.floor(total / 60)}m ${total % 60}s`
}
