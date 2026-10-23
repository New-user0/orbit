export * as Git from "./git.js"

import { lstat } from "fs/promises"
import path from "path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AbsolutePath, RelativePath } from "./schema.js"
import { FSUtil } from "@orbit/util/fs-util"
import { AppProcess } from "@orbit/util/process"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { FileDiff } from "@orbit/schema/file-diff"
import { GitSubmodules } from "@orbit/util/git-submodules"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { VcsPatch } from "./vcs/patch.js"
import { gitExecutable } from "./util/git-executable.js"

export class Repository extends Schema.Class<Repository>("Git.Repository")({
  worktree: AbsolutePath,
  gitDirectory: AbsolutePath,
  commonDirectory: AbsolutePath,
}) {}

// Included from $GIT_DIR/config via include.path (git >= 1.7.10); Orbit owns
// this file entirely, so updates are plain rewrites with no config parsing.
const snapshotConfigFile = "orbit.gitconfig"
const snapshotConfigInclude = `[include]
	path = ${snapshotConfigFile}
`
const snapshotConfig = `[core]
	autocrlf = false
	longpaths = true
	symlinks = true
	fsmonitor = false
	untrackedCache = true
[feature]
	manyFiles = true
[index]
	version = 4
	threads = true
`

export const TreeID = Schema.String.pipe(Schema.brand("Git.TreeID"))
export type TreeID = typeof TreeID.Type

