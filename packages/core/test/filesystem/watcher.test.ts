import { $ } from "bun"
import { describe, expect } from "bun:test"
import { realpathSync } from "fs"
import fs from "fs/promises"
import path from "path"
import type ParcelWatcher from "@parcel/watcher"
import { Deferred, Duration, Effect, Fiber, Layer, Option, Schedule, Stream } from "effect"
import { Config } from "@orbit/core/config"
import { ConfigLocationWatcherPlugin } from "@orbit/core/config/plugin/location-watcher"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Bus } from "@orbit/core/bus"
import { FSUtil } from "@orbit/util/fs-util"
import { LocationWatcher } from "@orbit/core/filesystem/location-watcher"
import { LocationWatcherPolicy } from "@orbit/core/filesystem/location-watcher-policy"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { FileSystem } from "@orbit/schema/filesystem"
import { Document, Event, Info, type Entry } from "@orbit/schema/config"
import { Location } from "@orbit/core/location"
import { Plugin } from "@orbit/core/plugin"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { AbsolutePath } from "@orbit/core/schema"
import { git, repository } from "../fixture/git"
import { keys, planted } from "../fixture/git-keys"
import { traced } from "../fixture/git-trace"
import { location } from "../fixture/location"
import { processNative } from "../fixture/native-watcher"
import { runProgram } from "../fixture/run-program"
import { tmpdir, tmpdirScoped, withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

type WatcherEvent = { file: string; event: "add" | "change" | "unlink" }
const describeNative = process.env.CI ? describe.skip : describe

const it = testEffect(AppNodeBuilder.build(LayerNode.group([FSUtil.node, Bus.node])))

const configLayer = Config.testLayer()

function withNative(native: Watcher.NativeInterface) {
  return Effect.provide(Watcher.layer().pipe(Layer.provide(Layer.succeed(Watcher.Native, native))))
}

function countingNative() {
  const counts = { subscribes: 0, unsubscribes: 0 }
  const native: Watcher.NativeInterface = {
    subscribe: () =>
      Effect.sync(() => {
        counts.subscribes++
        return {
          unsubscribe: () => {
            counts.unsubscribes++
            return Promise.resolve()
          },
        }
      }),
  }
  return { native, counts }
}

describe("Watcher lifecycle", () => {
  it.effect("signals readiness after acquisition and buffers updates published by the ready callback", () =>
    Effect.gen(function* () {
      const publish = yield* Deferred.make<(update: Watcher.Update) => void>()
      const acquired = yield* Deferred.make<void>()
      const counts = { ready: 0, closed: 0 }
      yield* Effect.gen(function* () {
        const watcher = yield* Watcher.Service
        const consumer = yield* watcher
          .subscribe(
            { path: "/shared", type: "entries", names: ["orbit.json"] },
            Effect.gen(function* () {
              counts.ready++
              const notify = yield* Deferred.await(publish)
              notify({ path: "/shared/orbit.json", type: "create" })
            }),
          )
          .pipe(Effect.flatMap(Stream.runHead), Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(publish)
        expect(counts.ready).toBe(0)
        yield* Deferred.succeed(acquired, undefined)
        expect(Option.getOrUndefined(yield* Fiber.join(consumer))).toEqual({
          path: "/shared/orbit.json",
          type: "create",
        })
        expect(counts).toEqual({ ready: 1, closed: 1 })
      }).pipe(
        withNative({
          subscribe: (input) =>
            Deferred.succeed(publish, input.publish).pipe(
              Effect.andThen(Deferred.await(acquired)),
              Effect.as({
                unsubscribe: async () => {
                  counts.closed++
                },
              }),
            ),
        }),
      )
    }),
  )

  it.effect("does not signal readiness for an unavailable native watch", () => {
    const counts = { ready: 0 }
    return Effect.gen(function* () {
      const watcher = yield* Watcher.Service
      const stream = yield* watcher.subscribe(
        { path: "/unavailable", type: "directory" },
        Effect.sync(() => {
          counts.ready++
        }),
      )
      yield* Stream.runDrain(stream)
      expect(counts.ready).toBe(0)
    }).pipe(withNative({ subscribe: () => Effect.undefined }))
  })

  it.live("watches only named immediate entries, including missing directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const native = yield* Watcher.Native
          const events: Watcher.Update[] = []
          yield* Effect.acquireRelease(
            native.subscribe({
              type: "entries",
              target: tmp.path,
              names: ["orbit.json", ".orbit"],
              ignore: [],
              publish: (update) => events.push(update),
            }),
            (subscription) => Effect.promise(() => subscription?.unsubscribe() ?? Promise.resolve()),
          )
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "nested"))
            await fs.writeFile(path.join(tmp.path, "nested", "orbit.json"), "ignored")
            await fs.writeFile(path.join(tmp.path, "orbit.jsonc"), "ignored")
            await fs.writeFile(path.join(tmp.path, "orbit.json"), "first")
          })
          yield* Effect.sync(() => events.length).pipe(
            Effect.filterOrFail((count) => count > 0),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeout("1 second"),
          )
          expect(events.every((update) => update.path === path.join(tmp.path, "orbit.json"))).toBe(true)
          yield* Effect.sleep("10 millis")
          yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".orbit")))
          yield* Effect.sync(() => events.some((update) => update.path === path.join(tmp.path, ".orbit"))).pipe(
            Effect.filterOrFail(Boolean),
            Effect.retry(Schedule.spaced("10 millis")),
            Effect.timeout("1 second"),
          )
        }).pipe(Effect.provide(Watcher.nativeLayer)),
      ),
    ),
  )

  it.effect("interrupting a consumer interrupts a pending acquisition", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const counts = { ready: 0 }
      yield* Effect.gen(function* () {
        const watcher = yield* Watcher.Service
        const consumer = yield* watcher
          .subscribe(
            { path: "/pending", type: "directory" },
            Effect.sync(() => {
              counts.ready++
            }),
          )
          .pipe(Effect.flatMap(Stream.runDrain), Effect.forkScoped({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(consumer)
        expect(yield* Deferred.isDone(interrupted)).toBe(true)
        expect(counts.ready).toBe(0)
      }).pipe(
        withNative({
          subscribe: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            ),
        }),
      )
    }),
  )

  it.effect("shares equivalent entry sets and releases exactly once after the final consumer", () => {
    const { native, counts } = countingNative()
    return Effect.gen(function* () {
      const watcher = yield* Watcher.Service
      const consume = (names: string[]) =>
        watcher
          .subscribe({ path: "/shared", type: "entries", names })
          .pipe(Effect.flatMap(Stream.runDrain), Effect.forkScoped({ startImmediately: true }))
      const first = yield* consume(["orbit.json", ".orbit", "orbit.json"])
      const second = yield* consume([".orbit", "orbit.json"])
      yield* Effect.yieldNow
      expect(counts.subscribes).toBe(1)

      yield* Fiber.interrupt(first)
      expect(counts.unsubscribes).toBe(0)

      yield* Fiber.interrupt(second)
      expect(counts.subscribes).toBe(1)
      expect(counts.unsubscribes).toBe(1)
    }).pipe(withNative(native))
  })

  it.effect("scope shutdown releases an active subscription exactly once", () => {
    const { native, counts } = countingNative()
    return Effect.gen(function* () {
      const consumer = yield* Effect.gen(function* () {
        const watcher = yield* Watcher.Service
        const updates = yield* watcher.subscribe({ path: "/active", type: "directory" })
        const consumer = yield* updates.pipe(Stream.runDrain, Effect.forkScoped({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(counts.subscribes).toBe(1)
        expect(counts.unsubscribes).toBe(0)
        return consumer
      }).pipe(withNative(native))
      // Closing the layer scope tears the native subscription down while the
      // consumer still holds a reference; the consumer's own release as its
      // stream ends must not tear it down a second time.
      yield* Fiber.join(consumer)
      expect(counts.unsubscribes).toBe(1)
    })
  })
})

// A stand-in for @parcel/watcher that records what parcel-bundler/watcher#262 makes unsafe on
// Windows: an unsubscribe while the watch still has its directory read queued. A watch loses its
// queued read only when it reports an error or the deletion of its own folder, as the real backend
// stops it then.
function fakeParcel(options?: { held?: Promise<void> }) {
  const watches: { dir: string; fn: ParcelWatcher.SubscribeCallback; queued: boolean }[] = []
  const counts = { subscribes: 0, unsubscribes: 0, unsafe: 0 }
  // The ignore list of each subscribe, in order: the real binding joins a watch to one of the same folder and list.
  const ignores: (readonly string[])[] = []
  const binding: Pick<typeof ParcelWatcher, "subscribe"> = {
    subscribe: async (dir, fn, settings) => {
      counts.subscribes++
      ignores.push(settings?.ignore ?? [])
      const watch = { dir, fn, queued: true }
      watches.push(watch)
      await options?.held
      return {
        unsubscribe: async () => {
          counts.unsubscribes++
          if (watch.queued) counts.unsafe++
          watches.splice(watches.indexOf(watch), 1)
        },
      }
    },
  }
  const emit = (dir: string, events: ParcelWatcher.Event[], error: Error | null = null) =>
    watches
      .filter((watch) => watch.dir === dir)
      .forEach((watch) => {
        if (error || events.some((event) => event.type === "delete" && event.path === dir)) watch.queued = false
        watch.fn(error, events)
      })
  return { binding, counts, emit, ignores }
}

describe("Watcher native directory watches", () => {
  // Each row watches a real folder, as a parked watch is reused only while the same folder is at
  // its path.
  const rooted = <A, E, R>(
    body: (root: {
      path: string
      file: Watcher.Update
      subscribe: (
        native: Watcher.NativeInterface,
        publish?: (update: Watcher.Update) => void,
      ) => ReturnType<Watcher.NativeInterface["subscribe"]>
    }) => Effect.Effect<A, E, R>,
  ) =>
    withTempDir((tmp) =>
      body({
        path: tmp.path,
        file: { path: path.join(tmp.path, "orbit.json"), type: "update" },
        subscribe: (native, publish = () => {}) =>
          native.subscribe({ type: "directory", target: tmp.path, ignore: [], publish }),
      }),
    )

  it.effect("on Windows a released watch is kept and reused by the next consumer, never unsubscribed", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const watcher = yield* Watcher.Service
        const consume = Effect.gen(function* () {
          const ready = yield* Deferred.make<void>()
          const consumer = yield* watcher
            .subscribe({ path: root.path, type: "directory" }, Deferred.succeed(ready, undefined).pipe(Effect.asVoid))
            .pipe(Effect.flatMap(Stream.runHead), Effect.forkScoped({ startImmediately: true }))
          yield* Deferred.await(ready)
          return consumer
        })
        const first = yield* consume
        parcel.emit(root.path, [root.file])
        expect(Option.getOrUndefined(yield* Fiber.join(first))).toEqual(root.file)

        const second = yield* consume
        parcel.emit(root.path, [root.file])
        expect(Option.getOrUndefined(yield* Fiber.join(second))).toEqual(root.file)
        expect(parcel.counts).toEqual({ subscribes: 1, unsubscribes: 0, unsafe: 0 })
      }).pipe(
        Effect.provide(
          Watcher.layer().pipe(
            Layer.provide(
              Layer.effect(
                Watcher.Native,
                Watcher.makeNative(() => parcel.binding, "windows"),
              ),
            ),
          ),
        ),
      ),
    )
  })

  it.effect("on Windows a parked watch no longer reaches the consumer that released it", () => {
    const parcel = fakeParcel()
    const seen: Watcher.Update[] = []
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const subscription = yield* root.subscribe(native, (update) => seen.push(update))
        yield* Effect.promise(() => subscription!.unsubscribe())
        parcel.emit(root.path, [root.file])
        expect(seen).toEqual([])
        expect(parcel.counts.unsafe).toBe(0)
      }),
    )
  })

  it.effect("on Windows a subscribe abandoned while pending is kept for the next consumer", () => {
    const held = Promise.withResolvers<void>()
    const parcel = fakeParcel({ held: held.promise })
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const abandoned = yield* root.subscribe(native).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(abandoned)
        held.resolve()
        yield* Effect.promise(() => held.promise.then(() => Bun.sleep(0)))
        const seen: Watcher.Update[] = []
        yield* root.subscribe(native, (update) => seen.push(update))
        parcel.emit(root.path, [root.file])
        expect(seen).toEqual([root.file])
        expect(parcel.counts).toEqual({ subscribes: 1, unsubscribes: 0, unsafe: 0 })
      }),
    )
  })
  ;[
    { name: "an error", deleted: false, error: new Error("overflow") },
    { name: "its folder's deletion", deleted: true, error: null },
  ].forEach((row) =>
    it.effect(`on Windows a watch that reported ${row.name} is unsubscribed on release and not reused`, () => {
      const parcel = fakeParcel()
      return rooted((root) =>
        Effect.gen(function* () {
          const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
          const subscription = yield* root.subscribe(native)
          parcel.emit(root.path, row.deleted ? [{ path: root.path, type: "delete" }] : [], row.error)
          yield* Effect.promise(() => subscription!.unsubscribe())
          expect(parcel.counts).toEqual({ subscribes: 1, unsubscribes: 1, unsafe: 0 })
          const seen: Watcher.Update[] = []
          yield* root.subscribe(native, (update) => seen.push(update))
          parcel.emit(root.path, [root.file])
          expect(seen).toEqual([root.file])
          expect(parcel.counts.subscribes).toBe(2)
        }),
      )
    }),
  )

  it.effect("on Windows a parked watch whose folder is deleted is unsubscribed by the next subscribe", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const subscription = yield* root.subscribe(native)
        yield* Effect.promise(() => subscription!.unsubscribe())
        parcel.emit(root.path, [{ path: root.path, type: "delete" }])
        const seen: Watcher.Update[] = []
        yield* root.subscribe(native, (update) => seen.push(update))
        parcel.emit(root.path, [root.file])
        expect(seen).toEqual([root.file])
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 1, unsafe: 0 })
      }),
    )
  })

  // The real binding keeps a watch on a folder that is moved, without an event, and joins a new
  // watch of the same path to it; reusing it would watch the moved folder instead of the new one. Its
  // read is still queued, so ending it would meet #262: it is retired, and the next watch names one
  // more ignored path so that the binding gives it a watch of its own.
  it.effect("on Windows a parked watch whose folder was moved away is not reused and not ended", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const watched = path.join(root.path, "watched")
        yield* Effect.promise(() => fs.mkdir(watched))
        const subscription = yield* native.subscribe({
          type: "directory",
          target: watched,
          ignore: [],
          publish: () => {},
        })
        yield* Effect.promise(() => subscription!.unsubscribe())
        yield* Effect.promise(async () => {
          await fs.rename(watched, path.join(root.path, "moved"))
          await fs.mkdir(watched)
        })
        yield* native.subscribe({ type: "directory", target: watched, ignore: [], publish: () => {} })
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 0, unsafe: 0 })
        expect(parcel.ignores).toEqual([[], ["<orbit-watch-1>"]])
      }),
    )
  })

  // A folder that keeps a retired watch keeps the name apart for every watch after it, also once the watch that took
  // the first name has ended; each name is new, so no two native watches of the folder share a list.
  it.effect("on Windows every later watch of a folder with a retired watch is set apart from it", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const watched = path.join(root.path, "watched")
        const watch = () => native.subscribe({ type: "directory", target: watched, ignore: ["x"], publish: () => {} })
        // The folder is moved away, not removed, so the new one cannot get the old one's file ID back.
        const moved = { count: 0 }
        const replace = Effect.promise(async () => {
          await fs.rename(watched, path.join(root.path, `moved-${moved.count++}`))
          await fs.mkdir(watched)
        })
        yield* Effect.promise(() => fs.mkdir(watched))
        const first = yield* watch()
        yield* Effect.promise(() => first!.unsubscribe())
        yield* replace
        const second = yield* watch()
        // The second watch reports its folder's deletion, so its release ends it.
        parcel.emit(watched, [{ path: watched, type: "delete" }])
        yield* Effect.promise(() => second!.unsubscribe())
        yield* replace
        yield* watch()
        expect(parcel.ignores).toEqual([["x"], ["x", "<orbit-watch-1>"], ["x", "<orbit-watch-2>"]])
        expect(parcel.counts).toEqual({ subscribes: 3, unsubscribes: 1, unsafe: 0 })
      }),
    )
  })

  // The retired watches end with the native watches, as the parked ones do (a host that closes Orbit must be able to
  // exit); that close is the one place that still meets #262 (FU-M5-022).
  it.effect("on Windows closing the native watches ends the retired ones", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const watched = path.join(root.path, "watched")
        yield* Effect.scoped(
          Effect.gen(function* () {
            const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
            yield* Effect.promise(() => fs.mkdir(watched))
            const watch = () => native.subscribe({ type: "directory", target: watched, ignore: [], publish: () => {} })
            const first = yield* watch()
            yield* Effect.promise(() => first!.unsubscribe())
            yield* Effect.promise(async () => {
              await fs.rename(watched, path.join(root.path, "moved"))
              await fs.mkdir(watched)
            })
            const second = yield* watch()
            yield* Effect.promise(() => second!.unsubscribe())
            expect(parcel.counts.unsubscribes).toBe(0)
          }),
        )
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 2, unsafe: 2 })
      }),
    )
  })

  // A folder whose identity cannot be read might no longer be the folder the watch follows. A path
  // with a NUL byte is one that every system refuses to stat, so the release and the next subscribe
  // both fail to read it.
  it.effect("on Windows a parked watch whose folder cannot be read is not reused and not ended", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const target = path.join(root.path, "un\0readable")
        const subscription = yield* native.subscribe({ type: "directory", target, ignore: [], publish: () => {} })
        yield* Effect.promise(() => subscription!.unsubscribe())
        expect(parcel.counts.unsubscribes).toBe(0)
        const seen: Watcher.Update[] = []
        yield* native.subscribe({ type: "directory", target, ignore: [], publish: (update) => seen.push(update) })
        parcel.emit(target, [root.file])
        expect(seen).toEqual([root.file])
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 0, unsafe: 0 })
        expect(parcel.ignores).toEqual([[], ["<orbit-watch-1>"]])
      }),
    )
  })

  // The binding applies the ignore list, so a watch parked with one list would hide or show other
  // paths than a consumer with another list asked for.
  it.effect("on Windows a parked watch is reused only by a watch with the same ignore list", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const watch = (ignore: string[]) =>
          native.subscribe({ type: "directory", target: root.path, ignore, publish: () => {} })
        const ignoring = yield* watch(["node_modules"])
        yield* Effect.promise(() => ignoring!.unsubscribe())
        yield* watch([])
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 0, unsafe: 0 })
        yield* watch(["node_modules"])
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 0, unsafe: 0 })
      }),
    )
  })

  it.effect("on Windows a parked watch is lent to one consumer at a time", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
        const subscription = yield* root.subscribe(native)
        yield* Effect.promise(() => subscription!.unsubscribe())
        const first: Watcher.Update[] = []
        const second: Watcher.Update[] = []
        yield* root.subscribe(native, (update) => first.push(update))
        yield* root.subscribe(native, (update) => second.push(update))
        parcel.emit(root.path, [root.file])
        expect({ first, second }).toEqual({ first: [root.file], second: [root.file] })
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 0, unsafe: 0 })
      }),
    )
  })

  it.effect("on other platforms a released watch is unsubscribed", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        const native = yield* Watcher.makeNative(() => parcel.binding, "inotify")
        const subscription = yield* root.subscribe(native)
        yield* Effect.promise(() => subscription!.unsubscribe())
        yield* root.subscribe(native)
        expect(parcel.counts).toEqual({ subscribes: 2, unsubscribes: 1, unsafe: 1 })
      }),
    )
  })

  // A live Parcel watch keeps the event loop running, so a host that closes Orbit and waits for its
  // process to end would wait forever on a parked one.
  it.effect("on Windows closing the native watches ends the parked ones", () => {
    const parcel = fakeParcel()
    return rooted((root) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
            const subscription = yield* root.subscribe(native)
            yield* Effect.promise(() => subscription!.unsubscribe())
            expect(parcel.counts.unsubscribes).toBe(0)
          }),
        )
        expect(parcel.counts).toEqual({ subscribes: 1, unsubscribes: 1, unsafe: 1 })
      }),
    )
  })

  // The close above meets parcel-bundler/watcher#262, which crashed core test workers on Windows (FU-M5-022), because
  // each test builds and closes a runtime of its own. A test process does not need the close: bun ends its workers with
  // live watches still open. So the tests take their native watches from one set that lives as long as the process
  // (test/fixture/native-watcher.ts), and a runtime that closes ends none of them.
  it.effect(
    "in a test process the native watches outlive each runtime: a closed one ends none, the next reuses it",
    () => {
      const parcel = fakeParcel()
      const binding = () => parcel.binding
      return rooted((root) =>
        Effect.gen(function* () {
          for (const _ of [1, 2]) {
            yield* Effect.scoped(
              Effect.gen(function* () {
                const subscription = yield* root.subscribe(processNative(binding, "windows"))
                yield* Effect.promise(() => subscription!.unsubscribe())
              }),
            )
          }
          expect(parcel.counts).toEqual({ subscribes: 1, unsubscribes: 0, unsafe: 0 })
        }),
      )
    },
  )

  // Nor does the file's end: the pool is never closed, so a test process ends no live watch, which on Windows can meet
  // #262. The rows keep what a watch follows to folders of their own (test/fixture/native-watcher.ts), so a watch left
  // open here wakes for no later file.
  it.live("a test file ends none of its native watches, also after its last row", () =>
    Effect.promise(async () => {
      await using dir = await tmpdir()
      const marks = path.join(dir.path, "marks.txt")
      const file = path.join(dir.path, "pool.test.ts")
      await Bun.write(
        file,
        [
          `import { appendFileSync } from "node:fs"`,
          `import { afterAll, test } from "bun:test"`,
          // A folder outside the package resolves no bare package name, so the child imports Effect by its path.
          `import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))}`,
          `import { processNative } from ${JSON.stringify(path.join(import.meta.dir, "..", "fixture", "native-watcher.ts"))}`,
          `const mark = (line: string) => appendFileSync(${JSON.stringify(marks)}, line + "\\n")`,
          `const binding = () => ({`,
          `  subscribe: async () => {`,
          `    mark("subscribe")`,
          `    return { unsubscribe: async () => mark("unsubscribe") }`,
          `  },`,
          `})`,
          `test("first row", async () => {`,
          `  const native = processNative(binding, "windows")`,
          `  const watch = { type: "directory" as const, target: ${JSON.stringify(dir.path)}, ignore: [], publish: () => {} }`,
          `  const subscription = await Effect.runPromise(native.subscribe(watch))`,
          `  await subscription!.unsubscribe()`,
          `  mark("first row ended")`,
          `})`,
          `test("last row", () => mark("last row ran"))`,
          `afterAll(() => mark("file ended"))`,
        ].join("\n"),
      )
      const run = await runProgram([process.execPath, "test", file], { cwd: path.join(import.meta.dir, "..", "..") })
      expect({ code: run.exitCode, stderr: run.exitCode === 0 ? "" : run.stderr.toString() }).toEqual({
        code: 0,
        stderr: "",
      })
      expect((await Bun.file(marks).text()).trim().split(/\r?\n/)).toEqual([
        "subscribe",
        "first row ended",
        "last row ran",
        "file ended",
      ])
    }),
  )

  // The reach of that set: every runtime a row builds, through the app graph or its own Effect.provide, gets the same
  // native watches, which no runtime's close ends (test/lib/effect.ts runs each row with the fixture's memo map).
  it.effect("every runtime a row builds takes the native watches of the process", () =>
    Effect.gen(function* () {
      const native = Effect.gen(function* () {
        return yield* Watcher.Native
      })
      const graph = AppNodeBuilder.build(LayerNode.group([Watcher.nativeNode]))
      const first = yield* native.pipe(Effect.provide(graph))
      expect(yield* native.pipe(Effect.provide(Watcher.nativeLayer))).toBe(first)
      expect(yield* native.pipe(Effect.provide(graph))).toBe(first)
    }),
  )

  it.effect("on Windows a subscribe that resolves after the native watches closed is unsubscribed", () => {
    const held = Promise.withResolvers<void>()
    const parcel = fakeParcel({ held: held.promise })
    return rooted((root) =>
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const native = yield* Watcher.makeNative(() => parcel.binding, "windows")
            const abandoned = yield* root.subscribe(native).pipe(Effect.forkChild({ startImmediately: true }))
            yield* Effect.yieldNow
            yield* Fiber.interrupt(abandoned)
          }),
        )
        held.resolve()
        yield* Effect.promise(() => held.promise.then(() => Bun.sleep(0)))
        expect(parcel.counts).toEqual({ subscribes: 1, unsubscribes: 1, unsafe: 1 })
      }),
    )
  })

  // The real binding: a parked watch still holds its folder open, so the folder that contains it cannot be renamed,
  // and removing that folder with everything in it works all the same.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "on Windows the folder around a parked watch can be removed while the watch is kept, though not renamed",
    () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const project = path.join(tmp.path, "a")
          const target = path.join(project, ".orbit")
          yield* Effect.promise(() => fs.mkdir(target, { recursive: true }))
          const native = yield* Watcher.Native
          const subscription = yield* native.subscribe({ type: "directory", target, ignore: [], publish: () => {} })
          expect(subscription?.backend).toBe("windows")
          yield* Effect.promise(() => subscription!.unsubscribe())
          // Control: the released watch is parked, not ended, so Windows refuses to rename the folder that holds it.
          const renamed = yield* Effect.promise(() =>
            fs.rename(project, path.join(tmp.path, "b")).then(
              () => "renamed",
              (error: NodeJS.ErrnoException) => error.code,
            ),
          )
          expect(renamed).toBe("EPERM")
          yield* Effect.promise(() => fs.rm(project, { recursive: true }))
          expect(yield* Effect.promise(() => fs.readdir(tmp.path))).toEqual([])
        }).pipe(Effect.provide(Watcher.nativeLayer)),
      ),
  )
})

