import { Clock, Duration, Effect } from "effect"
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

/** How many quiet turns of the event loop the waiting clock needs before it moves. */
const QUIET_TURNS = 10
const DAY = 24 * 60 * 60 * 1000
// One turn of the event loop: its timers, then the immediates the Effect scheduler runs fibers on.
const turn = () => new Promise<void>((resolve) => setTimeout(() => setImmediate(resolve), 0))

/**
 * A clock whose time moves only while everything the code under test does is waiting on it, so what fits in a span of
 * time does not depend on how fast the machine runs the work between the waits. The test runs that work through `work`
 * (or the services it wraps with `counted`), on the real clock; while any of it runs, or while anything touched the
 * clock in the last few turns of the event loop, the time stands still. Once all is quiet, the clock moves to the
 * earliest sleep and wakes every sleep due then. The time starts a day ahead of the real time, so a stored timestamp
 * stays plausible while code that mixes this clock with `Date.now()` is a day off and fails its test. The clock is driven
 * from the scope it is made in.
 */
export const waitingClock = Effect.gen(function* () {
  const live = yield* Clock.clockWith(Effect.succeed)
  let now = Date.now() + DAY
  let sequence = 0
  // Work running now, and a count bumped by every start or end of work, every sleep and every read of the time.
  let busy = 0
  let activity = 0
  const sleeps: Array<{ readonly at: number; readonly sequence: number; readonly wake: () => void }> = []
  const read = () => {
    activity++
    return now
  }
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: read,
    currentTimeMillis: Effect.sync(read),
    currentTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(read()) * 1_000_000n),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        activity++
        const millis = Duration.toMillis(duration)
        if (millis <= 0) return resume(Effect.void)
        const entry = { at: now + millis, sequence: sequence++, wake: () => resume(Effect.void) }
        sleeps.push(entry)
        sleeps.sort((left, right) => left.at - right.at || left.sequence - right.sequence)
        return Effect.sync(() => {
          activity++
          const index = sleeps.indexOf(entry)
          if (index >= 0) sleeps.splice(index, 1)
        })
      }),
  }
  const work = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      busy++
      activity++
      return effect.pipe(
        Effect.provideService(Clock.Clock, live),
        Effect.ensuring(
          Effect.sync(() => {
            busy--
            activity++
          }),
        ),
      )
    })
  /** `service` with every effect its methods return run as `work`, those of nested objects included. */
  const counted = <S extends object>(service: S): S =>
    new Proxy(service, {
      get: (target, key) => {
        const value: unknown = Reflect.get(target, key)
        if (Effect.isEffect(value)) return work(value)
        if (typeof value === "function")
          return (...args: ReadonlyArray<unknown>) => {
            const result: unknown = Reflect.apply(value, target, args)
            return Effect.isEffect(result) ? work(result) : result
          }
        if (typeof value === "object" && value !== null) return counted(value)
        return value
      },
    })
  const quiet = Effect.promise(async () => {
    const seen = activity
    for (let round = 0; round < QUIET_TURNS; round++) {
      await turn()
      if (busy > 0 || activity !== seen) return false
    }
    return true
  })
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.gen(function* () {
        if (!(yield* quiet) || sleeps.length === 0 || !Number.isFinite(sleeps[0].at)) return
        now = sleeps[0].at
        activity++
        for (const entry of sleeps.splice(0, sleeps.findLastIndex((entry) => entry.at <= now) + 1)) entry.wake()
      }),
    ),
  )
  return { clock, work, counted, now: () => now }
})