export class OperationError extends Schema.TaggedError<OperationError>()("Git.OperationError", {
  operation: Schema.Literals([
    "clone",
    "fetch",
    "checkout",
    "reset",
    "create",
    "refresh",
    "write_tree",
    "list_files",
    "diff",
    "restore",
    "status",
  ]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  cause: Schema.optional(Schema.Defect()),
}) {}

export class Worktree extends Schema.Class<Worktree>("Git.Worktree")({
  directory: AbsolutePath,
  kind: Schema.Literals(["main", "linked"]),
}) {}

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("Git.WorktreeError", {
  operation: Schema.Literals(["create", "remove", "list"]),
  message: Schema.String,
  directory: Schema.optional(AbsolutePath),
  forceRequired: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly repo: {
    /**
     * The repository whose `.git` is in `input` itself. Git is kept from looking in any folder above `input`, so pass
     * the folder that a trust decision covers, never a folder below it.
     */
    readonly discover: (input: AbsolutePath) => Effect.Effect<Repository | undefined>
    /**
     * The repository that a git started in `directory` works in, as git itself finds it, looking no further up than
     * `top`: its work tree, its git directory and its common directory, each as a real path. None when git finds no
     * repository or no work tree there. It runs `rev-parse`, which reads the config it finds but starts no program that
     * a config names (`GitAccess`).
     */
    readonly used: (directory: AbsolutePath, top: AbsolutePath) => Effect.Effect<Repository | undefined>
    readonly clone: (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) => Effect.Effect<Repository, OperationError>
    readonly create: (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) => Effect.Effect<Repository, OperationError>
  }
  readonly remote: {
    readonly get: (repository: Repository, name?: string) => Effect.Effect<string | undefined>
  }
  readonly history: {
    readonly head: (repository: Repository) => Effect.Effect<string | undefined>
    readonly branch: (repository: Repository) => Effect.Effect<string | undefined>
    readonly defaultRemoteBranch: (repository: Repository, remote?: string) => Effect.Effect<string | undefined>
    readonly rootCommits: (repository: Repository) => Effect.Effect<readonly string[]>
    /**
     * The branch checked out in `directory`; undefined for a detached head. Like every command here that takes a
     * `directory`, git looks for the repository in it and in the folders above it up to `top` (`directory` when not
     * given), and never above: pass the folder that the trust decision covers.
     */
    readonly current: (directory: AbsolutePath, top?: AbsolutePath) => Effect.Effect<string | undefined>
    /**
     * The branch that pull requests usually target, read from the remote-tracking refs of `origin` only: its head, else
     * `main`, else `master`, else the name `main`. It never contacts the remote.
     */
    readonly mainBranch: (directory: AbsolutePath, top?: AbsolutePath) => Effect.Effect<string>
    /**
     * The newest `count` commits as `git log --oneline` prints them. Empty when there are none. It reaches config keys
     * (`gpg.program` when `log.showSignature` is set), so call it only behind `ProjectTrust.trusted()`.
     */
    readonly recent: (directory: AbsolutePath, count: number, top?: AbsolutePath) => Effect.Effect<readonly string[]>
    /** The `user.name` that git resolves in `directory`, undefined when none is set. */
    readonly userName: (directory: AbsolutePath, top?: AbsolutePath) => Effect.Effect<string | undefined>
  }
  readonly status: {
    /**
     * `git status --short` run in `directory`, so paths are relative to it. It reaches config keys (`core.fsmonitor`, clean
     * filters), so call it only behind `ProjectTrust.trusted()`. It takes no optional lock, and a result
     * longer than `maxBytes` is cut to whole lines. A failure to start git or a non-zero exit is an error: a failed
     * status must not read as a clean tree.
     */
    readonly short: (directory: AbsolutePath, maxBytes: number, top?: AbsolutePath) => Effect.Effect<string, OperationError>
  }
  readonly sync: {
    readonly fetchRemotes: (repository: Repository, input?: { prune?: boolean }) => Effect.Effect<void, OperationError>
    readonly fetchBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) => Effect.Effect<void, OperationError>
    readonly checkoutRemoteBranch: (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) => Effect.Effect<void, OperationError>
    readonly resetHard: (repository: Repository, revision: string) => Effect.Effect<void, OperationError>
  }
  readonly worktree: {
    readonly create: (input: {
      repository: Repository
      directory: AbsolutePath
      ref?: string
    }) => Effect.Effect<Repository, WorktreeError>
    readonly remove: (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) => Effect.Effect<void, WorktreeError>
    readonly list: (repository: Repository) => Effect.Effect<readonly Worktree[], WorktreeError>
  }
  readonly index: {
    /** Refresh only the requested project-relative scope, preserving all other entries. */
    readonly refresh: (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<{ readonly skipped: readonly RelativePath[] }, OperationError>
    /**
     * The paths git ignores. By default a tracked file that matches a pattern counts as ignored, which is what a
     * snapshot wants; `tracked: "keep"` leaves tracked files out of the answer, as `git status` does.
     */
    readonly ignored: (input: {
      repository: Repository
      paths: readonly RelativePath[]
      tracked?: "keep"
    }) => Effect.Effect<ReadonlySet<RelativePath>, OperationError>
  }
  readonly tree: {
    readonly capture: (input: {
      repository: Repository
      scopes: readonly RelativePath[]
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) => Effect.Effect<TreeID, OperationError>
    readonly write: (repository: Repository) => Effect.Effect<TreeID, OperationError>
    readonly files: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) => Effect.Effect<readonly RelativePath[], OperationError>
    readonly diff: (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) => Effect.Effect<readonly FileDiff.Info[], OperationError>
    readonly restore: (input: {
      repository: Repository
      files: ReadonlyMap<RelativePath, TreeID>
    }) => Effect.Effect<void, OperationError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@orbit/Git") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const proc = yield* AppProcess.Service
    const locks = KeyedMutex.makeUnsafe<string>()
    const locked = <A, E, R>(repository: Repository, effect: Effect.Effect<A, E, R>) =>
      locks.withLock(repository.gitDirectory)(effect)

    const discover = Effect.fn("Git.repo.discover")(function* (input: AbsolutePath) {
      if (!(yield* fs.existsSafe(path.join(input, ".git")))) return undefined

      const result = yield* run(input, proc, ["rev-parse", "--git-dir", "--git-common-dir", "--show-toplevel"], input)
      const [gitDir, commonDir, topLevel] = result.text.split(/\r?\n/)
      if (!gitDir || !commonDir) return undefined

      return new Repository({
        worktree: AbsolutePath.make(topLevel ? resolvePath(input, topLevel) : input),
        gitDirectory: AbsolutePath.make(resolvePath(input, gitDir)),
        commonDirectory: AbsolutePath.make(resolvePath(input, commonDir)),
      })
    })

    const used = Effect.fn("Git.repo.used")(function* (directory: AbsolutePath, top: AbsolutePath) {
      const result = yield* run(
        directory,
        proc,
        ["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"],
        top,
      )
      // One path a line, in the order asked. A path with a line break in it gives more lines, and is not taken apart.
      const lines = result.text.replace(/\n$/, "").split("\n")
      if (result.exitCode !== 0 || lines.length !== 3) return undefined
      const real = yield* Effect.forEach(lines, (line) =>
        fs.realPath(FSUtil.windowsPath(process.platform === "win32" ? line.replace(/\r$/, "") : line)).pipe(
          Effect.map((found) => AbsolutePath.make(FSUtil.normalizePath(found))),
          Effect.orElseSucceed(() => undefined),
        ),
      )
      const [worktree, gitDirectory, commonDirectory] = real
      if (!worktree || !gitDirectory || !commonDirectory) return undefined
      return new Repository({ worktree, gitDirectory, commonDirectory })
    })

    const remote = Effect.fn("Git.remote.get")(function* (repository: Repository, name = "origin") {
      const result = yield* run(repository.worktree, proc, ["remote", "get-url", name])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const roots = Effect.fn("Git.history.rootCommits")(function* (repository: Repository) {
      const result = yield* run(repository.worktree, proc, ["rev-list", "--max-parents=0", "HEAD"])
      if (result.exitCode !== 0) return []
      return result.text
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean)
        .toSorted()
    })

    const head = Effect.fn("Git.history.head")(function* (repository: Repository) {
      const result = yield* run(repository.worktree, proc, ["rev-parse", "HEAD"])
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const currentBranch = Effect.fn("Git.history.current")(function* (directory: string, top = directory) {
      const result = yield* run(directory, proc, ["symbolic-ref", "--quiet", "--short", "HEAD"], top)
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const branch = Effect.fn("Git.history.branch")((repository: Repository) => currentBranch(repository.worktree))

    const headOf = Effect.fnUntraced(function* (directory: string, remoteName: string, top = directory) {
      const result = yield* run(directory, proc, ["symbolic-ref", `refs/remotes/${remoteName}/HEAD`], top)
      if (result.exitCode !== 0) return undefined
      return result.text.trim().replace(new RegExp(`^refs/remotes/${remoteName}/`), "") || undefined
    })

    const remoteHead = Effect.fn("Git.history.defaultRemoteBranch")(function* (
      repository: Repository,
      remoteName = "origin",
    ) {
      return yield* headOf(repository.worktree, remoteName)
    })

    const mainBranch = Effect.fn("Git.history.mainBranch")(function* (directory: AbsolutePath, top = directory) {
      const head = yield* headOf(directory, "origin", top)
      if (head) return head
      for (const name of ["main", "master"]) {
        const result = yield* run(directory, proc, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${name}`], top)
        if (result.exitCode === 0) return name
      }
      return "main"
    })

    const recent = Effect.fn("Git.history.recent")(function* (directory: AbsolutePath, count: number, top = directory) {
      const env = ceiling(top)
      if (!env) return []
      const result = yield* proc
        .run(
          ChildProcess.make(
            gitExecutable,
            GitSubmodules.skip(["--no-optional-locks", "log", "--oneline", "-n", String(count)]),
            {
              cwd: directory,
              env,
              extendEnv: true,
              stdin: "ignore",
            },
          ),
          { maxOutputBytes: SNAPSHOT_OUTPUT_BYTES },
        )
        .pipe(Effect.orElseSucceed(() => undefined))
      // A repository with no commits yet exits non-zero; it has nothing to list.
      if (!result || result.exitCode !== 0) return []
      return wholeLines(result.stdout.toString("utf8"), result.stdoutTruncated)
    })

    const userName = Effect.fn("Git.history.userName")(function* (directory: AbsolutePath, top = directory) {
      const result = yield* run(directory, proc, ["config", "user.name"], top)
      if (result.exitCode !== 0) return undefined
      return result.text.trim() || undefined
    })

    const shortStatus = Effect.fn("Git.status.short")(function* (
      directory: AbsolutePath,
      maxBytes: number,
      top = directory,
    ) {
      const failed = (message: string, cause?: unknown) =>
        new OperationError({ operation: "status", directory, message, cause })
      const env = ceiling(top)
      if (!env) return yield* failed(unbounded)
      const result = yield* proc
        .run(
          ChildProcess.make(gitExecutable, GitSubmodules.skip(["--no-optional-locks", "status", "--short"]), {
            cwd: directory,
            env,
            extendEnv: true,
            stdin: "ignore",
          }),
          { maxOutputBytes: maxBytes },
        )
        .pipe(Effect.mapError((cause) => failed(cause.message, cause)))
      if (result.exitCode !== 0) return yield* failed(result.stderr.toString("utf8").trim() || "Git status failed")
      return wholeLines(result.stdout.toString("utf8"), result.stdoutTruncated).join("\n")
    })

    const operation = Effect.fnUntraced(function* (
      operation: OperationError["operation"],
      directory: AbsolutePath,
      args: string[],
    ) {
      const result = yield* execute(directory, proc, args).pipe(
        Effect.mapError((cause) => new OperationError({ operation, directory, message: cause.message, cause })),
      )
      if (result.exitCode === 0) return
      return yield* new OperationError({
        operation,
        directory,
        message: result.stderr.trim() || result.text.trim() || `Git ${operation} failed`,
      })
    })

    const clone = Effect.fn("Git.repo.clone")(function* (input: {
      remote: string
      directory: AbsolutePath
      branch?: string
      depth?: number
    }) {
      yield* operation("clone", AbsolutePath.make(path.dirname(input.directory)), [
        "clone",
        "--depth",
        String(input.depth ?? 100),
        ...(input.branch ? ["--branch", input.branch] : []),
        "--",
        input.remote,
        input.directory,
      ])
      const repository = yield* discover(input.directory)
      if (repository) return repository
      return yield* new OperationError({
        operation: "clone",
        directory: input.directory,
        message: "Cloned repository could not be opened",
      })
    })

    const fetch = Effect.fn("Git.sync.fetchRemotes")(function* (
      repository: Repository,
      input: { prune?: boolean } = {},
    ) {
      yield* operation("fetch", repository.worktree, ["fetch", "--all", ...(input.prune === false ? [] : ["--prune"])])
    })

    const fetchBranch = Effect.fn("Git.sync.fetchBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; force?: boolean },
    ) {
      const remoteName = input.remote ?? "origin"
      const spec = `refs/heads/${input.branch}:refs/remotes/${remoteName}/${input.branch}`
      yield* operation("fetch", repository.worktree, ["fetch", remoteName, input.force === false ? spec : `+${spec}`])
    })

    const checkout = Effect.fn("Git.sync.checkoutRemoteBranch")(function* (
      repository: Repository,
      input: { remote?: string; branch: string; reset?: boolean },
    ) {
      const remoteName = input.remote ?? "origin"
      yield* operation("checkout", repository.worktree, [
        "checkout",
        ...(input.reset === false ? [input.branch] : ["-B", input.branch, `${remoteName}/${input.branch}`]),
      ])
    })

    const reset = Effect.fn("Git.sync.resetHard")(function* (repository: Repository, revision: string) {
      yield* operation("reset", repository.worktree, ["reset", "--hard", revision])
    })

    const repositoryArgs = (repository: Repository, args: string[]) =>
      GitSubmodules.skip(["--git-dir", repository.gitDirectory, "--work-tree", repository.worktree, ...args])

    const repositoryOperation = Effect.fnUntraced(function* (
      operationName: OperationError["operation"],
      repository: Repository,
      args: string[],
      options?: { stdin?: string; env?: Record<string, string>; maxOutputBytes?: number },
    ) {
      const result = yield* proc
        .run(
          ChildProcess.make(gitExecutable, repositoryArgs(repository, args), {
            cwd: repository.worktree,
            env: options?.env,
            extendEnv: true,
          }),
          { stdin: options?.stdin, maxOutputBytes: options?.maxOutputBytes },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: operationName,
                directory: repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      const text = result.stdout.toString("utf8")
      if (result.exitCode === 0)
        return { text, stderr: result.stderr.toString("utf8"), truncated: result.stdoutTruncated }
      return yield* new OperationError({
        operation: operationName,
        directory: repository.worktree,
        message: result.stderr.toString("utf8").trim() || text.trim() || `Git ${operationName} failed`,
      })
    })

    const create = Effect.fn("Git.repo.create")(function* (input: {
      worktree: AbsolutePath
      gitDirectory: AbsolutePath
      seed?: Repository
    }) {
      const operationError = (message: string) => (cause: unknown) =>
        new OperationError({ operation: "create", directory: input.gitDirectory, message, cause })
      yield* fs.ensureDir(input.gitDirectory).pipe(Effect.mapError(operationError("Failed to create Git storage")))
      const repository = new Repository({
        worktree: input.worktree,
        gitDirectory: input.gitDirectory,
        commonDirectory: input.gitDirectory,
      })
      yield* repositoryOperation("create", repository, ["init"])
      yield* Effect.gen(function* () {
        yield* fs.writeFileString(path.join(input.gitDirectory, snapshotConfigFile), snapshotConfig)
        const config = path.join(input.gitDirectory, "config")
        const current = yield* fs.readFileString(config)
        if (current.includes(snapshotConfigInclude)) return
        yield* fs.writeFileString(config, `${current.endsWith("\n") ? "\n" : "\n\n"}${snapshotConfigInclude}`, {
          flag: "a",
        })
      }).pipe(Effect.mapError(operationError("Failed to configure Git storage")))
      if (!input.seed) return repository
      yield* fs
        .ensureDir(path.join(input.gitDirectory, "objects", "info"))
        .pipe(Effect.mapError(operationError("Failed to configure shared Git objects")))
      yield* fs
        .writeFileString(
          path.join(input.gitDirectory, "objects", "info", "alternates"),
          path.join(input.seed.commonDirectory, "objects") + "\n",
        )
        .pipe(Effect.mapError(operationError("Failed to configure shared Git objects")))
      // The folder's index spares the first capture from reading every tracked file again. Git takes an entry whose size
      // and time match the file as unchanged only when the entry is older than the index file. A copy can be newer than
      // every entry (on Linux it is), so a file rewritten to the same size within the second the folder's index was
      // written would be recorded with its committed text. The copy is given the time of the index it came from, cut to the whole
      // second, so git still reads such a file. That time is read before the copy, so that a later write to the folder's
      // index can only make the copy look older. Without the time, there is no copy: the first capture reads every file.
      const seedIndex = path.join(input.seed.gitDirectory, "index")
      const index = path.join(input.gitDirectory, "index")
      yield* Effect.gen(function* () {
        const written = Option.getOrUndefined((yield* fs.stat(seedIndex)).mtime)
        if (written === undefined) return
        yield* fs.copyFile(seedIndex, index)
        const second = new Date(Math.floor(written.getTime() / 1000) * 1000)
        yield* fs.utimes(index, second, second)
      }).pipe(
        Effect.catch(() => fs.remove(index, { force: true })),
        Effect.ignore,
      )
      return repository
    })

    // Every snapshot command that takes paths (in the refresh, the comparison and the restore) reads them as names: each
    // passes `--literal-pathspecs`, except `check-ignore`, which refuses it and is handed each path behind `./` instead
    // (see `ignored`). Git reads a path as a pattern by default, so a file named `[s]ub`, `*`, `:memo` or `:!x` would also
    // stand for every path the pattern matches, or for none: restoring that one file would overwrite them or delete it,
    // leaving it out of a capture would drop them from the index, adding it would add them, and git would walk folders
    // that nobody listed.
    const refresh = Effect.fn("Git.index.refresh")(function* (input: {
      repository: Repository
      scope: RelativePath
      ignores?: Repository
      maximumUntrackedFileBytes?: number
    }) {
      const list = (args: string[]) =>
        repositoryOperation("refresh", input.repository, args).pipe(Effect.map((result) => nuls(result.text)))
      const [tracked, untracked] = yield* Effect.all(
        [
          list(["--literal-pathspecs", "diff-files", "--name-only", "-z", "--", input.scope]),
          list(["--literal-pathspecs", "ls-files", "--others", "--exclude-standard", "-z", "--", input.scope]),
        ],
        { concurrency: 2 },
      )
      // A tracked file whose folder became a link since the last capture is no longer in the work tree, and git refuses
      // to check or add a path beyond a link, which would fail the whole capture: it leaves the index instead.
      const linked = yield* linkedPaths(input.repository.worktree, tracked)
      const candidates = Array.from(new Set([...tracked, ...untracked]))
        .filter((file) => !linked.has(file))
        .map((file) => RelativePath.make(file))
      if (!candidates.length && !linked.size) return { skipped: [] }
      const excluded = input.ignores
        ? yield* ignored({ repository: input.ignores, paths: candidates })
        : new Set<RelativePath>()
      const allowed = candidates.filter((item) => !excluded.has(item))
      const maximum = input.maximumUntrackedFileBytes
      const skipped = maximum
        ? (yield* Effect.forEach(
            untracked.filter((item) => allowed.includes(RelativePath.make(item))),
            (item) =>
              fs.stat(path.join(input.repository.worktree, item)).pipe(
                Effect.map((info) =>
                  info.type === "File" && Number(info.size) > maximum ? RelativePath.make(item) : undefined,
                ),
                Effect.orElseSucceed(() => undefined),
              ),
            { concurrency: 8 },
          )).filter((item): item is RelativePath => item !== undefined)
        : []
      const stage = allowed.filter((item) => !skipped.includes(item))
      const remove = [...excluded, ...skipped, ...linked]
      if (remove.length)
        yield* repositoryOperation(
          "refresh",
          input.repository,
          [
            "--literal-pathspecs",
            "rm",
            "--cached",
            "-f",
            "--ignore-unmatch",
            "--pathspec-from-file=-",
            "--pathspec-file-nul",
          ],
          { stdin: remove.join("\0") + "\0" },
        )
      if (stage.length)
        yield* repositoryOperation(
          "refresh",
          input.repository,
          ["--literal-pathspecs", "add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
          { stdin: stage.join("\0") + "\0" },
        )
      return { skipped }
    })

    const ignored = Effect.fn("Git.index.ignored")(function* (input: {
      repository: Repository
      paths: readonly RelativePath[]
      tracked?: "keep"
    }) {
      // Git refuses to answer for a path beyond a link (a tracked folder that became one after a capture), and the
      // refusal would fail every capture and comparison that asks: such a path is answered as not ignored.
      const linked = yield* linkedPaths(input.repository.worktree, input.paths)
      const paths = input.paths.filter((file) => !linked.has(file))
      if (!paths.length) return new Set<RelativePath>()
      const result = yield* proc
        .run(
          ChildProcess.make(
            gitExecutable,
            repositoryArgs(input.repository, [
              // The config of the repository is the folder's own, and `core.fsmonitor` in it names a program that git runs
              // whenever it reads the index. Asking whether a path is ignored needs no such program.
              "-c",
              "core.fsmonitor=false",
              "check-ignore",
              ...(input.tracked === "keep" ? [] : ["--no-index"]),
              "--stdin",
              "-z",
            ]),
            {
              cwd: input.repository.worktree,
              extendEnv: true,
            },
          ),
          // `check-ignore` refuses `--literal-pathspecs`, and reads a leading `:` as pathspec magic: `:memo` would answer
          // for `memo`, and `:!x` or `:(icase)x` would stop the command and with it the capture or comparison that asked.
          // Behind `./` the name keeps its colon, and it is given back with the same `./` in front.
          { stdin: paths.map((file) => `./${file}\0`).join("") },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OperationError({
                operation: "list_files",
                directory: input.repository.worktree,
                message: cause.message,
                cause,
              }),
          ),
        )
      if (result.exitCode !== 0 && result.exitCode !== 1)
        return yield* new OperationError({
          operation: "list_files",
          directory: input.repository.worktree,
          message: result.stderr.toString("utf8").trim() || "Failed to check ignored paths",
        })
      return new Set(
        nuls(result.stdout.toString("utf8")).map((file) => RelativePath.make(file.startsWith("./") ? file.slice(2) : file)),
      )
    })

    const writeTree = Effect.fn("Git.tree.write")(function* (repository: Repository) {
      return TreeID.make((yield* repositoryOperation("write_tree", repository, ["write-tree"])).text.trim())
    })

    const captureTree = Effect.fn("Git.tree.capture")(
      (input: {
        repository: Repository
        scopes: readonly RelativePath[]
        ignores?: Repository
        maximumUntrackedFileBytes?: number
      }) =>
        locked(
          input.repository,
          Effect.gen(function* () {
            yield* Effect.forEach(input.scopes, (scope) => refresh({ ...input, scope }), { discard: true })
            return yield* writeTree(input.repository)
          }),
        ),
    )

    const treeFiles = Effect.fn("Git.tree.files")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
    }) {
      // Undo needs both paths of a rename, not only its destination.
      return nuls(
        (yield* repositoryOperation("list_files", input.repository, [
          "diff",
          "--name-only",
          "--no-renames",
          "-z",
          input.from,
          input.to,
        ])).text,
      ).map((file) => RelativePath.make(file))
    })

    /**
     * Three batched invocations over the tree pair instead of three per file. An
     * explicit empty selection diffs nothing; an absent one diffs every changed path.
     * Patch output is capped like VCS diffs: files past the cap get an empty patch.
     */
    const treeDiff = Effect.fn("Git.tree.diff")(function* (input: {
      repository: Repository
      from: TreeID
      to: TreeID
      context?: number
      paths?: readonly RelativePath[]
    }) {
      if (input.paths?.length === 0) return []
      const args = ["--no-renames", input.from, input.to, "--", ...(input.paths ?? [])]
      // Patch headers have no -z form: unquoted paths keep chunksByFile matching non-ASCII names.
      const [names, numbers, patch] = yield* Effect.all(
        [
          repositoryOperation("diff", input.repository, [
            "--literal-pathspecs",
            "diff",
            "--name-status",
            "-z",
            ...args,
          ]),
          repositoryOperation("diff", input.repository, ["--literal-pathspecs", "diff", "--numstat", "-z", ...args]),
          repositoryOperation(
            "diff",
            input.repository,
            [
              "--literal-pathspecs",
              "-c",
              "core.quotepath=false",
              "diff",
              "--no-ext-diff",
              `--unified=${input.context ?? 3}`,
              ...args,
            ],
            { maxOutputBytes: VcsPatch.MAX_TOTAL_PATCH_BYTES },
          ),
        ],
        { concurrency: 3 },
      )
      const statuses = nuls(names.text)
      const files = statuses.flatMap((code, index) => {
        const file = statuses[index + 1]
        if (index % 2 !== 0 || !file) return []
        return [
          {
            file: RelativePath.make(file),
            status: code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified",
          } as const,
        ]
      })
      const stats = new Map(
        nuls(numbers.text).flatMap((line) => {
          const [additions, deletions, ...file] = line.split("\t")
          if (!additions || !deletions || file.length === 0) return []
          return [
            [
              file.join("\t"),
              additions === "-" || deletions === "-"
                ? { binary: true, additions: 0, deletions: 0 }
                : { binary: false, additions: Number(additions), deletions: Number(deletions) },
            ] as const,
          ]
        }),
      )
      const patches = VcsPatch.chunksByFile(patch, (index) => files[index]?.file)
      return files.map((entry) => {
        const stat = stats.get(entry.file)
        return {
          ...entry,
          additions: stat?.additions ?? 0,
          deletions: stat?.deletions ?? 0,
          patch: stat?.binary ? "" : (patches.get(entry.file) ?? VcsPatch.emptyPatch(entry.file)),
        } satisfies FileDiff.Info
      })
    })

    const hasEntry = Effect.fnUntraced(function* (repository: Repository, tree: TreeID, file: RelativePath) {
      const text = (yield* repositoryOperation("restore", repository, [
        "--literal-pathspecs",
        "ls-tree",
        "-z",
        tree,
        "--",
        file,
      ])).text.replace(/\0$/, "")
      if (!text) return false
      if (!/^\d+\s+\w+\s+[0-9a-f]+\t/.test(text))
        return yield* new OperationError({
          operation: "restore",
          directory: repository.worktree,
          message: `Invalid tree entry for ${file}`,
        })
      return true
    })

    const restore = Effect.fn("Git.tree.restore")(
      (input: { repository: Repository; files: ReadonlyMap<RelativePath, TreeID> }) =>
        locked(
          input.repository,
          Effect.forEach(
            input.files,
            ([file, tree]) =>
              Effect.gen(function* () {
                if (yield* hasEntry(input.repository, tree, file)) {
                  yield* repositoryOperation("restore", input.repository, [
                    "--literal-pathspecs",
                    "checkout",
                    "--no-recurse-submodules",
                    tree,
                    "--",
                    file,
                  ])
                  return
                }
                // The tree has no file here: only a file or a link is removed, never a folder with what it holds.
                const absolute = path.join(input.repository.worktree, file)
                const found = yield* Effect.promise(() => lstat(absolute).catch(() => undefined))
                if (found?.isDirectory()) {
                  yield* Effect.logWarning("restore left a folder where the snapshot has no file", { file })
                  return
                }
                yield* fs.remove(absolute, { force: true }).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OperationError({
                        operation: "restore",
                        directory: input.repository.worktree,
                        message: `Failed to remove ${file}`,
                        cause,
                      }),
                  ),
                )
              }),
            { discard: true },
          ),
        ),
    )

    const worktreeRun = Effect.fnUntraced(function* (
      operation: "create" | "remove" | "list",
      repository: Repository,
      args: string[],
      worktreeDirectory?: AbsolutePath,
      cwd = repository.worktree,
    ) {
      const result = yield* proc
        .run(ChildProcess.make(gitExecutable, GitSubmodules.skip(args), { cwd, extendEnv: true, stdin: "ignore" }))
        .pipe(
          Effect.mapError(
            (cause) => new WorktreeError({ operation, directory: worktreeDirectory, message: cause.message, cause }),
          ),
        )
      if (result.exitCode === 0) return result.stdout.toString("utf8")
      const message = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim() || "Git failed"
      return yield* new WorktreeError({
        operation,
        directory: worktreeDirectory,
        message,
        forceRequired: operation === "remove" && /contains modified or untracked files|is dirty/i.test(message),
      })
    })

    const worktreeCreate = Effect.fn("Git.worktree.create")(function* (input: {
      repository: Repository
      directory: AbsolutePath
      ref?: string
    }) {
      yield* worktreeRun(
        "create",
        input.repository,
        ["worktree", "add", "--detach", "--", input.directory, input.ref ?? "HEAD"],
        input.directory,
      )
      const repository = yield* discover(input.directory)
      if (repository) return repository
      return yield* new WorktreeError({
        operation: "create",
        directory: input.directory,
        message: "Created worktree could not be opened",
      })
    })

    const worktreeRemove = Effect.fn("Git.worktree.remove")(function* (input: {
      repository: Repository
      directory: AbsolutePath
      force: boolean
    }) {
      yield* worktreeRun(
        "remove",
        input.repository,
        ["worktree", "remove", ...(input.force ? ["--force"] : []), input.directory],
        input.directory,
        input.repository.commonDirectory,
      )
    })

    const worktreeList = Effect.fn("Git.worktree.list")(function* (repository: Repository) {
      return (yield* worktreeRun("list", repository, ["worktree", "list", "--porcelain"]))
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map(
          (line, index) =>
            new Worktree({
              directory: AbsolutePath.make(resolvePath(repository.worktree, line.slice("worktree ".length).trim())),
              kind: index === 0 ? "main" : "linked",
            }),
        )
    })

    return Service.of({
      repo: { discover, used, clone, create },
      remote: { get: remote },
      history: {
        head,
        branch,
        defaultRemoteBranch: remoteHead,
        rootCommits: roots,
        current: currentBranch,
        mainBranch,
        recent,
        userName,
      },
      status: { short: shortStatus },
      sync: { fetchRemotes: fetch, fetchBranch, checkoutRemoteBranch: checkout, resetHard: reset },
      worktree: { create: worktreeCreate, remove: worktreeRemove, list: worktreeList },
      index: { refresh, ignored },
      tree: {
        capture: captureTree,
        write: writeTree,
        files: treeFiles,
        diff: treeDiff,
        restore,
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer: layer, deps: [FSUtil.node, AppProcess.node] })

interface Result {
  readonly exitCode: number
  readonly text: string
  readonly stderr: string
}

/**
 * What keeps a git started in `top` or below it from using a repository above `top` (`GIT_CEILING_DIRECTORIES`). Git
 * looks for `.git` in the folder it starts in and then in each folder above, and takes the first that it accepts, so a
 * `.git` that Orbit took for the repository but git passes over would hand the command, with that repository's config,
 * to a folder above that nobody was asked about (class 1, class 3). None when the folder above `top` cannot be one entry
 * of git's list, which `path.delimiter` separates: git is then not started.
 */
export function ceiling(top: string): Record<string, string> | undefined {
  const above = path.dirname(top)
  if (above === top) return {}
  if (above.includes(path.delimiter)) return undefined
  return { GIT_CEILING_DIRECTORIES: above }
}

// The message of a command that was not started because `ceiling` has no answer for its folder.
const unbounded = "Git was not started: the folder above the repository cannot be given to git as its ceiling"

/** A git command in `cwd` that looks for its repository no further up than `top`; one that was not started fails. */
function run(cwd: string, proc: AppProcess.Interface, args: string[], top?: string) {
  return execute(cwd, proc, args, top).pipe(Effect.orElseSucceed(() => ({ exitCode: 1, text: "", stderr: "" })))
}

function execute(cwd: string, proc: AppProcess.Interface, args: string[], top?: string) {
  const env = top === undefined ? {} : ceiling(top)
  if (!env) return Effect.succeed({ exitCode: 1, text: "", stderr: unbounded } satisfies Result)
  return proc
    .run(
      ChildProcess.make(gitExecutable, GitSubmodules.skip(args), {
        cwd,
        env,
        extendEnv: true,
        stdin: "ignore",
      }),
    )
    .pipe(
      Effect.map(
        (result) =>
          ({
            exitCode: result.exitCode,
            text: result.stdout.toString("utf8"),
            stderr: result.stderr.toString("utf8"),
          }) satisfies Result,
      ),
    )
}

// Room for 2,000 characters of status at four bytes each, with plenty over, and a bound on a log with a huge subject.
const SNAPSHOT_OUTPUT_BYTES = 64 * 1024

/** The lines of git output; when it was cut at a byte limit, the last line is dropped because it may be partial. */
function wholeLines(text: string, truncated: boolean) {
  const lines = text.split(/\r?\n/)
  if (truncated) lines.pop()
  return lines.filter((line) => line.length > 0)
}

/** Split NUL-terminated git output into its records. */
function nuls(text: string) {
  return text.split("\0").filter(Boolean)
}

/**
 * The work-tree paths with a link (a junction on Windows included) among their folders below the work tree, which git
 * refuses to check or add ("beyond a symbolic link"). Each folder is looked at once.
 */
function linkedPaths<Name extends string>(worktree: string, files: readonly Name[]) {
  const folders = (file: string) =>
    file
      .split("/")
      .slice(0, -1)
      .map((_, index, parts) => parts.slice(0, index + 1).join("/"))
  const unique = Array.from(new Set(files.flatMap(folders)))
  return Effect.promise(() =>
    Promise.all(
      unique.map((folder) =>
        lstat(path.join(worktree, folder)).then(
          (info) => info.isSymbolicLink(),
          () => false,
        ),
      ),
    ),
  ).pipe(
    Effect.map((links) => {
      const linked = new Set(unique.filter((_, index) => links[index]))
      return new Set(files.filter((file) => folders(file).some((folder) => linked.has(folder))))
    }),
  )
}

function resolvePath(cwd: string, value: string) {
  const trimmed = value.replace(/[\r\n]+$/, "")
  if (!trimmed) return cwd
  const normalized = FSUtil.windowsPath(trimmed)
  if (path.isAbsolute(normalized)) return path.normalize(normalized)
  return path.resolve(cwd, normalized)
}
