import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Fiber } from "effect"
import { ToolScheduler } from "@orbit/core/session/runner/tool-scheduler"
import { it } from "./lib/effect"

// Everything here is driven by Deferreds: a start is observed through the work effect, never through a clock. A call
// that must not have started is checked after a few yields, and the same test then shows it starting when it may.
const settle = Effect.forEach([0, 1, 2, 3, 4, 5], () => Effect.yieldNow, { discard: true })

const harness = (maxConcurrency = 10) =>
  Effect.gen(function* () {
    const log: Array<string> = []
    const scheduler = ToolScheduler.make<string>({
      maxConcurrency,
      onQueued: (id) => Effect.sync(() => log.push(`queued ${id}`)),
      onStarted: (id) => Effect.sync(() => log.push(`started ${id}`)),
    })
    const order: Array<string> = []
    const finalized: Array<string> = []
    const gates = new Map<string, Deferred.Deferred<void>>()
    const starts = new Map<string, Deferred.Deferred<void>>()
    const slot = (map: typeof gates, id: string) => {
      const existing = map.get(id)
      if (existing) return existing
      const created = Deferred.makeUnsafe<void>()
      map.set(id, created)
      return created
    }
    // The work of one entry: it records its start, holds until the test opens its gate, and records a finalizer.
    const work = (id: string) =>
      Effect.sync(() => order.push(id)).pipe(
        Effect.andThen(Deferred.succeed(slot(starts, id), undefined)),
        Effect.andThen(Deferred.await(slot(gates, id))),
        Effect.as(id),
        Effect.ensuring(Effect.sync(() => finalized.push(id))),
      )
    const run = (entry: ToolScheduler.Entry<string>, safe: boolean) =>
      scheduler
        .run(entry, { concurrencySafe: safe }, work(entry.id))
        .pipe(Effect.ensuring(scheduler.release(entry)), Effect.forkChild({ startImmediately: true }))
    return {
      scheduler,
      log,
      order,
      finalized,
      run,
      started: (id: string) => Deferred.await(slot(starts, id)),
      open: (id: string) => Deferred.succeed(slot(gates, id), undefined),
    }
  })

