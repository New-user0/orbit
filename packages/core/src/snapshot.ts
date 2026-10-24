export * as Snapshot from "./snapshot.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { lstat } from "fs/promises"
import path from "path"
import { Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { FileDiff } from "@orbit/schema/file-diff"
import { FSUtil } from "@orbit/util/fs-util"
import { Git } from "./git.js"
import { ProjectTrust } from "./project-trust.js"
import { Global } from "@orbit/util/global"
import { Location } from "./location.js"
import { AbsolutePath, RelativePath } from "./schema.js"
import { ID } from "@orbit/schema/snapshot"
import { Hash } from "@orbit/util/hash"
import { State } from "./state.js"

export { ID }

export class Error extends Schema.TaggedError<Error>()("Snapshot.Error", {
  operation: Schema.Literals(["capture", "files", "diff", "restore"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface CompareInput {
  readonly from: ID
  readonly to: ID
}

export interface DiffInput extends CompareInput {
  readonly context?: number
  readonly paths?: readonly RelativePath[]
}

export interface RestoreInput {
  /** Paths are relative to the project root. */
  readonly files: ReadonlyMap<RelativePath, ID>
}

export type Editor = {
  configure: (enabled: boolean) => void
}

export interface Interface extends State.Transformable<Editor> {
  /**
   * Capture the current Location-scoped filesystem state as a content-addressed
   * tree. Returns `undefined` when snapshots are disabled, unsupported, or the
   * best-effort capture fails.
   */
  readonly capture: () => Effect.Effect<ID | undefined>

  /**
   * List project-relative paths changed between two captured trees without
   * loading file contents or generating patches.
   */
  readonly files: (input: CompareInput) => Effect.Effect<readonly RelativePath[], Error>

  /**
   * Generate structured per-file diffs between two captured trees. `context`
   * controls unchanged lines around each unified diff hunk.
   */
  readonly diff: (input: DiffInput) => Effect.Effect<readonly FileDiff.Info[], Error>

  /**
   * Restore selected project-relative paths from their associated trees. A path
   * absent from its selected tree is removed; paths outside the map are untouched.
   * A path whose folder no longer leads where its name says, that has a file where
   * one of its folders was, or that is now a link or a folder, is skipped and logged. A file that fails to go back is logged, the
   * others still go back, and the restore then fails.
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>

  /** The paths among `files` that `restore` would write or remove now, by the same per-path decision. */
  readonly restorable: (files: readonly RelativePath[]) => Effect.Effect<readonly RelativePath[], Error>

  /** The real work tree that the paths of `files`, `diff` and `restore` are relative to. */
  readonly root: () => Effect.Effect<AbsolutePath, Error>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Snapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const trust = yield* ProjectTrust.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const lifetime = yield* Scope.Scope
    const state = State.create<{ enabled: boolean }, Editor>({
      name: "snapshot",
      initial: () => ({ enabled: true }),
      editor: (editor) => ({
        configure: (enabled) => {
          editor.enabled = enabled
        },
      }),
    })
    // Cache a scope-owned fiber so caller cancellation stops waiting without poisoning shared initialization.
    const repositoryFiber = yield* Effect.cached(
      Effect.gen(function* () {
        const source = yield* git.repo.discover(location.project.directory)
        if (!source) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
        const worktree = AbsolutePath.make(yield* fs.realPath(source.worktree).pipe(Effect.orDie))
        const gitDirectory = AbsolutePath.make(
          path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)),
        )
        const snapshotRepository = (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
          ? new Git.Repository({ worktree, gitDirectory, commonDirectory: gitDirectory })
          : yield* git.repo
              .create({ worktree, gitDirectory, seed: source })
              .pipe(Effect.mapError((cause) => failure("capture", cause)))
        // A Location keeps the project ID it was bound with, and the ID of a folder with no remote changes when trust is
        // granted, so the snapshots taken after a grant and before a reload are filed under the old ID. Each repository
        // that Orbit keeps for this work tree, under any ID, is listed as an alternate, so that the next resolve still
        // compares and restores those snapshots. They are Orbit's own directories, so nothing the folder chose is opened.
        const root = path.join(global.data, "snapshot")
        const siblings = yield* fs.readDirectory(root).pipe(
          Effect.orElseSucceed(() => [] as string[]),
          Effect.map((names) => names.map((name) => path.join(root, name, Hash.fast(worktree)))),
          Effect.flatMap((items) =>
            Effect.filter(
              items.filter((item) => item !== gitDirectory),
              (item) => fs.existsSafe(path.join(item, "HEAD")),
            ),
          ),
        )
        const alternates = path.join(gitDirectory, "objects", "info", "alternates")
        const current = yield* fs.readFileString(alternates).pipe(Effect.orElseSucceed(() => ""))
        const lines = siblings
          .map((item) => path.join(item, "objects"))
          .filter((line) => !current.split("\n").includes(line))
        if (lines.length)
          yield* fs
            .ensureDir(path.dirname(alternates))
            .pipe(
              Effect.andThen(
                fs.writeFileString(
                  alternates,
                  current + (current && !current.endsWith("\n") ? "\n" : "") + lines.join("\n") + "\n",
                ),
              ),
              Effect.orDie,
            )
        return { source, worktree, snapshotRepository }
      }).pipe(Effect.forkIn(lifetime)),
    )
    const opened = repositoryFiber.pipe(Effect.uninterruptible, Effect.flatMap(Fiber.join))
    // Every git command a snapshot runs applies config that the clone chooses: the folder's own repository's, and that
    // of each nested repository git looks into while it walks the work tree, even from a git directory of Orbit's. That
    // config names programs (`core.fsmonitor`, hooks, attribute drivers) and files or shares to open (`include.path`,
    // alternates, a `.git` file naming a share). Narrower guards each left a spelling open, so no snapshot starts git at
    // all while the folder is not trusted, in the folder or in Orbit's own directory (class 1, class 6): its steps get no
    // snapshot, as in a folder without git, and comparing or restoring fails until it is trusted. Git follows what the
    // folder's `.git` names, so the repository it lands in has to be in a trusted folder as well (class 3).
    const repository = Effect.fnUntraced(function* (operation: Error["operation"]) {
      if (!(yield* trust.trusted())) return yield* new Error({ operation, message: "The folder is not trusted" })
      if (!(yield* trust.git(location.project.directory)))
        return yield* new Error({ operation, message: "The repository that git uses here is not in a trusted folder" })
      return yield* opened
    })
    // One log line for each Location says why its steps have no snapshot.
    const untrustedNotice = yield* Effect.cached(
      Effect.logInfo("no snapshot while the folder is not trusted: undo is unavailable for these steps"),
    )

    const scope = Effect.fnUntraced(function* (worktree: AbsolutePath) {
      const relative = path.relative(worktree, location.directory)
      if (relative.startsWith("..") || path.isAbsolute(relative))
        return yield* new Error({ operation: "capture", message: "Location is outside the project" })
      return RelativePath.make(relative.replaceAll("\\", "/") || ".")
    })

    const enabled = () => location.vcs?.type === "git" && state.get().enabled

    const capture = Effect.fn("Snapshot.capture")(function* () {
      if (!enabled()) return undefined
      if (!(yield* trust.trusted())) return yield* untrustedNotice.pipe(Effect.as(undefined))
      if (!(yield* trust.git(location.project.directory))) return undefined
      return yield* Effect.gen(function* () {
        const repo = yield* opened
        return ID.make(
          yield* git.tree.capture({
            repository: repo.snapshotRepository,
            scopes: [yield* scope(repo.worktree)],
            ignores: repo.source,
            maximumUntrackedFileBytes: 2 * 1024 * 1024,
          }),
        )
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("failed to capture snapshot", { cause }).pipe(Effect.as(undefined))),
      )
    })

    const comparison = Effect.fnUntraced(function* (operation: "files" | "diff", input: CompareInput) {
      const from = yield* treeID(operation, input.from)
      const to = yield* treeID(operation, input.to)
      const repo = yield* repository(operation).pipe(Effect.mapError((cause) => failure(operation, cause)))
      return { source: repo.source, repository: repo.snapshotRepository, from, to }
    })

    // Snapshots track every scoped file; the source repository's ignore rules decide what callers see.
    const ignored = Effect.fnUntraced(function* (
      operation: "files" | "diff",
      source: Git.Repository,
      paths: readonly RelativePath[],
    ) {
      return yield* git.index
        .ignored({ repository: source, paths })
        .pipe(Effect.mapError((cause) => failure(operation, cause)))
    })

    const files = Effect.fn("Snapshot.files")(function* (input: CompareInput) {
      const compared = yield* comparison("files", input)
      const changed = yield* git.tree
        .files({ repository: compared.repository, from: compared.from, to: compared.to })
        .pipe(Effect.mapError((cause) => failure("files", cause)))
      const skipped = yield* ignored("files", compared.source, changed)
      return changed.filter((file) => !skipped.has(file))
    })

    const diff = Effect.fn("Snapshot.diff")(function* (input: DiffInput) {
      if (input.paths?.length === 0) return []
      const compared = yield* comparison("diff", input)
      // Only an explicit selection becomes a pathspec; ignored paths are dropped from the result instead.
      const diffs = yield* git.tree
        .diff({
          repository: compared.repository,
          from: compared.from,
          to: compared.to,
          context: input.context,
          paths: input.paths,
        })
        .pipe(Effect.mapError((cause) => failure("diff", cause)))
      const skipped = yield* ignored(
        "diff",
        compared.source,
        diffs.map((file) => RelativePath.make(file.file)),
      )
      return diffs.filter((file) => !skipped.has(RelativePath.make(file.file)))
    })

    // Each path is decided where it would be written, at the moment of the restore (class 4). It must name a place inside
    // the work tree, and the folder that holds it must really be the folder its name says: a folder that became a link
    // after the checkpoint (a junction, a dangling link, or a link to a share, which `leads` names without opening it)
    // would carry the write or the deletion out of the project. The path itself must be neither a link nor a folder: git
    // writes a file there by removing what stands in its way, and on Windows it takes a junction for a folder and removes
    // the files it leads to; a folder would go with everything in it.
    const placed = Effect.fnUntraced(function* (worktree: AbsolutePath, file: RelativePath) {
      const absolute = path.join(worktree, file)
      if (absolute === worktree || !FSUtil.contains(worktree, absolute)) return false
      const parent = path.dirname(absolute)
      // A folder's real place cannot lie below its own name, so "inside" here means "the same folder", with case
      // compared as the system compares it.
      if (!FSUtil.contains(parent, yield* trust.leads(parent))) return false
      // Every folder on the way that exists must still be a folder: git makes a missing folder by removing a file that
      // stands at its name, and that file is the person's own.
      const folders = path
        .relative(worktree, parent)
        .split(path.sep)
        .filter(Boolean)
        .map((_, index, parts) => path.join(worktree, ...parts.slice(0, index + 1)))
      const found = yield* Effect.promise(() =>
        Promise.all([...folders, absolute].map((item) => lstat(item).catch(() => undefined))),
      )
      if (found.slice(0, -1).some((info) => info && !info.isDirectory())) return false
      const leaf = found.at(-1)
      return !leaf?.isSymbolicLink() && !leaf?.isDirectory()
    })

    // A path that may not be written is skipped with one log line, and the others still go back (class 7).
    const plan = Effect.fnUntraced(function* (worktree: AbsolutePath, input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const tree = yield* treeID("restore", snapshot)
        if (!(yield* placed(worktree, file))) {
          yield* Effect.logWarning("restore skipped a path that is not a plain file in its own folder of the project", {
            file,
          })
          continue
        }
        files.set(file, tree)
      }
      return files
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!enabled()) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository("restore").pipe(Effect.mapError((cause) => failure("restore", cause)))
      const files = yield* plan(repo.worktree, input)
      if (files.size === 0) return
      yield* git.tree
        .restore({ repository: repo.snapshotRepository, files })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    const restorable = Effect.fn("Snapshot.restorable")(function* (files: readonly RelativePath[]) {
      const repo = yield* repository("restore").pipe(Effect.mapError((cause) => failure("restore", cause)))
      return yield* Effect.filter(files, (file) => placed(repo.worktree, file))
    })

    const root = Effect.fn("Snapshot.root")(function* () {
      return (yield* repository("files").pipe(Effect.mapError((cause) => failure("files", cause)))).worktree
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      capture,
      files,
      diff,
      restore,
      restorable,
      root,
    })
  }).pipe(Effect.withSpan("Snapshot.boot")),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Git.node, Global.node, Location.node, ProjectTrust.node],
})

export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
    capture: () => Effect.undefined,
    files: () => Effect.succeed([]),
    diff: () => Effect.succeed([]),
    restore: () => Effect.void,
    restorable: () => Effect.succeed([]),
    root: () => Effect.fail(new Error({ operation: "files", message: "Snapshots are disabled" })),
  }),
)

/**
 * Whether a stored checkpoint ID is the ID of a git tree: 40 lowercase hex digits, or 64 in a SHA-256 repository. A
 * checkpoint ID comes from a session's stored steps, and an imported session's steps say whatever its file says (class
 * 5). Git reads an argument that starts with `-` as an option, and `--output=<file>` makes `git diff` write that file, so
 * every operation here refuses anything else before git starts, and an import drops it.
 */
export function isTree(value: string) {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)
}

function treeID(operation: Error["operation"], value: ID) {
  if (isTree(value)) return Effect.succeed(Git.TreeID.make(value))
  return Effect.fail(new Error({ operation, message: "The checkpoint is not a snapshot tree" }))
}

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}