function provide(
  directory: string,
  vcs?: Location.Interface["vcs"],
  watcher?: Layer.Layer<Watcher.Service>,
  config: Layer.Layer<Config.Service> = configLayer,
  plugins?: LayerNode.Replacement,
  replacements: LayerNode.Replacements = [],
) {
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) }, { vcs })),
  )
  const built = AppNodeBuilder.build(
    LayerNode.group([PluginSupervisor.node, LocationWatcher.node, LocationWatcherPolicy.node, Bus.node, Config.node]),
    [
      Config.node.replace(config),
      Location.node.replace(locationLayer),
      plugins ?? PluginSupervisor.node.replace(Layer.empty),
      ...(watcher ? ([Watcher.node.replace(watcher)] as const) : []),
      ...replacements,
    ],
  )
  return Effect.provide(built)
}

function withTmp<A, E, R>(
  f: (directory: string, vcs?: Location.Interface["vcs"]) => Effect.Effect<A, E, R>,
  options?: {
    vcs?: "git" | "hg"
    init?: (directory: string) => Promise<void>
    watcher?: Layer.Layer<Watcher.Service>
    config?: Layer.Layer<Config.Service>
    plugins?: LayerNode.Replacement
    replacements?: LayerNode.Replacements
  },
) {
  return Effect.acquireRelease(
    Effect.promise(async () => {
      const tmp = await tmpdir()
      if (options?.vcs === "hg") {
        await fs.mkdir(path.join(tmp.path, ".hg"))
        return { tmp, vcs: { type: "hg" as const, store: AbsolutePath.make(path.join(tmp.path, ".hg")) } }
      }
      if (options?.vcs !== "git") return { tmp, vcs: undefined }
      await $`git init`.cwd(tmp.path).quiet()
      await $`git config core.fsmonitor false`.cwd(tmp.path).quiet()
      await $`git config commit.gpgsign false`.cwd(tmp.path).quiet()
      await $`git config user.email test@orbit.test`.cwd(tmp.path).quiet()
      await $`git config user.name Test`.cwd(tmp.path).quiet()
      await $`git commit --allow-empty -m root`.cwd(tmp.path).quiet()
      await options.init?.(tmp.path)
      return { tmp, vcs: { type: "git" as const, store: AbsolutePath.make(path.join(tmp.path, ".git")) } }
    }),
    ({ tmp }) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap(({ tmp, vcs }) =>
      f(tmp.path, vcs).pipe(
        provide(
          tmp.path,
          vcs,
          options?.watcher,
          options?.config ?? configLayer,
          options?.plugins,
          options?.replacements,
        ),
      ),
    ),
  )
}

