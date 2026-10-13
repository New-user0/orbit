export * as LinkShare from "./link-share.js"

import fsSync from "fs"
import path from "path"
import { Effect } from "effect"
import { minimatch } from "minimatch"
import type { FSUtil } from "./fs-util.js"

// Only links are read, so the platform file system serves as well as the injected one.
type Reader = Pick<FSUtil.Interface, "readLink">

/**
 * How many links a walk follows. Windows follows 63 in one path; the limit is above that so that a real chain is still
 * named as the share it leads to. A walk that gets this far has not found where the path leads, which is not the same as
 * leading nowhere: it is answered as unresolved, never as no share (class 7).
 */
export const LIMIT = 80

// Rooted on every platform: a name without a root would be read from the working folder on POSIX, and be inside it.
const prefix = process.platform === "win32" ? "\\\\?\\too-many-links\\" : "/\\?\\too-many-links\\"

/**
 * The answer for a path whose links were followed to the limit. On Windows it starts with two separators, so every
 * caller takes it for a share or a device: it is refused or skipped and never opened, and it is outside every folder.
 */
export const unresolved = (file: string) => `${prefix}${file.replace(/[\\/:]+/g, "\\")}`

export const isUnresolved = (file: string) => file.startsWith(prefix)

/**
 * The share that a link on the way to a file names, when one does: opening a path through such a link connects to the
 * share, which is a request to a host that the repository chose. The links are read one part at a time, which touches no
 * share, and the share is named as the link says. Only Windows has them. This is a leaf, so that the trust decision, the
 * fingerprints and every loader ask the same question the same way.
 */
export const of = (fs: Reader, file: string, depth = 0): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    if (process.platform !== "win32") return undefined
    if (depth >= LIMIT) return unresolved(file)
    // Already a share or device spelling: it is the answer, and its root is not read as a folder.
    if (/^[\\/]{2}/.test(file)) return file
    const parts = path.relative(path.parse(file).root, file).split(path.sep)
    for (const index of parts.keys()) {
      const named = path.join(path.parse(file).root, ...parts.slice(0, index + 1))
      const target = yield* fs.readLink(named).pipe(Effect.orElseSucceed(() => undefined))
      if (target === undefined) continue
      // A link to a device path (`\\?\Volume{…}\…`, `\\.\…`) reads back in the NT form `\??\…`, which `path.resolve`
      // would take for a folder named `??` on the current drive. It is named as the device path it is.
      if (target.startsWith("\\??\\")) return path.join(`\\\\?\\${target.slice(4)}`, ...parts.slice(index + 1))
      const leads = path.join(path.resolve(path.dirname(named), target), ...parts.slice(index + 1))
      if (leads.startsWith("\\\\")) return leads
      const deeper = yield* of(fs, leads, depth + 1)
      if (deeper !== undefined) return deeper
    }
    return undefined
  })

/** The same question for a caller that cannot yield, such as the scheduling check. Only `readlink` is called, never a call that opens the target. */
export const ofSync = (file: string, depth = 0): string | undefined => {
  if (process.platform !== "win32") return undefined
  if (depth >= LIMIT) return unresolved(file)
  if (/^[\\/]{2}/.test(file)) return file
  const parts = path.relative(path.parse(file).root, file).split(path.sep)
  for (const index of parts.keys()) {
    const named = path.join(path.parse(file).root, ...parts.slice(0, index + 1))
    const target = readLinkSync(named)
    if (target === undefined) continue
    if (target.startsWith("\\??\\")) return path.join(`\\\\?\\${target.slice(4)}`, ...parts.slice(index + 1))
    const leads = path.join(path.resolve(path.dirname(named), target), ...parts.slice(index + 1))
    if (leads.startsWith("\\\\")) return leads
    const deeper = ofSync(leads, depth + 1)
    if (deeper !== undefined) return deeper
  }
  return undefined
}

// A part that is not a link, or is not there, reads as no link.
function readLinkSync(file: string) {
  try {
    return fsSync.readlinkSync(file)
  } catch {
    return undefined
  }
}

/**
 * Whether opening a path would reach a share, a device, or a chain of links that was never followed to its end. This is
 * the one question a loader asks about a path a repository supplies before it stats, resolves, lists, reads or watches
 * it: a path that is blocked is left alone, as if it were not there.
 */
export const blocked = (fs: Reader, file: string) =>
  of(fs, file).pipe(Effect.map((found) => found !== undefined))

/**
 * `fs.resolve` for a path a repository supplies: the real path, or `undefined` for a path that is blocked, which is not
 * handed to the file system.
 */
export const resolve = (fs: FSUtil.Interface, file: string) =>
  blocked(fs, file).pipe(Effect.flatMap((stop) => (stop ? Effect.succeed(undefined) : fs.resolve(file))))

/** Folders deeper than this are not listed, which ends a loop of links that stays on the disk. */
const DEPTH = 12

/**
 * The files under `cwd` that match any of `patterns` (relative, with `/`), listed by reading each folder without
 * following anything: an entry that is a link is entered only after `blocked` has answered no for it, at any depth. The
 * `glob` package follows every link it meets, so a link one level below a folder that was checked still connected to
 * its target (class 6). Paths are absolute and in the order of the walk; callers sort.
 */
export const scan = (fs: FSUtil.Interface, cwd: string, patterns: readonly string[]): Effect.Effect<string[]> =>
  Effect.gen(function* () {
    if (yield* blocked(fs, cwd)) return []
    const nocase = process.platform === "win32" || process.platform === "darwin"
    const found: string[] = []
    // The real folders already listed, so that a link back to a folder above (or beside) it is not listed again.
    const seen = new Set<string>([yield* fs.resolve(cwd)])
    const visit = (directory: string, relative: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > DEPTH) return
        const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
        for (const entry of entries) {
          const full = path.join(directory, entry.name)
          const name = relative === "" ? entry.name : `${relative}/${entry.name}`
          const kind = entry.type === "symlink" ? yield* linked(fs, full) : entry.type
          if (kind === "directory") {
            // Only a link can lead back, and it is known not to lead to a share, so resolving it is safe.
            const real = entry.type === "symlink" ? yield* fs.resolve(full) : full
            if (entry.type === "symlink" && seen.has(real)) continue
            seen.add(real)
            yield* visit(full, name, depth + 1)
          }
          if (kind === "file" && patterns.some((pattern) => minimatch(name, pattern, { dot: true, nocase })))
            found.push(full)
        }
      })
    yield* visit(cwd, "", 0)
    return found
  })

// What a link entry is, asked only after the link was found not to lead to a share.
const linked = (fs: FSUtil.Interface, file: string) =>
  Effect.gen(function* () {
    if (yield* blocked(fs, file)) return "other" as const
    if (yield* fs.isDir(file)) return "directory" as const
    if (yield* fs.isFile(file)) return "file" as const
    return "other" as const
  })
