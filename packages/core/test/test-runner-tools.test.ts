import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { testArgs } from "../../../tools/test/args"
import { mergeTimings, refresh } from "../../../tools/test/timings"
import { linuxState, runTests } from "../../../tools/test/watchdog"
import { plant } from "./fixture/decoy"
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

// The environment of a run under test. GitHub reads `::error` lines from a job's output, so GITHUB_ACTIONS is left out
// for the runner and for the bun under it: a stand-in file stopped on purpose must not put a "Test file stuck"
// annotation, or bun's own failure annotation, on a passing CI job. The annotation rows set it on purpose and read their
// own piped output.
const quiet = (extra: Record<string, string> = {}) => ({ ...process.env, GITHUB_ACTIONS: undefined, ...extra })

// Where a run started in this process reports: into a list the row reads, with bun's own output dropped, so the job log
// of a failing core run holds no "Test file stuck" or "(fail) x" line from a stand-in ("keeps what the runs it starts in
// this process print out of its own output").
const captured = () => {
  const lines: string[] = []
  return { lines, output: { log: (line: string) => void lines.push(line), stdio: "ignore" as const } }
}
const stuckLines = (lines: string[]) => lines.filter((line) => line.startsWith("Test file stuck:"))

// A stand-in for `bun test`: one worker that writes the given heartbeat lines for test/a.test.ts, named by its full path
// as Bun.main gives it, then lives for three seconds.
const standIn = (root: string, lines: string[]) => [
  "-e",
  [
    `const log = require("node:path").join(process.env.ORBIT_TEST_HEARTBEAT, String(process.pid))`,
    ...lines.map(
      (line) =>
        `require("node:fs").appendFileSync(log, Date.now() + " ${line} " + ${JSON.stringify(path.join(root, "test", "a.test.ts"))} + "\\n")`,
    ),
    `setTimeout(() => {}, 3000)`,
  ].join("\n"),
]

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
      const out = captured()
      const code = await runTests(args(dir.path), quiet({ ORBIT_TEST_FILE_DEADLINE_MS: "1000" }), dir.path, out.output)
      const ended = Date.now()
      expect(code).toBe(1)
      expect(stuckLines(out.lines)).toEqual([expect.stringMatching(/^Test file stuck: test\/stuck\.test\.ts has run for/)])
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
    "gives a file three times its measured time",
    async () => {
      await using dir = await tmpdir()
      // Four seconds at the top level: past a 1.5 s deadline, inside three times a 2 s measurement.
      await suite(
        dir.path,
        { "slow.test.ts": `import { test } from "bun:test"\nawait Bun.sleep(4000)\ntest("slow", () => {})\n`, "a.test.ts": quick },
        { "test/slow.test.ts": 2000 },
      )
      const out = captured()
      const code = await runTests(args(dir.path), quiet({ ORBIT_TEST_FILE_DEADLINE_MS: "1500" }), dir.path, out.output)
      expect(code).toBe(0)
      expect(out.lines).toEqual([])
    },
    60_000,
  )

  test(
    "with no deadline set and no measured time, stops no file that waits a few seconds",
    async () => {
      await using dir = await tmpdir()
      await suite(dir.path, {
        "slow.test.ts": `import { test } from "bun:test"\nawait Bun.sleep(3000)\ntest("slow", () => {})\n`,
        "a.test.ts": quick,
      })
      const out = captured()
      expect(await runTests(args(dir.path), { ...quiet(), ORBIT_TEST_FILE_DEADLINE_MS: undefined }, dir.path, out.output)).toBe(0)
      expect(out.lines).toEqual([])
    },
    60_000,
  )

  test(
    "counts a worker as in a file only while its last line starts one",
    async () => {
      await using dir = await tmpdir()
      // bun ends an idle worker and starts the next file at once, so a real run seldom shows a live worker whose last
      // line ends a file. The stand-in writes such a line as a worker would, then lives past the deadline.
      const env = quiet({ ORBIT_TEST_FILE_DEADLINE_MS: "1000" })
      const ended = captured()
      expect(await runTests(standIn(dir.path, ["start", "end"]), env, dir.path, ended.output)).toBe(0)
      expect(ended.lines).toEqual([])
      // Control: the same worker still in its file is stopped.
      const inFile = captured()
      expect(await runTests(standIn(dir.path, ["start"]), env, dir.path, inFile.output)).toBe(1)
      expect(stuckLines(inFile.lines)).toEqual([expect.stringMatching(/^Test file stuck: test\/a\.test\.ts has run for/)])
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
        env: quiet({ ORBIT_TEST_WORKERS: "2", ORBIT_TEST_FILE_DEADLINE_MS: "3000" }),
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
    "gives each run fresh folders for its start slots and its transpiler cache, in place of inherited ones, and removes them at the end",
    async () => {
      await using dir = await tmpdir()
      const seen = path.join(dir.path, "seen.json")
      const names = { ORBIT_TEST_START_SLOTS: "orbit-starts-", ORBIT_TEST_TRANSPILER_CACHE: "orbit-transpiled-" }
      await suite(dir.path, {
        "folders.test.ts": [
          `import { test } from "bun:test"`,
          `import { existsSync, writeFileSync } from "node:fs"`,
          `const folders = ${JSON.stringify(Object.keys(names))}.map((name) => process.env[name] ?? "")`,
          `writeFileSync(${JSON.stringify(seen)}, JSON.stringify(folders.map((folder) => ({ folder, exists: existsSync(folder) }))))`,
          `test("records", () => {})`,
        ].join("\n"),
      })
      const outer = Object.fromEntries(Object.keys(names).map((name) => [name, path.join(dir.path, `outer-${name}`)]))
      const code = await runTests(args(dir.path), quiet(outer), dir.path, captured().output)
      expect(code).toBe(0)
      const run = (await Bun.file(seen).json()) as { folder: string; exists: boolean }[]
      expect(run.map((entry) => entry.exists)).toEqual([true, true])
      expect(run.map((entry) => entry.folder)).not.toContain(outer.ORBIT_TEST_START_SLOTS)
      expect(run.map((entry) => entry.folder)).not.toContain(outer.ORBIT_TEST_TRANSPILER_CACHE)
      expect(run.map((entry) => path.basename(entry.folder).replace(/-[^-]+$/, "-"))).toEqual(Object.values(names))
      for (const entry of run) expect(await fs.stat(entry.folder).catch(() => undefined)).toBeUndefined()
    },
    60_000,
  )

  test(
    "returns bun's own code when no file is stuck",
    async () => {
      await using dir = await tmpdir()
      await suite(dir.path, { "fails.test.ts": `import { expect, test } from "bun:test"\ntest("x", () => expect(1).toBe(2))\n` })
      const failed = captured()
      expect(await runTests(args(dir.path), quiet({ ORBIT_TEST_FILE_DEADLINE_MS: "5000" }), dir.path, failed.output)).toBe(1)
      expect(failed.lines).toEqual([])
      await suite(dir.path, { "fails.test.ts": `import { expect, test } from "bun:test"\ntest("x", () => expect(1).toBe(1))\n` })
      expect(await runTests(args(dir.path), quiet({ ORBIT_TEST_FILE_DEADLINE_MS: "5000" }), dir.path, captured().output)).toBe(0)
    },
    60_000,
  )

  test(
    "annotates a stuck file for GitHub when the environment it is given says so, whatever its own process's says",
    async () => {
      await using dir = await tmpdir()
      // A program that calls runTests on a stuck stand-in worker with GITHUB_ACTIONS set to its first argument, or left
      // out when that is empty, while its own environment holds the opposite.
      const driver = path.join(dir.path, "driver.ts")
      await Bun.write(
        driver,
        [
          `import { runTests } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../tools/test/watchdog.ts"))}`,
          `const env = { ...process.env, GITHUB_ACTIONS: process.argv[2] || undefined, ORBIT_TEST_FILE_DEADLINE_MS: "1000" }`,
          `process.exitCode = await runTests(${JSON.stringify(standIn(dir.path, ["start"]))}, env, ${JSON.stringify(dir.path)})`,
        ].join("\n"),
      )
      const drive = async (own: string | undefined, given: string) => {
        const result = await runProgram([process.execPath, driver, given], {
          cwd: dir.path,
          env: { ...process.env, GITHUB_ACTIONS: own },
        })
        expect(result.exitCode).toBe(1)
        const stderr = result.stderr.toString()
        expect(stderr).toMatch(/^Test file stuck: test\/a\.test\.ts has run for/m)
        return stderr
      }
      expect(await drive("true", "")).not.toContain("::error")
      expect(await drive(undefined, "true")).toContain("::error title=Test file stuck::test/a.test.ts")
    },
    60_000,
  )

  // The rows above call runTests in this process, so what they let through lands in the CI job's log, where a failing
  // core job's Failures group would show a stand-in as a stuck file or a failing test. Two of them, the one that stops a
  // stuck file and the one whose stand-in fails, run here as a test run of their own, and everything it prints is read.
  test(
    "keeps what the runs it starts in this process print out of its own output",
    async () => {
      const result = await runProgram(
        [
          process.execPath,
          "test",
          path.join(import.meta.dir, "test-runner-tools.test.ts"),
          "-t",
          "stops a file that blocks past the deadline|returns bun's own code when no file is stuck",
        ],
        { cwd: path.resolve(import.meta.dir, ".."), env: quiet(), deadline: 120_000 },
      )
      const printed = `${result.stdout}\n${result.stderr}`
      expect(result.exitCode).toBe(0)
      // Control: both rows ran and passed.
      expect(printed).toMatch(/^ 2 pass$/m)
      expect(printed).toMatch(/^ 0 fail$/m)
      expect(
        printed.split(/\r?\n/).filter((line) => line.startsWith("Test file stuck") || line.startsWith("(fail) x")),
      ).toEqual([])
    },
    120_000,
  )
})

