export * as LinkShare from "./link-share.js"

import fsSync from "fs"
import path from "path"
import { Cause, Effect } from "effect"
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

/**
 * Whether a path names a share or a device by its spelling: two separators (`\\host\share`, `//host/share`, `\\?\UNC\`,
 * `\\.\`), or a rooted `\??\` (the NT spelling, which Windows opens as a share too). Such a path is never walked part by
 * part, because reading a link on it connects to the host.
 */
export const isShare = (file: string) => SHARE.test(file) || SHARE.test(path.win32.normalize(file))

// The walks resolve `.` and `..` before they read a part, so a dot segment in front of `??` (`\x\..\??\UNC\h\s`) is the
// share too: a spelling is tested as written and as normalized.
const SHARE = /^[\\/]{2}|^[\\/]\?\?[\\/]/

export const isUnresolved = (file: string) => file.startsWith(prefix)

/**
 * The share that a link on the way to a file names, when one does: opening a path through such a link connects to the
 * share, which is a request to a host that the repository chose. The links are read one part at a time, which touches no
 * share, and the share is named as the link says. Only Windows has them. This is a leaf, so that the trust decision, the
 * fingerprints and every loader ask the same question the same way.
 */
export const of = (
  fs: Reader,
  file: string,
  depth = 0,
  reads: Reads = new Map(),
): Effect.Effect<string | undefined> =>
  follow(fs, file, depth, reads).pipe(Effect.map((found) => ("share" in found ? found.share : undefined)))

/** Where a path leads: the share it reaches, or the path with every link on it followed (`undefined` off Windows, where nothing is read). */
export type Followed = { readonly share: string } | { readonly real: string | undefined }

/**
 * `of`, and when the answer is no share, the path that the links lead to. It is read from the same one walk, so a caller
 * that goes on to ask what the path is can ask about the end of the chain, which is one step for the file system, and not
 * about the link, which it follows hop by hop (a chain of 63 links took seconds to stat for each entry that led to it).
 */
export const follow = (
  fs: Reader,
  file: string,
  depth = 0,
  reads: Reads = new Map(),
): Effect.Effect<Followed> =>
  Effect.gen(function* () {
    if (process.platform !== "win32") return { real: undefined }
    if (depth >= LIMIT) return { share: unresolved(file) }
    // Already a share or device spelling: it is the answer, and its root is not read as a folder.
    if (isShare(file)) return { share: file }
    const root = path.parse(file).root
    const parts = path.relative(root, file).split(path.sep)
    for (const index of parts.keys()) {
      const named = path.join(root, ...parts.slice(0, index + 1))
      // Each part is read once per question, however many links lead back through it.
      const target = reads.has(named)
        ? reads.get(named)
        : yield* fs.readLink(named).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.tap((read) => Effect.sync(() => reads.set(named, read))),
          )
      if (target === undefined) continue
      // The rest of the path is part of what the link leads to, so that one walk answers for it and the parts after the
      // link are not read again through it.
      const step = leadsTo(named, target, parts.slice(index + 1))
      if (step.answer !== undefined) return { share: step.answer }
      return yield* follow(fs, step.leads, depth + 1, reads)
    }
    return { real: file }
  })

/** The same question for a caller that cannot yield, such as the scheduling check. Only `readlink` is called, never a call that opens the target. */
export const ofSync = (file: string, depth = 0, reads: Reads = new Map()): string | undefined => {
  if (process.platform !== "win32") return undefined
  if (depth >= LIMIT) return unresolved(file)
  if (isShare(file)) return file
  const root = path.parse(file).root
  const parts = path.relative(root, file).split(path.sep)
  for (const index of parts.keys()) {
    const named = path.join(root, ...parts.slice(0, index + 1))
    const target = reads.has(named) ? reads.get(named) : readLinkSync(named)
    reads.set(named, target)
    if (target === undefined) continue
    const step = leadsTo(named, target, parts.slice(index + 1))
    return "answer" in step ? step.answer : ofSync(step.leads, depth + 1, reads)
  }
  return undefined
}

