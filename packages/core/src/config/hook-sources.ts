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
  const limits = limit(entries, restrictions)
  if (limits.disabled) return []
  return documents.filter(
    (entry) => entry.info.hooks !== undefined && (!limits.managed_only || entry.scope === "managed"),
  )
}

/**
 * The two restrictions on hooks, in either spelling: the organization's `disable_hooks` and `managed_hooks_only`, or the
 * managed file's own `hooks.disabled` and `hooks.managed_only`. `collect` and the effective-config answer both read them
 * here, so a client that runs something like a hook (the status line command) agrees with the runners.
 */
export function limit(
  entries: ReadonlyArray<Entry>,
  restrictions: Pick<ConfigManaged.Restrictions, "disable_hooks" | "managed_hooks_only">,
) {
  const managed = entries.filter(
    (entry): entry is Document => entry.type === "document" && entry.scope === "managed",
  )
  return {
    disabled: restrictions.disable_hooks === true || managed.some((entry) => entry.info.hooks?.disabled === true),
    managed_only:
      restrictions.managed_hooks_only === true || managed.some((entry) => entry.info.hooks?.managed_only === true),
  }
}