describe("tools/test/heartbeat.ts", () => {
  // The watchdog takes a live worker whose last line starts a file as one still in that file ("counts a worker as in a
  // file only while its last line starts one"), so every file a worker finishes must leave an end line after its start.
  test("writes a start line when a worker loads a file and an end line after its tests", async () => {
    await using dir = await tmpdir()
    await suite(dir.path, { "a.test.ts": quick, "b.test.ts": quick })
    const folder = path.join(dir.path, "heartbeat")
    await fs.mkdir(folder)
    const result = await runProgram([process.execPath, "test", "--parallel=2", `--preload=${heartbeat}`], {
      cwd: dir.path,
      env: quiet({ ORBIT_TEST_HEARTBEAT: folder }),
    })
    expect(result.exitCode).toBe(0)
    const workers = await Promise.all(
      (await fs.readdir(folder)).map(async (pid) =>
        (await fs.readFile(path.join(folder, pid), "utf8"))
          .trim()
          .split("\n")
          .map((line) => {
            const match = /^\d+ (start|end) (.+)$/.exec(line)
            return match ? `${match[1]} ${path.basename(match[2])}` : line
          }),
      ),
    )
    for (const lines of workers) {
      const starts = lines.filter((line) => line.startsWith("start "))
      expect(lines).toEqual(starts.flatMap((line) => [line, line.replace("start", "end")]))
    }
    expect(workers.flat().toSorted()).toEqual(["end a.test.ts", "end b.test.ts", "start a.test.ts", "start b.test.ts"])
  })
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

describe("linuxState", () => {
  // A stuck worker can exit between the look that finds it and the report: its /proc entries are gone by then. Off Linux
  // there is no /proc at all, so every read takes the same way.
  test("reports a worker that has gone as unknown instead of failing, so the kill after it still runs", async () => {
    const gone = Bun.spawn([process.execPath, "-e", "0"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
    await gone.exited
    expect(linuxState(gone.pid).split("\n")).toEqual([`worker ${gone.pid}: State: ?, wchan ?`, "threads: ", "children: none"])
  })

  test.skipIf(process.platform !== "linux")("control: a live worker's state, threads and children are read", async () => {
    await using child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 10_000)"], { stdout: "ignore" })
    const lines = linuxState(process.pid).split("\n")
    expect(lines[0]).toMatch(new RegExp(`^worker ${process.pid}: State:\\s+[RS]`))
    expect(lines[1]).toContain(`${process.pid} `)
    expect(lines[2]).toContain(`${child.pid} bun`)
  })
})

// On Linux and macOS `bun test` runs in its own process group, so a terminal's Ctrl-C and CI's SIGTERM reach only the
// runner, which passes them on to the group. Windows has no such signals to pass on: there the runner is ended outright.
describe.skipIf(process.platform === "win32")("tools/test/run.ts on a signal", () => {
  for (const name of ["SIGINT", "SIGTERM"] as const)
    test(
      `passes ${name} on to bun test, so the run and its workers end with it`,
      async () => {
        await using dir = await tmpdir()
        const pidFile = path.join(dir.path, "pid")
        await suite(dir.path, {
          "a.test.ts": quick,
          "wait.test.ts": [
            `import { test } from "bun:test"`,
            `import { writeFileSync } from "node:fs"`,
            `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))`,
            `await Bun.sleep(40_000)`,
            `test("never reached", () => {})`,
          ].join("\n"),
        })
        const child = Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../../../tools/test/run.ts")], {
          cwd: dir.path,
          env: quiet({ ORBIT_TEST_WORKERS: "2" }),
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        })
        const worker = await until(30_000, async () => Number(await Bun.file(pidFile).text().catch(() => "")) || undefined)
        const signalled = Date.now()
        child.kill(name)
        await child.exited
        // Without the signal passed on, the runner ends at once and the worker sleeps on in its own group.
        expect(await until(10_000, () => (running(worker) ? undefined : true))).toBe(true)
        expect(Date.now() - signalled).toBeLessThan(10_000)
      },
      60_000,
    )
})

async function until<T>(limit: number, look: () => T | undefined | Promise<T | undefined>) {
  const end = Date.now() + limit
  while (Date.now() < end) {
    const found = await look()
    if (found !== undefined) return found
    await Bun.sleep(50)
  }
  throw new Error(`nothing within ${limit} ms`)
}

function running(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("runProgram", () => {
  test("returns what the program printed and its exit code", async () => {
    const result = await runProgram([process.execPath, "-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"])
    expect([result.exitCode, result.success, result.stdout.toString(), result.stderr.toString()]).toEqual([3, false, "out", "err"])
    expect((await runProgram([process.execPath, "-e", "0"])).success).toBe(true)
  })

  test("kills a program that runs past its deadline and fails with the command and what it printed", async () => {
    const started = Date.now()
    const failure = await runProgram(
      [process.execPath, "-e", "process.stdout.write(String(process.pid)); setTimeout(() => {}, 60_000)"],
      { deadline: 1_000 },
    ).catch((error: Error) => error)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain("did not end within 1 s")
    // What it printed, which its command line does not hold: its own pid.
    const pid = Number(/^stdout:\n(\d+)$/m.exec((failure as Error).message)?.[1])
    expect(pid).toBeGreaterThan(0)
    // Killed, not left to wait out its minute.
    expect(await until(5_000, () => (running(pid) ? undefined : true))).toBe(true)
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

  test("downloads the run's timings artifacts with gh and merges them, and merges nothing when gh fails", async () => {
    await using root = await tmpdir()
    await fs.mkdir(path.join(root.path, "packages", "vscode", "test"), { recursive: true })
    await Bun.write(path.join(root.path, "packages", "vscode", "test", "a.test.ts"), "")
    // A stand-in for gh that records its arguments and leaves one artifact where --dir says, timed as the run's id.
    // For run 9 it then fails, as a download that stops part way does.
    const gh = path.join(root.path, "gh.ts")
    await Bun.write(
      gh,
      [
        `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"`,
        `const args = process.argv.slice(2)`,
        `appendFileSync(${JSON.stringify(path.join(root.path, "gh-args.txt"))}, JSON.stringify(args) + "\\n")`,
        `const dir = args[args.indexOf("--dir") + 1] + "/timings-linux-vscode"`,
        `mkdirSync(dir)`,
        `writeFileSync(dir + "/timings.json", JSON.stringify({ version: 1, files: { "test/a.test.ts": Number(args[2]) } }))`,
        `if (args[2] === "9") process.exit(1)`,
      ].join("\n"),
    )
    const timings = path.join(root.path, "packages", "vscode", "test", "timings.json")
    expect(await refresh(["--run", "42"], root.path, [process.execPath, gh])).toBe(0)
    expect(await Bun.file(timings).json()).toEqual({ version: 1, files: { "test/a.test.ts": 42 } })
    expect(await refresh(["--run", "9"], root.path, [process.execPath, gh])).toBe(1)
    expect(await Bun.file(timings).json()).toEqual({ version: 1, files: { "test/a.test.ts": 42 } })
    const calls = (await Bun.file(path.join(root.path, "gh-args.txt")).text()).trim().split("\n").map((line) => JSON.parse(line))
    expect(calls.map((args: string[]) => args.slice(0, 5))).toEqual([
      ["run", "download", "42", "--pattern", "timings-*"],
      ["run", "download", "9", "--pattern", "timings-*"],
    ])
  })

  // class 10: Windows looks a bare program name up in the working folder before PATH. The tool finds gh on PATH itself,
  // so a gh.exe in the folder it runs in is never started, and with no gh on PATH it stops instead.
  test.skipIf(process.platform !== "win32")(
    "finds gh on PATH only: a gh.exe in the working folder is never started (Windows)",
    async () => {
      await using root = await tmpdir()
      await using onPath = await tmpdir()
      await using empty = await tmpdir()
      const folderRan = await plant(root.path, "gh")
      const pathRan = await plant(onPath.path, "gh")
      const driver = path.join(root.path, "driver.ts")
      await Bun.write(
        driver,
        [
          `import { refresh } from ${JSON.stringify(path.resolve(import.meta.dir, "../../../tools/test/timings.ts"))}`,
          `process.exitCode = await refresh(["--run", "7"], ${JSON.stringify(root.path)})`,
        ].join("\n"),
      )
      // The variable that hides the working folder from the lookup is left out, and PATH names one folder alone.
      const env = (folder: string) => ({
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => key.toUpperCase() !== "PATH" && key !== "NoDefaultCurrentDirectoryInExePath",
          ),
        ),
        PATH: folder,
      })
      const none = await runProgram([process.execPath, driver], { cwd: root.path, env: env(empty.path) })
      expect([none.exitCode, none.stderr.toString().trim()]).toEqual([2, "gh is not on PATH"])
      expect(await folderRan()).toEqual([])
      // Control: the gh that PATH names is the one started.
      const found = await runProgram([process.execPath, driver], { cwd: root.path, env: env(onPath.path) })
      expect(found.exitCode).toBe(0)
      expect((await pathRan()).map((line) => line.split(" ").slice(0, 6).join(" "))).toEqual([
        "gh.exe run download 7 --pattern timings-*",
      ])
      expect(await folderRan()).toEqual([])
    },
    60_000,
  )
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
