import { lstat, mkdir, open, realpath } from "node:fs/promises"
import path from "node:path"
import { ConfigAgent } from "@orbit/schema/config/agent"
import type { Permission } from "@orbit/schema/permission"
import { ToolNames } from "@orbit/schema/tool-names"
import { FSUtil } from "@orbit/util/fs-util"

/** What the person chose in the create dialog. */
export type AgentDraft = {
  scope: "project" | "user"
  name: string
  description: string
  prompt: string
  /** Absent means every tool. */
  tools?: readonly string[]
  /** `inherit` is not written: an agent without a model uses the caller's. */
  model: ConfigAgent.ModelTier
  permissionMode?: Permission.Mode
}

/** Another agent that holds a name: where it came from, or nothing for an agent that Orbit ships. */
export type TakenName = { id: string; scope?: string }

const tools = Object.values(ToolNames.tools)
/** The three characters that JSON writes as they are and YAML reads as line breaks: NEL, LS and PS. */
const lineBreaks = new RegExp(`[${String.fromCharCode(0x85, 0x2028, 0x2029)}]`, "g")
const reads = new Set(["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "TaskList", "TaskOutput", "LSP"])
const edits = new Set(["Edit", "Write", "Patch", "NotebookEdit"])
const runs = new Set(["Bash", "TaskWatch", "TaskStop", "Execute"])

/** The built-in tools by what they do, in the order the dialog lists them. Empty groups are left out. */
export const toolGroups = [
  { id: "read", label: "Read-only tools", tools: tools.filter((tool) => reads.has(tool)) },
  { id: "edit", label: "Edit tools", tools: tools.filter((tool) => edits.has(tool)) },
  { id: "run", label: "Execution tools", tools: tools.filter((tool) => runs.has(tool)) },
  { id: "other", label: "Other tools", tools: tools.filter((tool) => !reads.has(tool) && !edits.has(tool) && !runs.has(tool)) },
].filter((group) => group.tools.length > 0)

export const allTools: readonly string[] = tools

/** Why `value` cannot name an agent, or nothing when it can. Trimmed first by the caller. */
export function nameProblem(value: string) {
  if (value.length < 3) return "The name needs at least 3 characters."
  if (value.length > 50) return "The name can be at most 50 characters."
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*[A-Za-z0-9]$/.test(value))
    return "Use letters, digits and hyphens, starting and ending with a letter or digit."
  // A file named like a Windows device cannot exist there, so the name is refused everywhere.
  if (!ConfigAgent.isName(value)) return "That name is reserved."
  return undefined
}

/**
 * The problems that stop a save, and the cautions that do not. A name is also refused when any agent already has it,
 * whatever the case, since the file would shadow or be shadowed on a case-insensitive disk.
 */
export function check(draft: AgentDraft, taken: readonly TakenName[]) {
  const errors: string[] = []
  const warnings: string[] = []
  const problem = nameProblem(draft.name)
  if (problem) errors.push(problem)
  else {
    const owner = taken.find((item) => item.id.toLowerCase() === draft.name.toLowerCase())
    if (owner) errors.push(`An agent named ${owner.id} already exists (${owner.scope ? `from the ${owner.scope} scope` : "built in"}).`)
  }
  if (draft.description.trim() === "") errors.push("The description is missing.")
  else if (draft.description.length < 10) warnings.push("The description is very short.")
  else if (draft.description.length > 5000) warnings.push("The description is longer than 5000 characters.")
  if (draft.prompt.trim() === "") errors.push("The system prompt is missing.")
  else if (draft.prompt.trim().length < 20) errors.push("The system prompt needs at least 20 characters.")
  else if (draft.prompt.length > 10_000) warnings.push("The system prompt is longer than 10000 characters.")
  const unknown = (draft.tools ?? []).filter((tool) => !tools.includes(tool as never))
  if (unknown.length > 0) errors.push(`Unknown tools: ${unknown.join(", ")}.`)
  if (draft.tools === undefined) warnings.push("The agent gets every tool.")
  else if (draft.tools.length === 0) warnings.push("The agent gets no tools, which makes it very limited.")
  return { errors, warnings }
}

/**
 * The file's text. Every value is written as a JSON string, which is also a valid YAML double-quoted scalar, so a
 * description with a colon, a quote, `---` or a line break cannot add a key or end the front matter. Three characters
 * that JSON leaves raw but YAML reads as line breaks are escaped too. The agent's name is the file's, so it is not written.
 */
export function render(draft: AgentDraft) {
  const scalar = (value: string) => JSON.stringify(value).replace(lineBreaks, (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"))
  return [
    "---",
    `description: ${scalar(draft.description.trim())}`,
    ...(draft.tools === undefined ? [] : draft.tools.length === 0 ? ["tools: []"] : ["tools:", ...draft.tools.map((tool) => `  - ${scalar(tool)}`)]),
    ...(draft.model === "inherit" ? [] : [`model: ${scalar(draft.model)}`]),
    ...(draft.permissionMode === undefined ? [] : [`permission_mode: ${scalar(draft.permissionMode)}`]),
    "---",
    "",
    `${draft.prompt.trim()}\n`,
  ].join("\n")
}

export type Created =
  | { type: "created"; file: string }
  | { type: "exists"; file: string }
  | { type: "escapes"; file: string }
  | { type: "failed"; file: string; reason: string }

/**
 * Writes the agent at `<configDirectory>/agents/<name>.md` and never over a file or link that is there. For a project the folder
 * it lands in must really be inside the project: the nearest folder of the path that exists is resolved on disk, and a
 * `.orbit` or `.orbit/agents` that is a link out of the project is refused before anything is made or written. The check
 * runs again once the folder exists. `root` is the project's folder; a user's own config directory has none.
 */
export async function create(input: { configDirectory: string; root?: string; draft: AgentDraft }): Promise<Created> {
  const folder = path.join(input.configDirectory, "agents")
  const file = path.join(folder, `${input.draft.name}.md`)
  const problem = nameProblem(input.draft.name)
  if (problem) return { type: "failed", file, reason: problem }
  const root = input.root === undefined ? undefined : await real(input.root)
  const inside = async () => {
    if (root === undefined) return input.root === undefined
    const near = await nearest(folder)
    return near !== undefined && FSUtil.contains(root, near)
  }
  if (!(await inside())) return { type: "escapes", file }
  const made = await mkdir(folder, { recursive: true }).then(
    () => undefined,
    (error: Error) => error,
  )
  if (made) return { type: "failed", file, reason: made.message }
  if (!(await inside())) return { type: "escapes", file }
  // Anything at the path refuses the write, a dangling link included: on Windows `wx` creates the target of a link that
  // leads nowhere, so the entry is looked at first instead of leaving it to the open. A link is reported as one that
  // escapes, whatever it points to.
  const entry = await lstat(file).then(
    (found) => found,
    () => undefined,
  )
  if (entry?.isSymbolicLink()) return { type: "escapes", file }
  if (entry) return { type: "exists", file }
  // `wx` still refuses a file that appeared since the look.
  const handle = await open(file, "wx").then(
    (opened) => opened,
    (error: NodeJS.ErrnoException) => error,
  )
  if (handle instanceof Error) return handle.code === "EEXIST" ? { type: "exists", file } : { type: "failed", file, reason: handle.message }
  return handle.writeFile(render(input.draft)).then(
    () => handle.sync().then(() => ({ type: "created", file }) as const),
    (error: Error) => ({ type: "failed", file, reason: error.message }) as const,
  ).finally(() => handle.close())
}

async function real(file: string) {
  return realpath(file).then(
    (resolved) => resolved,
    () => undefined,
  )
}

/** The real path of the nearest folder at or above `file` that exists. */
async function nearest(file: string): Promise<string | undefined> {
  const resolved = await real(file)
  if (resolved !== undefined) return resolved
  const parent = path.dirname(file)
  return parent === file ? undefined : nearest(parent)
}
