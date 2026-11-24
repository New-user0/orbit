import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { testArgs } from "../../../tools/test/args"
import { mergeTimings } from "../../../tools/test/timings"
import { runTests } from "../../../tools/test/watchdog"
import { tmpdir } from "./fixture/tmpdir"

// The parts of tools/test that test-runner-deadline.test.ts and ci-shards.test.ts reach only through a child process or
// not at all: the watchdog called in this process, the deadline a file's measured time extends, the arguments of a serial
// run and of a run that writes timings, and the merge of the timings CI uploads.

const heartbeat = path.resolve(import.meta.dir, "../../../tools/test/heartbeat.ts")

async function suite(root: string, files: Record<string, string>, timings?: Record<string, number>) {
  await fs.mkdir(path.join(root, "test"), { recursive: true })
  await Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(root, "test", name), text)))
  if (timings) await Bun.write(path.join(root, "test", "timings.json"), JSON.stringify({ version: 1, files: timings }))
}

const args = (root: string) => [
  "test",
  "--parallel=2",
  `--preload=${heartbeat}`,
  `--timings=${path.join(root, "test", "timings.json")}`,
  "--only-failures",
]

describe("runTests", () => {
  test(
    "stops a file that blocks past the deadline, returns 1 and stops its worker",
    async () => {
      await using dir = await tmpdir()
      const pidFile = path.join(dir.path, "pid")
      await suite(dir.path, {
        "a.test.ts": `import { test } from "bun:test"\ntest("a", () => {})\n`,
        "stuck.test.ts": [
          `import { test } from "bun:test"`,
          `import { writeFileSync } from "node:fs"`,
          `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
          `test("spins", () => { const end = Date.now() + 40_000; while (Date.now() < end) {} })`,
        ].join("\n"),
      })
      const started = Date.now()
      const code = await runTests(args(dir.path), { ...process.env, ORBIT_TEST_FILE_DEADLINE_MS: "2000" }, dir.path)
      expect(code).toBe(1)
      expect(Date.now() - started).toBeLessThan(20_000)
      const pid = Number(await Bun.file(pidFile).text())
      expect(() => process.kill(pid, 0)).toThrow()
    },
    60_000,
  )

  test(
    "gives a file three times its measured time when that is longer than the deadline",
    async () => {
      await using dir = await tmpdir()
      // Four seconds at the top level: past a 1.5 s deadline, inside three times a 2 s measurement.
      await suite(
        dir.path,
        { "slow.test.ts": `import { test } from "bun:test"\nawait Bun.sleep(4000)\ntest("slow", () => {})\n` },
        { "test/slow.test.ts": 2000 },
      )
      const code = await runTests(args(dir.path), { ...process.env, ORBIT_TEST_FILE_DEADLINE_MS: "1500" }, dir.path)
      expect(code).toBe(0)
    },
    60_000,
  )

  test(
    "returns bun's own code when no file is stuck",
    async () => {
      await using dir = await tmpdir()
      await suite(dir.path, { "fails.test.ts": `import { expect, test } from "bun:test"\ntest("x", () => expect(1).toBe(2))\n` })
      expect(await runTests(args(dir.path), { ...process.env, ORBIT_TEST_FILE_DEADLINE_MS: "5000" }, dir.path)).toBe(1)
      await suite(dir.path, { "fails.test.ts": `import { expect, test } from "bun:test"\ntest("x", () => expect(1).toBe(1))\n` })
      expect(await runTests(args(dir.path), { ...process.env, ORBIT_TEST_FILE_DEADLINE_MS: "5000" }, dir.path)).toBe(0)
    },
    60_000,
  )
})

describe("testArgs", () => {
  const withWorkers = <T>(workers: string, body: () => T) => {
    const previous = process.env.ORBIT_TEST_WORKERS
    process.env.ORBIT_TEST_WORKERS = workers
    const result = body()
    if (previous === undefined) delete process.env.ORBIT_TEST_WORKERS
    else process.env.ORBIT_TEST_WORKERS = previous
    return result
  }

  test("a serial run gets no workers, no heartbeat, no timings and does not write them", async () => {
    await using dir = await tmpdir()
    await suite(dir.path, {}, {})
    expect(withWorkers("1", () => testArgs(["--update-timings", "--only-failures"], dir.path, "linux"))).toEqual([
      "test",
      "--only-failures",
    ])
  })

  test("a parallel run preloads the heartbeat and writes the platform's timings, made or not", async () => {
    await using dir = await tmpdir()
    const windows = withWorkers("2", () => testArgs(["--update-timings"], dir.path, "win32"))
    expect(windows).toEqual([
      "test",
      "--parallel=2",
      `--preload=${heartbeat}`,
      `--timings=${path.join(dir.path, "test", "timings.windows.json")}`,
      "--update-timings",
    ])
    expect(withWorkers("2", () => testArgs(["--update-timings"], dir.path, "linux"))).toContain(
      `--timings=${path.join(dir.path, "test", "timings.json")}`,
    )
    // Without timings to read or write, none is named.
    expect(withWorkers("2", () => testArgs([], dir.path, "win32")).some((arg) => arg.startsWith("--timings"))).toBe(false)
    // Windows reads the Linux timings until it has its own.
    await suite(dir.path, {}, {})
    expect(withWorkers("2", () => testArgs([], dir.path, "win32"))).toContain(
      `--timings=${path.join(dir.path, "test", "timings.json")}`,
    )
  })
})

describe("mergeTimings", () => {
  test("joins every shard of a platform, keeps the platforms apart, sorts by name and drops files that are gone", async () => {
    await using root = await tmpdir()
    await using downloads = await tmpdir()
    await fs.mkdir(path.join(root.path, "packages", "cli", "test"), { recursive: true })
    await Promise.all(
      ["b.test.ts", "a.test.ts", "c.test.ts"].map((name) => Bun.write(path.join(root.path, "packages", "cli", "test", name), "")),
    )
    const artifact = async (name: string, file: string, files: Record<string, number>) => {
      await fs.mkdir(path.join(downloads.path, name))
      await Bun.write(path.join(downloads.path, name, file), JSON.stringify({ version: 1, files }))
    }
    await artifact("timings-linux-cli-1of2", "timings.json", { "test/b.test.ts": 2, "test/gone.test.ts": 9 })
    await artifact("timings-linux-cli-2of2", "timings.json", { "test/a.test.ts": 1 })
    await artifact("timings-windows-cli", "timings.windows.json", { "test/c.test.ts": 3 })
    await fs.mkdir(path.join(downloads.path, "lcov-linux-cli-1of2"))
    const lines = await mergeTimings(downloads.path, root.path)
    expect(lines.toSorted()).toEqual(["cli: 1 files in test/timings.windows.json", "cli: 2 files in test/timings.json"])
    const linux = await Bun.file(path.join(root.path, "packages", "cli", "test", "timings.json")).json()
    expect(linux).toEqual({ version: 1, files: { "test/a.test.ts": 1, "test/b.test.ts": 2 } })
    expect(Object.keys(linux.files)).toEqual(["test/a.test.ts", "test/b.test.ts"])
    expect(await Bun.file(path.join(root.path, "packages", "cli", "test", "timings.windows.json")).json()).toEqual({
      version: 1,
      files: { "test/c.test.ts": 3 },
    })
  })
})
