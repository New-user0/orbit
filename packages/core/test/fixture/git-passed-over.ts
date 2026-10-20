import { realpathSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { build, keys, marker } from "./git-keys"
import { tmpdirScoped } from "./tmpdir"

// A `.git` directory that git does not take for a repository: git passes over it and uses the repository above, with that
// repository's config (class 1, class 3). Git takes one only when its `HEAD` names a ref under `refs/` or holds a commit
// ID, read as bytes, and the directory with its shared files has `objects` and `refs` that it may search (in the
// directory that a `commondir` names, when there is one). Each shape fills `entry`, the `.git` of a folder, with one way
// to miss; `elsewhere` is an empty folder.

export type Shape = readonly [name: string, fill: (entry: string, elsewhere: string) => Promise<void>]

const head = (entry: string, text: string | Uint8Array = "ref: refs/heads/main\n") =>
  fs.writeFile(path.join(entry, "HEAD"), text)
const folders = (entry: string, ...names: string[]) =>
  Promise.all(names.map((name) => fs.mkdir(path.join(entry, name), { recursive: true })))

// A folder that its owner cannot search stops git only where permissions are checked: outside Windows, and for an
// account other than root, which may search any folder.
const searchChecked = process.platform !== "win32" && process.getuid?.() !== 0

export const shapes: readonly Shape[] = [
  ["a .git that holds only HEAD", (entry) => head(entry)],
  ["a .git with no objects", async (entry) => (await folders(entry, "refs"), await head(entry))],
  ["a .git with no refs", async (entry) => (await folders(entry, "objects"), await head(entry))],
  [
    "a .git whose HEAD names no ref and holds no commit ID",
    async (entry) => (await folders(entry, "objects", "refs"), await head(entry, "main\n")),
  ],
  [
    "a .git whose commondir names a folder that is not a repository",
    async (entry, elsewhere) => {
      await folders(entry, "objects", "refs")
      await head(entry)
      await fs.writeFile(path.join(entry, "commondir"), `${elsewhere}\n`)
    },
  ],
  [
    "a .git whose HEAD starts with a byte order mark",
    async (entry) => {
      await folders(entry, "objects", "refs")
      await head(entry, new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("ref: refs/heads/main\n")]))
    },
  ],
  ...(searchChecked
    ? ([
        [
          "a .git whose objects folder cannot be searched (mode 000)",
          async (entry) => {
            await folders(entry, "objects", "refs")
            await head(entry)
            await fs.chmod(path.join(entry, "objects"), 0o000)
          },
        ],
      ] satisfies Shape[])
    : []),
]

/** Lets the folders of a `.git` that a shape made unsearchable be searched again, so that the test can remove them. */
export const searchable = (entry: string) =>
  Effect.addFinalizer(() =>
    Effect.promise(() =>
      Promise.all(["objects", "refs"].map((name) => fs.chmod(path.join(entry, name), 0o755).catch(() => undefined))),
    ),
  )

// The keys that the surfaces reach: `status` runs the file system monitor and the clean filter, `diff` the clean filter
// and the text conversion, and `log` the program that checks a signature. The signed commit is made first, because
// making it reads the index, which would run a file system monitor planted before it.
const planting = ["gpg.program", "core.fsmonitor", "filter.<driver>.clean", "diff.<driver>.textconv"].map(
  (name) => keys.find((key) => key.name === name)!,
)

const real = (file: string) => realpathSync.native(file)

// The keys of the filter and the text conversion each write a `.gitattributes` that selects their own driver; both drivers
// are selected here.
const attributes = (root: string) => Bun.write(path.join(root, ".gitattributes"), "*.txt filter=marker diff=marker\n")

/**
 * A `.git` in `sub` that git takes for a repository, and that leads git into the repository of `outer` above it, whose
 * config and hooks then apply: a `.git` file that names that repository's git directory, a `.git` directory whose
 * `commondir` names it, a `.git` that is a junction (Windows) or a link to it, and a `.git` file that names a directory in
 * it as a submodule's does, which holds a copy of that repository's git directory and so its config. Each also puts a
 * file and the `.gitattributes` of `outer` into `sub`, so that a filter and a text conversion have a file to work on.
 */