describe("LocationWatcher subscriptions", () => {
  it.live("watches only exact Git branch metadata", () => {
    const subscriptions: Watcher.WatchInput[] = []
    const watcher = Layer.succeed(
      Watcher.Service,
      Watcher.Service.of({
        subscribe: (input) => Effect.sync(() => subscriptions.push(input)).pipe(Effect.as(Stream.empty)),
      }),
    )
    return withTmp(
      (directory) =>
        Effect.gen(function* () {
          yield* LocationWatcher.Service
          yield* Effect.sync(() => subscriptions.length).pipe(
            Effect.filterOrFail((count) => count > 0),
            Effect.retry(Schedule.spaced("10 millis")),
          )
          yield* Effect.sleep("10 millis")
          expect(subscriptions).toEqual([{ path: path.join(directory, ".git", "HEAD"), type: "file" }])
        }),
      { vcs: "git", watcher },
    )
  })

  it.live("watches only exact Hg branch metadata", () => {
    const subscriptions: Watcher.WatchInput[] = []
    const watcher = Layer.succeed(
      Watcher.Service,
      Watcher.Service.of({
        subscribe: (input) => Effect.sync(() => subscriptions.push(input)).pipe(Effect.as(Stream.empty)),
      }),
    )
    return withTmp(
      (directory) =>
        Effect.gen(function* () {
          yield* LocationWatcher.Service
          yield* Effect.sync(() => subscriptions.length).pipe(
            Effect.filterOrFail((count) => count > 0),
            Effect.retry(Schedule.spaced("10 millis")),
          )
          yield* Effect.sleep("10 millis")
          expect(subscriptions).toEqual([{ path: path.join(directory, ".hg", "branch"), type: "file" }])
        }),
      { vcs: "hg", watcher },
    )
  })

  it.live("reconciles config without duplicate subscriptions", () => {
    const entries = { current: [] as Entry[] }
    const subscriptions: Watcher.WatchInput[] = []
    const counts = { active: 0, released: 0 }
    const watcher = Layer.succeed(
      Watcher.Service,
      Watcher.Service.of({
        subscribe: (input) =>
          Effect.sync(() => {
            subscriptions.push(input)
            counts.active++
            return Stream.never.pipe(
              Stream.ensuring(
                Effect.sync(() => {
                  counts.active--
                  counts.released++
                }),
              ),
            )
          }),
      }),
    )
    const config = Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () => Effect.sync(() => entries.current),
        rejected: () => Effect.succeed([]),
        compatEnabled: () => Effect.succeed(Config.defaultCompat.enabled),
        compat: () => Effect.succeed(Config.defaultCompat),
        changes: () => Stream.never,
        notify: () => Effect.void,
      }),
    )
    return Effect.gen(function* () {
      yield* withTmp(
        () =>
          Effect.gen(function* () {
            const policy = yield* LocationWatcherPolicy.Service
            const bus = yield* Bus.Service
            yield* Effect.sync(() => subscriptions.length).pipe(
              Effect.filterOrFail((count) => count === 1),
              Effect.retry(Schedule.spaced("10 millis")),
            )
            expect(counts.active).toBe(1)

            entries.current = [new Document({ type: "document", info: new Info({ watcher: { ignore: [".git"] } }) })]
            yield* ConfigLocationWatcherPlugin.Plugin.effect(
              host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }),
            )
            yield* Effect.sync(() => counts.active).pipe(
              Effect.filterOrFail((count) => count === 0),
              Effect.retry(Schedule.spaced("10 millis")),
            )
            expect(counts.released).toBe(1)

            entries.current = []
            yield* bus.publish(Event.Updated, {})
            yield* Effect.sync(() => subscriptions.length).pipe(
              Effect.filterOrFail((count) => count === 2),
              Effect.retry(Schedule.spaced("10 millis")),
            )
            expect(counts.active).toBe(1)

            yield* policy.reload()
            expect(subscriptions).toHaveLength(2)
          }),
        { vcs: "git", watcher, config },
      )
      expect(counts.active).toBe(0)
      expect(counts.released).toBe(2)
    })
  })

  it.live("uses the policy changed while target discovery was suspended", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const discovering = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const subscribed = yield* Deferred.make<void>()
      const subscriptions: Watcher.WatchInput[] = []
      let released = 0
      yield* withTmp(
        (directory) =>
          Effect.gen(function* () {
            const policy = yield* LocationWatcherPolicy.Service
            yield* Deferred.await(discovering)
            const update = yield* policy
              .transform((editor) => editor.add([".hg"]))
              .pipe(Effect.forkScoped({ startImmediately: true }))
            expect(policy.current()).toEqual([".hg"])
            yield* Deferred.succeed(release, undefined)
            const registration = yield* Fiber.join(update)
            expect(subscriptions).toEqual([])

            yield* registration.dispose
            yield* Deferred.await(subscribed)
            yield* policy.reload()
            expect(subscriptions).toEqual([{ path: path.join(directory, ".hg", "branch"), type: "file" }])
            expect(released).toBe(0)
          }),
        {
          vcs: "hg",
          replacements: [
            Plugin.node.replace(Layer.mock(Plugin.Service, { awaitActivation: Effect.void })),
            FSUtil.node.replace(
              Layer.succeed(FSUtil.Service, {
                ...fs,
                realPath: (target) =>
                  Deferred.succeed(discovering, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(fs.realPath(target)),
                  ),
              }),
            ),
          ],
          watcher: Layer.succeed(
            Watcher.Service,
            Watcher.Service.of({
              subscribe: (input) =>
                Effect.sync(() => subscriptions.push(input)).pipe(
                  Effect.andThen(Deferred.succeed(subscribed, undefined)),
                  Effect.as(Stream.never.pipe(Stream.ensuring(Effect.sync(() => released++)))),
                ),
            }),
          ),
        },
      )
      expect(released).toBe(1)
    }),
  )

  it.live("does not start before configured policy is ready", () => {
    const subscriptions: Watcher.WatchInput[] = []
    const watcher = Layer.succeed(
      Watcher.Service,
      Watcher.Service.of({
        subscribe: (input) => Effect.sync(() => subscriptions.push(input)).pipe(Effect.as(Stream.never)),
      }),
    )
    const plugins = makeLocationNode({
      name: "test/watcher-plugins",
      layer: Layer.effectDiscard(
        Effect.gen(function* () {
          const policy = yield* LocationWatcherPolicy.Service
          yield* policy.transform((editor) => editor.add([".git"]))
        }),
      ),
      deps: [LocationWatcherPolicy.node],
    })
    return withTmp(
      () =>
        Effect.gen(function* () {
          yield* LocationWatcher.Service
          yield* Effect.sleep("50 millis")
          expect(subscriptions).toEqual([])
        }),
      { vcs: "git", watcher, plugins: PluginSupervisor.node.replace(plugins) },
    )
  })
})

