import { describe, expect, setDefaultTimeout } from "bun:test"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { processNative } from "../fixture/native-watcher"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

setDefaultTimeout(30_000)
const it = testEffect(Layer.empty)

// A native watch of a folder, made while the watch before it for the same folder is still being ended, joins the one
// that is going away and never hears the folder again. The watch layer runs over the real binding of the process, and
// a row that leaves a watch and makes the next one without waiting for the first one's end is how the plugin that
// watches a skills folder met it.
describe("a native watch of a folder that an earlier watch of it is leaving", () => {
  for (const row of [
    { name: "hears a file made after it is ready, after the earlier watch is gone", wait: true },
    { name: "hears a file made after it is ready, while the earlier watch is still being ended", wait: false },
  ]) {
    it.live(row.name, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const service = yield* Watcher.Service
          const input = { path: tmp.path, type: "directory" } as const
          const first = yield* service.subscribe(input).pipe(
            Effect.flatMap(Stream.runForEach(() => Effect.void)),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Effect.sleep("300 millis")
          const leaving = yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true })
          if (row.wait) yield* Fiber.join(leaving)
          const seen: string[] = []
          const ready = yield* Deferred.make<void>()
          const second = yield* service.subscribe(input, Deferred.succeed(ready, undefined)).pipe(
            Effect.flatMap(Stream.runForEach((item) => Effect.sync(() => seen.push(item.path)))),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Deferred.await(ready)
          yield* Effect.promise(() => Bun.write(path.join(tmp.path, "after.txt"), "x"))
          yield* Effect.gen(function* () {
            while (!seen.some((file) => file.endsWith("after.txt"))) yield* Effect.sleep("20 millis")
          }).pipe(Effect.timeoutOption("3 seconds"))
          yield* Fiber.interrupt(second)
          expect(seen.some((file) => file.endsWith("after.txt"))).toBe(true)
        }).pipe(
          Effect.provide(
            Watcher.layer().pipe(
              Layer.provide(Layer.succeed(Watcher.Native, processNative(Watcher.binding, Watcher.backend()))),
            ),
          ),
        ),
      ),
    )
  }
})

// The order of the calls the watch layer makes to the binding, with the end of a watch reported late: a watch of a folder
// starts only once the end of the one before it has been reported, whatever the binding does in between. On Windows a
// released watch is parked and never ended, so there is no end to wait for.
describe("the native watches of a folder are made one after the other", () => {
  (process.platform === "win32" ? it.live.skip : it.live)("starts a watch only after the end of the earlier one of the folder", () =>
    withTempDir((tmp) => {
      const calls: string[] = []
      const binding = Watcher.binding()!
      const slow = {
        subscribe: async (...args: Parameters<typeof binding.subscribe>) => {
          calls.push("subscribe")
          const subscription = await binding.subscribe(...args)
          return {
            unsubscribe: async () => {
              calls.push("unsubscribe")
              await subscription.unsubscribe()
              await Bun.sleep(300)
              calls.push("unsubscribed")
            },
          }
        },
      }
      return Effect.gen(function* () {
        const service = yield* Watcher.Service
        const input = { path: tmp.path, type: "directory" } as const
        const first = yield* service.subscribe(input).pipe(
          Effect.flatMap(Stream.runForEach(() => Effect.void)),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Effect.sleep("300 millis")
        yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true })
        const ready = yield* Deferred.make<void>()
        const second = yield* service.subscribe(input, Deferred.succeed(ready, undefined)).pipe(
          Effect.flatMap(Stream.runForEach(() => Effect.void)),
          Effect.forkChild({ startImmediately: true }),
        )
        yield* Deferred.await(ready)
        yield* Fiber.interrupt(second)
        expect(calls.slice(0, 4)).toEqual(["subscribe", "unsubscribe", "unsubscribed", "subscribe"])
      }).pipe(
        Effect.provide(
          Watcher.layer().pipe(
            Layer.provide(Layer.effect(Watcher.Native, Watcher.makeNative(() => slow, Watcher.backend()))),
          ),
        ),
      )
    }),
  )
})
