import type { TrustStatus, TrustWithheld } from "@orbit/client"

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

/**
 * Whether the folder is untrusted and so holds something of its own back, which is what the prompt and the indicator
 * are for. Config in a folder above it follows that folder's own decision, so a folder whose only held-back config
 * sits above it has nothing that trusting it would turn on.
 */
export function holdsBack(status: TrustStatus | undefined) {
  return status !== undefined && !status.trusted && groupWithheld(status.withheld).own.length > 0
}

/** The commands that trust the folders that hold what sits above the project, as they are typed. */
export function trustCommands(items: readonly TrustWithheld[]) {
  return [...new Set(items.flatMap((item) => item.directory ?? []))]
    .map((folder) => `\`orb trust ${/\s/.test(folder) ? `"${folder}"` : folder}\``)
    .join(", ")
}
