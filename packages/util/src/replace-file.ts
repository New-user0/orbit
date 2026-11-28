import { Effect, Schedule } from "effect"
import type { FileSystem } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { code, DEADLINE_MS, FIRST_DELAY_MS, held, MAX_DELAY_MS } from "./replace-file-plain.js"

// Replacing a file by rename, waiting for readers that hold it on Windows: see replace-file-plain.ts for why, the bound
// and the asynchronous form.
export { DEADLINE_MS, replaceFile } from "./replace-file-plain.js"

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
