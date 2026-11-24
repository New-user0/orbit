// Refreshes the committed test timings from a CI run: `bun tools/test/timings.ts --run <run id>`.
//
// Every test job in .github/workflows/check.yml measures its files with `--update-timings` and uploads what it wrote as
// `timings-<linux|windows>-<package><part>`. This downloads those artifacts with `gh run download` and writes, for each
// package, `test/timings.json` from the Linux jobs and `test/timings.windows.json` from the Windows jobs: every shard's
// files together, sorted by name, without files that no longer exist. It is a developer tool; nothing in Orbit runs it.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const repo = path.resolve(import.meta.dir, "../..")

if (import.meta.main) {
  const run = parseArgs({ options: { run: { type: "string" } } }).values.run
  if (!run || !/^\d+$/.test(run)) {
    console.error("Usage: bun tools/test/timings.ts --run <CI run id>")
    process.exit(2)
  }
  // Found on PATH, so Windows never starts a gh.exe from the working folder (class 10).
  const gh = Bun.which("gh")
  if (!gh) {
    console.error("gh is not on PATH")
    process.exit(2)
  }
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "orbit-timings-"))
  const download = Bun.spawn([gh, "run", "download", run, "--pattern", "timings-*", "--dir", folder], {
    cwd: repo,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await download.exited) !== 0) process.exit(1)
  for (const line of await mergeTimings(folder)) console.log(line)
  await fs.rm(folder, { recursive: true, force: true })
}

/**
 * Writes the timings of the artifacts downloaded into `folder` (one folder per artifact, named as CI names it) into the
 * packages under `root`, and returns one line per file written.
 */
export async function mergeTimings(folder: string, root = repo) {
  const artifacts = Map.groupBy(
    (await fs.readdir(folder)).flatMap((name) => {
      const match = /^timings-(linux|windows)-([a-z-]+?)(?:-\d+of\d+)?$/.exec(name)
      return match ? [{ name, platform: match[1], pkg: match[2] }] : []
    }),
    (artifact) => `${artifact.pkg}/${artifact.platform}`,
  )
  return Promise.all(
    [...artifacts].map(async ([key, list]) => {
      const [pkg, platform] = key.split("/")
      const file = platform === "windows" ? "timings.windows.json" : "timings.json"
      const measured = await Promise.all(
        list.map(async (artifact) =>
          Object.entries(
            ((await Bun.file(path.join(folder, artifact.name, file)).json()) as { files: Record<string, number> }).files,
          ),
        ),
      )
      // An unsharded job keeps what it read for files it did not run, so a file that is gone is dropped here.
      const kept = await Promise.all(
        measured
          .flat()
          .map(async ([name, ms]) =>
            (await Bun.file(path.join(root, "packages", pkg, name)).exists()) ? [[name, ms] as const] : [],
          ),
      )
      const files = Object.fromEntries(kept.flat().sort(([a], [b]) => a.localeCompare(b)))
      await Bun.write(
        path.join(root, "packages", pkg, "test", file),
        JSON.stringify({ version: 1, files }, null, 2) + "\n",
      )
      return `${pkg}: ${Object.keys(files).length} files in test/${file}`
    }),
  )
}