/** What the links already read answered, kept for the length of one question. */
export type Reads = Map<string, string | undefined>

// Where a link at `named` with the readlink answer `target` leads, with `rest` below it: the share or device it names, or
// the path to walk next.
function leadsTo(named: string, target: string, rest: string[]) {
  // A link to a device path (`\\?\Volume{…}\…`, `\\.\…`) reads back in the NT form `\??\…`, which `path.resolve`
  // would take for a folder named `??` on the current drive. It is named as the device path it is.
  if (target.startsWith("\\??\\")) return { answer: path.join(`\\\\?\\${target.slice(4)}`, ...rest) }
  const leads = path.join(path.resolve(path.dirname(named), target), ...rest)
  if (leads.startsWith("\\\\")) return { answer: leads }
  return { leads }
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
export const blocked = (fs: Reader, file: string, reads?: Reads) =>
  of(fs, file, 0, reads).pipe(Effect.map((found) => found !== undefined))

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
    // One set of answers for the whole listing: the parts above `cwd` are read once, not once per entry.
    const reads: Reads = new Map()
    if (yield* blocked(fs, cwd, reads)) return []
    const nocase = process.platform === "win32" || process.platform === "darwin"
    const found: string[] = []
    // The real folders already listed, so that a link back to a folder above (or beside) it is not listed again.
    const key = (file: string) => (nocase ? file.toLowerCase() : file)
    const start = (yield* followed(fs, cwd, reads)).real
    const seen = new Set<string>(start === undefined ? [] : [key(start)])
    const visit = (directory: string, relative: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > DEPTH) return
        const entries = yield* fs.readDirectoryEntries(directory).pipe(Effect.orElseSucceed(() => []))
        for (const entry of entries) {
          const full = path.join(directory, entry.name)
          const name = relative === "" ? entry.name : `${relative}/${entry.name}`
          const where = entry.type === "symlink" ? yield* followed(fs, full, reads) : undefined
          const kind =
            where === undefined
              ? entry.type
              : where.share || where.real === undefined
                ? ("other" as const)
                : yield* kindOf(fs, where.real)
          if (kind === "directory") {
            // A folder that no pattern can match below is not entered, and nor is a package folder, which holds thousands.
            if (!enters(name, patterns, nocase)) continue
            // Only a link can lead back, and it is known not to lead to a share.
            const real = key(where === undefined ? full : where.real!)
            if (where !== undefined && seen.has(real)) continue
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

// Where a link entry leads, as one walk of its links: a share, or the end of its chain. Off Windows, where the walk reads
// nothing, the file system resolves it. The end of a chain is asked about once and not hop by hop, which is what made a
// listing of 63 links to one folder take seconds.
const followed = (fs: FSUtil.Interface, file: string, reads: Reads) =>
  Effect.gen(function* () {
    const found = yield* follow(fs, file, 0, reads)
    if ("share" in found) return { share: true as const, real: file }
    if (found.real !== undefined) return { share: false as const, real: found.real }
    // Off Windows the file system resolves it. A link it cannot resolve (a loop, a path through a file, no access) is not a
    // share and is not followed; it must not be a defect, because a repository can ship one (class 7).
    const real = yield* fs.resolve(file).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`not following ${file}: ${Cause.pretty(cause).slice(0, 200)}`).pipe(Effect.as(undefined)),
      ),
    )
    return { share: false as const, real }
  })

// What the end of a chain is. It has no link on it, so asking does not follow one.
const kindOf = (fs: FSUtil.Interface, file: string) =>
  Effect.gen(function* () {
    if (yield* fs.isDir(file)) return "directory" as const
    if (yield* fs.isFile(file)) return "file" as const
    return "other" as const
  })

// Whether a file below the folder `name` (relative, with `/`) can match a pattern. `partial` answers for a path that is only
// the start of a match, so `commands` is entered for `{command,commands}/**/*.md` and `plugins` is not.
function enters(name: string, patterns: readonly string[], nocase: boolean) {
  if (name.split("/").includes("node_modules")) return false
  return patterns.some((pattern) => minimatch(name, pattern, { dot: true, nocase, partial: true }))
}
