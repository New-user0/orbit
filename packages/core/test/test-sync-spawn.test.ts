import { describe, expect, test } from "bun:test"
import path from "path"

// A synchronous spawn that never returns holds its test worker for good: bun's per-test timeout is a timer, and no timer
// fires while the call runs. On Linux, Bun.spawnSync sometimes never returns after its child has exited: the worker spins
// at full CPU with the child left a zombie, the other worker runs every file that is left, and the run never ends. That
// is how the Linux core job hung until GitHub cancelled it at 90 minutes (2026-11-07, 11-22, 11-23 and 11-24), and how the
// cli trust rows hung before 7788efda moved them to an asynchronous spawn with a limit. So no test code starts a program
// synchronously; it awaits an asynchronous spawn under a deadline that kills the child and names the command.

const repo = path.resolve(import.meta.dir, "../../..")
// A call of Bun.spawnSync, or of node's spawnSync, execSync or execFileSync, however it was imported.
const synchronous = /\b(?:spawnSync|execSync|execFileSync)\s*\(/
const self = path.relative(repo, import.meta.path).split(path.sep).join("/")

// Every file the package suites run or start: everything under a package's test folder, and test files kept in src.
const files = (
  await Promise.all(
    ["packages/*/test/**/*.{ts,tsx,js,mjs}", "packages/*/src/**/*.test.{ts,tsx}"].map((pattern) =>
      Array.fromAsync(new Bun.Glob(pattern).scan(repo)),
    ),
  )
)
  .flat()
  .map((file) => file.split(path.sep).join("/"))
  .filter((file) => !file.split("/").includes("node_modules") && file !== self)

describe("test code starts no program synchronously", () => {
  test("the matcher finds every spelling of a synchronous spawn and nothing else", () => {
    const planted = [
      'Bun.spawnSync(["git", "status"])',
      "Bun.spawnSync ([sh])",
      'spawnSync("cmd", ["/c", "ver"])',
      'child_process.execSync("ls")',
      'execFileSync("git", ["init"])',
    ]
    const clean = [
      'Bun.spawn(["git", "status"])',
      "await child.exited",
      "// It is never started with `Bun.spawnSync`: a synchronous spawn",
      'execFile("git", ["init"], callback)',
      "where(/\\b(?:execFile|execFileSync|exec|execSync|spawn|spawnSync|fork)\\s*\\(/)",
    ]
    expect(planted.filter((line) => !synchronous.test(line))).toEqual([])
    expect(clean.filter((line) => synchronous.test(line))).toEqual([])
  })

  test("no test file, fixture or test helper calls one", async () => {
    expect(files.length).toBeGreaterThan(500)
    const found = (
      await Promise.all(
        files.map(async (file) =>
          (await Bun.file(path.join(repo, file)).text())
            .split(/\r?\n/)
            .flatMap((line, index) => (synchronous.test(line) ? [`${file}:${index + 1}`] : [])),
        ),
      )
    ).flat()
    expect(found).toEqual([])
  })
})
