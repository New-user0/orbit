import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { testArgs } from "../../../tools/test/args"
import { mergeTimings, refresh } from "../../../tools/test/timings"
import { runTests } from "../../../tools/test/watchdog"
import { runProgram } from "./fixture/run-program"
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

const quick = `import { test } from "bun:test"\ntest("quick", () => {})\n`

// The heartbeat folders this worker's runs left in the temporary folder.
const heartbeats = async () =>
  (await fs.readdir(os.tmpdir())).filter((name) => name.startsWith("orbit-heartbeat-")).length

describe("runTests", () => {
  test(
    "stops a file that blocks past the deadline within a poll, returns 1, stops its worker and removes its folder",
    async () => {
      await using dir = await tmpdir()
      const startFile = path.join(dir.path, "started")
      await suite(dir.path, {
        "a.test.ts": quick,
        "stuck.test.ts": [
          `import { test } from "bun:test"`,
          `import { writeFileSync } from "node:fs"`,
          `writeFileSync(${JSON.stringify(startFile)}, JSON.stringify({ pid: process.pid, at: Date.now() }))`,
          `test("spins", () => { const end = Date.now() + 40_000; while (Date.now() < end) {} })`,
        ].join("\n"),
      })
      const before = await heartbeats()
      const code = await runTests(args(dir.path), { ...process.env, ORBIT_TEST_FILE_DEADLINE_MS: "1000" }, dir.path)
      const ended = Date.now()
      expect(code).toBe(1)
      const started = (await Bun.file(startFile).json()) as { pid: number; at: number }
      // A one-second deadline is looked at every quarter second, so the run ends soon after it, not at a 5 s poll.
      expect(ended - started.at).toBeLessThan(4_000)
      // Gone, not only killed: on Linux the run waits until the killed worker has been reaped.
      expect(() => process.kill(started.pid, 0)).toThrow()
      expect(await heartbeats()).toBe(before)
    },
    60_000,
  )

  test(
    "gives a file three times its measured time, and a worker that ended its last file is not stuck",
    async () => {
      await using dir = await tmpdir()
      // Four seconds at the top level: past a 1.5 s deadline, inside three times a 2 s measurement. The other worker
      // ends the quick file at once and waits while the slow one runs.
      await suite(
        dir.path,
        { "slow.test.ts": `import { test } from "bun:test"\nawait Bun.sleep(4000)\ntest("slow", () => {})\n`, "a.test.ts": quick },
        { "test/slow.test.ts": 2000 },
      )
      const code = await runTests(args(dir.path), { ...process.env, ORBIT_TEST_FILE_DEADLINE_MS: "1500" }, dir.path)
      expect(code).toBe(0)
    },
    60_000,
  )

  test(
    "names no file when a worker dies in one: bun restarts the worker and reports the file itself",
    async () => {
      await using dir = await tmpdir()
      await suite(dir.path, {
        "crash.test.ts": `process.kill(process.pid, "SIGKILL")\n`,
        ...Object.fromEntries(
          [1, 2, 3, 4, 5, 6].map((n) => [
            `wait-${n}.test.ts`,
            `import { test } from "bun:test"\ntest("waits", () => Bun.sleep(1500))\n`,
          ]),
        ),
      })
      const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../tools/test/run.ts")], {
        cwd: dir.path,
        env: { ...process.env, ORBIT_TEST_WORKERS: "2", ORBIT_TEST_FILE_DEADLINE_MS: "3000" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(1)
      expect(stdout + stderr).toContain("crash.test.ts")
      expect(stdout + stderr).not.toContain("Test file stuck")
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

describe("tools/test/run.ts on a stuck file", () => {
  test(
    "annotates the file for GitHub, prints on Linux what the worker was doing, and uses no inherited heartbeat folder",
    async () => {
      await using dir = await tmpdir()
      await suite(dir.path, {
        "stuck.test.ts": `import { test } from "bun:test"\ntest("spins", () => { const end = Date.now() + 40_000; while (Date.now() < end) {} })\n`,
      })
      // The folder of a run that started this one: the run under test must keep its own.
      const outer = path.join(dir.path, "outer-heartbeat")
      await fs.mkdir(outer)
      const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../tools/test/run.ts")], {
        cwd: dir.path,
        env: {
          ...process.env,
          ORBIT_TEST_WORKERS: "2",
          ORBIT_TEST_FILE_DEADLINE_MS: "1000",
          GITHUB_ACTIONS: "true",
          ORBIT_TEST_HEARTBEAT: outer,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(code).toBe(1)
      expect(stderr).toMatch(/^Test file stuck: test\/stuck\.test\.ts has run for \d+ s, past its deadline of 1 s \(worker \d+\)/m)
      expect(stderr).toContain("::error title=Test file stuck::test/stuck.test.ts")
      if (process.platform === "linux") {
        expect(stderr).toMatch(/^worker \d+: State:\s+R/m)
        expect(stderr).toMatch(/^threads: \d+ R/m)
        expect(stderr).toMatch(/^children: /m)
      }
      expect(stdout).not.toContain("Test file stuck")
      expect(await fs.readdir(outer)).toEqual([])
    },
    60_000,
  )
})

describe("runProgram", () => {
  test("returns what the program printed and its exit code", async () => {
    const result = await runProgram([process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"])
    expect([result.exitCode, result.success, result.stdout.toString(), result.stderr.toString()]).toEqual([3, false, "out", "err"])
    expect((await runProgram([process.execPath, "-e", "0"])).success).toBe(true)
  })

  test("kills a program that runs past its deadline and fails with the command and what it printed", async () => {
    const started = Date.now()
    const failure = await runProgram(
      [process.execPath, "-e", "process.stdout.write(String(6 * 7)); setTimeout(() => {}, 60_000)"],
      { deadline: 1_000 },
    ).catch((error: Error) => error)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("did not end within 1 s")
    // What it printed, which its command line does not hold.
    expect((failure as Error).message).toContain("stdout:\n42\n")
    if (process.platform === "linux") expect((failure as Error).message).toContain("processes:")
  })
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
    // A parallel package asked for one worker still gives each file a fresh module registry; a --serial package does not.
    expect(withWorkers("1", () => testArgs(["--update-timings", "--only-failures"], dir.path, "linux"))).toEqual([
      "test",
      "--isolate",
      "--only-failures",
    ])
    expect(
      withWorkers("1", () => testArgs(["--serial", "--update-timings", "--only-failures"], dir.path, "linux")),
    ).toEqual(["test", "--only-failures"])
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

describe("tools/test/timings.ts", () => {
  test("refuses a run that is not a number, and a host without gh", async () => {
    expect(await refresh(["--run", "45466682864; rm -rf ."])).toBe(2)
    expect(await refresh([])).toBe(2)
    expect(await refresh(["--run", "1"], "unused", [])).toBe(2)
  })

  test("downloads the run's timings artifacts with gh and merges them, and fails when gh does", async () => {
    await using root = await tmpdir()
    await fs.mkdir(path.join(root.path, "packages", "vscode", "test"), { recursive: true })
    await Bun.write(path.join(root.path, "packages", "vscode", "test", "a.test.ts"), "")
    // A stand-in for gh that records its arguments and leaves one artifact where --dir says.
    const gh = path.join(root.path, "gh.ts")
    await Bun.write(
      gh,
      [
        `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"`,
        `const args = process.argv.slice(2)`,
        `appendFileSync(${JSON.stringify(path.join(root.path, "gh-args.txt"))}, JSON.stringify(args) + "\\n")`,
        `if (args[2] === "9") process.exit(1)`,
        `const dir = args[args.indexOf("--dir") + 1] + "/timings-linux-vscode"`,
        `mkdirSync(dir)`,
        `writeFileSync(dir + "/timings.json", JSON.stringify({ version: 1, files: { "test/a.test.ts": 12 } }))`,
      ].join("\n"),
    )
    expect(await refresh(["--run", "42"], root.path, [process.execPath, gh])).toBe(0)
    expect(await Bun.file(path.join(root.path, "packages", "vscode", "test", "timings.json")).json()).toEqual({
      version: 1,
      files: { "test/a.test.ts": 12 },
    })
    expect(await refresh(["--run", "9"], root.path, [process.execPath, gh])).toBe(1)
    const calls = (await Bun.file(path.join(root.path, "gh-args.txt")).text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(calls.map((args: string[]) => args.slice(0, 5))).toEqual([
      ["run", "download", "42", "--pattern", "timings-*"],
      ["run", "download", "9", "--pattern", "timings-*"],
    ])
  })
})

describe("mergeTimings", () => {
  test("joins every shard of a platform into the committed times, keeps the platforms apart, sorts by name and drops files that are gone", async () => {
    await using root = await tmpdir()
    await using downloads = await tmpdir()
    await fs.mkdir(path.join(root.path, "packages", "cli", "test"), { recursive: true })
    await Promise.all(
      ["b.test.ts", "a.test.ts", "c.test.ts", "d.test.ts"].map((name) =>
        Bun.write(path.join(root.path, "packages", "cli", "test", name), ""),
      ),
    )
    // Committed: a time the run replaces, one for a file no job measured, which stays, and one for a file that is gone.
    await Bun.write(
      path.join(root.path, "packages", "cli", "test", "timings.json"),
      JSON.stringify({ version: 1, files: { "test/a.test.ts": 100, "test/d.test.ts": 7, "test/old.test.ts": 5 } }),
    )
    const artifact = async (name: string, file: string, files: Record<string, number>) => {
      await fs.mkdir(path.join(downloads.path, name))
      await Bun.write(path.join(downloads.path, name, file), JSON.stringify({ version: 1, files }))
    }
    await artifact("timings-linux-cli-1of2", "timings.json", { "test/b.test.ts": 2, "test/gone.test.ts": 9 })
    await artifact("timings-linux-cli-2of2", "timings.json", { "test/a.test.ts": 1, "test/c.test.ts": 4 })
    await artifact("timings-windows-cli", "timings.windows.json", { "test/c.test.ts": 3 })
    await fs.mkdir(path.join(downloads.path, "lcov-linux-cli-1of2"))
    const lines = await mergeTimings(downloads.path, root.path)
    expect(lines.toSorted()).toEqual(["cli: 1 files in test/timings.windows.json", "cli: 4 files in test/timings.json"])
    const linux = await Bun.file(path.join(root.path, "packages", "cli", "test", "timings.json")).json()
    expect(linux).toEqual({
      version: 1,
      files: { "test/a.test.ts": 1, "test/b.test.ts": 2, "test/c.test.ts": 4, "test/d.test.ts": 7 },
    })
    expect(Object.keys(linux.files)).toEqual(["test/a.test.ts", "test/b.test.ts", "test/c.test.ts", "test/d.test.ts"])
    expect(await Bun.file(path.join(root.path, "packages", "cli", "test", "timings.windows.json")).json()).toEqual({
      version: 1,
      files: { "test/c.test.ts": 3 },
    })
  })
})
