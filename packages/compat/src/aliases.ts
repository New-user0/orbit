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
 * A tool that an MCP server provides has one more. `<server>_<tool>` does not say where the server's name ends, since
 * either may hold an underscore, so the name comes from the connected MCP tools `mcpTools`: the one whose registry name
 * is `tool` gives the server and the tool, and a name that no MCP tool has gets no MCP name.
 */
export function toForeign(
  tool: string,
  mcpTools: readonly { readonly server: string; readonly name: string }[] = [],
): readonly string[] {
  const names = Object.entries(tools).flatMap(([foreign, orbit]) => (orbit.includes(tool) ? [foreign] : []))
  const owner = mcpTools.find((candidate) => Mcp.name(candidate.server, candidate.name) === tool)
  if (owner === undefined) return names
  // The registry name already has the tool's characters replaced, so only the separator after the server changes.
  const namespace = Mcp.namespace(owner.server)
  return [...names, `${mcpPrefix}${namespace}${mcpSeparator}${tool.slice(namespace.length + 1)}`]
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
 * another product read the project directory from. The directory is not always the session's: see
 * `CompatSettings.projectDirectory`, which names it for the document a hook comes from.
 */
export function hookEnv(directory: string): Readonly<Record<string, string>> {
  return { [CompatNames.vendor.projectDirVariable]: directory }
}
