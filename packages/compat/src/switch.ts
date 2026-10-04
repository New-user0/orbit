export * as CompatSwitch from "./switch.js"

import type { Document, Entry, Scope } from "@orbit/schema/config"

// The scopes a person or organization controls. A repository's files, local overrides and well-known remote config
// rank below them or beside them, and none may decide whether Orbit reads other tools' files.
const authoritative: readonly Scope[] = ["user", "flag", "managed"]

/**
 * Whether Orbit reads other agent products' settings, skills, output styles and instruction files.
 *
 * Only `compatibility.enabled` in native documents of the user, flag and managed scopes counts, and the latest wins,
 * so a repository cannot switch compatibility back on after the user turned it off. An entry without a scope counts
 * as user, as everywhere else. `ORBIT_DISABLE_COMPAT=1` forces compatibility off whatever the documents say.
 *
 * Callers load the native user documents first and only then discover compatibility roots, so the switch never
 * depends on anything it controls.
 */
export function enabled(entries: readonly Entry[], env: Readonly<Record<string, string | undefined>>) {
  if (env.ORBIT_DISABLE_COMPAT === "1") return false
  const decided = entries.findLast(
    (entry): entry is Document =>
      entry.type === "document" &&
      authoritative.includes(entry.scope ?? "user") &&
      entry.info.compatibility?.enabled !== undefined,
  )
  return decided?.info.compatibility?.enabled ?? true
}
