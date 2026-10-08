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

/**
 * For each view `view` handed out, the current field to the old name whose accessor it defined and the value the current
 * field had then, so a withdrawal is told apart from a later write of the current field.
 */
const views = new WeakMap<object, Map<string, { readonly old: string; readonly value: unknown }>>()

/**
 * What the shell tool is advertised as when the session shell is PowerShell. It is another spelling of the same action,
 * so a `Bash` or `shell` rule governs it and a `PowerShell` rule governs `Bash`, but it is not an old name: `canonical`
 * leaves it alone, so a call recorded as `PowerShell` is replayed as `PowerShell`.
 */
export const powershell = "PowerShell"

const family = (name: string) => (name === powershell ? tools.shell : canonical(name))

/** The current name of a tool, whichever spelling it is given in. Names the table does not list pass through. */
export function canonical(name: string): string {
  return Object.hasOwn(tools, name) ? tools[name as keyof typeof tools] : name
}

/** The name a tool had before the rename, or the name itself when it never had another. */
export function legacy(name: string): string {
  return Object.entries(tools).find(([, value]) => value === family(name))?.[0] ?? name
}

/**
 * Every spelling of a tool or permission action: the name given, its current name and each old name that maps to it.
 * A rule or matcher written with any one of them stands for the same tool, and for no other.
 */
export function spellings(name: string): readonly string[] {
  const now = family(name)
  if (!current.has(now)) return [name]
  const olds = Object.entries(tools).flatMap(([old, value]) => (value === now ? [old] : []))
  return Array.from(new Set([name, now, ...olds, ...(now === tools.shell ? [powershell] : [])]))
}

/** The input of a call recorded with old field names, under the current names. Fields already current pass through. */
export function lowerInput(tool: string, input: Record<string, unknown>): Record<string, unknown>
export function lowerInput(tool: string, input: unknown): unknown
export function lowerInput(tool: string, input: unknown): unknown {
  const table = fieldTable(tool)
  if (!table || typeof input !== "object" || input === null || Array.isArray(input)) return input
  const renames = new Map(Object.entries(table).map(([next, old]) => [old, next]))
  // A hook that deleted an old name from the view withdrew that field: its accessor is gone, but the current field is
  // still in the copy, so it goes too. A current field the hook wrote after the delete is a write and stays.
  const record = input as Record<string, unknown>
  const withdrawn = new Set(
    Array.from(views.get(input) ?? [], ([next, seen]) =>
      Object.hasOwn(input, seen.old) || !Object.is(record[next], seen.value) ? undefined : next,
    ),
  )
  return Object.fromEntries(
    Object.entries(input)
      .filter(([key]) => !withdrawn.has(key))
      .map(([key, value]) => [renames.get(key) ?? key, value]),
  )
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
export function aliased<T>(record: Record<string, T>): Record<string, T> {
  // An entry under the exact key wins: a plugin tool called `write` beside the built-in `Write` is a different entry.
  const key = (target: Record<string, T>, property: string | symbol) =>
    typeof property !== "string" || Object.hasOwn(target, property) ? property : canonical(property)
  return new Proxy(record, {
    get: (target, property) => target[key(target, property) as string],
    set: (target, property, value: T) => {
      target[key(target, property) as string] = value
      return true
    },
    has: (target, property) => key(target, property) in target,
    deleteProperty: (target, property) => delete target[key(target, property) as string],
    getOwnPropertyDescriptor: (target, property) => Object.getOwnPropertyDescriptor(target, key(target, property)),
  })
}

/**
 * The input of a current call as a plugin hook sees it: a plain copy with the current fields and the old field names as
 * non-enumerable accessors, so a guard keyed on `input.path` still reads and writes the path. The copy clones, spreads and
 * serializes like any object and carries the current names only. What a hook leaves in `event.input`, the copy or an object
 * of its own that uses an old field name, is read back with `lowerInput`. Inputs that are not plain objects, tools whose
 * fields did not change, and inputs that are already a view are returned as they are, so a withdrawal an earlier hook
 * recorded survives the next view.
 */
export function view(tool: string, input: unknown): unknown {
  const table = fieldTable(tool)
  if (!table || typeof input !== "object" || input === null || Array.isArray(input)) return input
  if (views.has(input)) return input
  const copy: Record<string, unknown> = { ...input }
  const defined = new Map<string, { readonly old: string; readonly value: unknown }>()
  views.set(copy, defined)
  Object.entries(table).forEach(([next, old]) => {
    if (Object.hasOwn(copy, old)) return
    defined.set(next, { old, value: copy[next] })
    Object.defineProperty(copy, old, {
      get: () => copy[next],
      set: (value: unknown) => {
        copy[next] = value
      },
      enumerable: false,
      configurable: true,
    })
  })
  return copy
}

function fieldTable(tool: string): Readonly<Record<string, string>> | undefined {
  const now = family(tool)
  return Object.hasOwn(fields, now) ? fields[now as keyof typeof fields] : undefined
}
