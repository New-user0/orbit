export * as PluginSourceDirectory from "./source-directory.js"

import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { EntryLinks } from "@orbit/plugin/entry-links"
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
    // A folder that a link leads to a share is not listed: listing it connects. Neither is an entry in it that does.
    LinkShare.blocked(fs, path.join(directory, source)).pipe(
      Effect.flatMap((stop) => (stop ? Effect.succeed([]) : fs.readDirectoryEntries(path.join(directory, source)))),
      Effect.orElseSucceed(() => []),
      // A dependency folder is never a plugin, so the digest does not read it and the loaders do not activate it.
      Effect.map((entries) =>
        entries
          .filter((entry) => entry.name !== "node_modules")
          .map((entry) => ({ ...entry, target: path.join(directory, source, entry.name) })),
      ),
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
      if (yield* LinkShare.blocked(fs, entry.target)) return Option.none<string>()
      if (source && (yield* fs.isFile(entry.target))) return Option.some(entry.target)
      if (yield* fs.isDir(entry.target)) return Option.some(entry.target)
      return Option.none<string>()
    }),
  )
  return targets.flatMap(Option.toArray)
})

/**
 * What the supervisor loads from `target`: unset when nothing would be loaded (no server entry, an entry file that a
 * link leads out of the folder, or a link the resolver could take as an entry that loops or leads out, even when the
 * resolver did not take it: one named `server`, `index`, `tui` or `rpc` in any case and with any extension, or, in a
 * folder of such a name (a link to a folder too), its `index`, its `package.json` or a step of the `main` that names).
 * `ConfigPluginSource.scan` activates by this. It hands the folder to the runtime's resolver, which follows links, so
 * it runs only for folders that are trusted. The link check is `EntryLinks.escapes`, which the terminal UI's loader
 * asks too.
 */
export const entrypoints = Effect.fn("PluginSourceDirectory.entrypoints")(function* (
  fs: FSUtil.Interface,
  target: string,
) {
  const directory = yield* fs.isDir(target)
  const resolved: Host.Entrypoints = directory
    ? yield* Effect.sync(() => Host.resolve({ directory: target }))
    : { server: pathToFileURL(target).href }
  if (resolved.server === undefined) return undefined
  const files = Object.values(resolved)
    .filter((entry) => entry !== undefined)
    .map((entry) => fileURLToPath(entry))
  if (!directory) return { directory, files, manifest: path.join(path.dirname(target), "package.json") }
  if (yield* EntryLinks.escapes(fs, target, files)) return undefined
  return { directory, files, manifest: path.join(target, "package.json") }
})
