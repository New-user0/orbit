import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { processNative } from "../fixture/native-watcher"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

setDefaultTimeout(30_000)
const it = testEffect(Layer.empty)

const realLayer = Watcher.layer().pipe(
  Layer.provide(Layer.succeed(Watcher.Native, processNative(Watcher.binding, Watcher.backend()))),
)

// The binding shares one backend among all the native watches of a process and destroys it when the last of them ends. A
// watch made while that last one is being ended joins the backend that is going away and hears nothing for good,
// whichever folder it watches. So the layer starts a native watch only once every watch that is being ended has ended.
describe("a native watch made while the last native watch of the process is being ended", () => {
  for (const row of [
    { name: "of another folder hears its folder, after the end of the last one", wait: true },
    { name: "of another folder hears its folder, while the last one is being ended", wait: false },
  ]) {
    // On Windows a released watch is parked and never ended, so there is no end to hear a watch made during.
    const test = process.platform === "win32" ? it.live.skip : it.live
    test(row.name, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const service = yield* Watcher.Service
          // One try fails only some of the time on the old code, since the end of the watch is quick, so the row tries 20 times.
          yield* Effect.forEach(
            Array.from({ length: 20 }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const left = path.join(tmp.path, `left-${index}`)
                const next = path.join(tmp.path, `next-${index}`)
                yield* Effect.promise(() => Promise.all([fs.mkdir(left), fs.mkdir(next)]))
                const first = yield* service.subscribe({ path: left, type: "directory" }).pipe(
                  Effect.flatMap(Stream.runForEach(() => Effect.void)),
                  Effect.forkChild({ startImmediately: true }),
                )
                yield* Effect.sleep("50 millis")
                const leaving = yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true })
                if (row.wait) yield* Fiber.join(leaving)
                const seen: string[] = []
                const ready = yield* Deferred.make<void>()
                const second = yield* service
                  .subscribe({ path: next, type: "directory" }, Deferred.succeed(ready, undefined))
                  .pipe(
                    Effect.flatMap(Stream.runForEach((item) => Effect.sync(() => seen.push(item.path)))),
                    Effect.forkChild({ startImmediately: true }),
                  )
                yield* Deferred.await(ready)
                yield* Effect.promise(() => Bun.write(path.join(next, "after.txt"), "x"))
                yield* Effect.gen(function* () {
                  while (!seen.some((file) => file.endsWith("after.txt"))) yield* Effect.sleep("20 millis")
                }).pipe(Effect.timeoutOption("3 seconds"))
                yield* Fiber.interrupt(second)
                // The first try that hears nothing ends the row.
                expect(seen.some((file) => file.endsWith("after.txt"))).toBe(true)
              }),
          )
        }).pipe(Effect.provide(realLayer)),
      ),
    )
  }
})