describe("ToolScheduler", () => {
  it.effect("starts entries in registration order and shares the cap in a sliding window", () =>
    Effect.gen(function* () {
      const h = yield* harness(2)
      const [a, b, c, d] = ["a", "b", "c", "d"].map(h.scheduler.register)
      // Their traits arrive in another order than they were registered.
      const fibers = [yield* h.run(d, true), yield* h.run(c, true), yield* h.run(b, true), yield* h.run(a, true)]

      yield* h.started("a")
      yield* h.started("b")
      yield* settle
      expect([...h.order].sort()).toEqual(["a", "b"])

      yield* h.open("a")
      yield* h.started("c")
      yield* settle
      expect([...h.order].sort()).toEqual(["a", "b", "c"])

      yield* h.open("b")
      yield* h.started("d")
      yield* h.open("c")
      yield* h.open("d")
      yield* Fiber.joinAll(fibers)
      expect([...h.order].sort()).toEqual(["a", "b", "c", "d"])
    }),
  )

  it.effect("runs an entry that is not safe alone, and holds a safe entry behind it", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const [a, b, c] = ["a", "b", "c"].map(h.scheduler.register)
      const fibers = [yield* h.run(a, true), yield* h.run(b, false), yield* h.run(c, true)]

      yield* h.started("a")
      yield* settle
      // `b` waits for the running safe entry, and `c` does not overtake `b`.
      expect(h.order).toEqual(["a"])

      yield* h.open("a")
      yield* h.started("b")
      yield* settle
      expect(h.order).toEqual(["a", "b"])

      yield* h.open("b")
      yield* h.started("c")
      yield* h.open("c")
      yield* Fiber.joinAll(fibers)
    }),
  )

  it.effect("holds every later entry until an earlier entry's traits are resolved", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const [a, b] = ["a", "b"].map(h.scheduler.register)
      const second = yield* h.run(b, true)
      yield* settle
      expect(h.order).toEqual([])

      const first = yield* h.run(a, true)
      yield* h.started("a")
      yield* h.started("b")
      yield* h.open("a")
      yield* h.open("b")
      yield* Fiber.joinAll([first, second])
      expect([...h.order].sort()).toEqual(["a", "b"])
    }),
  )

  it.effect("starts a partition before the entries after it exist", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const a = h.scheduler.register("a")
      const first = yield* h.run(a, true)
      // Entry 1 runs before entry 2 is registered: nothing waits for the end of the batch.
      yield* h.started("a")

      const b = h.scheduler.register("b")
      const second = yield* h.run(b, false)
      yield* settle
      expect(h.log).toEqual(["queued b"])

      const c = h.scheduler.register("c")
      const third = yield* h.run(c, true)
      yield* settle
      expect(h.order).toEqual(["a"])

      yield* h.open("a")
      yield* Fiber.join(first)
      yield* h.started("b")
      expect(h.log).toEqual(["queued b", "queued c", "started b"])
      yield* h.open("b")
      yield* h.started("c")
      yield* h.open("c")
      yield* Fiber.joinAll([second, third])
      expect(h.log).toEqual(["queued b", "queued c", "started b", "started c"])
    }),
  )

  it.effect("starts an entry at once when everything before it has settled, without a hint", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const a = h.scheduler.register("a")
      const first = yield* h.run(a, false)
      yield* h.open("a")
      yield* Fiber.join(first)

      const b = h.scheduler.register("b")
      const second = yield* h.run(b, false)
      yield* h.started("b")
      yield* h.open("b")
      yield* Fiber.join(second)
      expect(h.log).toEqual([])
    }),
  )

  it.effect("cancels a queued entry without running its work, and lets the next one start", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const [a, b, c] = ["a", "b", "c"].map(h.scheduler.register)
      const fibers = [yield* h.run(a, false), yield* h.run(b, false), yield* h.run(c, false)]
      yield* h.started("a")

      yield* h.scheduler.cancel({ running: false, future: false, select: (id) => id === "b" }, "skipped")
      expect(yield* Fiber.join(fibers[1])).toEqual({ _tag: "Cancelled", error: "skipped" })
      yield* h.open("a")
      yield* h.started("c")
      yield* h.open("c")
      yield* Fiber.joinAll([fibers[0], fibers[2]])
      expect(h.order).toEqual(["a", "c"])
    }),
  )

  it.effect("lets the next entry start when the head of the queue is cancelled", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const [a, b, c] = ["a", "b", "c"].map(h.scheduler.register)
      const first = yield* h.run(a, false)
      yield* h.started("a")
      const second = yield* h.run(b, false)
      const third = yield* h.run(c, true)

      // `b` is the head of the queue; once it is gone `c` is first, but `a` still runs and `c` is safe.
      yield* h.scheduler.cancel({ running: false, future: false, select: (id) => id === "b" }, "skipped")
      yield* Fiber.join(second)
      yield* settle
      expect(h.order).toEqual(["a"])
      yield* h.open("a")
      yield* h.started("c")
      yield* h.open("c")
      yield* Fiber.joinAll([first, third])
    }),
  )

  it.effect("cancels a running entry, interrupts its work and runs the work's finalizer", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const a = h.scheduler.register("a")
      const fiber = yield* h.run(a, true)
      yield* h.started("a")

      yield* h.scheduler.cancel({ running: true, future: false, select: () => true }, "stopped")

      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Cancelled", error: "stopped" })
      expect(h.finalized).toEqual(["a"])
    }),
  )

  it.effect("leaves a running entry alone when only queued ones are selected", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const a = h.scheduler.register("a")
      const fiber = yield* h.run(a, true)
      yield* h.started("a")

      yield* h.scheduler.cancel({ running: false, future: false, select: () => true }, "stopped")
      yield* settle
      expect(h.finalized).toEqual([])
      yield* h.open("a")
      expect(yield* Fiber.join(fiber)).toEqual({ _tag: "Ran", value: "a" })
    }),
  )

  it.effect("cancels the matching entries registered later when asked", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      yield* h.scheduler.cancel({ running: false, future: true, select: (id) => id.startsWith("x") }, "later")

      const x = h.scheduler.register("x1")
      const a = h.scheduler.register("a")
      const cancelled = yield* h.run(x, true)
      const ran = yield* h.run(a, true)

      expect(yield* Fiber.join(cancelled)).toEqual({ _tag: "Cancelled", error: "later" })
      // The cancelled entry never joined the queue, so it does not hold `a` back.
      yield* h.started("a")
      yield* h.open("a")
      yield* Fiber.join(ran)
      expect(h.order).toEqual(["a"])
    }),
  )

  it.effect("halts the queued and future entries but not the running ones", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const [a, b, c] = ["a", "b", "c"].map(h.scheduler.register)
      const running = yield* h.run(a, false)
      yield* h.started("a")
      const queued = yield* h.run(b, true)
      // `c` has no traits yet when the halt lands.
      yield* h.scheduler.halt("declined")

      expect(yield* Fiber.join(queued)).toEqual({ _tag: "Cancelled", error: "declined" })
      expect(yield* Fiber.join(yield* h.run(c, true))).toEqual({ _tag: "Cancelled", error: "declined" })
      const future = h.scheduler.register("d")
      expect(yield* Fiber.join(yield* h.run(future, true))).toEqual({ _tag: "Cancelled", error: "declined" })

      yield* settle
      expect(h.finalized).toEqual([])
      yield* h.open("a")
      expect(yield* Fiber.join(running)).toEqual({ _tag: "Ran", value: "a" })
      expect(h.order).toEqual(["a"])
    }),
  )

  it.effect("starts the next entry when an entry's work dies and is released", () =>
    Effect.gen(function* () {
      const h = yield* harness()
      const [a, b] = ["a", "b"].map(h.scheduler.register)
      const failing = yield* h.scheduler
        .run(a, { concurrencySafe: false }, Effect.die("defect"))
        .pipe(Effect.ensuring(h.scheduler.release(a)), Effect.exit, Effect.forkChild({ startImmediately: true }))
      const second = yield* h.run(b, false)

      yield* h.started("b")
      const exit = yield* Fiber.join(failing)
      expect(exit._tag === "Failure" && Cause.hasDies(exit.cause)).toBe(true)
      yield* h.open("b")
      yield* Fiber.join(second)
    }),
  )
})
