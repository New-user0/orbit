export * as CompatRoots from "./roots.js"

import path from "path"
import { Effect } from "effect"
import { AbsolutePath } from "@orbit/schema/schema"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { CompatNames } from "./names.js"

/** The convention a root follows: the reference vendor's dot-directory, or the vendor-neutral `.agents` directory. */
export type Kind = "vendor" | "agents"

export interface Root {
  readonly path: AbsolutePath
  readonly kind: Kind
  /** Roots in the user's home directory are user scope; roots found walking up from the location are project scope. */
  readonly scope: "user" | "project"
}

// In this order, so every vendor root ranks below every `.agents` root when both define the same skill.
const conventions = [
  { kind: "vendor", name: CompatNames.vendor.directory },
  { kind: "agents", name: CompatNames.agents },
] as const

/**
 * Finds the roots that other agent products keep skills, output styles and settings in, lowest priority first: for
 * each kind, the user's own root in the home directory, then the roots found in the walked directories, outermost
 * first.
 *
 * Roots are listed whether or not they exist yet, so a watcher can see one appear. A root that resolves to the global
 * config directory or to one of the user's own roots is not listed again as project config, and neither is anything in
 * the home directory itself, which belongs to the user. With `global: false` the user's own roots, and anything that
 * resolves inside them, are left out entirely.
 */
export const discover = Effect.fn("CompatRoots.discover")(function* (input: {
  /** The directories to search, innermost first. Empty skips the project walk. */
  readonly directories: readonly string[]
  readonly global: boolean
}) {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const home = yield* fs.resolve(global.home)
  const reserved = yield* Effect.forEach(
    [global.config, ...conventions.map((convention) => path.join(global.home, convention.name))],
    (item) => fs.resolve(item),
  )

  const candidates = (yield* Effect.forEach(input.directories, (directory) =>
    Effect.gen(function* () {
      // Resolve the parent too: missing children must honor symlinked global roots.
      const parent = yield* fs.resolve(directory)
      return yield* Effect.forEach(conventions, (convention) =>
        fs.resolve(path.join(parent, convention.name)).pipe(
          Effect.map((resolved) => ({
            kind: convention.kind,
            path: path.join(directory, convention.name),
            resolved,
            parent,
          })),
        ),
      )
    }),
  )).flat()

  // realpath keeps the spelling it is given while Windows ignores case, so a location spelled differently from
  // Global.home still walks through home. path.relative compares case-insensitively there, where === would not.
  const reenters = (resolved: string) =>
    input.global
      ? reserved.includes(resolved)
      : reserved.some((root) => resolved === root || resolved.startsWith(root + path.sep))
  const visible = candidates.filter(
    (candidate) => path.relative(candidate.parent, home) !== "" && !reenters(candidate.resolved),
  )

  const root = (location: string, kind: Kind, scope: Root["scope"]): Root => ({
    path: AbsolutePath.make(location),
    kind,
    scope,
  })
  return conventions.flatMap((convention) => [
    ...(input.global ? [root(path.join(global.home, convention.name), convention.kind, "user")] : []),
    ...visible
      .filter((candidate) => candidate.kind === convention.kind)
      .toReversed()
      .map((candidate) => root(candidate.path, convention.kind, "project")),
  ])
})
