export * as WorktreeGit from "./git.js"

import { Effect } from "effect"
import { Worktree } from "@orbit/schema/worktree"
import { FSUtil } from "@orbit/util/fs-util"
import { Git } from "../git.js"
import { GitAccess } from "../git/access.js"
import { GitLayout } from "../git/layout.js"
import { AbsolutePath } from "../schema.js"
import { WorkspaceTrust } from "../workspace-trust.js"
import { canonical, DirectoryUnavailableError } from "./directory.js"
import type { Strategy } from "./strategies.js"

export const make = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const git = yield* Git.Service
  const trust = yield* WorkspaceTrust.Service

  // Git applies the config of the repository it runs in, and a clone chooses that file: its hooks, `include.path` and
  // `core.worktree` run programs and open shares (class 1, class 6). So a folder that is not trusted starts no git,
  // whether it is listed, added to or removed from; its main checkout is told from the files. The decision is the main
  // checkout's for a linked worktree, as `Project.resolve` takes it. Git follows what the folder's `.git` names, so the
  // repository it uses there must be in trusted folders as well (`GitAccess`).
  const placed = Effect.fnUntraced(function* (directory: AbsolutePath) {
    const layout = yield* GitLayout.locate(fs, directory)
    if (!layout) return yield* new DirectoryUnavailableError({ directory })
    const access = yield* GitAccess.check(
      { fs, trust },
      { decision: layout.canonical, folders: [layout.worktree, layout.canonical], used: git.repo.used(directory, directory) },
    )
    if (access.refused) yield* GitAccess.log(directory, access.refused)
    return { layout, repository: access.repository }
  })

  return {
    id: Worktree.StrategyID.make("git"),
    create: Effect.fn("Worktree.Git.create")(function* (input) {
      const repository = (yield* placed(input.sourceDirectory)).repository
      if (!repository) return yield* new DirectoryUnavailableError({ directory: input.sourceDirectory })
      yield* git.worktree.create({ repository, directory: input.directory, ref: input.branch })
      return { directory: yield* canonical(fs, input.directory) }
    }),
    remove: Effect.fn("Worktree.Git.remove")(function* (input) {
      const repository = (yield* placed(input.directory)).repository
      if (!repository) return yield* new DirectoryUnavailableError({ directory: input.directory })
      yield* git.worktree.remove({ repository, directory: input.directory, force: input.force })
    }),
    list: Effect.fn("Worktree.Git.list")(function* (directory) {
      const found = yield* placed(directory)
      if (!found.repository) return [{ directory: found.layout.canonical, type: "root" }] satisfies Worktree.ListEntry[]
      const entries = yield* git.worktree.list(found.repository)
      return yield* Effect.forEach(entries, (entry) =>
        canonical(fs, entry.directory).pipe(
          Effect.map((directory) => ({ directory, type: entry.kind === "main" ? "root" : "worktree" }) as const),
          Effect.catchTag("Worktree.DirectoryUnavailableError", () => Effect.undefined),
        ),
      ).pipe(Effect.map((items) => items.filter((item): item is Worktree.ListEntry => item !== undefined)))
    }),
  } satisfies Strategy
})
