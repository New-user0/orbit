export * as FileAccess from "./file-access.js"

import { ToolFailure } from "@orbit/ai"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Array, Context, Effect, Layer, Schema } from "effect"
import { lstat } from "fs/promises"
import path from "path"
import { DevicePath } from "./device-path.js"
import { LinkShare } from "@orbit/util/link-share"
import { Location } from "./location.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { ProjectTrust } from "./project-trust.js"
import { AbsolutePath } from "./schema.js"
import type { SessionErrors } from "./session/error.js"
import { Tool } from "./tool.js"

/** A read named a device or stream that never ends, such as `/dev/zero` or `NUL`. Nothing is asked or opened. */
export class DeviceError extends Schema.TaggedError<DeviceError>()("FileAccess.DeviceError", {
  resource: Schema.String,
}) {
  override get message() {
    return `${this.resource} is a device or stream, not a file, and reading it can block or never finish. Name a regular file instead.${
      process.platform === "win32"
        ? " NUL, CON, PRN, AUX, COM1 to COM9 and LPT1 to LPT9 are reserved Windows device names, with or without an extension."
        : ""
    }`
  }
}

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /**
   * The directory used as the external approval boundary: the target's own, as it is written, or the real directory
   * that a link in a project that is not trusted leads the target out to.
   */
  readonly directory: AbsolutePath
  readonly resource: string
  readonly save: string
  /**
   * The directory is where a link in a project that is not trusted leads out to, so the allows Orbit gives every agent
   * for its own folders do not decide it: only the person's own rules and approvals do.
   */
  readonly escaped?: true
}

export interface Target {
  readonly absolute: AbsolutePath
  /**
   * Where the tool acts: the real place that a link in a project that is not trusted leads `absolute` out to, and
   * `absolute` otherwise. A request names this place, so an approval does not show a link as a folder of the project.
   */
  readonly place: AbsolutePath
  /**
   * Where `absolute` really leads once its links are followed, when that differs from `absolute` in a project that is
   * trusted. It is a subject for deny and ask rules only (`Permission.AssertInput.leads`), never for an allow.
   */
  readonly leads?: AbsolutePath
  /** Location-relative for internal paths, absolute for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export type Invocation = Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id"> &
  Partial<Pick<Tool.Context, "progress">>

export interface ReadOptions {
  /** A target already authorized by this invocation, used for filename recovery. */
  readonly siblingOf?: Target
  /** Selects the external approval boundary, as for `resolve`; a sibling is a file. */
  readonly kind?: Kind
}

