export * as InstructionNotes from "./instruction-notes.js"

import { Instruction } from "@orbit/schema/instruction"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bom } from "@orbit/util/bom"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { Global } from "@orbit/util/global"
import { Context, Effect, Layer, Schema } from "effect"
import { basename, dirname, join, relative } from "path"
import { Config } from "./config.js"
import { ConfigInstructionFile } from "./config/instruction-file.js"
import { FileMutation } from "./file-mutation.js"
import { Git } from "./git.js"
import { GitLayout } from "./git/layout.js"
import { InstructionDiscovery } from "./instruction-discovery.js"
import { Instructions } from "./instructions/index.js"
import { Location } from "./location.js"
import { Plugin } from "./plugin.js"
import { ProjectTrust } from "./project-trust.js"
import { AbsolutePath, RelativePath } from "./schema.js"

/** A note that was refused. Nothing was created or changed. */
export class TargetError extends Schema.TaggedError<TargetError>()("InstructionNotes.TargetError", {
  scope: Instruction.NoteScope,
  reason: Instruction.NoteRefusal,
  message: Schema.String,
}) {}

/** The file could not be read or written: a permission, a lock held by another program, a read-only folder. Nothing partial was written. */
export class WriteError extends Schema.TaggedError<WriteError>()("InstructionNotes.WriteError", {
  scope: Instruction.NoteScope,
  path: Schema.String,
  message: Schema.String,
}) {}