// Class 1 (register FU-M1-022): the watcher found the git directory by asking git, when the Location started and before
// anyone was asked about the folder, and git applies the config of the folder it runs in. It reads the files now, so no
// git starts, whatever the config names (`project-git-trust.test.ts` is the table of keys). The oracle is git's trace of
// every process it starts. The files are the ones git itself wrote, or the Location's store when they cannot be matched
// to a registered worktree.
describe("LocationWatcher watches again", () => {
  // The watch of .git/HEAD ends when the git folder goes away, and the location watcher watches the new folder: a change of
  // HEAD after the folder was made again is heard.
  it.live("publishes .git/HEAD events after the git folder was removed and made again", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const head = path.join(directory, ".git", "HEAD")
          yield* ready(head)
          yield* Effect.promise(async () => {
            await fs.rm(path.join(directory, ".git"), { recursive: true })
            await git(directory, "init", "-q")
          })
          // What the removal itself reported is over before the next write is waited for. The location watcher looks again
          // when the policy changes, as it does when the folder is back.
          yield* Effect.sleep("1 second")
          const policy = yield* LocationWatcherPolicy.Service
          yield* policy.reload()
          yield* ready(head)
        }),
      { vcs: "git" },
    ),
  )
})

describe("LocationWatcher finds the git directory without git", () => {
  const SLOW = 60_000
  /** The folders that the watcher subscribed to for a Location, once it has subscribed or has had time to. */
  const subscribed = (directory: string, vcs: Location.Interface["vcs"], expected: number) => {
    const subscriptions: Watcher.WatchInput[] = []
    const watcher = Layer.succeed(
      Watcher.Service,
      Watcher.Service.of({
        subscribe: (input) => Effect.sync(() => subscriptions.push(input)).pipe(Effect.as(Stream.empty)),
      }),
    )
    return traced(
      Effect.gen(function* () {
        yield* LocationWatcher.Service
        if (expected > 0)
          yield* Effect.sync(() => subscriptions.length).pipe(
            Effect.filterOrFail((count) => count >= expected),
            Effect.retry(Schedule.spaced("10 millis")),
          )
        yield* Effect.sleep("100 millis")
        return subscriptions.map((input) => input.path)
      }).pipe(provide(directory, vcs, watcher)),
    )
  }
  const real = (file: string) => Effect.sync(() => realpathSync.native(file))

  for (const key of keys)
    it.live(
      `starts no git for an ordinary repository that sets ${key.name}`,
      () =>
        Effect.gen(function* () {
          const found = yield* planted(key)
          const root = yield* real(found.root)

          const { value, git } = yield* subscribed(
            root,
            { type: "git", store: AbsolutePath.make(path.join(root, ".git")) },
            1,
          )

          expect(git).toEqual([])
          expect(yield* found.ran()).toEqual([])
          expect(value).toEqual([path.join(root, ".git", "HEAD")])
        }),
      SLOW,
    )

  it.live(
    "watches the HEAD of a linked worktree's own entry, not the main checkout's",
    () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        yield* repository(path.join(root, "main"))
        yield* Effect.promise(() =>
          git(path.join(root, "main"), "worktree", "add", "--detach", path.join(root, "linked")),
        )
        const main = yield* real(path.join(root, "main"))
        const linked = yield* real(path.join(root, "linked"))

        const { value, git: started } = yield* subscribed(
          linked,
          { type: "git", store: AbsolutePath.make(path.join(main, ".git")) },
          1,
        )

        expect(started).toEqual([])
        expect(value).toEqual([path.join(main, ".git", "worktrees", "linked", "HEAD")])
      }),
    SLOW,
  )

  it.live(
    "watches the Location's own git directory for a layout that no registered worktree matches, and only when it is a folder",
    () =>
      Effect.gen(function* () {
        const root = (yield* tmpdirScoped()).path
        yield* repository(path.join(root, "source"))
        yield* Effect.promise(async () => {
          // A separate git directory: the `.git` file names a place that nothing registered.
          await git(
            root,
            "clone",
            "-q",
            "--separate-git-dir",
            path.join(root, "elsewhere"),
            path.join(root, "source"),
            path.join(root, "separate"),
          )
          // A `.git` that a clone forged: nothing opens it, so the store the Location names is a file.
          await fs.mkdir(path.join(root, "forged"))
          await fs.writeFile(path.join(root, "forged", ".git"), "gitdir: ./nowhere\n")
        })
        const separate = yield* real(path.join(root, "separate"))
        const forged = yield* real(path.join(root, "forged"))
        const elsewhere = yield* real(path.join(root, "elsewhere"))

        const here = yield* subscribed(separate, { type: "git", store: AbsolutePath.make(elsewhere) }, 1)
        const there = yield* subscribed(forged, { type: "git", store: AbsolutePath.make(path.join(forged, ".git")) }, 0)

        expect(here.value).toEqual([path.join(elsewhere, "HEAD")])
        expect(there.value).toEqual([])
        expect([...here.git, ...there.git]).toEqual([])
      }),
    SLOW,
  )
})

