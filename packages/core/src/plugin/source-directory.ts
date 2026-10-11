export * as PluginSourceDirectory from "./source-directory.js"

import { FSUtil } from "@orbit/util/fs-util"
import { Host } from "@orbit/plugin/host"
import { Effect, Option } from "effect"
import path from "path"
import { fileURLToPath, pathToFileURL } from "url"

export const names = ["plugin", "plugins"] as const

export const discover = Effect.fn("PluginSourceDirectory.discover")(function* (
  fs: FSUtil.Interface,
  directory: string,
  folders: readonly string[] = names,
) {
  const children = (yield* Effect.forEach(folders, (source) =>
    fs.readDirectoryEntries(path.join(directory, source)).pipe(
      Effect.orElseSucceed(() => []),
      Effect.map((entries) => entries.map((entry) => ({ ...entry, target: path.join(directory, source, entry.name) }))),
    ),
  ))
    .flat()
    .sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))
  const targets = yield* Effect.forEach(children, (entry) =>
    Effect.gen(function* () {
      const source = entry.target.endsWith(".ts") || entry.target.endsWith(".js")
      if (entry.type === "file" && source) return Option.some(entry.target)
      if (entry.type === "directory") return Option.some(entry.target)
      if (entry.type !== "symlink") return Option.none<string>()
      if (source && (yield* fs.isFile(entry.target))) return Option.some(entry.target)
      if (yield* fs.isDir(entry.target)) return Option.some(entry.target)
      return Option.none<string>()
    }),
  )
  return targets.flatMap(Option.toArray)
})

/**
 * Every file that makes up the plugin at `target`: each entry file Host.resolve finds (server, tui, rpc) and the
 * `package.json` beside them, which may not exist. `activates` is false for a directory with no server entry, which
 * `ConfigPluginSource.scan` skips; the TUI still imports the tui entry of such a folder, so the fingerprints digest
 * these files whether or not the plugin activates. `escapes` is true when an entry's real path leaves the folder.
 */
export const files = Effect.fn("PluginSourceDirectory.files")(function* (fs: FSUtil.Interface, target: string) {
  const directory = yield* fs.isDir(target)
  const resolved: Host.Entrypoints = directory
    ? yield* Effect.sync(() => Host.resolve({ directory: target }))
    : { server: pathToFileURL(target).href }
  const entries = Object.values(resolved)
    .filter((entry) => entry !== undefined)
    .map((entry) => fileURLToPath(entry))
  const escapes = directory
    ? yield* Effect.gen(function* () {
        const root = yield* fs.resolve(target)
        const real = yield* Effect.forEach(entries, (entry) => fs.resolve(entry))
        return real.some((entry) => !FSUtil.contains(root, entry))
      })
    : false
  return {
    directory,
    activates: resolved.server !== undefined,
    escapes,
    files: entries,
    manifest: path.join(directory ? target : path.dirname(target), "package.json"),
  }
})

/**
 * What the supervisor loads from `target`: unset when nothing would be loaded (no server entry, or an entry file that a
 * link leads out of the folder). `ConfigPluginSource.scan` activates by this.
 */
export const entrypoints = Effect.fn("PluginSourceDirectory.entrypoints")(function* (
  fs: FSUtil.Interface,
  target: string,
) {
  const found = yield* files(fs, target)
  if (!found.activates || found.escapes) return undefined
  return { directory: found.directory, files: found.files, manifest: found.manifest }
})
