export * as GitAccess from "./access.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import type { Git } from "../git.js"
import type { WorkspaceTrust } from "../workspace-trust.js"

// Whether Orbit's own git may start in a folder that a person trusted.
//
// Git does not stay in the folder it starts in. It follows what the folder's `.git` names (a `gitdir:` pointer, a link,
// a `commondir`, the directory of a submodule inside the repository around it), and it passes over a `.git` directory
// that it does not take for a repository and looks in the folder above. Wherever it lands, it applies the config and the
// hooks of that directory, which can name programs for it to run (class 1). A trust decision covers one folder, so
// before Orbit runs a command that can start such a program, it asks git which directories it will use and starts
// nothing unless each of them is covered by a decision that is trusted (class 3). Orbit used to copy git's rules for
// finding a repository instead, and every copy missed a spelling, so the answer now comes from git: `rev-parse` reads
// the config of the repository it finds but starts no program that a config names (no file system monitor, filter, text
// conversion, hook or signing program).

/** Why git is not started; logged once by the caller. */
export interface Refusal {
  readonly reason: string
  /** The folder to trust for git to start, when one would do. */
  readonly folder?: string
}

/** The repository git uses, when every folder of it is trusted; otherwise why not, or neither while the decision is not trusted. */
export interface Answer {
  readonly repository?: Git.Repository
  readonly refused?: Refusal
}

/**
 * Whether git may work in the repository that `used` finds. `decision` is the folder whose trust covers `folders`, the
 * folders a caller names its project by. Nothing runs while that decision is not trusted. Then the work tree, the git
 * directory and the common directory that git reports must each lie in one of `folders`, or else in a folder that is
 * trusted in its own right: the nearest folder at or above it that holds `.git` or `.hg`, as `ProjectTrust.trustedAt`
 * finds an owner, or the directory itself. So the git directory of a linked worktree that its repository lists is
 * covered by the decision for the main checkout, and a submodule's git directory, which lives in the repository around
 * it, by that repository's own decision. Git that finds no repository there counts as a refusal too.
 */
export const check = Effect.fn("GitAccess.check")(function* (
  services: { readonly fs: FSUtil.Interface; readonly trust: WorkspaceTrust.Interface },
  input: {
    readonly decision: string
    readonly folders: readonly string[]
    readonly used: Effect.Effect<Git.Repository | undefined>
  },
): Effect.fn.Return<Answer> {
  if (!(yield* services.trust.status(input.decision)).trusted) return {}
  const found = yield* input.used
  if (!found) return { refused: { reason: "git names no repository in the trusted folder" } }
  const covered = yield* Effect.forEach(input.folders, (folder) =>
    services.fs.resolve(folder).pipe(Effect.map(FSUtil.normalizePath)),
  )
  for (const place of [found.worktree, found.gitDirectory, found.commonDirectory]) {
    if (covered.some((folder) => FSUtil.contains(folder, place))) continue
    const owner = yield* services.fs.up({ targets: [".git", ".hg"], start: place, mode: "first" }).pipe(
      Effect.map((matches) => (matches[0] === undefined ? place : path.dirname(matches[0]))),
      Effect.orElseSucceed(() => place),
    )
    if (!(yield* services.trust.status(owner)).trusted)
      return {
        refused: { reason: `the repository git uses keeps ${place} in a folder that is not trusted`, folder: owner },
      }
  }
  return { repository: found }
})

/** The one log line for a refusal. */
export const log = (directory: string, refusal: Refusal) =>
  Effect.logWarning("git not used for this folder", { directory, reason: refusal.reason, folder: refusal.folder })
