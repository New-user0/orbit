import type { TrustStatus, TrustWithheld } from "@orbit/client"
import { plain } from "@orbit/flow/plain"
import { shellArgument } from "@orbit/util/shell-argument"

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

/** The files of the folder itself whose executable config changed since the folder was trusted. */
export function changedOwn(status: TrustStatus) {
  const changed = new Set((status.changed ?? []).map((item) => item.path))
  return groupWithheld(status.withheld).own.filter((item) => changed.has(item.path))
}

/**
 * Whether the folder holds something of its own back, which is what the prompt and the indicator are for: it is
 * untrusted, or it is trusted and some of its config changed since. Config in a folder above it follows that folder's
 * own decision, so a folder whose only held-back config sits above it has nothing that trusting it would turn on.
 */
export function holdsBack(status: TrustStatus | undefined) {
  if (status === undefined) return false
  return status.trusted ? changedOwn(status).length > 0 : groupWithheld(status.withheld).own.length > 0
}

/**
 * What to do about the folders that hold what sits above the project, as they are typed: the command that trusts each
 * one through the location in view, which the grant would otherwise go to the wrong project for, and for a home
 * directory or a filesystem root, which can never be trusted for good, the way it is trusted for one run.
 */
export function trustCommands(items: readonly TrustWithheld[], location: string) {
  return [
    ...new Map(
      items.flatMap((item) => (item.directory === undefined ? [] : [[item.directory, item.persistent !== false] as const])),
    ),
  ]
    .map(([folder, persistent]) => {
      if (!persistent) return `${plain(folder)} (a home directory or filesystem root: \`--trust\` for one run)`
      const holder = shellArgument(folder)
      const through = shellArgument(location)
      // A name that no quoting makes safe to paste is shown escaped, with no command to run.
      if (holder === undefined || through === undefined)
        return `${plain(folder)} (its name is not printed as a command because a shell could act on it)`
      return `\`orb trust ${holder}${folder === location ? "" : ` --for ${through}`}\``
    })
    .join(", ")
}
