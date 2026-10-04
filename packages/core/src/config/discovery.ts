export * as ConfigDiscovery from "./discovery.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
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
  readonly claude: readonly AbsolutePath[]
  readonly agents: readonly AbsolutePath[]
}

export const discover = Effect.fn("ConfigDiscovery.discover")(function* (options?: Options) {
  const fs = yield* FSUtil.Service
  const global = yield* Global.Service
  const location = yield* Location.Service
  const globalDirectory = AbsolutePath.make(global.config)
  const globalAgentsDirectory = AbsolutePath.make(path.join(global.home, ".agents"))
  const globalClaudeDirectory = AbsolutePath.make(path.join(global.home, ".claude"))
  const globalRoots = yield* Effect.forEach([globalDirectory, globalClaudeDirectory, globalAgentsDirectory], (item) =>
    fs.resolve(item),
  )
  const homeDirectory = yield* fs.resolve(global.home)
  const directories =
    (yield* fs.resolve(location.directory)) === globalRoots[0] || options?.project === false
      ? []
      : yield* fs.up({ targets: ["."], start: location.directory }).pipe(Effect.orDie)

  const probe = (directory: string, targets: readonly string[]) =>
    Effect.gen(function* () {
      // Resolve the parent too: missing children must honor symlinked global roots.
      const parent = yield* fs.resolve(directory)
      return yield* Effect.forEach(targets, (name) =>
        fs
          .resolve(path.join(parent, name))
          .pipe(Effect.map((resolved) => ({ item: AbsolutePath.make(path.join(directory, name)), resolved, parent }))),
      )
    })
  const discovered = yield* Effect.forEach(directories, (directory) =>
    probe(directory, [".claude", ".agents", ".orbit", ...names.toReversed(), ...localNames.toReversed()]),
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
      ? globalRoots.includes(resolved) || globalFiles.includes(resolved)
      : globalRoots.some((root) => resolved === root || resolved.startsWith(root + path.sep))
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

  return {
    global: globalEnabled ? globalDirectory : undefined,
    home: homeVisible ? yield* level(homeVisible) : undefined,
    explicit: options?.file ? AbsolutePath.make(path.resolve(options.file)) : undefined,
    ...(yield* level(visible)),
    claude: [
      ...new Set([
        ...(globalEnabled ? [globalClaudeDirectory] : []),
        ...visible.filter((item) => path.basename(item) === ".claude").toReversed(),
      ]),
    ],
    agents: [
      ...new Set([
        ...(globalEnabled ? [globalAgentsDirectory] : []),
        ...visible.filter((item) => path.basename(item) === ".agents").toReversed(),
      ]),
    ],
  } satisfies Sources
})
