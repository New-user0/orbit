export * as CompatSettings from "./settings.js"

import path from "path"
import { Effect, Option, Schema } from "effect"
import { Document, Info, type Scope } from "@orbit/schema/config"
import { EnvConfig } from "@orbit/schema/config/env-config"
import { HookConfig } from "@orbit/schema/config/hook-config"
import type { Permission } from "@orbit/schema/permission"
import { AbsolutePath, optional } from "@orbit/schema/schema"
import { FSUtil } from "@orbit/util/fs-util"
import type { CompatDiagnostic } from "./diagnostic.js"
import { CompatNames } from "./names.js"
import type { CompatRoots } from "./roots.js"

/**
 * The settings files that the reference vendor keeps in its dot-directory, read as config documents. Only the keys
 * Orbit has a use for come through: the hooks today, and the permission lists once something translates them.
 */

/** The permission lists of a settings file, as its product writes them: rule specs that Orbit does not read as is. */
export const ForeignPermissions = Schema.Struct({
  allow: optional(Schema.Array(Schema.String)),
  deny: optional(Schema.Array(Schema.String)),
  ask: optional(Schema.Array(Schema.String)),
})
export type ForeignPermissions = typeof ForeignPermissions.Type

/** A settings file that may exist, and the scope its document ranks in. */
export interface File {
  readonly path: AbsolutePath
  readonly scope: Scope
}

// Only these keys matter here and the file's others are ignored. Each is read on its own, so one that cannot be used
// never costs the other, and the hooks are decoded entry by entry, so a hook this version cannot read costs only itself.
const Settings = Schema.Struct({
  hooks: Schema.optionalKey(Schema.Unknown),
  permissions: Schema.optionalKey(Schema.Unknown),
  env: Schema.optionalKey(Schema.Unknown),
})
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(Settings))
const decodePermissions = Schema.decodeUnknownOption(ForeignPermissions)
const decodeInfo = Schema.decodeUnknownOption(Info, {
  errors: "all",
  onExcessProperty: "ignore",
  propertyOrder: "original",
})

/**
 * The settings file and the local settings file of every vendor root, lowest priority first: roots come in the order
 * discovery lists them, and each root's shared file comes before its local one. The user's own root ranks as user scope
 * for both files. In a project root the shared file is project scope, and the local file, which a person keeps out of
 * version control, is local scope.
 *
 * Files are listed whether or not they exist, so a watcher can see one appear.
 */
export function files(roots: readonly CompatRoots.Root[]): readonly File[] {
  return roots
    .filter((root) => root.kind === "vendor")
    .flatMap((root) => [
      { path: AbsolutePath.make(path.join(root.path, CompatNames.vendor.settings.shared)), scope: root.scope },
      {
        path: AbsolutePath.make(path.join(root.path, CompatNames.vendor.settings.local)),
        scope: root.scope === "user" ? "user" : "local",
      },
    ])
}

/**
 * Reads the settings files of the vendor roots into documents, one for each file that has something Orbit can use.
 * A file that is missing or unreadable is skipped without a word. One that is not JSON, or has a value Orbit cannot
 * use, is reported in the result, and whatever else it holds still comes through.
 */
export const read = Effect.fn("CompatSettings.read")(function* (roots: readonly CompatRoots.Root[]) {
  const fs = yield* FSUtil.Service
  const results = yield* Effect.forEach(files(roots), (file) =>
    fs.readFileStringSafe(file.path).pipe(
      Effect.orElseSucceed(() => undefined),
      Effect.map((text) => (text === undefined ? empty : parse(text, file))),
    ),
  )
  return {
    documents: results.flatMap((result) => result.documents),
    diagnostics: results.flatMap((result) => result.diagnostics),
  } satisfies CompatDiagnostic.Result
})

/** Whether a document's path is a settings file of this kind, so the document came from another product's files. */
export function isForeign(file: string | undefined) {
  if (file === undefined) return false
  const name = path.basename(file)
  return (
    (name === CompatNames.vendor.settings.shared || name === CompatNames.vendor.settings.local) &&
    path.basename(path.dirname(file)) === CompatNames.vendor.directory
  )
}

/**
 * The directory that a hook from this document reads as the project directory, where `session` is the directory the
 * session runs in. A settings folder of a project answers for the directory that holds it. Discovery walks up from the
 * session, so that can be a directory above it, and a hook that runs a script kept in the folder, as
 * `"$<variable>/<vendor directory>/hooks/check.sh"`, only finds it from there. The user's own settings folder is not a
 * project's, and the documents that are not settings files of another product are Orbit's own, so those answer for
 * `session`.
 */
export function projectDirectory(document: { readonly path?: string; readonly scope?: Scope }, session: string) {
  if (document.path === undefined || (document.scope !== "project" && document.scope !== "local")) return session
  return isForeign(document.path) ? path.dirname(path.dirname(document.path)) : session
}

/**
 * Orbit rules for the permission lists of a settings file. Nothing translates them yet, so a file's permissions never
 * reach the configuration; the permissions work fills this in, with the alias table, and the rules then arrive in each
 * file's document.
 */
export function translatePermissions(_foreign: ForeignPermissions): readonly Permission.Rule[] {
  return []
}

const empty: CompatDiagnostic.Result = { documents: [], diagnostics: [] }

function parse(text: string, file: File): CompatDiagnostic.Result {
  const settings = decodeSettings(text)
  if (Option.isNone(settings))
    return { documents: [], diagnostics: [problem(file, "invalid", ["$"], "rejected malformed JSON document")] }

  const hooks = settings.value.hooks === undefined ? undefined : HookConfig.decode(settings.value.hooks)
  const env = settings.value.env === undefined ? undefined : EnvConfig.decode(settings.value.env)
  const permissions =
    settings.value.permissions === undefined ? undefined : decodePermissions(settings.value.permissions)
  const rules = permissions !== undefined && Option.isSome(permissions) ? translatePermissions(permissions.value) : []
  const diagnostics = [
    ...(hooks?.diagnostics ?? []).map((diagnostic) =>
      problem(file, diagnostic.kind, diagnostic.path, diagnostic.message),
    ),
    ...(env?.diagnostics ?? []).map((diagnostic) => problem(file, diagnostic.kind, diagnostic.path, diagnostic.message)),
    ...(permissions !== undefined && Option.isNone(permissions)
      ? [problem(file, "invalid", ["permissions"], "skipped malformed recognized value")]
      : []),
  ]
  // Only what a file holds: a file with nothing to contribute makes no document.
  const encoded = {
    ...(hooks?.hooks !== undefined && Object.keys(hooks.hooks).length > 0 ? { hooks: hooks.hooks } : {}),
    ...(rules.length > 0 ? { permissions: rules } : {}),
    ...(env?.env !== undefined && Object.keys(env.env).length > 0 ? { env: env.env } : {}),
  }
  if (Object.keys(encoded).length === 0) return { documents: [], diagnostics }

  const info = decodeInfo(encoded)
  if (Option.isNone(info))
    return {
      documents: [],
      diagnostics: [
        ...diagnostics,
        problem(file, "invalid", ["$"], "rejected canonical configuration after final validation"),
      ],
    }
  return {
    documents: [new Document({ type: "document", path: file.path, scope: file.scope, info: info.value })],
    diagnostics,
  }
}

function problem(
  file: File,
  kind: CompatDiagnostic.Info["kind"],
  where: readonly string[],
  message: string,
): CompatDiagnostic.Info {
  return { source: file.path, kind, path: where, message }
}
