export * as CompatNames from "./names.js"

/**
 * Every name that belongs to another agent product, kept here so the rest of Orbit never spells one and the
 * compatibility switch has a single list to honor. Nothing below is read unless compatibility is enabled.
 */

/**
 * The reference vendor: the dot-directory that holds its skills, output styles and settings files, and the
 * instruction file it keeps beside the code. The key is neutral so callers outside this package need not name it.
 */
export const vendor = {
  directory: ".claude",
  settings: ["settings.json", "settings.local.json"],
  instructions: "CLAUDE.md",
} as const

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
