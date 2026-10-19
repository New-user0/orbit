import { realpathSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { build, keys, marker } from "./git-keys"
import { tmpdirScoped } from "./tmpdir"

// A `.git` directory that git does not take for a repository: git passes over it and uses the repository above, with that
// repository's config (class 1, class 3). Git takes one only when its `HEAD` names a ref under `refs/` or holds a commit
// ID, and the directory with its shared files has `objects` and `refs` (in the directory that a `commondir` names, when
// there is one). Each shape fills `entry`, the `.git` of a folder, with one way to miss; `elsewhere` is an empty folder.

export type Shape = readonly [name: string, fill: (entry: string, elsewhere: string) => Promise<void>]

const head = (entry: string, text = "ref: refs/heads/main\n") => fs.writeFile(path.join(entry, "HEAD"), text)
const folders = (entry: string, ...names: string[]) =>
  Promise.all(names.map((name) => fs.mkdir(path.join(entry, name), { recursive: true })))

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
]

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
