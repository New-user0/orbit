export * as ConfigInstructionRules from "./instruction-rules.js"

import { LinkShare } from "@orbit/util/link-share"
import type { FSUtil } from "@orbit/util/fs-util"
import { Effect } from "effect"
import { join } from "path"
import { ConfigInstructionFile } from "./instruction-file.js"

/** The most rule files one scan lists. */
export const MAX_FILES = 256

/** A rule file the scan found: the path as the walk built it, and where it really is. */
export interface Found {
  readonly file: string
  readonly real: string
}

/**
 * The rule files under a `rules` folder, in the order they load: the entries of a folder by name (code units, so that the
 * order and the hash of what is loaded do not depend on the file system), a subfolder where it falls, depth first. A file is
 * a rule when its name ends in `.md` in lower case; dot names count. Links are followed, a folder is entered once under its
 * real path so that a loop ends, and each real file is listed once.
 *
 * Nothing the folder holds costs more than itself: a missing or unreadable folder, a dangling link, a pipe, a folder where
 * a file was expected, and anything `allow` refuses are skipped. A network path, or a link that leads to one, is never
 * opened (class 6). `allow` is asked of every real folder and of every file reached through a link, just before it is listed, and
 * is where a caller keeps a repository's link out of the project from supplying a file (class 4).
 */
export const scan = Effect.fn("ConfigInstructionRules.scan")(function* (input: {
  readonly directory: string
  readonly fs: Pick<FSUtil.Interface, "isDir" | "isFile" | "readDirectoryEntries">
  /** Where a path really leads, a link to a network share named as the share without being opened (`ProjectTrust.leads`). */
  readonly leads: (spelling: string) => Effect.Effect<string>
  /** `spelling` is the path as the walk built it, given for a file so that a caller can tell a link from the file itself. */
  readonly allow: (real: string, spelling?: string) => Effect.Effect<boolean>
  readonly platform?: NodeJS.Platform
  /** Fewer files than `MAX_FILES`, for a caller that spends one budget over several scans. */
  readonly max?: number
}) {
  const limit = Math.min(input.max ?? MAX_FILES, MAX_FILES)
  const nocase = (input.platform ?? process.platform) !== "linux"
  const key = (value: string) => (nocase ? value.toLowerCase() : value)
  const folders = new Set<string>()
  const files = new Set<string>()
  const found: Found[] = []
  let capped = false

  // A path that names a share or a device, or links that were never followed to their end, is not handed to the file system.
  const unreachable = (path: string) => /^[\\/]{2}/.test(path) || LinkShare.isUnresolved(path)

  const visit = (spelled: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (capped || unreachable(spelled)) return
      const real = yield* input.leads(spelled)
      if (unreachable(real) || folders.has(key(real))) return
      folders.add(key(real))
      if (!(yield* input.fs.isDir(real)) || !(yield* input.allow(real))) return
      const entries = yield* input.fs.readDirectoryEntries(real).pipe(Effect.orElseSucceed(() => []))
      for (const entry of entries.toSorted((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const child = join(spelled, entry.name)
        const target = entry.type === "symlink" ? yield* input.leads(child) : join(real, entry.name)
        if (unreachable(target)) continue
        const type =
          entry.type !== "symlink"
            ? entry.type
            : (yield* input.fs.isDir(target))
              ? "directory"
              : (yield* input.fs.isFile(target))
                ? "file"
                : "other"
        if (type === "directory") {
          yield* visit(child)
          continue
        }
        if (type !== "file" || !ConfigInstructionFile.isRuleName(entry.name) || files.has(key(target))) continue
        // A plain file in a folder that `allow` accepted is as acceptable as the folder: no link is in its path, so only a link
        // entry needs the check, and asking it of every file made a scan cost more the deeper the folder was.
        if (entry.type === "symlink" && !(yield* input.allow(target, child))) continue
        files.add(key(target))
        // A repository chooses how many rule files it holds, and a read walks them: the rest are not listed.
        if (found.length >= limit) {
          if (!capped) yield* Effect.logWarning("instruction rules skipped", { path: input.directory, reason: `more than ${limit} rule files` })
          capped = true
          return
        }
        found.push({ file: child, real: target })
      }
    })

  yield* visit(input.directory)
  return found as readonly Found[]
})
