export * as FileAccess from "./file-access.js"

import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Array, Context, Effect, Layer, Schema } from "effect"
import path from "path"
import { Location } from "./location.js"
import { Permission } from "./permission.js"
import { Project } from "./project.js"
import { ProjectTrust } from "./project-trust.js"
import { AbsolutePath } from "./schema.js"
import type { SessionErrors } from "./session/error.js"
import type { Tool } from "./tool.js"

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
  /** Location-relative for internal paths, absolute for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export type Invocation = Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">

export interface ReadOptions {
  /** A target already authorized by this invocation, used for filename recovery. */
  readonly siblingOf: Target
}

export interface Interface {
  /** Resolve a lexical path and its permission resources, without requesting approval. */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, FSUtil.Error>
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
  ) => Effect.Effect<Target, FSUtil.Error | Error | SessionErrors.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/FileAccess") {}

/** Expand a leading ~ and normalize Windows shell paths before lexical resolution, as the clients that show a call do. */
export const resolvePath = (directory: string, input: string, home = Global.Path.home) =>
  FSUtil.resolveFrom(directory, input, home)

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

    // A target outside the project, or one that a link in an untrusted project leads out to, which is `escapes`.
    const external = Effect.fnUntraced(function* (absolute: AbsolutePath, kind: Kind | undefined, escapes?: string) {
      const place = escapes ?? absolute
      const type =
        kind === "directory"
          ? "Directory"
          : kind === "file"
            ? "File"
            : (yield* fs.stat(place).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)))
                ?.type
      const directory = AbsolutePath.make(type === "Directory" ? place : path.dirname(place))
      return {
        absolute,
        place: AbsolutePath.make(place),
        resource: slash(place),
        externalDirectory: {
          action: "external_directory",
          directory,
          resource: slash(path.join(directory, "*")),
          save: slash(path.join((yield* Project.root(fs, directory)) ?? directory, "*")),
          ...(escapes === undefined ? {} : { escaped: true as const }),
        },
      } satisfies Target
    })

    const resolve = Effect.fn("FileAccess.resolve")(function* (input: ResolveInput) {
      const absolute = AbsolutePath.make(resolvePath(location.directory, input.path))
      const worktree = path.resolve(location.project.directory)
      const internal =
        FSUtil.contains(location.directory, absolute) ||
        (worktree !== path.parse(worktree).root && FSUtil.contains(worktree, absolute))
      if (!internal) return yield* external(absolute, input.kind)
      // Until the project is trusted, a link in it that leads out of it does not make the target the project's own: the
      // repository ships its links, and one to the user's other files would be read or written without a question.
      const escapes = yield* trust.escapes(absolute)
      if (escapes !== undefined) return yield* external(absolute, input.kind, escapes)
      return {
        absolute,
        place: absolute,
        resource: slash(path.relative(location.directory, absolute) || "."),
      } satisfies Target
    })

    const authorizeExternal = Effect.fn("FileAccess.authorizeExternal")(function* (
      targets: readonly Target[],
      context: Invocation,
      metadata?: Permission.AssertInput["metadata"],
    ) {
      const external = Array.dedupeWith(
        targets.flatMap((target) => (target.externalDirectory ? [target.externalDirectory] : [])),
        (left, right) => left.resource === right.resource,
      )
      if (external.length === 0) return
      // A folder counts as escaped when any target reaches it through a link, even if another names it directly.
      const escaped = Array.dedupe(
        targets.flatMap((target) => (target.externalDirectory?.escaped ? [target.externalDirectory.resource] : [])),
      )
      yield* permission.assert({
        action: "external_directory",
        resources: external.map((item) => item.resource),
        save: external.map((item) => item.save),
        ...(escaped.length === 0 ? {} : { escaped }),
        ...(metadata === undefined ? {} : { metadata }),
        ...invocation(context),
      })
    })

    const authorizeRead = Effect.fn("FileAccess.authorizeRead")(function* (
      file: string,
      context: Invocation,
      options?: ReadOptions,
    ) {
      const target = yield* resolve({ path: file, kind: options ? "file" : undefined })
      const sibling = options && path.dirname(target.absolute) === path.dirname(options.siblingOf.absolute)

      // Filename recovery shares the directory approval, but checks the recovered file's own read rules.
      if (!sibling) yield* authorizeExternal([target], context)
      yield* permission.assert({
        action: "Read",
        resources: [target.resource],
        save: ["*"],
        ...invocation(context),
      })
      return target
    })

    return Service.of({ resolve, authorizeExternal, authorizeRead })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [FSUtil.node, Location.node, Permission.node, ProjectTrust.node],
})
