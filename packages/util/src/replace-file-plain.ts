// A file is written whole by writing a temporary file next to it and renaming that over it. On Windows the rename
// answers EPERM, EACCES or EBUSY while any other handle has the target open, and readers do hold it for a moment:
// another process loading the file, a reload, a client reading a registration. The rename is tried again with a short
// backoff until the deadline, and then the last error is thrown, so a handle that is never let go still fails the write.
//
// This module is plain TypeScript with no Effect, so the VS Code extension can bundle it; replace-file.ts adds the Effect
// form on the same bound. There is no synchronous form: its waits would hold the calling thread, which in the extension
// is the editor's extension host, for up to the whole deadline.
import { rename } from "node:fs/promises"

/** How long a replace waits for readers to let go of the target before it gives up. */
export const DEADLINE_MS = 5_000
export const FIRST_DELAY_MS = 10
export const MAX_DELAY_MS = 200

export async function replaceFile(from: string, to: string) {
  const stop = performance.now() + DEADLINE_MS
  const attempt = async (delay: number): Promise<void> =>
    rename(from, to).catch(async (error: unknown) => {
      if (!held(code(error)) || performance.now() + delay > stop) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
      return attempt(Math.min(delay * 2, MAX_DELAY_MS))
    })
  return attempt(FIRST_DELAY_MS)
}

/** Whether a rename failed only because a reader still has the target open, which on Windows ends when it lets go. */
export function held(code: string | undefined) {
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")
}

export function code(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return
  return error.code
}
