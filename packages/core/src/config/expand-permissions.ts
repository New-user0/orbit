export * as ConfigPermissionExpand from "./expand-permissions.js"

import path from "path"
import type { FileAccess } from "../file-access.js"
import type { Permission } from "../permission.js"
import type { ReadTool } from "../tool/plugin/read.js"
import type { EditTool } from "../tool/plugin/edit.js"
import { ToolNames } from "../tool/names.js"
import { Wildcard } from "../util/wildcard.js"

type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "Read", "Edit"] as const satisfies readonly PathAction[]

/** Config and managed rules share this, so `~` and `$HOME` mean the same folder in both. */
export function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.flatMap((rule) => {
    if (!matchesPathAction(rule.action)) return [rule]
    const expanded = { ...rule, resource: expandHome(rule.resource, home) }
    if (isPathAction(rule.action)) return [expanded]
    // A pattern such as `*`, `Read*` or (on Windows) `READ` also names Bash and the other tools, whose text stays as
    // written. Keep the rule and put an expanded copy beside it so the path actions are decided on the resolved path.
    return expanded.resource === rule.resource ? [rule] : [rule, expanded]
  })
}

function isPathAction(action: string) {
  return pathActions.some((item) => item === ToolNames.canonical(action))
}

// The same test the evaluator applies (`actionMatches` in permission.ts), without importing it back into the config.
function matchesPathAction(pattern: string) {
  return pathActions.some((item) => ToolNames.spellings(item).some((spelling) => Wildcard.match(spelling, pattern)))
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  // `~\` is home only on Windows, exactly where FSUtil.resolveFrom (which the tools resolve paths with) reads it so.
  const relative =
    resource.startsWith("~/") || (process.platform === "win32" && resource.startsWith("~\\"))
      ? resource.slice(2)
      : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
        ? resource.slice(6)
        : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}
