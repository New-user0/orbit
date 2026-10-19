export * as GitLayout from "./layout.js"

import path from "path"
import { Effect } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { AbsolutePath } from "../schema.js"

// Where a folder keeps its git directory and its remote, read from the files git writes and never by running git.
//
// A clone chooses every one of these files, and git applies the config of whatever directory it finds, which can name
// programs for it to run (class 1). Orbit finds the project of a folder before anyone has decided about the folder, so it
// reads these files itself and starts git only for a folder that is trusted. It follows nothing that git itself would not
// have written: the folder's own `.git` directory, or the entry that `git worktree add` made for a linked worktree. Every
// other `.git` is named and left alone, because what it points at is the clone's to choose (class 3, 4, 5).

/** A pointer file holds one path or one name, so a longer file is not git's. */
const POINTER_LIMIT = 4096

/** A `.git/config` is a few kilobytes. A clone can ship any size, and one URL is read from it. */
const CONFIG_LIMIT = 1024 * 1024

/** The one line that `git worktree add` and `git init --separate-git-dir` write into a `.git` file. */
const POINTER = /^gitdir: ([^\r\n]+)\r?\n?$/

export interface Layout {
  /** The folder that holds `.git`. */
  readonly worktree: AbsolutePath
  /** The directory with this folder's `HEAD`: its own `.git`, or the entry that its repository keeps for a linked worktree. */
  readonly gitDirectory: AbsolutePath
  /** The directory with the refs, objects and config that every worktree of the repository shares. */
  readonly commonDirectory: AbsolutePath
  /** The main checkout when this folder is a linked worktree that its repository lists, and the folder itself otherwise. */
  readonly canonical: AbsolutePath
  /**
   * Whether `gitDirectory` is a place git itself made for this folder, which may be read. A `.git` that is a link, a
   * `.git` file that Orbit cannot match to a registered worktree (a submodule, a separate git directory, a forged one)
   * and a `.git` directory that names a `commondir` are named in the layout and not read further.
   */
  readonly verified: boolean
}

/**
 * The layout of the git directory in `folder`, or none when the folder holds no `.git` that git would take for one. It
 * reads at most three small files (the `HEAD` and `commondir` of a `.git` directory, or the `.git` pointer and the
 * `commondir` and `gitdir` of its entry) and starts no process.
 */
export const locate = Effect.fn("GitLayout.locate")(function* (fs: FSUtil.Interface, folder: string) {
  const files = reader(fs)
  const resolved = yield* files.real(folder)
  if (resolved === undefined) return undefined
  const here = AbsolutePath.make(resolved)
  const entry = path.join(here, ".git")
  const info = yield* files.stat(entry)
  if (info === undefined) return undefined
  // A link can lead to any repository, and git would follow it.
  if (yield* files.link(entry)) return unverified(here, entry)
  if (info.type === "Directory") return yield* ordinary(files, here, entry)
  if (info.type === "File") return yield* pointed(files, here, entry)
  return undefined
})

/**
 * The URL that the shared config of a verified layout gives remote `name`, as written. It reads the text of one key and
 * does not apply `url.<base>.insteadOf`, follow an include or look at any other scope, which `git remote get-url` does.
 */
export const remote = Effect.fn("GitLayout.remote")(function* (fs: FSUtil.Interface, layout: Layout, name = "origin") {
  if (!layout.verified) return undefined
  const config = yield* reader(fs).text(path.join(layout.commonDirectory, "config"), CONFIG_LIMIT)
  return config === undefined ? undefined : remoteUrl(config, name)
})

/**
 * The first `url` of `[remote "<name>"]` in the text of a git config. The syntax is the one `git help config` gives for a
 * section header and a value (quotes, `#` and `;` comments, backslash escapes, a backslash at the end of a line); nothing
 * in the text is run, included or expanded. The deprecated `[remote.<name>]` header is not read.
 */
