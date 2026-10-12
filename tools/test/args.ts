import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Arguments for `bun test` in one package: parallel worker processes and the package's committed timings file, so the
// slowest files start first. ORBIT_TEST_WORKERS=1 gives the serial run used for debugging.
//
// A package whose files are small and many passes `--serial`: every file a parallel worker runs starts a fresh module
// registry, which costs about a second on Windows, so its parallel run is slower than its serial one. It runs serially
// unless ORBIT_TEST_WORKERS asks for workers. The flag is read here and never reaches `bun test`.
export function testArgs(extra: string[], cwd = process.cwd()) {
  const serial = extra.includes("--serial")
  const rest = extra.filter((arg) => arg !== "--serial")
  const workers = workerCount(serial)
  const timings = path.join(cwd, "test", "timings.json")
  return [
    "test",
    ...(workers > 1 ? [`--parallel=${workers}`] : []),
    ...(workers > 1 && (rest.includes("--update-timings") || fs.existsSync(timings)) ? [`--timings=${timings}`] : []),
    ...rest.filter((arg) => workers > 1 || arg !== "--update-timings"),
  ]
}

function workerCount(serial: boolean) {
  const requested = Number(process.env.ORBIT_TEST_WORKERS)
  if (Number.isInteger(requested) && requested >= 1) return requested
  if (serial) return 1
  return Math.max(2, Math.floor(os.availableParallelism() / 2))
}
