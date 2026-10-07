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