export function remoteUrl(config: string, name = "origin") {
  let inside = false
  // A byte order mark in front of the text, and a backslash that ends a line, are not part of any key or value.
  for (const raw of config.replace(/^\u{FEFF}/u, "").replace(/\\\r?\n/g, "").split(/\r?\n/)) {
    const header = SECTION.exec(raw)
    // A key can follow its header on the same line.
    const rest = header ? header[3]! : raw
    if (header) inside = header[1]!.toLowerCase() === "remote" && header[2]?.replace(/\\(.)/g, "$1") === name
    const entry = KEY.exec(rest)
    if (!inside || !entry || entry[1]!.toLowerCase() !== "url" || entry[2] === undefined) continue
    const url = unquote(entry[2])
    if (url) return url
  }
  return undefined
}

const SECTION = /^\s*\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\](.*)$/
const KEY = /^\s*([A-Za-z][A-Za-z0-9-]*)\s*(?:=(.*))?$/
const ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", b: "\b" }

// A value as git reads it: a quote opens and closes a quoted span, a `#` or `;` outside one ends the line, and a backslash
// takes the character after it. Leading and trailing white space is not part of the value.
function unquote(value: string) {
  const out: string[] = []
  let quoted = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    if (char === "\\" && index + 1 < value.length) {
      const next = value[++index]!
      out.push(ESCAPES[next] ?? next)
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && (char === "#" || char === ";")) break
    out.push(char)
  }
  return out.join("").trim()
}

const unverified = (here: AbsolutePath, entry: string): Layout => ({
  worktree: here,
  gitDirectory: AbsolutePath.make(entry),
  commonDirectory: AbsolutePath.make(entry),
  canonical: here,
  verified: false,
})

// Git takes a `.git` directory for a repository when its `HEAD` names a ref under `refs/` or holds a commit ID, and the
// directory with its shared files has `objects` and `refs`. It passes over any other `.git` directory and looks in the
// folder above, so a folder whose `.git` git would pass over must not stand for the repository: the person would be asked
// about this folder while git works in the one above (class 3). Where Orbit cannot match git exactly it is stricter, and
// the folder it names then lies above the one git uses: a `HEAD` that is a link, a `HEAD` past 4 KiB, and an `objects` or
// `refs` that is not a directory are passed over.
const ordinary = Effect.fnUntraced(function* (files: Files, here: AbsolutePath, entry: string) {
  const head = path.join(entry, "HEAD")
  if ((yield* files.link(head)) || !HEAD_TEXT.test((yield* files.text(head, POINTER_LIMIT))?.slice(0, 255) ?? ""))
    return undefined
  // `commondir` moves refs, objects and config to another directory. `git worktree add` writes it into an entry under
  // `worktrees` and never into a `.git` directory, so one here is a layout that a clone forged for git to follow. Git
  // looks for `objects` and `refs` in the directory it names, which is read no further than that.
  const commondir = path.join(entry, "commondir")
  if ((yield* files.stat(commondir)) !== undefined) {
    const named = line(yield* files.text(commondir, POINTER_LIMIT))
    if (named === undefined || !(yield* shared(files, path.resolve(entry, FSUtil.windowsPath(named))))) return undefined
    return unverified(here, entry)
  }
  if (!(yield* shared(files, entry))) return undefined
  return {
    worktree: here,
    gitDirectory: AbsolutePath.make(entry),
    commonDirectory: AbsolutePath.make(entry),
    canonical: here,
    verified: true,
  } satisfies Layout
})

// What git reads of `HEAD`: its first 255 bytes, which start with `ref:`, any spaces, tabs or line breaks, and `refs/`, or
// with a commit ID (40 hex digits, which a 64-digit one starts with too).
const HEAD_TEXT = /^(?:ref:[ \t\r\n]*refs\/|[0-9a-fA-F]{40})/

// The directories that every git directory needs beside its `HEAD`.
const shared = Effect.fnUntraced(function* (files: Files, directory: string) {
  return (
    (yield* files.stat(path.join(directory, "objects")))?.type === "Directory" &&
    (yield* files.stat(path.join(directory, "refs")))?.type === "Directory"
  )
})

