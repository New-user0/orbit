import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Arguments for `bun test` in one package: parallel worker processes and the package's committed timings file, so the
// slowest files start first and `--shard` splits the files by time. ORBIT_TEST_WORKERS=1 gives the serial run used for
// debugging.
//
// Windows and Linux runners take very different times for the same file, so each keeps its own timings:
// `test/timings.windows.json` on Windows and `test/timings.json` elsewhere. `--update-timings` writes the platform's
// file, and Windows falls back to `test/timings.json` until it has one.
//
// A parallel run also preloads tools/test/heartbeat.ts, which tells the runner's watchdog which file each worker is in.
//
// A package whose files are small and many passes `--serial`: every file a parallel worker runs starts a fresh module
// registry, which costs about a second on Windows, so its parallel run is slower than its serial one. It runs serially
// unless ORBIT_TEST_WORKERS asks for workers. The flag is read here and never reaches `bun test`.
export function testArgs(extra: string[], cwd = process.cwd(), platform = process.platform) {
  const serial = extra.includes("--serial")
  const rest = extra.filter((arg) => arg !== "--serial")
  const workers = workerCount(serial)
  const update = rest.includes("--update-timings")
  const windows = path.join(cwd, "test", "timings.windows.json")
  const timings =
    platform === "win32" && (update || fs.existsSync(windows)) ? windows : path.join(cwd, "test", "timings.json")
  // A package that runs in parallel by default keeps a fresh module registry for each file when ORBIT_TEST_WORKERS=1
  // asks for one worker, as its parallel run has, so files that share a fixture module each get their own copy.
  if (workers === 1)
    return ["test", ...(serial ? [] : ["--isolate"]), ...rest.filter((arg) => arg !== "--update-timings")]
  return [
    "test",
    `--parallel=${workers}`,
    `--preload=${path.join(import.meta.dir, "heartbeat.ts")}`,
    ...(update || fs.existsSync(timings) ? [`--timings=${timings}`] : []),
    ...rest,
  ]
}

function workerCount(serial: boolean) {
  const requested = Number(process.env.ORBIT_TEST_WORKERS)
  if (Number.isInteger(requested) && requested >= 1) return requested
  if (serial) return 1
  return Math.max(2, Math.floor(os.availableParallelism() / 2))
}
