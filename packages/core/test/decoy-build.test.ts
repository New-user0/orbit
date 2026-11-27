// The decoy programs of a test run are links to one build that the run keeps (test/fixture/decoy.ts): each build is a
// 110 MB copy of the Bun runtime, and on a Windows runner writing one for every row held the other worker's disk work for
// seconds. A link must still behave as its own program, writing its ran.txt beside the path it was started by, so the
// program lookup rows keep what they check (class 10).
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { plant } from "./fixture/decoy"
import { runProgram } from "./fixture/run-program"
import { tmpdir } from "./fixture/tmpdir"

const identity = async (file: string) => {
  const stat = await fs.stat(file, { bigint: true })
  return `${stat.dev}:${stat.ino}`
}

describe("decoy programs", () => {
  test("in a run of the test runner every decoy is a link to the run's one build", async () => {
    const shared = process.env.ORBIT_TEST_PROGRAMS
    expect(shared).toBeDefined()
    await using first = await tmpdir()
    await using second = await tmpdir()
    const ranFirst = await plant(first.path, "git", "hg")
    const ranSecond = await plant(second.path, "git")
    const files = [path.join(first.path, "git.exe"), path.join(first.path, "hg.exe"), path.join(second.path, "git.exe")]
    const identities = await Promise.all(files.map(identity))
    expect(new Set(identities).size).toBe(1)
    const names = await fs.readdir(shared!)
    const builds = names.filter((name) => name.startsWith("decoy-"))
    expect(builds).toHaveLength(1)
    // This process's own build is gone once it is linked to the shared name (another worker's may be in progress).
    expect(names.filter((name) => name.startsWith(`build-${process.pid}-`))).toEqual([])
    expect(await identity(path.join(shared!, builds[0]!))).toBe(identities[0])
    // Each link writes beside itself: the second folder's decoy ran, the first folder's did not.
    expect((await runProgram([files[2]!, "status"])).exitCode).toBe(0)
    expect(await ranSecond()).toEqual(["git.exe status"])
    expect(await ranFirst()).toEqual([])
  }, 60_000)

  // A build makes the folder it writes to, and callers rely on it (packages/vscode/test/program.test.ts plants into a
  // folder it never made), so a link into a folder that is not there yet makes the folder first.
  test("a decoy linked into a folder that is not there yet makes the folder", async () => {
    await using root = await tmpdir()
    const folder = path.join(root.path, "not", "there")
    const ran = await plant(folder, "orb")
    expect(await identity(path.join(folder, "orb.exe"))).toBe(
      await identity(path.join(process.env.ORBIT_TEST_PROGRAMS!, (await fs.readdir(process.env.ORBIT_TEST_PROGRAMS!)).find((name) => name.startsWith("decoy-"))!)),
    )
    expect(await ran()).toEqual([])
  }, 60_000)

  // Control: a file run without the runner's folder builds a program of its own for each plant.
  test("without the runner's folder each plant builds its own program", async () => {
    const shared = process.env.ORBIT_TEST_PROGRAMS
    delete process.env.ORBIT_TEST_PROGRAMS
    try {
      await using first = await tmpdir()
      await using second = await tmpdir()
      await plant(first.path, "git")
      const ran = await plant(second.path, "git")
      expect(await identity(path.join(first.path, "git.exe"))).not.toBe(await identity(path.join(second.path, "git.exe")))
      expect((await runProgram([path.join(second.path, "git.exe")])).exitCode).toBe(0)
      expect(await ran()).toEqual(["git.exe"])
    } finally {
      process.env.ORBIT_TEST_PROGRAMS = shared
    }
  }, 60_000)
})