// A `.git` file is a pointer. An invalid one is not a repository, as for git. A valid one is a linked worktree only when its
// repository lists the folder.
const pointed = Effect.fnUntraced(function* (files: Files, here: AbsolutePath, entry: string) {
  const text = yield* files.text(entry, POINTER_LIMIT)
  const named = text === undefined ? undefined : POINTER.exec(text)?.[1]
  if (named === undefined) return undefined
  // A target that Orbit cannot match to this folder is named by the pointer only. Matching it reads the `commondir` and
  // `gitdir` files of the target, and nothing else there is opened.
  return (yield* linked(files, here, entry, path.resolve(here, FSUtil.windowsPath(named)))) ?? unverified(here, entry)
})

// `git worktree add` makes a folder whose `.git` file names an entry `<common>/worktrees/<name>`. That entry's `commondir`
// file names `<common>`, and its `gitdir` file names this folder's `.git` back. A `.git` file can name any entry, and a forged
// entry can name any `commondir`, but only a repository that the folder was added to lists it, so the entry has to sit
// directly under the `worktrees` of the `commondir` it names, and name this very `.git` (class 3). The back-link's folder is
// resolved and `.git` joined to it, so a `.git` that is itself a link cannot stand for another folder's.
const linked = Effect.fnUntraced(function* (files: Files, here: AbsolutePath, entry: string, target: string) {
  const common = line(yield* files.text(path.join(target, "commondir"), POINTER_LIMIT))
  const back = line(yield* files.text(path.join(target, "gitdir"), POINTER_LIMIT))
  if (common === undefined || back === undefined) return undefined
  const commonDirectory = yield* files.real(path.resolve(target, FSUtil.windowsPath(common)))
  const entries = yield* files.real(path.dirname(target))
  const listed = yield* files.real(path.dirname(path.resolve(target, FSUtil.windowsPath(back))))
  if (commonDirectory === undefined || entries === undefined || listed === undefined) return undefined
  if (!same(entries, path.join(commonDirectory, "worktrees"))) return undefined
  if (!same(path.join(listed, path.basename(back)), entry)) return undefined
  return {
    worktree: here,
    gitDirectory: AbsolutePath.make(path.join(entries, path.basename(target))),
    commonDirectory: AbsolutePath.make(commonDirectory),
    // The main checkout is the folder around a `.git`; the common directory of a bare repository is the checkout itself.
    canonical: AbsolutePath.make(same(path.basename(commonDirectory), ".git") ? path.dirname(commonDirectory) : commonDirectory),
    verified: true,
  } satisfies Layout
})

// The one line of a pointer file, or none for a file that is empty, has more lines, or was not read.
const line = (text: string | undefined) => (text === undefined ? undefined : /^([^\r\n]+)\r?\n?$/.exec(text)?.[1])

// Two real paths name the same place. `path.relative` ignores case on Windows, as the file system does.
const same = (left: string, right: string) => path.relative(left, right) === ""

type Files = ReturnType<typeof reader>

// What the reader asks of the disk. Every name is asked about a share and a link first, because a clone chooses the names
// and opening one that leads to a share connects to a host of its choosing (class 6). A name that is blocked, missing,
// too large or unreadable answers as not there, never as a failure (class 7).
function reader(fs: FSUtil.Interface) {
  // The links on the way to each name are read once for every question of one call.
  const reads: LinkShare.Reads = new Map()
  const stat = Effect.fnUntraced(function* (file: string) {
    if (yield* LinkShare.blocked(fs, file, reads)) return undefined
    return yield* fs.stat(file).pipe(Effect.orElseSucceed(() => undefined))
  })
  const text = Effect.fnUntraced(function* (file: string, limit: number) {
    const info = yield* stat(file)
    if (info?.type !== "File" || Number(info.size) > limit) return undefined
    return yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined))
  })
  // The real path, as the trust store spells it, so that two answers about one place agree.
  const real = Effect.fnUntraced(function* (file: string) {
    if (yield* LinkShare.blocked(fs, file, reads)) return undefined
    return yield* fs.realPath(file).pipe(Effect.map(FSUtil.normalizePath), Effect.orElseSucceed(() => undefined))
  })
  const link = (file: string) => fs.readLink(file).pipe(Effect.as(true), Effect.orElseSucceed(() => false))
  return { stat, text, real, link }
}
