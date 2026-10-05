import type { TrustWithheld } from "@orbit/client"

/**
 * What trusting the project turns on, apart from what it does not. A file or directory in a folder above the project
 * names that folder as its `directory`, because each folder is trusted on its own: trusting the project lifts `own` and
 * leaves `above` held back.
 */
export function groupWithheld(items: readonly TrustWithheld[]) {
  return {
    own: items.filter((item) => item.directory === undefined),
    above: items.filter((item) => item.directory !== undefined),
  }
}

/** The commands that trust the folders that hold what sits above the project, as they are typed. */
export function trustCommands(items: readonly TrustWithheld[]) {
  return [...new Set(items.flatMap((item) => item.directory ?? []))]
    .map((folder) => `\`orb trust ${/\s/.test(folder) ? `"${folder}"` : folder}\``)
    .join(", ")
}