function wait(check: (event: WatcherEvent) => boolean) {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const deferred = yield* Deferred.make<WatcherEvent>()
    const fiber = yield* bus.subscribe(FileSystem.Event.Changed).pipe(
      Stream.runForEach((event) => {
        if (!check(event.data)) return Effect.void
        return Deferred.succeed(deferred, event.data).pipe(Effect.asVoid)
      }),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    return { deferred, fiber }
  })
}

function maybeNextUpdate<E>(
  check: (event: WatcherEvent) => boolean,
  trigger: Effect.Effect<void, E>,
  timeout: Duration.Input = "5 seconds",
) {
  return Effect.acquireUseRelease(
    wait(check),
    ({ deferred }) => trigger.pipe(Effect.andThen(Deferred.await(deferred)), Effect.timeoutOption(timeout)),
    ({ fiber }) => Fiber.interrupt(fiber),
  )
}

function nextUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    const result = yield* maybeNextUpdate(check, trigger)
    if (Option.isSome(result)) return result.value
    return yield* Effect.fail(new Error("timed out waiting for file watcher update"))
  })
}

function eventuallyUpdate<E>(check: (event: WatcherEvent) => boolean, trigger: () => Effect.Effect<void, E>) {
  return Effect.gen(function* () {
    while (true) {
      const result = yield* maybeNextUpdate(check, trigger(), "250 millis")
      if (Option.isSome(result)) return result.value
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () => Effect.fail(new Error("timed out waiting for file watcher readiness")),
    }),
  )
}

