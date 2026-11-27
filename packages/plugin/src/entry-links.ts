export * as EntryLinks from "./entry-links.js"

import { FSUtil } from "@orbit/util/fs-util"
import { Effect, Option, Schema } from "effect"
import path from "path"

/**
 * Whether a local plugin folder must be left out: one of `files` (the entries the runtime's resolver took) or a link the
 * resolver could have taken as an entry loops or leads out of `target`. Bun's resolver passes over a link it cannot
 * follow (one that loops) as if the entry were not there, so the links it could have taken are checked beside what it
 * found: a link named `server`, `index`, `tui` or `rpc` with any extension, and in a folder of one of those names (a
 * link to one too) the links it could take as that folder's entry. The server's supervisor and the terminal UI's plugin
 * loader both ask this before they read or import an entry, so they leave out the same folders (classes 3 and 12).
 */
export const escapes = Effect.fn("EntryLinks.escapes")(function* (
  fs: FSUtil.Interface,
  target: string,
  files: readonly string[],
) {
  const top = yield* named(fs, target, ["server", "index", "tui", "rpc"])
  const inner = yield* Effect.forEach(top.folders, (folder) => folderLinks(fs, folder))
  return yield* leaves(fs, target, [...files, ...top.links, ...inner.flat()])
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
// without an extension and in any case, and the `index` of each folder a step names (a link to one too), as the
// resolver tries it.
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

// The links and the folders in `directory` whose name, or name without its extension, is one of `names`. Names are
// compared without case on every platform: the resolver takes `TUI.ts` for `tui` on Windows and macOS, and the stricter
// answer wins (class 3), so Linux refuses that spelling too. A link to a folder is a folder the resolver enters as well
// as a link `leaves` checks. It is entered at its own path, from which Bun 1.4.5 takes a `..` of `main`, and at the
// real path it leads to, where a runtime that steps from there would look (class 3 again).
const named = Effect.fnUntraced(function* (fs: FSUtil.Interface, directory: string, names: readonly string[]) {
  const wanted = new Set(names.map((name) => name.toLowerCase()))
  const entries = (yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))).filter(
    (entry) => wanted.has(entry.name.toLowerCase()) || wanted.has(path.parse(entry.name).name.toLowerCase()),
  )
  const links = entries.filter((entry) => entry.type === "symlink").map((entry) => path.join(directory, entry.name))
  const linked = yield* Effect.forEach(links, (link) =>
    Effect.gen(function* () {
      if (!(yield* fs.isDir(link))) return []
      return [link, yield* fs.resolve(link)]
    }),
  )
  return {
    links,
    folders: [
      ...entries.filter((entry) => entry.type === "directory").map((entry) => path.join(directory, entry.name)),
      ...linked.flat(),
    ],
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
