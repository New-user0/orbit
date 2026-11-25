import fs from "node:fs/promises"
import path from "node:path"
import { runProgram } from "../../../core/test/fixture/run-program"

// Errors that mean another process still holds a file in the folder, so the removal can succeed once it lets go. On
// Windows that is EBUSY for an open handle without delete sharing, EPERM for a file whose deletion is still pending, and
// ENOTEMPTY for a folder that still lists such a file.
const BUSY = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])

/**
 * Removes a test's folder once nothing holds a file in it, and fails, naming what still runs, if that takes longer than
 * the deadline.
 *
 * Bun's fs.rm ignores `maxRetries` and `retryDelay`: a removal that meets a busy file fails at once. On Windows SQLite
 * opens its database without delete sharing, and the private server that `orb acp` starts can still be closing
 * `orbit.db` after `orb acp` has exited (its lease ends when the pipe closes, and `orb acp` exits without waiting for
 * it). So the removal is tried again until the holder lets go. `parents` are the processes the test started: on Windows the error lists the
 * running processes they started, which is where such a holder comes from.
 */
export async function removeTree(folder: string, options: { deadline?: number; parents?: number[] } = {}) {
  const limit = options.deadline ?? 30_000
  const started = Date.now()
  while (true) {
    const error = await fs.rm(folder, { recursive: true, force: true }).then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    if (error === undefined) return
    if (!BUSY.has(String(error.code)) || Date.now() - started >= limit) {
      throw new Error(
        `${folder} could not be removed within ${limit / 1000} s (${error.code}). ` +
          `Running processes started by ${options.parents?.join(", ") || "nothing listed"}:\n` +
          (await children(options.parents ?? [])),
        { cause: error },
      )
    }
    await Bun.sleep(100)
  }
}

// The running processes whose parent is one of `parents`, one per line with its command line. Windows keeps a
// process's parent id after the parent has exited, so this still finds what an exited child left running. Elsewhere an
// open file does not stop a removal, and the list is not needed.
async function children(parents: number[]) {
  if (process.platform !== "win32" || parents.length === 0) return "(not listed on this platform)"
  // The absolute path, so no powershell.exe in the working folder is started instead (class 10).
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  )
  const filter = parents.map((pid) => `ParentProcessId=${pid}`).join(" OR ")
  const result = await runProgram(
    [
      powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`,
    ],
    { deadline: 30_000 },
  )
  return result.stdout.toString().trim() || "(none)"
}