function ready(file: string, eventFile = file) {
  return Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const content = (yield* fs.readFileStringSafe(file)) ?? `ready-${Math.random()}`
    yield* eventuallyUpdate(
      (event) => event.file === eventFile,
      () => fs.writeFileString(file, content),
    ).pipe(Effect.asVoid)
  })
}

describeNative("LocationWatcher", () => {
  it.live("limits file watches to the exact target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const watcher = yield* Watcher.Service
        const target = path.join(directory, "orbit.json")
        const sibling = path.join(directory, "other.json")
        const updates = yield* watcher.subscribe({ path: target, type: "file" })
        const update = yield* updates.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        )
        yield* fs.writeFileString(sibling, "sibling")
        const writes = yield* Effect.suspend(() => fs.writeFileString(target, `target-${Math.random()}`)).pipe(
          Effect.repeat(Schedule.spaced("10 millis")),
          Effect.forkScoped,
        )
        const event = yield* Fiber.join(update).pipe(Effect.ensuring(Fiber.interrupt(writes)))

        expect(event.valueOrUndefined?.path).toBe(target)
      }).pipe(Effect.provide(AppNodeBuilder.build(Watcher.node))),
    ),
  )

  it.live("detects creation of a missing directory target", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const watcher = yield* Watcher.Service
        const target = path.join(directory, "generated")
        const updates = yield* watcher.subscribe({ path: target, type: "file" })
        const update = yield* updates.pipe(
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        )
        const creates = yield* Effect.suspend(() =>
          fs.remove(target, { recursive: true, force: true }).pipe(Effect.andThen(fs.ensureDir(target))),
        ).pipe(Effect.repeat(Schedule.spaced("10 millis")), Effect.forkScoped)
        const event = yield* Fiber.join(update).pipe(Effect.ensuring(Fiber.interrupt(creates)))

        expect(event.valueOrUndefined?.path).toBe(target)
      }).pipe(Effect.provide(AppNodeBuilder.build(Watcher.node))),
    ),
  )

  it.live("publishes .git/HEAD events", () =>
    withTmp(
      (directory) =>
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          const head = path.join(directory, ".git", "HEAD")
          const branch = `watch-${Math.random().toString(36).slice(2)}`
          yield* ready(head)
          yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
          expect(
            yield* nextUpdate((event) => event.file === head, fs.writeFileString(head, `ref: refs/heads/${branch}\n`)),
          ).toEqual({ file: head, event: "change" })
        }),
      { vcs: "git" },
    ),
  )

  const describeSymlink = process.platform !== "win32" ? describe : describe.skip
  describeSymlink("symlinked .git", () => {
    it.live("publishes .git/HEAD events through a symlinked .git directory", () =>
      withTmp(
        (directory) =>
          Effect.gen(function* () {
            const afs = yield* FSUtil.Service
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            yield* Effect.addFinalizer(() => Effect.promise(() => fs.rm(actual, { recursive: true, force: true })))
            const head = path.join(directory, ".git", "HEAD")
            yield* ready(head, path.join(actual, "HEAD"))
            const branch = `watch-${Math.random().toString(36).slice(2)}`
            yield* Effect.promise(() => $`git branch ${branch}`.cwd(directory).quiet())
            expect(
              yield* nextUpdate(
                (event) => event.file === path.join(actual, "HEAD"),
                afs.writeFileString(head, `ref: refs/heads/${branch}\n`),
              ),
            ).toEqual({ file: path.join(actual, "HEAD"), event: "change" })
          }),
        {
          vcs: "git",
          init: async (directory) => {
            const actual = path.join(directory, "..", `actual_${path.basename(directory)}`)
            await fs.rename(path.join(directory, ".git"), actual)
            await fs.symlink(actual, path.join(directory, ".git"))
          },
        },
      ),
    )
  })

  it.live("publishes .hg/branch events", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<string>()
      const watcher = Layer.effect(
        Watcher.Service,
        Effect.gen(function* () {
          const service = yield* Watcher.Service
          return Watcher.Service.of({
            subscribe: (input, onReady) =>
              service.subscribe(
                input,
                Deferred.succeed(started, input.path).pipe(Effect.andThen(onReady ?? Effect.void)),
              ),
          })
        }),
      ).pipe(Layer.provide(AppNodeBuilder.build(Watcher.node)))
      return yield* withTmp(
        (directory) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const branch = path.join(directory, ".hg", "branch")
            // Use the actual acquisition barrier, not a probe write whose event
            // callback can race the next write in Bun's filesystem watcher.
            expect(yield* Deferred.await(started)).toBe(branch)
            expect(
              yield* nextUpdate((event) => event.file === branch, fs.writeFileString(branch, "feature\n")),
            ).toMatchObject({ file: branch })
          }),
        { vcs: "hg", watcher },
      )
    }),
  )
})
