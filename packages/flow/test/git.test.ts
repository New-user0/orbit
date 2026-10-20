import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Git } from "../src/git"

const root = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-flow-git-"))

afterAll(() => fs.rm(root, { recursive: true, force: true }))

async function repository(name: string) {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  await Bun.write(path.join(directory, "calc.py"), "x = 1\n")
  await Git.git(directory, ["init", "-q", "-b", "main"])
  await Git.git(directory, ["add", "-A"])
  await Git.git(directory, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"])
  return directory
}

test("agent commits leave out caches that tools generate", async () => {
  const directory = await repository("commit")
  await Bun.write(path.join(directory, "test_calc.py"), "def test(): pass\n")
  await Bun.write(path.join(directory, "__pycache__", "calc.cpython-311.pyc"), "cache")
  await Bun.write(path.join(directory, "pkg", "__pycache__", "mod.pyc"), "cache")
  await Bun.write(path.join(directory, ".pytest_cache", "v", "cache"), "cache")
  await Bun.write(path.join(directory, "node_modules", "left-pad", "index.js"), "cache")

  expect(await Git.commit(directory, "agent work")).toBe(true)

  const tracked = (await Git.git(directory, ["ls-files"])).stdout.split("\n")
  expect(tracked).toEqual(["calc.py", "test_calc.py"])
  expect(await Git.commit(directory, "nothing new")).toBe(false)
})

// A run ID comes from the run store, a file in the repository that a clone brings along, and becomes a folder to remove
// and a branch to delete, so a run named like a path must lead nowhere.
test("a run that is named like a path never takes clean or worktree out of .orbit/worktrees", async () => {
  const directory = await repository("traversal")
  const base = await Git.head(directory)
  // `../../../victim` from .orbit/worktrees is the folder beside the repository, and `../..` is the repository itself.
  const victim = path.join(root, "victim")
  await Bun.write(path.join(victim, "precious.txt"), "keep\n")
  await Bun.write(path.join(directory, ".orbit", "keep.txt"), "keep\n")
  const before = await fs.readdir(root)

  for (const run of ["../../../victim", "../..", "..", ".", "", "a/b", "*", "run?", "run\n"]) {
    await expect(Git.clean(directory, run)).rejects.toThrow("Not a run")
    await expect(Git.worktree(directory, run, "node", base)).rejects.toThrow("Not a run")
  }

  expect(await fs.readdir(victim)).toEqual(["precious.txt"])
  expect(await Bun.file(path.join(directory, ".orbit", "keep.txt")).text()).toBe("keep\n")
  expect(await Bun.file(path.join(directory, "calc.py")).text()).toBe("x = 1\n")
  expect(await fs.readdir(root)).toEqual(before)
})

test("a node named like a path stays inside the folder of its run, and a run is cleaned up with its branch", async () => {
  const directory = await repository("nodes")
  const base = await Git.head(directory)
  const run = "run_20260101000004_0a1b2c"
  const worktrees = path.join(directory, ".orbit", "worktrees")

  for (const node of ["..", ".", "...", ""])
    await expect(Git.worktree(directory, run, node, base)).rejects.toThrow("Not a node")
  expect(await fs.readdir(worktrees).catch(() => [])).toEqual([])

  const place = await Git.worktree(directory, run, "build/test", base)
  // What is not a plain name is made into one, as before.
  expect(place).toEqual({ directory: path.join(worktrees, run, "build-test"), branch: `orbit/${run}/build-test` })
  expect(await Git.clean(directory, run)).toEqual({ worktrees: 1, branches: 1 })
  expect(await fs.readdir(path.join(directory, ".orbit"))).not.toContain("worktrees")
})

// Git can fail one of several concurrent `worktree add` calls in a repository ("failed to read commondir"), a race that
// shows about once in a few hundred adds. The post-checkout hook runs inside each add, so a hook that is slow and logs
// when it starts and ends shows whether two adds overlapped.
test("worktrees of parallel nodes are added one at a time", async () => {
  const directory = await repository("parallel")
  const base = await Git.head(directory)
  const log = path.join(directory, ".git", "adds.log")
  const hook = path.join(directory, ".git", "hooks", "post-checkout")
  await Bun.write(hook, `#!/bin/sh\necho start >> "${log.replaceAll("\\", "/")}"\nsleep 0.3\necho end >> "${log.replaceAll("\\", "/")}"\n`)
  await fs.chmod(hook, 0o755)
  const run = "run_20260101000006_0a1b2c"

  const places = await Promise.all(["a", "b", "c", "d"].map((node) => Git.worktree(directory, run, node, base)))

  expect((await Bun.file(log).text()).split(/\r?\n/).filter(Boolean)).toEqual(Array(4).fill(["start", "end"]).flat())
  expect(places.map((place) => place.branch).sort()).toEqual(["a", "b", "c", "d"].map((node) => `orbit/${run}/${node}`))
  for (const place of places) expect(await fs.stat(place.directory)).toBeTruthy()
})

// Git lists a worktree under the long name of each folder, in the case it has on disk, and the caller may spell the
// repository otherwise: a drive or folder name in other case, or the 8.3 short name of a folder (GitHub's Windows runner
// hands out a temporary folder under `C:\Users\RUNNER~1`). Compared as strings, the run's worktree is not found, it is
// left in place, and its branch cannot be deleted.
const LONG = "a folder with a long name"
// NTFS names the only folder of a fresh folder whose name is LONG this way, unless the volume makes no short names.
const SHORT = "AFOLDE~1"
const shortNames =
  process.platform === "win32" &&
  (await fs.mkdir(path.join(root, LONG), { recursive: true }).then(async () => {
    const real = await fs.realpath(path.join(root, LONG))
    return (await fs.realpath(path.join(root, SHORT)).catch(() => undefined)) === real
  }))

test.skipIf(process.platform !== "win32")(
  "a run is cleaned up with its branch whatever case or short name the repository path is spelled with",
  async () => {
    const spellings = [
      {
        name: "case",
        folder: path.join(root, "case"),
        spell: (directory: string) => directory.slice(0, 1).toLowerCase() + directory.slice(1).replace(/case$/, "CASE"),
      },
      ...(shortNames
        ? [
            {
              name: "short",
              folder: path.join(root, LONG, "short"),
              spell: (directory: string) => directory.replace(LONG, SHORT),
            },
            {
              name: "short-case",
              folder: path.join(root, LONG, "short-case"),
              spell: (directory: string) => directory.replace(LONG, SHORT).toUpperCase(),
            },
          ]
        : []),
    ]
    // Without short names on this volume, only the case row runs; GitHub's runner covers the short name through `root`.
    if (!shortNames) console.warn("8.3 short names are off on this volume: the short-name rows do not run")

    const results = await Promise.all(
      spellings.map(async (spelling, index) => {
        const directory = await repository(path.relative(root, spelling.folder))
        const run = `run_2026010100001${index}_0a1b2c`
        await Git.worktree(directory, run, "build", await Git.head(directory))
        const respelled = spelling.spell(directory)
        const cleaned = await Git.clean(respelled, run)
        const left = (await Git.git(directory, ["for-each-ref", "--format=%(refname:short)", `refs/heads/orbit/${run}/`]))
          .stdout
        const listed = (await Git.git(directory, ["worktree", "list", "--porcelain"])).stdout
          .split("\n")
          .filter((line) => line.startsWith("worktree ")).length
        return { name: spelling.name, respelled: respelled !== directory, cleaned, left, listed }
      }),
    )

    expect(results).toEqual(
      spellings.map((spelling) => ({
        name: spelling.name,
        respelled: true,
        cleaned: { worktrees: 1, branches: 1 },
        left: "",
        listed: 1,
      })),
    )
  },
)

// Git lists a worktree under the path it was added at. When the repository has since moved and its old path is a link to
// the new one, that path is not real, and the run's folder may be gone too: git lists such a worktree until it is pruned.
test("a run is cleaned up with its branch when git lists its worktree under a link or its folder is gone", async () => {
  const rows = [
    { name: "linked", link: true, gone: false },
    { name: "gone", link: false, gone: true },
    { name: "linked-gone", link: true, gone: true },
  ]

  // Git lists the long name of each folder, in the case it has on disk, whatever spelling of the temporary folder `root`
  // holds (on GitHub's Windows runner an 8.3 short name), so the control looks for that spelling.
  const longRoot = await fs.realpath(root)
  const fold = (file: string) =>
    process.platform === "win32" ? file.replaceAll("\\", "/").toLowerCase() : file.replaceAll("\\", "/")

  const results = await Promise.all(
    rows.map(async (row, index) => {
      const added = await repository(`moved-${row.name}`)
      const run = `run_2026010100002${index}_0a1b2c`
      await Git.worktree(added, run, "build", await Git.head(added))
      const directory = row.link ? `${added}-now` : added
      if (row.link) {
        await fs.rename(added, directory)
        await fs.symlink(directory, added, process.platform === "win32" ? "junction" : "dir")
      }
      if (row.gone) await fs.rm(path.join(directory, ".orbit", "worktrees", run), { recursive: true, force: true })
      const before = (await Git.git(directory, ["worktree", "list", "--porcelain"])).stdout
      const cleaned = await Git.clean(directory, run)
      const left = (await Git.git(directory, ["for-each-ref", "--format=%(refname:short)", `refs/heads/orbit/${run}/`]))
        .stdout
      const listed = (await Git.git(directory, ["worktree", "list", "--porcelain"])).stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length
      // The control: git lists the worktree under the path it was added at, not under the repository's real path.
      const control = fold(before).includes(fold(`${path.join(longRoot, `moved-${row.name}`)}/.orbit/`))
      return { name: row.name, control, cleaned, left, listed }
    }),
  )

  expect(results).toEqual(
    rows.map((row) => ({
      name: row.name,
      control: true,
      cleaned: { worktrees: 1, branches: 1 },
      left: "",
      listed: 1,
    })),
  )
})

// A worktree can sit on a drive that is no longer there (a removed disk, or a `subst` drive that went away), and git
// lists it until it is pruned. Its path has no folder up to its drive that exists.
test.skipIf(process.platform !== "win32")("a worktree listed on a drive that is gone leaves a run's clean working", async () => {
  const letters = await Promise.all(
    [..."QRSTUVWXYZ"].map(async (letter) => ((await fs.stat(`${letter}:\\`).catch(() => undefined)) ? [] : [letter])),
  )
  const letter = letters.flat()[0]
  if (letter === undefined) throw new Error("every drive letter from Q to Z is in use")
  const directory = await repository("drive-gone")
  const run = "run_20260101000030_0a1b2c"
  await Git.worktree(directory, run, "build", await Git.head(directory))
  const admin = path.join(directory, ".git", "worktrees", "elsewhere")
  await Bun.write(path.join(admin, "gitdir"), `${letter}:/elsewhere/.git\n`)
  await Bun.write(path.join(admin, "commondir"), "../..\n")
  await Bun.write(path.join(admin, "HEAD"), `${await Git.head(directory)}\n`)
  // The control: git lists the worktree on the missing drive.
  expect((await Git.git(directory, ["worktree", "list", "--porcelain"])).stdout).toContain(`worktree ${letter}:/elsewhere`)

  expect(await Git.clean(directory, run)).toEqual({ worktrees: 1, branches: 1 })
  expect((await Git.git(directory, ["for-each-ref", "--format=%(refname:short)", `refs/heads/orbit/${run}/`])).stdout).toBe(
    "",
  )
})

test("a merge that would overwrite untracked files reports them and changes nothing", async () => {
  const directory = await repository("blocked")
  await Git.git(directory, ["checkout", "-q", "-b", "agent"])
  await Bun.write(path.join(directory, "notes.txt"), "from the agent\n")
  await Git.commit(directory, "agent work")
  await Git.git(directory, ["checkout", "-q", "main"])
  await Bun.write(path.join(directory, "notes.txt"), "mine\n")

  const outcome = await Git.merge(directory, "agent", "merge agent")

  expect(outcome).toEqual({ merged: false, files: [], blocked: ["notes.txt"] })
  expect(await Bun.file(path.join(directory, "notes.txt")).text()).toBe("mine\n")
  expect((await Git.git(directory, ["rev-list", "--count", "HEAD"])).stdout).toBe("1")
})

// Review of #118: the run store is found by two lookups, and in a folder with a stray empty `.git` directory they must
// name the same folder, or `orb flow run` writes one store and `orb flow ls` reads another. The server names the
// repository above as the project of such a folder, which is where `root` may look.
test("holder passes over a .git directory with no HEAD, as root does", async () => {
  const directory = await repository("stray")
  const inner = path.join(directory, "sub")
  await fs.mkdir(path.join(inner, ".git"), { recursive: true })

  expect(Git.holder(inner)).toBe(directory)
  expect(await Git.root(inner, { directory, canonical: directory })).toEqual({ root: await fs.realpath(directory) })
})
