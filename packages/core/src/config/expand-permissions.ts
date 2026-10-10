export * as ConfigPermissionExpand from "./expand-permissions.js"

import path from "path"
import type { FileAccess } from "../file-access.js"
import type { Permission } from "../permission.js"
import type { ReadTool } from "../tool/plugin/read.js"
import type { EditTool } from "../tool/plugin/edit.js"
import { ToolNames } from "../tool/names.js"

type PathAction = FileAccess.ExternalDirectoryAuthorization["action"] | typeof ReadTool.name | typeof EditTool.name
const pathActions = ["external_directory", "Read", "Edit"] as const satisfies readonly PathAction[]

/** Config and managed rules share this, so `~` and `$HOME` mean the same folder in both. */
export function expandPermissions(rules: Permission.Ruleset, home: string): Permission.Ruleset {
  // Expand only resources tools resolve as filesystem paths. Bash resources are raw shell text:
  // rewriting `$HOME/private/**` would miss `$HOME/private/key`, and safe expansion needs shell-aware parsing.
  return rules.map((rule) =>
    isPathAction(rule.action) ? { ...rule, resource: expandHome(rule.resource, home) } : rule,
  )
}

function isPathAction(action: string) {
  return pathActions.some((item) => item === ToolNames.canonical(action))
}

function expandHome(resource: string, home: string) {
  if (resource === "~" || resource === "$HOME") return home
  const relative = resource.startsWith("~/")
    ? resource.slice(2)
    : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
      ? resource.slice(6)
      : undefined
  if (relative !== undefined) return (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative)
  return resource
}
