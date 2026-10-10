export * as ShellStall from "./stall.js"

import { Duration, Effect } from "effect"

/** How often the size of a background command's output is looked at. */
export const CHECK = Duration.seconds(5)
/** How long the output must stay unchanged before its tail is looked at. Growth is only seen at a check. */
export const QUIET = Duration.seconds(45)
/** How much of the end of the output is read. */
export const TAIL_BYTES = 1024

// A question the model can act on by supplying the answer or a non-interactive flag. Credential and login prompts are
// deliberately absent. Each cue is tried against the last line only, ignoring letter case.
const cues = [
  /\(y\/n\)/i,
  /\[y\/n\]/i,
  /\(yes\/no\)/i,
  /\b(?:do you|would you|shall i|are you sure|ready to)\b.*\?\s*$/i,
  /press (?:any key|enter)/i,
  /continue\?/i,
  /overwrite\?/i,
]

/** Whether the last line of `tail` looks like a question that is waiting for an answer. */
export function looksLikePrompt(tail: string) {
  const last = tail.trimEnd().split("\n").at(-1) ?? ""
  return cues.some((cue) => cue.test(last))
}

type Gone = { readonly _tag: string }

/**
 * Runs until the output has been quiet for `QUIET` and ends on a prompt, then calls `onStall` once with the tail and
 * returns. Counts checks instead of reading the clock, so it follows a test clock. A removed shell ends it quietly; any
 * other failed read skips that check, and a failed tail read is retried at the next one.
 */
export const watch = <E extends Gone, E2 extends Gone, R>(input: {
  size: Effect.Effect<number, E>
  tail: Effect.Effect<string, E2>
  onStall: (tail: string) => Effect.Effect<void, never, R>
}) =>
  Effect.gen(function* () {
    const needed = Math.ceil(Duration.toMillis(QUIET) / Duration.toMillis(CHECK))
    let seen = 0
    let quiet = 0
    while (true) {
      yield* Effect.sleep(CHECK)
      const size = yield* input.size.pipe(readOrSkip)
      if (size === "gone") return
      if (size !== undefined && size > seen) {
        seen = size
        quiet = 0
        continue
      }
      if (size === undefined) continue
      quiet++
      if (quiet < needed) continue
      const tail = yield* input.tail.pipe(readOrSkip)
      if (tail === "gone") return
      if (tail === undefined) continue
      if (!looksLikePrompt(tail)) {
        quiet = 0
        continue
      }
      return yield* input.onStall(tail.trimEnd())
    }
  })

// "gone" when the shell was removed, undefined when this read failed in some other way.
const readOrSkip = <A, E extends Gone>(read: Effect.Effect<A, E>) =>
  read.pipe(
    Effect.catch((error) => Effect.succeed(error._tag === "Shell.NotFoundError" ? ("gone" as const) : undefined)),
  )
