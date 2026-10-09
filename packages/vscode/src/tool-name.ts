/**
 * The names the built-in tools had before they took the reference interface. Chats recorded earlier still carry them
 * and the views here are written against them, so a call is read under its old name whichever one it was recorded
 * with. The same table lives in `@orbit/schema/tool-names`, which this package does not depend on.
 */
const current = {
  Bash: "shell",
  TaskOutput: "shell_output",
  TaskWatch: "shell_watch",
  TaskStop: "shell_stop",
  Read: "read",
  Edit: "edit",
  Write: "write",
  Patch: "patch",
  Glob: "glob",
  Grep: "grep",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  AskUserQuestion: "question",
  TodoWrite: "todo",
  TaskCreate: "task_create",
  TaskUpdate: "task_update",
  TaskList: "task_list",
  Agent: "subagent",
  Skill: "skill",
  NotebookEdit: "notebook_edit",
  LSP: "lsp",
  EnterPlanMode: "enter_plan_mode",
  ExitPlanMode: "exit_plan_mode",
  EnterWorktree: "enter_worktree",
  ExitWorktree: "exit_worktree",
  Workflow: "workflow",
  Memory: "memory",
  Execute: "execute",
} as const satisfies Record<string, string>

export function legacyToolName(name: string): string {
  if (name === "PowerShell") return current.Bash
  return Object.hasOwn(current, name) ? current[name as keyof typeof current] : name
}

/** The fields a view reads for a value. A file tool reads its current field first, as the runner does. */
export const fieldNames = { path: ["path"], file: ["file_path", "notebook_path", "path"] } as const
