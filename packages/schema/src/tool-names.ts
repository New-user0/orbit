export * as ToolNames from "./tool-names.js"

/**
 * The one table of the names Orbit's built-in tools had before they took the reference interface, and of the input
 * fields that changed with them. Everything that reads a name a person or an old session wrote goes through it:
 * permission rules and saved approvals, hook matchers, plugin hooks, history lowering and the clients that draw a
 * recorded call. Events keep the names they were recorded with, so nothing here rewrites storage.
 */

/** Old tool name to current tool name. */
export const tools = {
  shell: "Bash",
  shell_output: "TaskOutput",
  shell_watch: "TaskWatch",
  shell_stop: "TaskStop",
  read: "Read",
  edit: "Edit",
  write: "Write",
  patch: "Patch",
  glob: "Glob",
  grep: "Grep",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  question: "AskUserQuestion",
  todo: "TodoWrite",
  task_create: "TaskCreate",
  task_update: "TaskUpdate",
  task_list: "TaskList",
  subagent: "Agent",
  skill: "Skill",
  notebook_edit: "NotebookEdit",
  lsp: "LSP",
  enter_plan_mode: "EnterPlanMode",
  exit_plan_mode: "ExitPlanMode",
  enter_worktree: "EnterWorktree",
  exit_worktree: "ExitWorktree",
  workflow: "Workflow",
  memory: "Memory",
  execute: "Execute",
} as const satisfies Record<string, string>

/** Current tool name to its input fields, from the current field name to the old one. */
export const fields = {
  Edit: { file_path: "path", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  Write: { file_path: "path" },
  Read: { file_path: "path" },
  Bash: { run_in_background: "background" },
  NotebookEdit: { notebook_path: "path" },
} as const satisfies Record<string, Record<string, string>>

const current = new Set<string>(Object.values(tools))

/** The current name of a tool, whichever spelling it is given in. Names the table does not list pass through. */
export function canonical(name: string): string {
  return Object.hasOwn(tools, name) ? tools[name as keyof typeof tools] : name
}

/** The name a tool had before the rename, or the name itself when it never had another. */
export function legacy(name: string): string {
  return Object.entries(tools).find(([, value]) => value === name)?.[0] ?? name
}

/**
 * Every spelling of a tool or permission action: the name given, its current name and each old name that maps to it.
 * A rule or matcher written with any one of them stands for the same tool, and for no other.
 */
export function spellings(name: string): readonly string[] {
  const now = canonical(name)
  if (!current.has(now)) return [name]
  const olds = Object.entries(tools).flatMap(([old, value]) => (value === now ? [old] : []))
  return Array.from(new Set([name, now, ...olds]))
}

/** The input of a call recorded with old field names, under the current names. Fields already current pass through. */
export function lowerInput(tool: string, input: Record<string, unknown>): Record<string, unknown>
export function lowerInput(tool: string, input: unknown): unknown
export function lowerInput(tool: string, input: unknown): unknown {
  const table = fieldTable(tool)
  if (!table || typeof input !== "object" || input === null || Array.isArray(input)) return input
  const renames = new Map(Object.entries(table).map(([next, old]) => [old, next]))
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [renames.get(key) ?? key, value]))
}

/** The input of a current call under the old field names, for a reader written before the rename. */
export function raiseInput(tool: string, input: Record<string, unknown>): Record<string, unknown>
export function raiseInput(tool: string, input: unknown): unknown
export function raiseInput(tool: string, input: unknown): unknown {
  const table = fieldTable(tool)
  if (!table || typeof input !== "object" || input === null || Array.isArray(input)) return input
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [Object.hasOwn(table, key) ? table[key] : key, value]),
  )
}

/**
 * A view of a record keyed by tool name in which a key written with an old name reaches the entry of the current one,
 * so a plugin hook that deletes or reads `tools.write` still acts on `Write`. Keys the table does not list pass through.
 */
export function aliased<T extends object>(record: T): T {
  const key = (property: string | symbol) => (typeof property === "string" ? canonical(property) : property)
  return new Proxy(record, {
    get: (target, property) => Reflect.get(target, key(property)),
    set: (target, property, value) => Reflect.set(target, key(property), value),
    has: (target, property) => Reflect.has(target, key(property)),
    deleteProperty: (target, property) => Reflect.deleteProperty(target, key(property)),
    defineProperty: (target, property, descriptor) => Reflect.defineProperty(target, key(property), descriptor),
    getOwnPropertyDescriptor: (target, property) => Reflect.getOwnPropertyDescriptor(target, key(property)),
  })
}

function fieldTable(tool: string): Readonly<Record<string, string>> | undefined {
  const now = canonical(tool)
  return Object.hasOwn(fields, now) ? fields[now as keyof typeof fields] : undefined
}
