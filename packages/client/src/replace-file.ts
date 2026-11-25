import { rename } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

// The client writes the persistent-terminal ticket by renaming a temporary file over it, and on Windows that rename
// answers EPERM, EACCES or EBUSY while any other handle has the target open: every contender reads the ticket while a
// replacement is under way. The rename is tried again with a short backoff until the deadline, and then the last error
// is thrown. The client may not depend on `@orbit/util`, whose `replaceFile` does the same for the other writers.

/** How long a replace waits for readers to let go of the target before it gives up. */
export const DEADLINE_MS = 5_000

export async function replaceFile(from: string, to: string) {
  const stop = performance.now() + DEADLINE_MS
  const attempt = async (delay: number): Promise<void> =>
    rename(from, to).catch(async (error: unknown) => {
      if (!held(error) || performance.now() + delay > stop) throw error
      await sleep(delay)
      return attempt(Math.min(delay * 2, 200))
    })
  return attempt(10)
}

function held(error: unknown) {
  if (process.platform !== "win32") return false
  if (typeof error !== "object" || error === null || !("code" in error)) return false
  return error.code === "EPERM" || error.code === "EACCES" || error.code === "EBUSY"
}
