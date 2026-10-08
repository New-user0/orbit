export * as PluginLegacyNames from "./legacy-names.js"

import type { Context } from "@orbit/plugin/effect/plugin"
import { ToolNames } from "../tool/names.js"

/**
 * The host a code plugin sees when it was written against the old tool names: its `tool` and `permission` hooks are
 * told the old names (`shell`, `read`, `edit`, `write` and the rest) where the tools are now `Bash`, `Edit` and `Write`, so a guard such as
 * `event.tool === "shell"` keeps matching and blocking. A name the hook writes back is read as any spelling of the tool.
 * Built-in plugins and plugins that declare `toolNames: "reference"` get the host as it is.
 */
export function host(context: Context): Context {
  return {
    ...context,
    tool: {
      ...context.tool,
      hook: (name, callback) =>
        context.tool.hook(name, (event) => {
          // Another plugin, or the input repair, may have replaced `event.input` since the last view was made. Every hook
          // is given the view of the input as it stands when it runs, so a guard on an old field name never reads nothing.
          const record = event as Record<string, unknown>
          if ("input" in record) record.input = ToolNames.view(event.tool, record.input)
          return callback(named(event, "tool"))
        }),
    },
    permission: {
      ...context.permission,
      hook: (name, callback) => context.permission.hook(name, (event) => callback(named(event, "action"))),
    },
  }
}

// The facade reads the old spelling of one field and passes everything else, writes included, to the event, so
// the hook's changes reach the registry.
function named<Event extends object>(event: Event, field: "tool" | "action"): Event {
  const record = event as Record<string | symbol, unknown>
  return new Proxy(event, {
    get: (_, property) => {
      const value = record[property]
      return property === field && typeof value === "string" ? ToolNames.legacy(value) : value
    },
    set: (_, property, value) => {
      record[property] = property === field && typeof value === "string" ? ToolNames.canonical(value) : value
      return true
    },
  })
}