export interface Interface {
  /**
   * The file a note for each scope would be added to, in the order user, project, local. It reads the instruction files
   * again first, so `loaded` is what the disk holds now whether or not anything watches it.
   */
  readonly targets: () => Effect.Effect<readonly Instruction.NoteTarget[]>
  /**
   * Adds `text` as a bullet at the end of the instruction file the loader reads for `scope`, creating `ORBIT.md` (user),
   * `AGENTS.md` (project) or `ORBIT.local.md` (local) when there is none, and then reads the instruction files again.
   * `text` is the person's own, already trimmed and limited by the caller.
   */
  readonly add: (input: {
    readonly scope: Instruction.NoteScope
    readonly text: string
  }) => Effect.Effect<Instruction.NoteAdded, TargetError | WriteError>
  /**
   * The file a note for `scope` would be added to, created empty when it is not there, and where it really is. An
   * existing file is never changed. Unlike `add` it takes a file the loader does not read (a scope that is off, an
   * excluded file), since a person may want to open it all the same; a file that leads outside is refused as `add`
   * refuses it.
   */
  readonly ensure: (
    scope: Instruction.NoteScope,
  ) => Effect.Effect<{ readonly path: string; readonly created: boolean }, TargetError | WriteError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/InstructionNotes") {}

const defaults = { user: "ORBIT.md", project: "AGENTS.md", local: "ORBIT.local.md" } as const
const scopes = ["user", "project", "local"] as const

type Target = {
  readonly scope: Instruction.NoteScope
  /** Where the file is, or would be, by the name the loader walks to. */
  readonly file: string
  /** The real path of a file that is there, and `file` otherwise. */
  readonly path: string
  readonly exists: boolean
  readonly enabled: boolean
  /** The file is a link that leads to a network share, or its place could not be read: it is never opened, and a note is refused. */
  readonly blocked: boolean
  /** The file is there, no candidate of the loader survives, and a pattern of `instructions_exclude` drops this one. */
  readonly excluded: boolean
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const discovery = yield* InstructionDiscovery.Service
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const mutation = yield* FileMutation.Service
    const plugins = yield* Plugin.Service
    const trust = yield* ProjectTrust.Service

    // A project at the home folder or a filesystem root also bounds a link, as the loader does: the file the loader skips for
    // it is no target, and a note is not written to it (`ConfigInstructionFile.leadsOut`, the loader's own question).
    const leadsOut = Effect.fnUntraced(function* (spelling: string, real: string) {
      const wide = ConfigInstructionFile.wideProject(yield* fs.resolve(global.home), [
        yield* fs.resolve(location.project.directory),
        yield* fs.resolve(location.project.canonical),
      ])
      return yield* ConfigInstructionFile.leadsOut(
        { wide, importable: trust.importable, outward: trust.outward },
        spelling,
        real,
      )
    })

    // The loader's own rules, asked of this one folder pair, in the loader's order (config/plugin/instruction.ts).
    const target = Effect.fn("InstructionNotes.target")(function* (scope: Instruction.NoteScope) {
      const compat = yield* config.compatEnabled()
      const patterns = yield* ConfigInstructionFile.prepare(
        ConfigInstructionFile.excludes(yield* config.entries()),
        fs.resolve,
      )
      const root = yield* fs.resolve(location.project.directory)
      const start = yield* fs.resolve(location.directory)
      const folder = scope === "user" ? yield* fs.resolve(global.config) : root
      const names = scope === "local" ? ConfigInstructionFile.localNames(compat) : ConfigInstructionFile.names(compat)
      const globalFiles = yield* Effect.forEach(ConfigInstructionFile.names(compat), (name) =>
        fs.resolve(join(global.config, name)),
      )
      // A link to a share is found by reading links only: resolving or statting it would connect to the host the
      // repository named. Such a file counts as there, and is never opened.
      const spelled = yield* Effect.forEach(
        names.map((name) => join(folder, name)),
        (file) =>
          Effect.gen(function* () {
            if (scope === "user") return { file, real: yield* fs.resolve(file), blocked: false }
            if ((yield* LinkShare.of(fs, file)) !== undefined) return { file, real: file, blocked: true }
            // A defect from the file system (a link that cannot be followed) is a refusal, not a failure of the request.
            const real = yield* fs.resolve(file).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
            return real === undefined ? { file, real: file, blocked: true } : { file, real, blocked: false }
          }),
      )
      const present = yield* Effect.filter(spelled, (item) => (item.blocked ? Effect.succeed(true) : fs.isFile(item.real)))
      const kept = yield* ConfigInstructionFile.included(
        patterns,
        present.filter((item) => !item.blocked).map((item) => item.file),
        fs.resolve,
      )
      // The project's files meet the same gate as the loader's, which asks it of the spelling the walk built.
      const survivors =
        scope === "user"
          ? kept
          : yield* Effect.filter(kept, (item) =>
              Effect.all([trust.reachable(item.file), leadsOut(item.file, item.real)]).pipe(
                Effect.map(([reachable, out]) => reachable && !out),
              ),
            )
      const base = scope === "user" ? discovery.global : discovery.project && FSUtil.contains(root, start)
      // The loader drops a project file that is also a global file while global files are off.
      const isGlobal = (real: string) => globalFiles.some((file) => relative(file, real) === "")
      const chosen = survivors[0]
      if (chosen)
        return {
          scope,
          file: chosen.file,
          path: chosen.real,
          exists: true,
          blocked: false,
          enabled: base && (scope === "user" || discovery.global || !isGlobal(chosen.real)),
          excluded: false,
        } satisfies Target
      // No file of the loader's survives. A note still goes to the first one that is there and is refused, so that a
      // second file is never made beside one the loader skipped.
      const first = present[0]
      if (first)
        return {
          scope,
          file: first.file,
          path: first.real,
          exists: true,
          blocked: first.blocked,
          enabled: base,
          excluded: !first.blocked && !kept.some((item) => item.file === first.file),
        } satisfies Target
      const file = join(folder, defaults[scope])
      return { scope, file, path: file, exists: false, blocked: false, enabled: base, excluded: false } satisfies Target
    })

    // Compared by relative(), which ignores case where the file system does, so a drive letter's case does not matter.
    const loaded = Effect.fn("InstructionNotes.loaded")(function* (path: string) {
      const files = yield* discovery.list()
      if (!Array.isArray(files)) return false
      const real = yield* fs.resolve(path)
      return files.some((file) => relative(file.path, real) === "")
    })

    const targets = Effect.fn("InstructionNotes.targets")(function* () {
      // A cold location activates its plugins asynchronously, and the loader registers its rescan when it does.
      yield* plugins.awaitActivation
      yield* discovery.rescan()
      return yield* Effect.forEach(scopes, (scope) =>
        Effect.gen(function* () {
          const item = yield* target(scope)
          // Enabled means a note would be taken, so a file that add refuses is not enabled. The project and local scopes
          // name the file as the walk spelled it, which is the one the checks are asked of.
          const refused = item.excluded || (yield* outside(item))
          return new Instruction.NoteTarget({
            scope,
            path: scope === "user" ? item.path : item.file,
            exists: item.exists,
            enabled: item.enabled && !refused,
            loaded: item.exists && !item.blocked && (yield* loaded(item.path)),
          })
        }),
      )
    })

    // Whether the file leads outside the project while the project is not trusted. The spelling the walk built is asked,
    // and a path that is not there yet counts by where it would be.
    const outside = Effect.fnUntraced(function* (item: Target) {
      if (item.scope === "user") return false
      if (item.blocked) return true
      if ((yield* trust.escapes(item.file)) !== undefined) return true
      if (item.exists && (yield* leadsOut(item.file, item.path))) return true
      return !(yield* trust.reachable(item.file))
    })

    const refuse = (scope: Instruction.NoteScope, reason: Instruction.NoteRefusal, message: string) =>
      new TargetError({ scope, reason, message })

    const add = Effect.fn("InstructionNotes.add")(function* (input: {
      readonly scope: Instruction.NoteScope
      readonly text: string
    }) {
      yield* plugins.awaitActivation
      const item = yield* target(input.scope)
      if (!item.enabled) return yield* refuse(input.scope, "disabled", `Instruction files are not loaded for the ${input.scope} scope here.`)
      if ((yield* discovery.list()) === Instructions.unavailable)
        return yield* refuse(input.scope, "unavailable", "The instruction files could not all be read, so where a note would load is not known.")
      if (item.excluded) return yield* refuse(input.scope, "excluded", `${item.path} is excluded by instructions_exclude, so a note in it would not load.`)
      if (yield* outside(item)) return yield* refuse(input.scope, "outside", `${item.file} leads outside the project, which is not trusted.`)

      const layout = input.scope === "local" ? yield* gitLayout() : undefined
      const excludePath = layout?.verified ? join(layout.commonDirectory, "info", "exclude") : undefined
      const written = yield* mutation.withLock(excludePath === undefined ? [item.path] : [item.path, excludePath])(
        Effect.gen(function* () {
          // A link may have been swapped in since the question above.
          if (yield* outside(item)) return yield* refuse(input.scope, "outside", `${item.file} leads outside the project, which is not trusted.`)
          const created = yield* append(input.scope, item.path, input.text)
          if (created && layout !== undefined) yield* keepOut(layout, item.path)
          return created
        }),
      )
      yield* discovery.rescan()
      return new Instruction.NoteAdded({
        scope: input.scope,
        path: item.path,
        created: written,
        loaded: yield* loaded(item.path),
      })
    })

    const ensure = Effect.fn("InstructionNotes.ensure")(function* (scope: Instruction.NoteScope) {
      yield* plugins.awaitActivation
      const item = yield* target(scope)
      const leads = () => refuse(scope, "outside", `${item.file} leads outside the project, which is not trusted.`)
      if (yield* outside(item)) return yield* leads()
      if (item.exists) return { path: item.path, created: false }
      const folder = dirname(item.path)
      const failed = (error: { readonly message: string }) => new WriteError({ scope, path: item.path, message: error.message })
      return yield* mutation.withLock([item.path])(
        Effect.gen(function* () {
          yield* fs.ensureDir(folder).pipe(Effect.mapError(failed))
          const made = yield* exclusive(item.path, "", failed)
          // What is there now, the file this made or one that appeared, must really be in the folder the target named, and
          // a link that leads nowhere is not (class 4). So a link out that was swapped in since the question above is refused
          // here: the exclusive create never writes through it, and where it leads is not in that folder.
          const real = yield* fs.realPath(item.path).pipe(Effect.orElseSucceed(() => undefined))
          const base = yield* fs.realPath(folder).pipe(Effect.orElseSucceed(() => undefined))
          if (real === undefined || base === undefined || !FSUtil.contains(base, real)) return yield* leads()
          if (!(yield* fs.isFile(real))) return yield* failed({ message: `${item.path} is not a file.` })
          return { path: real, created: made === "created" }
        }),
      )
    })

    // Creates `path` holding `text` unless something is there. A link at the file's own place counts as something: an
    // exclusive create on Windows follows it, even one that leads nowhere, and would make the file where it points.
    const exclusive = Effect.fnUntraced(function* (
      path: string,
      text: string,
      failed: (error: { readonly message: string }) => WriteError,
    ) {
      if (yield* Effect.isSuccess(fs.readLink(path))) return "link" as const
      return yield* fs.writeFileString(path, text, { flag: "wx" }).pipe(
        Effect.as("created" as const),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed("exists" as const)),
        Effect.mapError(failed),
      )
    })