export interface Interface {
  /**
   * Resolve a path and its permission resources, without requesting approval. On Windows it refuses a data stream, a share
   * or device path (unless it is in the project's own folder), and an 8.3 short name it cannot find the long name of or
   * that is below a link to a share (`file.spelling`), and names a file as the disk does.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, FSUtil.Error | ToolFailure>
  /**
   * The `external_directory` request that `authorizeExternal` makes for these targets, or undefined when none is outside.
   * It asks nobody; a caller that checks every request of a call for a deny before the first question builds it with this.
   */
  readonly externalRequest: (
    targets: readonly Target[],
    base: Pick<Permission.AssertInput, "sessionID" | "agent" | "source">,
    metadata?: Permission.AssertInput["metadata"],
  ) => Permission.AssertInput | undefined
  /** Approve external directories in one batch, preserving first-seen resource order. */
  readonly authorizeExternal: (
    targets: readonly Target[],
    context: Invocation,
    metadata?: Permission.AssertInput["metadata"],
  ) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /** Resolve a read target and obtain external-directory approval before read approval. */
  readonly authorizeRead: (
    file: string,
    context: Invocation,
    options?: ReadOptions,
  ) => Effect.Effect<Target, FSUtil.Error | ToolFailure | DeviceError | Error | SessionErrors.NotFoundError>
  /**
   * The targets among absolute `files` that are in the project, by name or by another spelling of its folder, and that a
   * link in it leads out of while it is not trusted, each with its real place and an `escaped` external directory. Nothing else about the files is refused
   * or asked: they are paths that a shell command names in its text, not paths a tool was given.
   */
  readonly escaped: (files: readonly string[]) => Effect.Effect<readonly Target[], FSUtil.Error | ToolFailure>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/FileAccess") {}

/** Expand a leading ~ and normalize Windows shell paths before lexical resolution, as the clients that show a call do. */
export const resolvePath = (directory: string, input: string, home = Global.Path.home) =>
  FSUtil.resolveFrom(directory, input, home)

// A share or device path on Windows: `\\server\share`, `\\?\Volume{...}` or `\\.\...`. `resolvePath` already writes the
// drive forms of a `\\?\` path as the drive.
// A path that a walk of links gave up on (`LinkShare.unresolved`) counts as one on every platform.
const isShare = (file: string) =>
  (process.platform === "win32" && file.startsWith("\\\\")) || LinkShare.isUnresolved(file)
// A chain of links that was followed to the limit has no known end, which is a different reason from a share.
const linksFailure = (spelled: string) =>
  new ToolFailure({
    message: `${spelled} passes through more than ${LinkShare.LIMIT} links, more than any system follows, so it is not opened. Use the path of the file or folder itself.`,
    code: Tool.ErrorCode.FileSpelling,
  })
const shareFailure = (spelled: string) =>
  new ToolFailure({
    message: `${spelled} is a network share or device path, which tools do not open. Use the path of the file or folder on a local drive.`,
    code: Tool.ErrorCode.FileSpelling,
  })
/**
 * The name a diff in a request gives the file: the resource, which is the project's own spelling, unless the tool acts
 * somewhere else (a link leads out), where it is the place, so that an approval does not show the link as the file.
 */
export const shownName = (target: Target) => (target.place === target.absolute ? target.resource : slash(target.place))
/** The `leads` of a permission request for these targets: the real places they lead to, keyed by their resource. */
export const leadsOf = (targets: readonly Target[]) => {
  const entries = targets.flatMap((target) =>
    target.leads === undefined ? [] : [[target.resource, [target.leads]] as const],
  )
  return entries.length === 0 ? {} : { leads: Object.fromEntries(entries) }
}
const slash = (value: string) => value.replaceAll("\\", "/")
const invocation = (context: Invocation) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const permission = yield* Permission.Service
    const trust = yield* ProjectTrust.Service
    const worktree = path.resolve(location.project.directory)
    // The project's folders by name: a target in one is the project's own, unless a link leads it out.
    const folders = [location.directory, ...(worktree === path.parse(worktree).root ? [] : [worktree])]
    // Those folders as the disk has them, for finding a path that names the project through another spelling of it.
    const real = yield* Effect.forEach(folders, (folder) => fs.resolve(folder).pipe(Effect.map(FSUtil.normalizePath)))

    // Windows opens a file by its 8.3 short name too: `ENV~1` is `.env`, and `PROJEC~1` the project's folder. Each part
    // below `from` that is such a name is replaced by the name it stands for, so rules and the project's folders see the
    // file's own name. Only a part with `~` can be one, so other paths touch no disk, and this walk reads no share that
    // is not a folder of the project.
    const longNames = Effect.fnUntraced(function* (file: string, from?: string) {
      if (process.platform !== "win32") return file
      const root = path.parse(file).root
      if (from === undefined && root.startsWith("\\\\")) return file
      const base = from ?? root
      return yield* Effect.reduce(
        path.relative(base, file).split(path.sep),
        () => base,
        (folder, part) => {
          if (!part.includes("~")) return Effect.succeed(path.join(folder, part))
          return refuseShare(folder, file).pipe(
            // The listing goes through `FSUtil` so a test sees which folder was read.
            Effect.andThen(() =>
              fs.readDirectoryEntries(folder).pipe(
                Effect.map((list) => list.map((entry) => entry.name)),
                Effect.orElseSucceed(() => undefined),
              ),
            ),
            Effect.flatMap((entries) => Effect.promise(() => longName(folder, part, entries))),
            Effect.flatMap((name) =>
              name === undefined
                ? new ToolFailure({
                    message: `${file} names a file by a Windows short name whose long name could not be found. Use the long name.`,
                    code: Tool.ErrorCode.FileSpelling,
                  })
                : Effect.succeed(path.join(folder, name)),
            ),
          )
        },
      )
    })

    // Reading a folder for the long name of a part would connect to the share that a link of the repository leads that
    // folder to, before anyone is asked. Links are read one part at a time, which touches no share, so such a folder is
    // refused here, whatever the part below it is.
    const refuseShare = (folder: string, file: string) =>
      trust.escapes(folder).pipe(
        Effect.flatMap((leads) =>
          leads?.startsWith("\\\\")
            ? new ToolFailure({
                message: `${file} is below a link that leads to a network share, whose short names tools do not look up. Use the long name.`,
                code: Tool.ErrorCode.FileSpelling,
              })
            : Effect.void,
        ),
      )

