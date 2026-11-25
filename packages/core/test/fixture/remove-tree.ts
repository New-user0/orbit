import fs from "node:fs/promises"
import path from "node:path"
import { runProgram } from "./run-program"

// What another process still holding a file in the folder answers on Windows: EBUSY for a handle opened without delete
// sharing (SQLite opens its database that way), EPERM for a file whose deletion is still pending, and ENOTEMPTY for a
// folder that still lists such a file. Each ends once the holder lets go.
const HELD = new Set(["EBUSY", "EPERM", "ENOTEMPTY"])

/**
 * Removes a test's folder, waiting for a process that still holds a file in it, and fails once the deadline passes,
 * naming the processes that `parents` started that still run: by default those the test's own process started, which
 * on Windows keep its id as their parent's after they exit too.
 *
 * Bun's fs.rm takes `maxRetries` and `retryDelay` and ignores them, so a removal that meets a held file fails at once.
 * A program the test ran (a compiled binary, a planted decoy, a server with its database) can hold its folder for a
 * moment after it exits on Windows, which failed the cleanup after the tests had passed.
 */
export async function removeTree(folder: string, options: { deadline?: number; parents?: number[] } = {}) {
  const limit = options.deadline ?? 30_000
  const parents = options.parents ?? [process.pid]
  const started = Date.now()
  while (true) {
    const error = await fs.rm(folder, { recursive: true, force: true }).then(
      () => undefined,
      (error: NodeJS.ErrnoException) => error,
    )
    if (error === undefined) return
    if (!HELD.has(String(error.code)) || Date.now() - started >= limit)
      throw new Error(
        `${folder} could not be removed within ${limit / 1000} s (${error.code}). Processes still running that ` +
          `${parents.join(", ")} started:\n${await running(parents)}`,
        { cause: error },
      )
    // A handle that only the garbage collector would close (a finished Bun.spawn's pipe) goes now.
    Bun.gc(true)
    await Bun.sleep(100)
  }
}

// The running processes whose parent is one of `parents`, with their command lines. Windows keeps a process's parent id
// after the parent exits, so this also finds what an exited child left running. Elsewhere an open file does not stop a
// removal, so there is nothing to list.
async function running(parents: number[]) {
  if (process.platform !== "win32" || parents.length === 0) return "(not listed)"
  // By its full path, so no powershell.exe in the working folder is started instead (class 10).
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
