import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { currentDirectoryOnPath, plant } from "./fixture/decoy"
import { tmpdir } from "./fixture/tmpdir"

// The package test runners (tools/test/run.ts, and script/test.ts here in core) stop a run whose test file has run past
// its deadline, name that file, and fail. Without that, a file that never finishes holds a CI job silently until GitHub
// cancels it at the job's time limit, as the Linux core job did on 2026-11-07, 11-22, 11-23 and 11-24 (class 14: a gate
// that cannot fail says nothing).
//
// Each stuck file below ends by itself after STUCK_MS, so a runner without a deadline still exits and leaves no process
// behind. The run must end long before that, with a failure that names the file.

const core = path.resolve(import.meta.dir, "..")
const runner = path.resolve(core, "../../tools/test/run.ts")
const STUCK_MS = 45_000
// Generous for a loaded runner: bun's start-up, two workers, the deadline and the watchdog's poll.
const ENDS_WITHIN_MS = 25_000

// A test whose body never yields: bun's per-test timeout is a timer, so it cannot fire while the loop runs.
const syncLoop = `import { test } from "bun:test"
import { writeFileSync } from "node:fs"
writeFileSync(process.env.FIXTURE_PID_FILE!, String(process.pid))
test("spins", () => {
  const end = Date.now() + ${STUCK_MS}
  while (Date.now() < end) {}
})
`
// A module that waits at its top level: no test has started, so no per-test timeout applies.
const topLevelWait = `import { test } from "bun:test"
import { writeFileSync } from "node:fs"
writeFileSync(process.env.FIXTURE_PID_FILE!, String(process.pid))
await Bun.sleep(${STUCK_MS})
test("never reached in time", () => {})
`
const quick = `import { expect, test } from "bun:test"
test("adds", () => expect(1 + 1).toBe(2))
`
// Four seconds in all, longer than bun's default five-second per-test timeout would allow for one test but made of
// short tests, and under the eight-second deadline the control sets.
const slowButFine = `import { test } from "bun:test"
for (const n of [1, 2, 3, 4]) test(\`step \${n}\`, () => Bun.sleep(1000))
`

async function run(input: { cmd: string[]; cwd: string; pidFile: string; deadline: number }) {
  const started = Date.now()
  const child = Bun.spawn({
    cmd: input.cmd,
    cwd: input.cwd,
    env: {
      ...process.env,
      ORBIT_TEST_WORKERS: "2",
      ORBIT_TEST_FILE_DEADLINE_MS: String(input.deadline),
      FIXTURE_PID_FILE: input.pidFile,
      // The outer run's own heartbeat folder must not leak into the run under test.
      ORBIT_TEST_HEARTBEAT: undefined,
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
  return { code, output: stdout + stderr, elapsed: Date.now() - started }
}

async function alive(pidFile: string) {
  const pid = Number(await Bun.file(pidFile).text().catch(() => "0"))
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The watchdog's line about the stuck file. A run that failed for another reason (a preload that threw before the file
// ran) also exits non-zero and names the file, so the rows read this line rather than the file name anywhere.
function stuckReport(output: string) {
  return output.split(/\r?\n/).find((line) => line.startsWith("Test file stuck: ")) ?? ""
}

async function suite(root: string, files: Record<string, string>) {
  await fs.mkdir(path.join(root, "test"), { recursive: true })
  await Promise.all(Object.entries(files).map(([name, text]) => fs.writeFile(path.join(root, "test", name), text)))
}

describe("tools/test/run.ts stops a test file that runs past its deadline", () => {
  for (const [kind, body] of [
    ["a synchronous loop in a test", syncLoop],
    ["a wait at the module's top level", topLevelWait],
  ] as const) {
    test(
      `${kind}: the run fails within seconds, names the file and leaves no worker behind`,
      async () => {
        await using dir = await tmpdir()
        await suite(dir.path, { "a.test.ts": quick, "b.test.ts": quick, "stuck.test.ts": body })
        const pidFile = path.join(dir.path, "pid")
        const result = await run({
          cmd: [process.execPath, runner, "--only-failures"],
          cwd: dir.path,
          pidFile,
          deadline: 3_000,
        })
        expect(result.elapsed).toBeLessThan(ENDS_WITHIN_MS)
        expect(result.code).not.toBe(0)
        expect(stuckReport(result.output)).toContain("stuck.test.ts")
        expect(await alive(pidFile)).toBe(false)
      },
      STUCK_MS + 30_000,
    )
  }

  // Class 10: on Windows the runner stops the worker tree with taskkill, which a bare name would find in the package's
  // folder before System32. The control row above shows the run is stopped at all; this row shows what stopped it.
  test.skipIf(process.platform !== "win32")(
    "stopping a stuck run on Windows starts no taskkill from the package's folder",
    async () => {
      await using dir = await tmpdir()
      using _ = currentDirectoryOnPath()
      await suite(dir.path, { "a.test.ts": quick, "stuck.test.ts": syncLoop })
      const ran = await plant(dir.path, "taskkill", "cmd")
      const batch = path.join(dir.path, "ran-bat.txt")
      await fs.writeFile(path.join(dir.path, "taskkill.bat"), `@echo off\r\necho ran> "${batch}"\r\n`)
      const pidFile = path.join(dir.path, "pid")
      const result = await run({
        cmd: [process.execPath, runner, "--only-failures"],
        cwd: dir.path,
        pidFile,
        deadline: 3_000,
      })
      expect(result.elapsed).toBeLessThan(ENDS_WITHIN_MS)
      expect(result.code).not.toBe(0)
      expect(stuckReport(result.output)).toContain("stuck.test.ts")
      expect(await ran()).toEqual([])
      expect(await Bun.file(batch).exists()).toBe(false)
      expect(await alive(pidFile)).toBe(false)
    },
    STUCK_MS + 30_000,
  )

  test(
    "control: files that finish under the deadline pass and the run names no file as stuck",
    async () => {
      await using dir = await tmpdir()
      await suite(dir.path, { "a.test.ts": quick, "slow.test.ts": slowButFine })
      const result = await run({
        cmd: [process.execPath, runner, "--only-failures"],
        cwd: dir.path,
        pidFile: path.join(dir.path, "pid"),
        deadline: 8_000,
      })
      expect(result.code).toBe(0)
      expect(result.output).not.toContain("slow.test.ts")
    },
    STUCK_MS + 30_000,
  )
})

describe("core's script/test.ts applies the same deadline", () => {
  test(
    "a synchronous loop in a core test file fails the run within seconds and names the file",
    async () => {
      await using dir = await tmpdir()
      const stuck = path.join(dir.path, "stuck-core.test.ts")
      await fs.writeFile(stuck, syncLoop)
      const pidFile = path.join(dir.path, "pid")
      const result = await run({
        cmd: [process.execPath, "run", "script/test.ts", stuck],
        cwd: core,
        pidFile,
        deadline: 3_000,
      })
      expect(result.elapsed).toBeLessThan(ENDS_WITHIN_MS)
      expect(result.code).not.toBe(0)
      expect(stuckReport(result.output)).toContain("stuck-core.test.ts")
      expect(await alive(pidFile)).toBe(false)
    },
    STUCK_MS + 30_000,
  )
})