    // Appends in one write and returns whether the file was created by it. An existing file is never truncated.
    const append = Effect.fnUntraced(function* (scope: Instruction.NoteScope, path: string, text: string) {
      const failed = (error: { readonly message: string }) => new WriteError({ scope, path, message: error.message })
      const read = yield* fs.readFile(path).pipe(
        Effect.map((bytes) => Bom.decodeBytes(bytes).text),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
        Effect.mapError(failed),
      )
      const addition = format(read ?? "", text)
      if (read === undefined) {
        yield* fs.ensureDir(dirname(path)).pipe(Effect.mapError(failed))
        // Exclusive, so that a file that appeared in between is appended to and never replaced.
        const made = yield* exclusive(path, addition, failed)
        if (made === "created") return true
        // The file could not be read and a link is at its place: it leads nowhere, or somewhere nobody asked about (class 4).
        if (made === "link") return yield* refuse(scope, "outside", `${path} is a link, and a new file is never written through one.`)
        const now = yield* fs.readFile(path).pipe(Effect.mapError(failed))
        yield* fs.writeFileString(path, format(Bom.decodeBytes(now).text, text), { flag: "a" }).pipe(Effect.mapError(failed))
        return false
      }
      yield* fs.writeFileString(path, addition, { flag: "a" }).pipe(Effect.mapError(failed))
      return false
    })

