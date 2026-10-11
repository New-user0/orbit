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
 * The files that make up the plugin at `target` as the supervisor loads it: the entry files, and the `package.json`
 * beside them, which may not exist. Unset when nothing would be loaded: a directory with no server entry, or one with
 * an entry file (server, tui or rpc)
 * that a link leads out of it. `ConfigPluginSource.scan` activates by this and the fingerprints digest by it, so the
 * two never disagree about what a plugin is.
 */
export const entrypoints = Effect.fn("PluginSourceDirectory.entrypoints")(function* (
  fs: FSUtil.Interface,
  target: string,
) {
  const directory = yield* fs.isDir(target)
  const resolved: Host.Entrypoints = directory
    ? yield* Effect.sync(() => Host.resolve({ directory: target }))
    : { server: pathToFileURL(target).href }
  if (!resolved.server) return undefined
  if (directory) {
    const root = yield* fs.resolve(target)
    const entries = Object.values(resolved).filter((entry) => entry !== undefined)
    const real = yield* Effect.forEach(entries, (entry) => fs.resolve(fileURLToPath(entry)))
    if (real.some((entry) => !FSUtil.contains(root, entry))) return undefined
  }
  return {
    directory,
    files: Object.values(resolved)
      .filter((entry) => entry !== undefined)
      .map((entry) => fileURLToPath(entry)),
    manifest: path.join(directory ? target : path.dirname(target), "package.json"),
  }
})
