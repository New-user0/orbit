export * as CompatAliases from "./aliases.js"

import { Mcp } from "@orbit/schema/mcp"
import { CompatNames } from "./names.js"

/**
 * How other products name Orbit's tools. Hook matchers and permission rules written for them name a tool one way, and
 * Orbit's own tool may go by another, or by several: `patch` takes the place of `edit` and `write` on some models.
 *
 * Nothing here checks the compatibility switch. Callers that apply an alias ask the switch first.
 */

const tools: Readonly<Record<string, readonly string[]>> = CompatNames.tools
// An MCP tool is `mcp__<server>__<tool>` there, and `<server>_<tool>` here, where the registry names it.
const mcpPrefix = "mcp__"
const mcpSeparator = "__"

/**
 * The Orbit tools a tool name from another product stands for: several for an editing name, so a rule or matcher
 * reaches whichever editing tool the model has, and none for a name that is not an alias.
 */
export function toOrbit(foreign: string): readonly string[] {
  const mcp = mcpToOrbit(foreign)
  if (mcp !== undefined) return [mcp]
  return Object.hasOwn(tools, foreign) ? tools[foreign] : []
}

/**
 * The names other products give an Orbit tool, in the order the table lists them, so the first is the one to report.
 * An MCP tool can only be told from its name by the servers it could belong to, and `<server>_<tool>` is ambiguous
 * when one server's namespace begins with another's, so every server that fits yields a name.
 */
export function toForeign(tool: string, servers: readonly string[] = []): readonly string[] {
  return [
    ...Object.entries(tools).flatMap(([foreign, names]) => (names.includes(tool) ? [foreign] : [])),
    ...servers.flatMap((server) => {
      const namespace = Mcp.namespace(server)
      const rest = tool.slice(namespace.length + 1)
      return tool.startsWith(`${namespace}_`) && rest !== "" ? [`${mcpPrefix}${namespace}${mcpSeparator}${rest}`] : []
    }),
  ]
}

/**
 * The registry name of the MCP tool that `mcp__<server>__<tool>` names, or undefined when `foreign` is not that form.
 * The server ends at the first `__`, as it does for the product that writes these names, so a tool name may hold more.
 */
export function mcpToOrbit(foreign: string) {
  if (!foreign.startsWith(mcpPrefix)) return undefined
  const rest = foreign.slice(mcpPrefix.length)
  const split = rest.indexOf(mcpSeparator)
  if (split < 1 || split + mcpSeparator.length >= rest.length) return undefined
  return Mcp.name(rest.slice(0, split), rest.slice(split + mcpSeparator.length))
}

/**
 * The environment a hook's command gets besides Orbit's own `ORBIT_PROJECT_DIR`: the variable that hooks written for
 * another product read the project directory from.
 */
export function hookEnv(directory: string): Readonly<Record<string, string>> {
  return { [CompatNames.vendor.projectDirVariable]: directory }
}
