// A file is written whole by writing a temporary file next to it and renaming that over it. On Windows the rename
// answers EPERM, EACCES or EBUSY while any other handle has the target open, and readers do hold it for a moment:
// another process loading the file, a reload, a client reading a registration. The rename is tried again with a short
// backoff until the deadline, and then the last error is thrown, so a handle that is never let go still fails the write.
//
// This module is plain TypeScript with no Effect, so the VS Code extension can bundle it; replace-file.ts builds the
// asynchronous and Effect forms on the same bound.
import { renameSync } from "node:fs"

/** How long a replace waits for readers to let go of the target before it gives up. */
export const DEADLINE_MS = 5_000
export const FIRST_DELAY_MS = 10
export const MAX_DELAY_MS = 200

/**
 * Replaces a file for a writer that is called synchronously (the IDE bridge rewrites its lock from an editor event): the
 * thread waits between tries, with the same deadline as the asynchronous form.
 */
export function replaceFileSync(from: string, to: string) {
  const stop = performance.now() + DEADLINE_MS
  const attempt = (delay: number): void => {
    const error = renamed(from, to)
    if (error === undefined) return
    if (!held(code(error)) || performance.now() + delay > stop) throw error
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay)
    attempt(Math.min(delay * 2, MAX_DELAY_MS))
  }
  attempt(FIRST_DELAY_MS)
}

function renamed(from: string, to: string) {
  try {
    renameSync(from, to)
    return undefined
  } catch (error) {
    return error
  }
}

/** Whether a rename failed only because a reader still has the target open, which on Windows ends when it lets go. */
export function held(code: string | undefined) {
  return process.platform === "win32" && (code === "EPERM" || code === "EACCES" || code === "EBUSY")
}

export function code(error: unknown) {
  if (typeof error !== "object" || error === null || !("code" in error) || typeof error.code !== "string") return
  return error.code
}