    // Where the repository's own exclude file is, when the project is a git one and the folder's git directory is one git
    // made for it. Only the project root the Location resolved is asked: a Mercurial project nested in a repository has no
    // exclude step, and the repository above it is not this project's (class 1, 3, 4). Nothing is run.
    const gitLayout = Effect.fnUntraced(function* () {
      if (location.vcs?.type !== "git") return undefined
      return yield* GitLayout.locate(fs, yield* fs.resolve(location.project.directory))
    })

    // Best effort: a failure here is logged and the note stands.
    const keepOut = (layout: GitLayout.Layout, path: string) =>
      Effect.gen(function* () {
        // A `.git` that names another repository's directory gets no line: that repository is not this project's (class 3).
        if (!layout.verified)
          return yield* Effect.logWarning("instruction note not excluded from git", { reason: "unverified git directory" })
        const common = layout.commonDirectory
        const exclude = { layout, file: join(common, "info", "exclude") }
        const info = dirname(exclude.file)
        // A link anywhere on the way could lead the write out of the verified directory (class 4).
        const link = (name: string) => fs.readLink(name).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
        if ((yield* link(info)) || (yield* link(exclude.file))) {
          return yield* Effect.logWarning("instruction note not excluded from git", { reason: "exclude file is a link" })
        }
        if (!FSUtil.contains(common, yield* fs.resolve(info)))
          return yield* Effect.logWarning("instruction note not excluded from git", { reason: "exclude file leaves the git directory" })
        const worktreePath = relative(exclude.layout.worktree, path).replaceAll("\\", "/")
        if (worktreePath === "" || worktreePath.startsWith("../") || worktreePath === "..") return
        const line = `/${worktreePath}`
        const current = yield* fs.readFileString(exclude.file).pipe(
          Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("")),
        )
        if (current.split(/\r?\n/).includes(line)) return
        // Git runs only in a folder that is trusted: its config can name programs for it to run (class 1).
        if (yield* trust.trusted()) {
          const repository = yield* git.repo.discover(AbsolutePath.make(exclude.layout.worktree))
          if (repository) {
            const ignored = yield* git.index
              .ignored({ repository, paths: [RelativePath.make(worktreePath)] })
              .pipe(Effect.orElseSucceed(() => new Set<RelativePath>()))
            if (ignored.size > 0) return
          }
        }
        yield* fs.ensureDir(info)
        yield* fs.writeFileString(exclude.file, `${current === "" || /\r?\n$/.test(current) ? "" : "\n"}${line}\n`, {
          flag: "a",
        })
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("instruction note not excluded from git", { basename: basename(path), cause }),
        ),
      )

    return Service.of({ targets, add, ensure })
  }),
)

/** The text to append: a bullet with the note's lines indented under it, in the file's own line break, after a break if the file lacks one. */
export function format(existing: string, note: string) {
  const eol = existing.includes("\r\n") ? "\r\n" : "\n"
  const lines = note.split(/\r?\n/).map((line, index) => (index === 0 ? `- ${line}` : line === "" ? "" : `  ${line}`))
  return `${existing === "" || /\n$/.test(existing) ? "" : eol}${lines.join(eol)}${eol}`
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Config.node,
    InstructionDiscovery.node,
    FSUtil.node,
    Git.node,
    Global.node,
    Location.node,
    FileMutation.node,
    Plugin.node,
    ProjectTrust.node,
  ],
})
