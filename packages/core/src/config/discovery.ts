export * as ConfigDiscovery from "./discovery.js"

import path from "path"
import { Effect } from "effect"
import { CompatNames } from "@orbit/compat/names"
import { CompatRoots } from "@orbit/compat/roots"
import { CompatSettings } from "@orbit/compat/settings"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LinkShare } from "@orbit/util/link-share"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import type { Options } from "../config.js"

export const names = ["orbit.json", "orbit.jsonc"]
/** Per-machine overrides that outrank every shared file, kept out of version control. */
export const localNames = ["orbit.local.json", "orbit.local.jsonc"]

/** Config files and `.orbit` roots found together, each list ordered from outermost to innermost. */
export interface Level {
  readonly direct: readonly AbsolutePath[]
  readonly local: readonly AbsolutePath[]
  readonly project: readonly { readonly path: AbsolutePath; readonly present: boolean }[]
}

/** Eligible sources in priority order, including paths that may appear later. */
export interface Sources extends Level {
  readonly global?: AbsolutePath
  /**
   * Orbit files kept in the home directory itself. They are the user's own config, even when a project walk passes
   * through home on the way up.
   */
  readonly home?: Level
  readonly explicit?: AbsolutePath
  /** Candidate roots of other agent products, whether or not the compatibility switch is on or the roots exist yet. */
  readonly compat: readonly CompatRoots.Root[]
  /**
   * The settings files in the compat roots that exist now, whether or not the files do. A root that is missing has no
   * directory to watch for them, and the watch on its parent sees it appear.
   */
  readonly compatSettings: readonly AbsolutePath[]
  /** The MCP file of other agent products in the project directory, unset when project discovery is off. */
  readonly compatMcp?: AbsolutePath
}

export const discover = Effect.fn("ConfigDiscovery.discover")(function* (options?: Options) {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const globalDirectory = AbsolutePath.make(global.config)
  const globalRoot = yield* fs.resolve(globalDirectory)
  const homeDirectory = yield* fs.resolve(global.home)
  const start = yield* fs.resolve(location.directory)
  // As the reference reads a project's settings only from the project it starts in, the walk ends at the project's root
  // (D7): a folder above it supplies nothing, even one whose grant covers the project. Both ends are real paths, so a
  // start folder reached through a link walks where it really is, and the case Windows ignores does not count (class 4).
  const directories =
    start === globalRoot || options?.project === false
      ? []
      : projectWalk(start, yield* fs.resolve(location.project.directory))

  const probe = (directory: string, targets: readonly string[]) =>
    Effect.gen(function* () {
      // Resolve the parent too: missing children must honor symlinked global roots.
      const parent = yield* LinkShare.resolve(fs, directory)
      if (parent === undefined) return []
      // A name that a link leads to a share is not resolved, or listed: resolving it connects, before any trust check.
      const found = yield* Effect.forEach(targets, (name) =>
        LinkShare.resolve(fs, path.join(parent, name)).pipe(
          Effect.map((resolved) =>
            resolved === undefined
              ? undefined
              : { item: AbsolutePath.make(path.join(directory, name)), resolved, parent },
          ),
        ),
      )
      return found.filter((candidate) => candidate !== undefined)
    })
  const discovered = yield* Effect.forEach(directories, (directory) =>
    probe(directory, [".orbit", ...names.toReversed(), ...localNames.toReversed()]),
  ).pipe(
    Effect.map((items) => items.flat()),
    Effect.orDie,
  )

  const globalEnabled = options?.global !== false
  const globalFiles = yield* Effect.forEach([...names, ...localNames], (name) =>
    fs.resolve(path.join(globalDirectory, name)),
  )
  const reentersGlobal = ({ resolved }: { readonly resolved: string }) =>
    globalEnabled
      ? resolved === globalRoot || globalFiles.includes(resolved)
      : resolved === globalRoot || resolved.startsWith(globalRoot + path.sep)
  // Global sources must not re-enter through the project walk. The home directory is the user's own config, not a
  // project's, so the walk leaves its Orbit files to the home source below. realpath keeps the spelling it is given
  // while Windows ignores case, and a lowercase cwd then names home differently from Global.home: path.relative
  // compares case-insensitively there, where === would send home's files through the walk as project config.
  const visible = discovered
    .filter((candidate) => path.relative(candidate.parent, homeDirectory) !== "" && !reentersGlobal(candidate))
    .map(({ item }) => item)

  // Home-level files are probed directly so they apply wherever the project sits, and under --bare.
  const homeVisible = globalEnabled
    ? (yield* probe(global.home, [".orbit", ...names.toReversed(), ...localNames.toReversed()]))
        .filter((candidate) => !reentersGlobal(candidate))
        .map(({ item }) => item)
    : undefined

  // The probes list each directory innermost first, so reverse to run outer to inner.
  const level = Effect.fnUntraced(function* (items: readonly AbsolutePath[]) {
    const select = (targets: readonly string[]) =>
      items.filter((item) => targets.includes(path.basename(item))).toReversed()
    return {
      direct: select(names),
      local: select(localNames),
      project: yield* Effect.forEach(select([".orbit"]), (directory) =>
        fs.isDir(directory).pipe(Effect.map((present) => ({ path: directory, present }))),
      ),
    } satisfies Level
  })

  const compat = yield* CompatRoots.discover({ directories, global: globalEnabled })
  // The project's MCP file is project discovery like the orbit files are: wherever the walk is skipped, it is too, and
  // it stays out of reach of a disabled global config directory the same way.
  const mcp = directories.length === 0 ? [] : yield* probe(location.project.directory, [CompatNames.mcp])
  return {
    global: globalEnabled ? globalDirectory : undefined,
    home: homeVisible ? yield* level(homeVisible) : undefined,
    explicit: options?.file ? AbsolutePath.make(path.resolve(options.file)) : undefined,
    ...(yield* level(visible)),
    compat,
    compatSettings: CompatSettings.files(yield* Effect.filter(compat, (root) => fs.isDir(root.path))).map(
      (file) => file.path,
    ),
    compatMcp: mcp.find((candidate) => !reentersGlobal(candidate))?.item,
  } satisfies Sources
})

/**
 * The folders from `start` up to and including `top`, innermost first, when `top` is `start` or a folder above it, and
 * otherwise `start` alone. Both are real paths.
 */
function projectWalk(start: string, top: string): string[] {
  if (!FSUtil.contains(top, start)) return [start]
  const parent = path.dirname(start)
  if (path.relative(top, start) === "" || parent === start) return [start]
  return [start, ...projectWalk(parent, top)]
}
