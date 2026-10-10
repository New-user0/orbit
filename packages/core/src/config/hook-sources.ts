export * as HookSources from "./hook-sources.js"

import type { Document, Entry } from "@orbit/schema/config"
import type { ConfigManaged } from "@orbit/schema/config/managed"

/**
 * The documents whose hooks may run, given the organization's restrictions: none when `disable_hooks` is set, and only
 * the managed-scope documents when `managed_hooks_only` is set. The managed file's own `hooks.disabled` and
 * `hooks.managed_only` are the same two restrictions in another spelling, so they count here too. Every runner of
 * declarative hooks takes its documents from here, so a restriction cannot be missed by one of them.
 */
export function collect(
  entries: ReadonlyArray<Entry>,
  restrictions: Pick<ConfigManaged.Restrictions, "disable_hooks" | "managed_hooks_only">,
): Document[] {
  const documents = entries.filter((entry): entry is Document => entry.type === "document")
  const managed = documents.filter((entry) => entry.scope === "managed")
  if (restrictions.disable_hooks || managed.some((entry) => entry.info.hooks?.disabled)) return []
  const only = restrictions.managed_hooks_only || managed.some((entry) => entry.info.hooks?.managed_only)
  return documents.filter((entry) => entry.info.hooks !== undefined && (!only || entry.scope === "managed"))
}
