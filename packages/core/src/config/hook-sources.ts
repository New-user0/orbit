export * as HookSources from "./hook-sources.js"

import type { Document, Entry } from "@orbit/schema/config"
import type { ConfigManaged } from "@orbit/schema/config/managed"

/**
 * The documents whose hooks may run, given the organization's restrictions: none when `disable_hooks` is set, and only
 * the managed-scope documents when `managed_hooks_only` is set. Every runner of declarative hooks takes its documents
 * from here, so a restriction cannot be missed by one of them.
 */
export function collect(
  entries: ReadonlyArray<Entry>,
  restrictions: Pick<ConfigManaged.Restrictions, "disable_hooks" | "managed_hooks_only">,
): Document[] {
  if (restrictions.disable_hooks) return []
  return entries.filter(
    (entry): entry is Document =>
      entry.type === "document" &&
      entry.info.hooks !== undefined &&
      (!restrictions.managed_hooks_only || entry.scope === "managed"),
  )
}