// The order of the calls the layer makes to the binding, with the end of a watch reported late (and, in the third row, a
// watch that is still being made when it is left): a watch starts only once every end before it has been reported,
// whatever the binding does in between. On Windows a released watch is parked and never ended, so there is no end to
// wait for.
describe("the native watches of a process are made after the ends before them", () => {
  for (const row of [
    { name: "of the same folder", other: false, left: 300 },
    { name: "of another folder", other: true, left: 300 },
    { name: "of another folder, the first one left while it is still being made", other: true, left: 100 },
  ]) {
    const test = process.platform === "win32" ? it.live.skip : it.live
    test(`starts a watch ${row.name} only after the end of the earlier one`, () =>
      withTempDir((tmp) => {
        const calls: string[] = []
        const binding = Watcher.binding()!
        const slow = {
          subscribe: async (...args: Parameters<typeof binding.subscribe>) => {
            const folder = path.basename(args[0])
            calls.push(`subscribe ${folder}`)
            // Making the first watch takes 300 ms, so the third row leaves it before it is made.
            if (row.left === 100 && calls.length === 1) await Bun.sleep(300)
            const subscription = await binding.subscribe(...args)
            return {
              unsubscribe: async () => {
                calls.push(`unsubscribe ${folder}`)
                await subscription.unsubscribe()
                await Bun.sleep(300)
                calls.push(`unsubscribed ${folder}`)
              },
            }
          },
        }
        const left = path.join(tmp.path, "left")
        const next = row.other ? path.join(tmp.path, "next") : left
        return Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all([fs.mkdir(left, { recursive: true }), fs.mkdir(next, { recursive: true })]),
          )
          const service = yield* Watcher.Service
          const first = yield* service.subscribe({ path: left, type: "directory" }).pipe(
            Effect.flatMap(Stream.runForEach(() => Effect.void)),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Effect.sleep(`${row.left} millis`)
          yield* Effect.forkChild(Fiber.interrupt(first), { startImmediately: true })
          const ready = yield* Deferred.make<void>()
          const second = yield* service
            .subscribe({ path: next, type: "directory" }, Deferred.succeed(ready, undefined))
            .pipe(
              Effect.flatMap(Stream.runForEach(() => Effect.void)),
              Effect.forkChild({ startImmediately: true }),
            )
          yield* Deferred.await(ready)
          yield* Fiber.interrupt(second)
          const ended = calls.indexOf(`unsubscribed ${path.basename(left)}`)
          expect(ended).toBeGreaterThan(-1)
          expect(calls.indexOf(`subscribe ${path.basename(next)}`, ended)).toBeGreaterThan(ended)
        }).pipe(
          Effect.provide(
            Watcher.layer().pipe(
              Layer.provide(Layer.effect(Watcher.Native, Watcher.makeNative(() => slow, Watcher.backend()))),
            ),
          ),
        )
      }),
    )
  }
})

// Bun keeps one fs.watch per path on Linux. While one stays open after its folder was removed and made again, a new
// watch of the path hears nothing: 50 of 50 times in a script, and 100 of 100 when the stale one was closed after the new
// one opened. So a watch of a folder that went away reports it, closes, and ends its stream, and its consumers watch again.
describe("a file or entries watch of a folder that is removed and made again", () => {
  for (const type of ["entries", "file"] as const) {
    it.live(`${type}: reports it and ends, and a new watch hears the new folder`, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const service = yield* Watcher.Service
          const folder = path.join(tmp.path, "root")
          yield* Effect.promise(() => fs.mkdir(folder))
          const input =
            type === "entries"
              ? ({ path: folder, type, names: ["settings.json", "skills"] } as const)
              : ({ path: path.join(folder, "skills"), type } as const)
          const seen: string[] = []
          const old = yield* service.subscribe(input).pipe(
            Effect.flatMap(Stream.runForEach((item) => Effect.sync(() => seen.push(item.path)))),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Effect.sleep("300 millis")
          // Back to back, within one reload of a consumer that waits to read what changed.
          yield* Effect.promise(async () => {
            await fs.rm(folder, { recursive: true })
            await fs.mkdir(folder)
          })
          const ended = yield* Fiber.await(old).pipe(Effect.timeoutOption("5 seconds"))
          expect(ended._tag).toBe("Some")
          expect(seen.length).toBeGreaterThan(0)
          const heard: string[] = []
          const ready = yield* Deferred.make<void>()
          const fresh = yield* service.subscribe(input, Deferred.succeed(ready, undefined)).pipe(
            Effect.flatMap(Stream.runForEach((item) => Effect.sync(() => heard.push(item.path)))),
            Effect.forkChild({ startImmediately: true }),
          )
          yield* Deferred.await(ready)
          yield* Effect.promise(() => Bun.write(path.join(folder, "skills"), "x"))
          yield* Effect.gen(function* () {
            while (heard.length === 0) yield* Effect.sleep("20 millis")
          }).pipe(Effect.timeoutOption("3 seconds"))
          yield* Fiber.interrupt(fresh)
          expect(heard.length).toBeGreaterThan(0)
        }).pipe(Effect.provide(realLayer)),
      ),
    )
  }
})
