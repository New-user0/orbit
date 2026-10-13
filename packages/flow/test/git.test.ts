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

// Git lists a worktree under the spelling of the folder as it is on disk, and the caller may spell the drive or a folder
// name with other case. A string prefix test then leaves the run's worktrees behind.
test.skipIf(process.platform !== "win32")(
  "a run is cleaned up whatever case the repository path is spelled with",
  async () => {
    const directory = await repository("spelling")
    const base = await Git.head(directory)
    const run = "run_20260101000005_0a1b2c"
    await Git.worktree(directory, run, "build", base)

    const respelled = directory.slice(0, 1).toLowerCase() + directory.slice(1).replace(/spelling$/, "SPELLING")
    expect(await Git.clean(respelled, run)).toEqual({ worktrees: 1, branches: 1 })
  },
)

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
