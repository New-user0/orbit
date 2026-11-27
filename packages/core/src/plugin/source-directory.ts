export * as PluginSourceDirectory from "./source-directory.js"

import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { Host } from "@orbit/plugin/host"
import { Effect, Option, Schema } from "effect"
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
 * real folder of such a name, its `index`, its `package.json` or a step of the `main` that names).
 * `ConfigPluginSource.scan` activates by this. It hands the folder to the runtime's resolver, which follows links, so
 * it runs only for folders that are trusted.
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
  // Bun's resolver passes over a link it cannot follow (one that loops) as if the entry were not there, so the links
  // it could have taken as an entry are checked with what it found: a link named `server`, `index`, `tui` or `rpc`
  // with any extension, and in a real folder of one of those names the links it could take as that folder's entry.
  const top = yield* named(fs, target, ["server", "index", "tui", "rpc"])
  const inner = yield* Effect.forEach(top.folders, (folder) => folderLinks(fs, folder))
  if (yield* leaves(fs, target, [...files, ...top.links, ...inner.flat()])) return undefined
  return { directory, files, manifest: path.join(target, "package.json") }
})

// A folder the resolver enters is read for its `package.json` (a link there counts too) and the `main` that names, then
// for its `index` with any extension. A link on the way of `main` counts too (`walk`).
const folderLinks = Effect.fnUntraced(function* (fs: FSUtil.Interface, folder: string) {
  const own = yield* named(fs, folder, ["index", "package.json"])
  const main = yield* fs.readJson(path.join(folder, "package.json")).pipe(
    Effect.map((json) => Option.getOrUndefined(decodeManifest(json))?.main),
    Effect.orElseSucceed(() => undefined),
  )
  if (main === undefined) return own.links
  return [
    ...own.links,
    ...(yield* walk(fs, [folder], path.relative(folder, path.resolve(folder, main)).split(path.sep))),
  ]
})

// `main` one step at a time: the links each step could name in the folders the steps before it reached, with or
// without an extension and in any case, and the `index` of each real folder a step names, as the resolver tries it.
const walk = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  folders: readonly string[],
  steps: readonly string[],
): Effect.fn.Return<string[]> {
  const step = steps[0]
  if (step === undefined) return []
  if (step === "..") return yield* walk(fs, folders.map(path.dirname), steps.slice(1))
  const found = yield* Effect.forEach(folders, (folder) => named(fs, folder, [step, path.parse(step).name]))
  const reached = found.flatMap((entry) => entry.folders)
  const index = yield* Effect.forEach(reached, (folder) => named(fs, folder, ["index"]))
  return [
    ...found.flatMap((entry) => entry.links),
    ...index.flatMap((entry) => entry.links),
    ...(yield* walk(fs, reached, steps.slice(1))),
  ]
})

// The links and the real folders in `directory` whose name, or name without its extension, is one of `names`. Names
// are compared without case on every platform: the resolver takes `TUI.ts` for `tui` on Windows and macOS, and the
// stricter answer wins (class 3), so Linux refuses that spelling too.
const named = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string, names: readonly string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const entries = (yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))).filter(
    (entry) => wanted.has(entry.name.toLowerCase()) || wanted.has(path.parse(entry.name).name.toLowerCase()),
  )
  return {
    links: entries.filter((entry) => entry.type === "symlink").map((entry) => path.join(directory, entry.name)),
    folders: entries.filter((entry) => entry.type === "directory").map((entry) => path.join(directory, entry.name)),
  }
})

const decodeManifest = Schema.decodeUnknownOption(Schema.Struct({ main: Schema.String }))

// An entry whose real path cannot be found (a loop of links, a share that cannot be reached) counts as leaving the
// folder, so that one bad plugin costs only itself.
const leaves = Effect.fnUntraced(function* (fs: FSUtil.Interface, target: string, files: readonly string[]) {
  const stays = yield* Effect.gen(function* () {
    const root = yield* fs.resolve(target)
    const real = yield* Effect.forEach(files, (entry) => fs.resolve(entry))
    return real.every((entry) => FSUtil.contains(root, entry))
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("plugin entry cannot be resolved", { target, cause }).pipe(Effect.as(false)),
    ),
  )
  return !stays
})
