export * as CompatNames from "./names.js"

/**
 * Every name that belongs to another agent product, kept here so the rest of Orbit never spells one and the
 * compatibility switch has a single list to honor. Nothing below is read unless compatibility is enabled.
 */

/**
 * The reference vendor: the dot-directory that holds its skills, output styles and settings files, the instruction
 * file it keeps beside the code, and the variable its hook commands read the project directory from. The key is
 * neutral so callers outside this package need not name it.
 */
export const vendor = {
  directory: ".claude",
  /** The settings file a team shares, and the one a person keeps to themselves. */
  settings: { shared: "settings.json", local: "settings.local.json" },
  instructions: "CLAUDE.md",
  /** The private variant of the instruction file, which is kept out of version control. */
  localInstructions: "CLAUDE.local.md",
  projectDirVariable: "CLAUDE_PROJECT_DIR",
  /** The folder inside the dot-directory that holds rule files, some of which name the files they are about. */
  rules: "rules",
} as const

/**
 * The tool names that hook matchers and permission rules of the reference vendor use, and the Orbit tools each one
 * stands for. The table is many to many: Orbit swaps its editing tools for `patch` on some models, so an editing name
 * must reach `patch` as well, and `patch` answers to every editing name. Where a tool answers to several names, such as
 * the subagent tool to `Agent` and its older name `Task`, the first one listed is the one a hook is told, unless the
 * hook's own matcher accepts only a later one.
 */
export const tools = {
  Bash: ["shell"],
  Read: ["read"],
  Edit: ["edit", "patch"],
  MultiEdit: ["edit", "patch"],
  Write: ["write", "patch"],
  NotebookEdit: ["notebook_edit"],
  Glob: ["glob"],
  Grep: ["grep"],
  WebFetch: ["webfetch"],
  WebSearch: ["websearch"],
  // `Task` is the name this tool had before `Agent`. Matchers and rules written then still name it, so it stays an alias,
  // but it comes second: a hook is told the current name.
  Agent: ["subagent"],
  Task: ["subagent"],
  TodoWrite: ["todo"],
} as const satisfies Record<string, readonly string[]>

/** The vendor-neutral directory that several agent products keep skills in. */
export const agents = ".agents"

/** The project file other agent products use to declare MCP servers. */
export const mcp = ".mcp.json"

/**
 * Rule and instruction files that other agent products keep. `/init` reads them for guidance worth preserving, but
 * Orbit never loads them as instructions of its own.
 */
export const foreign = {
  cursor: [".cursor/rules/", ".cursorrules"],
  copilot: [".github/copilot-instructions.md"],
} as const
