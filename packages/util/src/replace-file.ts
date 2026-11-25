import { rename } from "node:fs/promises"
import { Effect, Schedule } from "effect"
import type { FileSystem } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { code, DEADLINE_MS, FIRST_DELAY_MS, held, MAX_DELAY_MS } from "./replace-file-sync.js"

// Replacing a file by rename, waiting for readers that hold it on Windows: see replace-file-sync.ts for why, the bound
// and the synchronous form.
export { DEADLINE_MS, replaceFileSync } from "./replace-file-sync.js"

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

/** `replaceFile` through an Effect file system, for the writers that use one. */
export function replaceFileEffect(fs: FileSystem.FileSystem, from: string, to: string) {
  return fs.rename(from, to).pipe(
    Effect.retry({
      while: (error: PlatformError) => held(code(error.reason.cause)),
      schedule: Schedule.min([Schedule.exponential(FIRST_DELAY_MS), Schedule.spaced(MAX_DELAY_MS)]).pipe(
        Schedule.while((meta) => meta.elapsed < DEADLINE_MS),
      ),
    }),
  )
}