export const pointers: readonly Shape[] = [
  [
    "a .git file that names the git directory of the repository above",
    async (entry) => {
      await fs.rm(entry, { recursive: true, force: true })
      await fs.writeFile(entry, "gitdir: ../.git\n")
      await work(entry)
    },
  ],
  [
    "a .git directory whose commondir names the git directory above, with a copy of its index",
    async (entry) => {
      await head(entry)
      await fs.writeFile(path.join(entry, "commondir"), "../../.git\n")
      await fs.copyFile(path.join(entry, "..", "..", ".git", "index"), path.join(entry, "index"))
      await work(entry)
    },
  ],
  [
    "a .git that is a junction or link to the git directory above",
    async (entry) => {
      await fs.rm(entry, { recursive: true, force: true })
      await fs.symlink(path.join(entry, "..", "..", ".git"), entry, process.platform === "win32" ? "junction" : "dir")
      await work(entry)
    },
  ],
  [
    "a .git file that names a submodule's directory in the repository above, with that repository's config",
    async (entry, elsewhere) => {
      const outer = path.join(entry, "..", "..", ".git")
      await fs.cp(outer, path.join(elsewhere, "module"), { recursive: true })
      await fs.mkdir(path.join(outer, "modules"), { recursive: true })
      await fs.rename(path.join(elsewhere, "module"), path.join(outer, "modules", "sub"))
      await fs.rm(entry, { recursive: true, force: true })
      await fs.writeFile(entry, "gitdir: ../.git/modules/sub\n")
      await work(entry)
    },
  ],
]

// The file and the `.gitattributes` of the repository above, in the folder of `entry`.
const work = async (entry: string) => {
  await Bun.write(path.join(entry, "..", "a.txt"), "two\n")
  await Bun.write(path.join(entry, "..", ".gitattributes"), "*.txt filter=marker diff=marker\n")
}

/**
 * A repository `root` whose config makes git run a program for each command that the surfaces start, and a folder `sub`
 * in it, with a file that the repository's `.gitignore` names. `fill` makes the `.git` of `sub`; without it `sub` has
 * none. `ran` reads what the program of `root` has run.
 */
export const outer = (fill?: Shape[1]) =>
  Effect.gen(function* () {
    const folder = (yield* tmpdirScoped("orbit-git-outer-")).path
    const root = path.join(folder, "clone")
    const sub = path.join(root, "sub")
    const recorder = yield* Effect.promise(async () => {
      const own = path.join(folder, "outer")
      await fs.mkdir(own, { recursive: true })
      const recorder = await marker(own)
      await build(root, planting, recorder.program, own)
      await attributes(root)
      await fs.mkdir(path.join(sub, ".git"), { recursive: true })
      await fs.mkdir(path.join(folder, "elsewhere"), { recursive: true })
      await Bun.write(path.join(root, ".gitignore"), "sub/hidden.txt\n")
      await Bun.write(path.join(sub, "hidden.txt"), "x\n")
      if (fill) await fill(path.join(sub, ".git"), path.join(folder, "elsewhere"))
      else await fs.rm(path.join(sub, ".git"), { recursive: true })
      return recorder
    })
    yield* searchable(path.join(sub, ".git"))
    return { folder, root: real(root), sub: real(sub), ran: () => Effect.promise(recorder.ran) }
  })

/**
 * The control: `sub` of `outer` made a repository that git takes, with the same keys planted to run a program of its own,
 * and the reader of what that program has run.
 */
export const inner = (found: { readonly folder: string; readonly sub: string }) =>
  Effect.promise(async () => {
    const own = path.join(found.folder, "inner")
    await fs.mkdir(own, { recursive: true })
    const recorder = await marker(own)
    await fs.rm(path.join(found.sub, ".git"), { recursive: true, force: true })
    await build(found.sub, planting, recorder.program, own)
    await attributes(found.sub)
    await Bun.write(path.join(found.sub, ".gitignore"), "hidden.txt\n")
    return { ran: () => Effect.promise(recorder.ran) }
  })

/** Whether git, by its trace, opened the repository whose work tree is `root`. */
export const opened = (worktrees: readonly string[], root: string) =>
  worktrees.some((worktree) => path.relative(worktree, root) === "")
