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
