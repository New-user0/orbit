import { describe, expect } from "bun:test"
import { Clock, Duration, Effect, Option } from "effect"
import { advance, waitingClock } from "./clock"
import { it } from "./effect"

// `advance` drives the TestClock while real work (an import, a file write, a subprocess) finishes between its steps.
// It gave that real work 100 one-millisecond macrotask ticks and then failed with "condition never became true after
// 100 advances", so a plugin import that took longer on a loaded machine failed the PluginSupervisor reload rows
// (docs/known-failures.md) with a wrong result rather than a timeout. The real work has no promise of how long it takes;
// the bound on waiting for it is the test's own time limit, which reports a timeout as a timeout.
it.effect(
  "advance waits for real work that outlasts a hundred macrotask ticks",
  () =>
    Effect.gen(function* () {
      let done = false
      // Real work that takes far longer than 100 macrotask ticks on any machine.
      const timer = setTimeout(() => (done = true), 3_000)
      yield* advance(() => done).pipe(Effect.ensuring(Effect.sync(() => clearTimeout(timer))))
      expect(done).toBe(true)
    }),
  15_000,
)

it.effect("advance returns at once when the condition already holds: the control for the row above", () =>
  Effect.gen(function* () {
    yield* advance(() => true)
  }),
)

// The waiting clock takes the speed of the machine out of a row about what fits in a span of time: its time stands
// still while counted work runs, however long that work takes, and moves to the next sleep once all is quiet.
describe("waitingClock", () => {
  // Real work three times as long as the time allowed for it.
  const slow = Effect.promise(() => Bun.sleep(300).then(() => "done"))

  it.live("counted work takes no time on it, however long it runs on the real clock", () =>
    Effect.gen(function* () {
      const time = yield* waitingClock
      const before = time.now()
      const result = yield* time
        .work(slow)
        .pipe(Effect.timeoutOption("100 millis"), Effect.provideService(Clock.Clock, time.clock))
      expect(result).toEqual(Option.some("done"))
      expect(time.now()).toBe(before)
    }),
  )

  it.live("the same work runs out of that time on the real clock: the control for the row above", () =>
    Effect.gen(function* () {
      expect(yield* slow.pipe(Effect.timeoutOption("100 millis"))).toEqual(Option.none())
    }),
  )

  it.live("moves to each sleep in turn once all is quiet, and wakes the sleeps due together", () =>
    Effect.gen(function* () {
      const time = yield* waitingClock
      const start = time.now()
      const woke: Array<[string, number]> = []
      const sleeper = (name: string, duration: Duration.Input) =>
        Effect.sleep(duration).pipe(Effect.andThen(Effect.sync(() => woke.push([name, time.now() - start]))))
      yield* Effect.all(
        [sleeper("hour", "1 hour"), sleeper("minute", "1 minute"), sleeper("also a minute", "1 minute")],
        {
          concurrency: "unbounded",
        },
      ).pipe(Effect.provideService(Clock.Clock, time.clock))
      expect(woke).toEqual([
        ["minute", 60_000],
        ["also a minute", 60_000],
        ["hour", 3_600_000],
      ])
      // A day ahead of the real clock, so code that mixes the two is far off.
      expect(start - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1000)
    }),
  )

  it.live("a sleep that is interrupted is forgotten, so the time never moves to it", () =>
    Effect.gen(function* () {
      const time = yield* waitingClock
      const start = time.now()
      yield* Effect.sleep("1 hour").pipe(
        Effect.timeoutOption("1 minute"),
        Effect.provideService(Clock.Clock, time.clock),
      )
      // Quiet for longer than the clock needs to move, with only the interrupted hour left to move to.
      yield* Effect.promise(() => Bun.sleep(300))
      expect(time.now() - start).toBe(60_000)
    }),
  )

  it.live("counts the effects of a wrapped service's methods, effects and nested objects as work", () =>
    Effect.gen(function* () {
      const time = yield* waitingClock
      const names = new Set(["a"])
      const service = time.counted({ read: () => slow, ready: slow, files: { read: () => slow }, size: () => 3, names })
      const timed = (effect: Effect.Effect<string>) =>
        effect.pipe(Effect.timeoutOption("100 millis"), Effect.provideService(Clock.Clock, time.clock))
      expect(yield* timed(service.read())).toEqual(Option.some("done"))
      expect(yield* timed(service.ready)).toEqual(Option.some("done"))
      expect(yield* timed(service.files.read())).toEqual(Option.some("done"))
      // A method that returns no effect, and a value that is not a plain object, are left as they are.
      expect(service.size()).toBe(3)
      expect(service.names).toBe(names)
    }),
  )
})