    // A target outside the project, or one that a link in an untrusted project leads out to, which is `escapes`.
    const external = Effect.fnUntraced(function* (
      absolute: AbsolutePath,
      kind: Kind | undefined,
      escapes?: string,
      // A place that a link of a trusted project leads to is the real one too, but it is not an escape from an untrusted one.
      escaped = true,
    ) {
      const place = escapes ?? absolute
      // A share is asked about without being opened: statting it, or looking for a repository in it, would connect.
      const network = isShare(place)
      const type =
        kind === "directory"
          ? "Directory"
          : kind === "file"
            ? "File"
            : network
              ? undefined
              : (yield* fs.stat(place).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)))
                ?.type
      const directory = AbsolutePath.make(type === "Directory" ? place : path.dirname(place))
      // A link outside the project leads somewhere too, and a deny or ask written for that folder decides it. A share
      // spelling is never followed (`resolve` refuses one before this), and an escaped place is already the real one.
      const leads = escapes === undefined && !isShare(absolute) ? yield* trust.leads(absolute) : absolute
      return {
        absolute,
        place: AbsolutePath.make(place),
        ...(FSUtil.contains(leads, absolute) && FSUtil.contains(absolute, leads)
          ? {}
          : { leads: AbsolutePath.make(leads) }),
        resource: slash(place),
        externalDirectory: {
          action: "external_directory",
          directory,
          resource: slash(path.join(directory, "*")),
          save: slash(path.join((network ? undefined : yield* Project.root(fs, directory)) ?? directory, "*")),
          ...(escapes === undefined || !escaped ? {} : { escaped: true as const }),
        },
      } satisfies Target
    })

    // The path under the project's folder, by that folder's name, that `file` really is in. Each part of `file` from its
    // root is resolved on the disk, and the first one that is inside the project is the start: what follows it keeps its
    // name, so a link of the repository below it is followed afterwards as for the plain spelling, not here. Undefined
    // when no part of it is in the project.
    const anchor = Effect.fnUntraced(function* (file: AbsolutePath) {
      const root = path.parse(file).root
      const parts = path.relative(root, file).split(path.sep)
      // The root comes first: a drive that is made from the project's folder (`subst Q: <project>`) is the project.
      for (const index of [-1, ...parts.keys()]) {
        const prefix = path.join(root, ...parts.slice(0, index + 1))
        if ((yield* fs.stat(prefix).pipe(Effect.orElseSucceed(() => undefined))) === undefined) return undefined
        // The native path: the JavaScript one leaves a drive made from a folder (`subst`) as the drive.
        const where = FSUtil.normalizePath(yield* fs.resolve(prefix))
        const folder = real.findIndex((item) => FSUtil.contains(item, where))
        if (folder !== -1)
          return AbsolutePath.make(
            path.join(folders[folder]!, path.relative(real[folder]!, where), ...parts.slice(index + 1)),
          )
      }
      return undefined
    })

    const resolve = Effect.fn("FileAccess.resolve")(function* (input: ResolveInput) {
      const lexical = resolvePath(location.directory, input.path)
      // On Windows `name::$DATA` opens the file `name` and `name:x` a stream of it, so a rule for the file would not see
      // the call, and a shell reads `HKLM:` or `FileSystem::C:\x` as a drive. No tool needs either, so a `:` after the
      // drive or share is refused.
      if (process.platform === "win32" && lexical.slice(path.parse(lexical).root.length).includes(":"))
        return yield* new ToolFailure({
          message: `${input.path} has a ":" after its drive, which on Windows names a data stream of a file or a drive that is not a disk. Use the plain path of the file or folder.`,
          code: Tool.ErrorCode.FileSpelling,
        })
      const named = folders.find((folder) => FSUtil.contains(folder, lexical))
      // A share path (`\\localhost\C$\...`) or a device path (`\\?\Volume{...}`, `\\.\...`) names a folder of the
      // project in a spelling that no rule is written for, and opening one connects to a share. No tool needs one, so it
      // is refused before any disk is read, unless the path is in the project's folder.
      if (named === undefined && isShare(lexical)) return yield* shareFailure(input.path)
      // A part below a folder of the project is named in that folder as the disk names it, and a path outside from its
      // root, so that an 8.3 short name does not hide the name that rules are written for.
      const long = AbsolutePath.make(yield* longNames(lexical, named))
      // A path outside the project by name can still be in it by another spelling of the project's folder, such as a
      // system junction (`C:\Documents and Settings` for `C:\Users`) or a link to it. It is decided where it really is,
      // under the folder of the project it is in, so that a link in the repository below it is followed as for the plain
      // spelling.
      // Expanding an 8.3 short name can make `long` the project's own name, so what the anchor found, not a difference
      // from `long`, says that the path is in the project.
      const anchored = named === undefined ? yield* anchor(long) : undefined
      const absolute = anchored ?? long
      const internal = named !== undefined || anchored !== undefined
      if (!internal) return yield* external(absolute, input.kind)
      // Until the project is trusted, a link in it that leads out of it does not make the target the project's own: the
      // repository ships its links, and one to the user's other files would be read or written without a question.
      const escapes = yield* trust.escapes(absolute)
      // A link of the repository can lead to a share, whatever host the share names, a local one included (`\localhost\C$`).
      // The person's rules name the folder as a drive path, so a question about the share's spelling would let their deny
      // become an ask, and approving it would connect to the host. It is refused as a share given directly is, before
      // anything is asked or opened.
      if (escapes !== undefined && LinkShare.isUnresolved(escapes)) return yield* linksFailure(input.path)
      if (escapes !== undefined && isShare(escapes)) return yield* shareFailure(input.path)
      if (escapes !== undefined) return yield* external(absolute, input.kind, escapes)
      // A trusted project follows its links, but the person's deny and ask rules, and the managed ones, are written against
      // the place a file really is: a link to `~/.ssh` is that folder to them. The real place joins as a subject that only
      // a deny or an ask can use.
      const leads = yield* trust.leads(absolute)
      // A link of a trusted project that leads out of it is asked about as the shell asks (class 3): the question is for the
      // folder it really leads to, and a link to a share is asked about the same way, before anything is opened: the question
      // names the share, so the person decides whether to connect. A walk that gave up on a long chain is refused.
      if (LinkShare.isUnresolved(leads)) return yield* linksFailure(input.path)
      if (![...folders, ...real].some((folder) => FSUtil.contains(folder, leads))) {
        // The resource stays the spelling in the project, so a rule written for the link still decides, and `leads` joins
        // the real place for a rule written for that.
        const outside = yield* external(absolute, input.kind, leads, false)
        return {
          ...outside,
          leads: AbsolutePath.make(leads),
          resource: slash(path.relative(location.directory, absolute) || "."),
        } satisfies Target
      }
      return {
        absolute,
        place: absolute,
        ...(FSUtil.contains(leads, absolute) && FSUtil.contains(absolute, leads)
          ? {}
          : { leads: AbsolutePath.make(leads) }),
        resource: slash(path.relative(location.directory, absolute) || "."),
      } satisfies Target
    })

    const externalRequest = (
      targets: readonly Target[],
      base: Pick<Permission.AssertInput, "sessionID" | "agent" | "source">,
      metadata?: Permission.AssertInput["metadata"],
    ): Permission.AssertInput | undefined => {
      const external = Array.dedupeWith(
        targets.flatMap((target) => (target.externalDirectory ? [target.externalDirectory] : [])),
        (left, right) => left.resource === right.resource,
      )
      if (external.length === 0) return undefined
      // A folder counts as escaped when any target reaches it through a link, even if another names it directly.
      const escaped = Array.dedupe(
        targets.flatMap((target) => (target.externalDirectory?.escaped ? [target.externalDirectory.resource] : [])),
      )
      // A link outside the project, or a system junction, can lead into a folder that a deny or an ask is written for. The
      // spelled folder is what the tool acts on, but the rules also meet the real one, as they do for Read and Edit.
      const led = targets.flatMap((target) =>
        target.externalDirectory === undefined || target.leads === undefined
          ? []
          : [
              [
                target.externalDirectory.resource,
                slash(
                  path.join(
                    target.externalDirectory.directory === target.place ? target.leads : path.dirname(target.leads),
                    "*",
                  ),
                ),
              ] as const,
            ],
      )
      const leads = Object.fromEntries(
        Array.dedupe(led.map((item) => item[0])).map((resource) => [
          resource,
          Array.dedupe(led.filter((item) => item[0] === resource).map((item) => item[1])),
        ]),
      )
      return {
        action: "external_directory",
        resources: external.map((item) => item.resource),
        save: external.map((item) => item.save),
        ...(led.length === 0 ? {} : { leads }),
        ...(escaped.length === 0 ? {} : { escaped }),
        ...(metadata === undefined ? {} : { metadata }),
        ...base,
      }
    }

    const authorizeExternal = Effect.fn("FileAccess.authorizeExternal")(function* (
      targets: readonly Target[],
      context: Invocation,
      metadata?: Permission.AssertInput["metadata"],
    ) {
      const request = externalRequest(targets, invocation(context), metadata)
      if (request) yield* permission.assert(request)
    })

    // Whether the place exists and, followed through links, is neither a file nor a folder. A stat opens nothing.
    const isSpecial = (place: string) =>
      fs.stat(place).pipe(
        Effect.map((info) => info.type !== "File" && info.type !== "Directory"),
        Effect.orElseSucceed(() => false),
      )

    const authorizeRead = Effect.fn("FileAccess.authorizeRead")(function* (
      file: string,
      context: Invocation,
      options?: ReadOptions,
    ) {
      // Before any disk is read: resolving a path stats every part of it, and a stat of a device can block.
      // A share or device-namespace spelling (`\?\Volume{...}`) outside the project is refused as one first, with the
      // same code at every door, since the device list would otherwise answer for it with another message.
      const lexical = resolvePath(location.directory, file)
      if (isShare(lexical) && !folders.some((folder) => FSUtil.contains(folder, lexical))) return yield* shareFailure(file)
      if (DevicePath.blocked(lexical)) return yield* new DeviceError({ resource: file })
      const target = yield* resolve({ path: file, kind: options?.kind ?? (options?.siblingOf ? "file" : undefined) })
      // Before anything is asked or opened: a device is no place for a question. The listed names are the Windows rule;
      // elsewhere what the place really is decides, so a spelling the list lacks, a link to a device or a pipe is
      // refused too.
      if (
        DevicePath.blocked(target.absolute) ||
        DevicePath.blocked(target.place) ||
        (process.platform !== "win32" && (yield* isSpecial(target.place)))
      )
        return yield* new DeviceError({ resource: file })
      const sibling =
        options?.siblingOf !== undefined && path.dirname(target.absolute) === path.dirname(options.siblingOf.absolute)

      // Filename recovery shares the directory approval, but checks the recovered file's own read rules.
      // The place as resolved, before anything is asked, so a client names what the tool reads even when no rule asks.
      if (context.progress) yield* context.progress({ places: [target.place] })
      if (!sibling) yield* authorizeExternal([target], context)
      yield* permission.assert({
        action: "Read",
        resources: [target.resource],
        save: ["*"],
        // The place as resolved here, absolute, so a client shows it rather than the input's spelling, and the real place
        // when a link in an untrusted project leads there.
        metadata: { paths: [target.place] },
        ...leadsOf([target]),
        ...invocation(context),
      })
      return target
    })

    const escaped = Effect.fn("FileAccess.escaped")(function* (files: readonly string[]) {
      if (yield* trust.trusted()) return []
      const targets = yield* Effect.forEach(
        // A share is not opened to find out where it is: no tool is given one, and a command that names one is asked about
        // as the shell asks.
        files.filter((file) => !isShare(file)),
        Effect.fnUntraced(function* (file) {
          // A word that names the project through another spelling of its folder is decided where it really is, as `resolve`
          // does for a tool's path.
          const absolute = folders.some((folder) => FSUtil.contains(folder, file))
            ? AbsolutePath.make(file)
            : yield* anchor(AbsolutePath.make(file))
          if (absolute === undefined) return []
          const escapes = yield* trust.escapes(absolute)
          if (escapes !== undefined && isShare(escapes)) return yield* shareFailure(file)
          return escapes === undefined ? [] : [yield* external(absolute, undefined, escapes)]
        }),
      )
      return targets.flat()
    })

    return Service.of({ resolve, externalRequest, authorizeExternal, authorizeRead, escaped })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Permission.node, ProjectTrust.node],
})

// The name in `folder` that `part` stands for: `part` itself when the folder has an entry of that name or nothing is
// there, and otherwise the one entry that is the same file, which is the long name of an 8.3 short name. Undefined when
// something is there under `part` but no single entry is it.
async function longName(folder: string, part: string, entries: readonly string[] | undefined) {
  if (entries === undefined || entries.some((entry) => entry.toLowerCase() === part.toLowerCase())) return part
  const file = await lstat(path.join(folder, part), { bigint: true }).catch(() => undefined)
  if (file === undefined) return part
  const same = await Promise.all(
    entries.map((entry) =>
      lstat(path.join(folder, entry), { bigint: true }).then(
        (stat) => (stat.ino === file.ino ? [entry] : []),
        () => [],
      ),
    ),
  )
  const names = same.flat()
  return names.length === 1 ? names[0] : undefined
}
