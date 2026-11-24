import { describe, expect, test } from "bun:test"
import { existsSync } from "fs"
import fs from "fs/promises"
import path from "path"
import { testArgs } from "../../../tools/test/args"
import { tmpdir } from "./fixture/tmpdir"

// CI splits the long package suites into shards (`bun test --shard`), and bun balances the shards by each package's
// committed timings. Timings that miss the files added since they were measured put every unmeasured file in one shard,
// so `test on Windows (cli 1/3)` ran 58 of 115 files for 27 to 53 minutes while 2/3 and 3/3 ran 36 and 21 files in 17 to
// 28 (runs of 2026-11-24). These rows pin what keeps the shards balanced: enough shards, timings measured on the
// platform that uses them that name the files that exist, no file longer than a shard's share, and CI publishing what
// it measured so the timings can be refreshed.

const repo = path.resolve(import.meta.dir, "../../..")
const workflow = Bun.YAML.parse(await Bun.file(path.join(repo, ".github/workflows/check.yml")).text()) as {
  jobs: Record<string, Job>
}
type Job = {
  "runs-on": string
  strategy: { matrix: { package: string[]; include?: { package: string; shard?: string; part?: string }[] } }
  steps: { name?: string; uses?: string; run?: string; with?: Record<string, string> }[]
}
// The test jobs, keyed by the platform whose timings their runner reads.
const jobs = { linux: workflow.jobs.test, windows: workflow.jobs.windows }
// GitHub's standard runners have 4 CPUs, so tools/test/args.ts starts 2 workers in each shard.
const WORKERS = 2

const shards = (job: Job) =>
  Map.groupBy(
    (job.strategy.matrix.include ?? []).filter((entry) => entry.shard),
    (entry) => entry.package,
  )

// The files `bun test` finds in a package: its default name patterns, outside node_modules.
async function testFiles(pkg: string) {
  const dir = path.join(repo, "packages", pkg)
  return Array.fromAsync(new Bun.Glob("**/*{.test,_test,.spec,_spec}.{ts,tsx,js,jsx}").scan(dir)).then((files) =>
    files.map((file) => file.split(path.sep).join("/")).filter((file) => !file.split("/").includes("node_modules")),
  )
}

async function timings(pkg: string, platform: "linux" | "windows") {
  const file = path.join(repo, "packages", pkg, "test", platform === "windows" ? "timings.windows.json" : "timings.json")
  const exists = await Bun.file(file).exists()
  if (!exists) return undefined
  return ((await Bun.file(file).json()) as { files: Record<string, number> }).files
}

// Every package whose runner reads a timings file: the ones that run in parallel workers.
const timed = (await fs.readdir(path.join(repo, "packages"))).filter((pkg) =>
  existsSync(path.join(repo, "packages", pkg, "test", "timings.json")),
)

describe("CI test shards", () => {
  test("Windows cli runs as four or more shards", () => {
    expect(shards(jobs.windows).get("cli")?.length ?? 1).toBeGreaterThanOrEqual(4)
  })

  for (const [platform, job] of Object.entries(jobs)) {
    test(`${platform}: each sharded package runs shards 1 to n of n once, each with its own coverage artifact`, () => {
      for (const [pkg, list] of shards(job)) {
        const n = list.length
        expect({ pkg, shards: list.map((entry) => entry.shard) }).toEqual({
          pkg,
          shards: list.map((_, index) => `${index + 1}/${n}`),
        })
        expect({ pkg, parts: list.map((entry) => entry.part) }).toEqual({
          pkg,
          parts: list.map((_, index) => `-${index + 1}of${n}`),
        })
        expect(job.strategy.matrix.package).not.toContain(pkg)
      }
    })

    test(`${platform}: every test job writes the timings it measured and uploads them`, () => {
      const run = job.steps.find((step) => step.name === "Test")?.run ?? ""
      expect(run).toContain("--update-timings")
      const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact") && step.with?.name?.startsWith("timings-"))
      expect(upload?.with?.name).toContain("${{ matrix.package }}${{ matrix.part }}")
    })
  }

  for (const pkg of timed) {
    for (const platform of ["linux", "windows"] as const) {
      test(`${pkg}: the ${platform} timings name the package's test files and no file that is gone`, async () => {
        const files = await testFiles(pkg)
        const measured = await timings(pkg, platform)
        expect(measured).toBeDefined()
        const names = Object.keys(measured ?? {})
        expect(names.filter((name) => !files.includes(name))).toEqual([])
        // A file added since the last refresh is allowed until the next one; a twentieth of the files is the slack.
        expect(files.filter((file) => names.includes(file)).length).toBeGreaterThanOrEqual(Math.ceil(files.length * 0.95))
      })
    }
  }

  for (const [platform, job] of Object.entries(jobs)) {
    for (const [pkg, list] of shards(job)) {
      test(`${platform} ${pkg}: no test file is longer than one shard's share of the package's time`, async () => {
        const measured = Object.entries((await timings(pkg, platform as "linux" | "windows")) ?? {})
        expect(measured.length).toBeGreaterThan(0)
        const total = measured.reduce((sum, [, ms]) => sum + ms, 0)
        // A shard's wall time is about its files' total over the workers; a longer file is a floor no split can lower.
        const share = total / list.length / WORKERS
        expect(measured.filter(([, ms]) => ms > share).map(([file]) => file)).toEqual([])
      })
    }
  }
})

describe("the runner's timings file", () => {
  test("on Windows the runner balances by the Windows timings, and elsewhere by test/timings.json", async () => {
    await using dir = await tmpdir()
    await fs.mkdir(path.join(dir.path, "test"))
    await Bun.write(path.join(dir.path, "test", "timings.json"), JSON.stringify({ version: 1, files: {} }))
    await Bun.write(path.join(dir.path, "test", "timings.windows.json"), JSON.stringify({ version: 1, files: {} }))
    const previous = process.env.ORBIT_TEST_WORKERS
    process.env.ORBIT_TEST_WORKERS = "2"
    const args = (platform: NodeJS.Platform) =>
      (testArgs as (extra: string[], cwd: string, platform: NodeJS.Platform) => string[])([], dir.path, platform)
    const windows = args("win32")
    const linux = args("linux")
    if (previous === undefined) delete process.env.ORBIT_TEST_WORKERS
    else process.env.ORBIT_TEST_WORKERS = previous
    expect(windows).toContain(`--timings=${path.join(dir.path, "test", "timings.windows.json")}`)
    expect(linux).toContain(`--timings=${path.join(dir.path, "test", "timings.json")}`)
  })
})
