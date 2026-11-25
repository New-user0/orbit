import { Effect } from "effect"
import { TestClock } from "effect/testing"

// Defers on a real macrotask so pubsub delivery, fiber hops, and filesystem
// work can complete between TestClock advances.
const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)))

// One advance step: let pending real work finish, then fire due TestClock timers.
const tick = Effect.gen(function* () {
  yield* settle
  yield* TestClock.adjust("500 millis")
})

/**
 * Drives every pending TestClock timer to completion: stream debounces register
 * their sleeps from separate fiber hops that a single adjust can miss, so the
 * loop alternates real-macrotask settles with adjusts until the condition
 * holds. Extra adjusts are harmless when nothing is pending.
 */
export const advance = Effect.fnUntraced(function* (condition: () => boolean) {
  // No count of its own: the real work between the steps has no promise of how long it takes, and a count reported a
  // loaded machine as a wrong result. The test's time limit bounds the wait and reports it as a timeout.
  while (!condition()) yield* tick
})

/**
 * Advances far enough that any pending debounced work would have completed,
 * so a no-op assertion afterwards is meaningful.
 */
export const drain = Effect.gen(function* () {
  for (let round = 0; round < 4; round++) {
    yield* tick
  }
  yield* settle
})
