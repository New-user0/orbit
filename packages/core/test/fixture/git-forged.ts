import { realpathSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { AbsolutePath } from "@orbit/core/schema"
import { git, repository } from "./git"
import { tmpdirScoped } from "./tmpdir"

// A clone chooses every file under its `.git`, so it can name another repository's directories there. These are the layouts
// that it can ship (class 3), over a victim: a repository with a remote, and a linked worktree that git added to it. The folder
// that the clone fills in is `crafted`. Each forgery must leave `crafted` its own canonical folder, never the victim's.

export interface Found {
  readonly root: string
  readonly victim: AbsolutePath
  readonly linked: AbsolutePath
  readonly crafted: AbsolutePath
  /** The entry that the victim's repository keeps for its linked worktree. */
  readonly entry: string
}

// The path as the file system spells it (`native` also expands a short Windows name), which is how git and Orbit spell it.
const real = (file: string) => Effect.sync(() => AbsolutePath.make(realpathSync.native(file)))

export const folders = Effect.gen(function* () {
  const root = (yield* tmpdirScoped()).path
  yield* repository(path.join(root, "victim"), "git@example.test:victim/repo.git")
  yield* Effect.promise(async () => {
    await git(path.join(root, "victim"), "worktree", "add", "--detach", path.join(root, "linked"))
    await fs.mkdir(path.join(root, "crafted"))
  })
  const victim = yield* real(path.join(root, "victim"))
  return {
    root,
    victim,
    linked: yield* real(path.join(root, "linked")),
    crafted: yield* real(path.join(root, "crafted")),
    entry: path.join(victim, ".git", "worktrees", "linked"),
  } satisfies Found
})

/** Each forgery fills `crafted` with a layout that names the victim, and leaves the victim as it was except where it says. */
export const forgeries: ReadonlyArray<readonly [string, (found: Found) => Promise<void>]> = [
  [
    "a .git file that names another repository's common directory through a forged entry",
    async (found) => {
      await fs.mkdir(path.join(found.crafted, "gd"))
      await fs.writeFile(path.join(found.crafted, "gd", "HEAD"), "ref: refs/heads/main\n")
      await fs.writeFile(path.join(found.crafted, "gd", "commondir"), path.join(found.victim, ".git"))
      await fs.writeFile(path.join(found.crafted, "gd", "gitdir"), path.join(found.crafted, ".git"))
      await fs.writeFile(path.join(found.crafted, ".git"), "gitdir: ./gd\n")
    },
  ],
  [
    "a .git file that names the entry of the victim's real worktree, which names another folder back",
    async (found) => fs.writeFile(path.join(found.crafted, ".git"), `gitdir: ${found.entry}\n`),
  ],
  [
    "a .git file that names an entry with no back-link",
    async (found) => {
      await fs.rm(path.join(found.entry, "gitdir"))
      await fs.writeFile(path.join(found.crafted, ".git"), `gitdir: ${found.entry}\n`)
    },
  ],
  [
    "a .git file that names an entry with no commondir",
    async (found) => {
      await fs.rm(path.join(found.entry, "commondir"))
      await fs.writeFile(path.join(found.crafted, ".git"), `gitdir: ${found.entry}\n`)
    },
  ],
  [
    "a .git file whose entry names a back-link that does not exist",
    async (found) => {
      await fs.writeFile(path.join(found.entry, "gitdir"), path.join(found.root, "nowhere", ".git"))
      await fs.writeFile(path.join(found.crafted, ".git"), `gitdir: ${found.entry}\n`)
    },
  ],
  [
    "a .git file that names the victim's .git directory itself",
    async (found) => fs.writeFile(path.join(found.crafted, ".git"), `gitdir: ${path.join(found.victim, ".git")}\n`),
  ],
  [
    "a .git file that names a folder that is not there",
    async (found) => fs.writeFile(path.join(found.crafted, ".git"), "gitdir: ../nowhere/at/all\n"),
  ],
  [
    "a .git directory that holds a commondir file naming the victim's",
    async (found) => {
      await fs.mkdir(path.join(found.crafted, ".git"))
      await fs.writeFile(path.join(found.crafted, ".git", "HEAD"), "ref: refs/heads/main\n")
      await fs.writeFile(path.join(found.crafted, ".git", "commondir"), path.join(found.victim, ".git"))
    },
  ],
  [
    "a .git that is a link to the victim's .git directory",
    async (found) => fs.symlink(path.join(found.victim, ".git"), path.join(found.crafted, ".git"), "junction"),
  ],
]
