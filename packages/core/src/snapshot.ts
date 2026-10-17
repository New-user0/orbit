export * as Snapshot from "./snapshot.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import path from "path"
import { Context, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { FileDiff } from "@orbit/schema/file-diff"
import { FSUtil } from "@orbit/util/fs-util"
import { Git } from "./git.js"
import { GitLayout } from "./git/layout.js"
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
   */
  readonly restore: (input: RestoreInput) => Effect.Effect<void, Error>
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
    // Git applies the config of the repository it runs in, and a clone chooses that file: `include.path`, `core.worktree`
    // and `core.excludesFile` open files and shares that it names, and its objects can chain to more through
    // `objects/info/alternates` (class 1, class 6). So while the project is not trusted no git starts in the project's own
    // repository: its place is read from the files, the snapshot repository is not seeded from it (no alternates, no index),
    // and the ignore rules come from the snapshot repository, whose work tree is the folder and so reads its `.gitignore`
    // files. That repository is a separate one, so that what a trusted run seeded from the project's objects is not reached.
    // Cache a scope-owned fiber so caller cancellation stops waiting without poisoning shared initialization.
    const open = (trusted: boolean) =>
      Effect.cached(
        Effect.gen(function* () {
          const source = trusted ? yield* git.repo.discover(location.project.directory) : undefined
          const found = source ?? (trusted ? undefined : yield* GitLayout.locate(fs, location.project.directory))
          if (!found) return yield* new Error({ operation: "capture", message: "Project is not a Git repository" })
          const worktree = AbsolutePath.make(yield* fs.realPath(found.worktree).pipe(Effect.orDie))
          // Untrusted snapshots are keyed by the work tree alone, not by the project ID, which can change when trust is
          // granted, so a snapshot taken before trust is found after it.
          const untrustedDirectory = path.join(global.data, "snapshot", "untrusted", Hash.fast(worktree))
          const gitDirectory = AbsolutePath.make(
            trusted ? path.join(global.data, "snapshot", location.project.id, Hash.fast(worktree)) : untrustedDirectory,
          )
          const snapshotRepository = (yield* fs.existsSafe(path.join(gitDirectory, "HEAD")))
            ? new Git.Repository({ worktree, gitDirectory, commonDirectory: gitDirectory })
            : yield* git.repo
                .create({ worktree, gitDirectory, seed: source })
                .pipe(Effect.mapError((cause) => failure("capture", cause)))
          // Trees captured before trust live in the untrusted repository, which is Orbit's own. Listing its objects as an
          // alternate of the trusted one lets those snapshots be compared and restored once the folder is trusted; it
          // opens nothing that the folder chose.
          if (trusted && (yield* fs.existsSafe(path.join(untrustedDirectory, "HEAD")))) {
            const alternates = path.join(gitDirectory, "objects", "info", "alternates")
            const line = path.join(untrustedDirectory, "objects")
            const current = yield* fs.readFileString(alternates).pipe(Effect.orElseSucceed(() => ""))
            if (!current.split("\n").includes(line))
              yield* fs.ensureDir(path.dirname(alternates)).pipe(
                Effect.andThen(
                  fs.writeFileString(alternates, current + (current && !current.endsWith("\n") ? "\n" : "") + line + "\n"),
                ),
                Effect.orDie,
              )
          }
          return { source: source ?? snapshotRepository, worktree, snapshotRepository }
        }).pipe(Effect.forkIn(lifetime)),
      )
    const trustedFiber = yield* open(true)
    const untrustedFiber = yield* open(false)
    const repository = trust.trusted().pipe(
      Effect.flatMap((yes) => (yes ? trustedFiber : untrustedFiber)),
      Effect.uninterruptible,
      Effect.flatMap(Fiber.join),
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
      return yield* Effect.gen(function* () {
        const repo = yield* repository
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
      const repo = yield* repository.pipe(Effect.mapError((cause) => failure(operation, cause)))
      return {
        source: repo.source,
        repository: repo.snapshotRepository,
        from: Git.TreeID.make(input.from),
        to: Git.TreeID.make(input.to),
      }
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

    const plan = Effect.fnUntraced(function* (worktree: AbsolutePath, input: RestoreInput) {
      const files = new Map<RelativePath, Git.TreeID>()
      for (const [file, snapshot] of input.files) {
        const absolute = path.resolve(worktree, file)
        if (!FSUtil.contains(worktree, absolute))
          return yield* new Error({ operation: "restore", message: `Path escapes the project: ${file}` })
        files.set(file, Git.TreeID.make(snapshot))
      }
      return files
    })

    const restore = Effect.fn("Snapshot.restore")(function* (input: RestoreInput) {
      if (!enabled()) return yield* new Error({ operation: "restore", message: "Snapshots are disabled" })
      const repo = yield* repository.pipe(Effect.mapError((cause) => failure("restore", cause)))
      yield* git.tree
        .restore({ repository: repo.snapshotRepository, files: yield* plan(repo.worktree, input) })
        .pipe(Effect.mapError((cause) => failure("restore", cause)))
    })

    return Service.of({ transform: state.transform, reload: state.reload, capture, files, diff, restore })
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
  }),
)

function failure(operation: Error["operation"], cause: unknown) {
  if (cause instanceof Error && cause.operation === operation) return cause
  return new Error({
    operation,
    message: cause instanceof globalThis.Error ? cause.message : String(cause),
    cause,
  })
}
