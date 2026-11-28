import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { processNative } from "../fixture/native-watcher"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

setDefaultTimeout(60_000)
const it = testEffect(Layer.empty)

const realLayer = Watcher.layer().pipe(
  Layer.provide(Layer.succeed(Watcher.Native, processNative(Watcher.binding, Watcher.backend()))),
)

// What a directory watch reports must not depend on the backend (Parcel on Linux and macOS, Bun's fs.watch on Windows), so
// each row runs the same operations on the one that the platform uses and holds it to what both do.
const IGNORE = ["node_modules", ".git", "**/{node_modules,.git}/**"]

// Watches the folder, and returns what it reports as `type relative-path`, with a way to wait for what an operation did: a
// file made after the operation is heard after everything the operation caused, so the events before it are the operation's.
const watching = (folder: string) =>
  Effect.gen(function* () {
    const service = yield* Watcher.Service
    const seen: string[] = []
    const ready = yield* Deferred.make<void>()
    const watch = yield* service
      .subscribe({ path: folder, type: "directory", ignore: IGNORE }, Deferred.succeed(ready, undefined))
      .pipe(
        Effect.flatMap(
          Stream.runForEach((item) => Effect.sync(() => seen.push(`${item.type} ${path.relative(folder, item.path)}`))),
        ),
        Effect.forkChild({ startImmediately: true }),
      )
    yield* Deferred.await(ready)
    let marks = 0
    const after = Effect.fnUntraced(function* (operation: () => Promise<unknown>) {
      seen.length = 0
      yield* Effect.promise(operation)
      const mark = `mark-${marks++}.txt`
      yield* Effect.promise(() => Bun.write(path.join(folder, mark), "m"))
      // The row's time limit bounds the wait.
      while (!seen.includes(`create ${mark}`)) yield* Effect.sleep("20 millis")
      return [...new Set(seen)].filter((line) => !line.endsWith(mark))
    })
    return { after, stop: Fiber.interrupt(watch) }
  })

describe("a directory watch reports the same on every backend", () => {
  it.live("a case-only rename is a delete of the old name and a create of the new one", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const watch = yield* watching(tmp.path)
        yield* watch.after(() => Bun.write(path.join(tmp.path, "b.txt"), "b"))
        const seen = yield* watch.after(() => fs.rename(path.join(tmp.path, "b.txt"), path.join(tmp.path, "B.txt")))
        expect(seen).toContain("delete b.txt")
        expect(seen).toContain("create B.txt")
        yield* watch.stop
      }).pipe(Effect.provide(realLayer)),
    ),
  )

  it.live("an ignored folder is not reported, nor what is in it, at any depth", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const watch = yield* watching(tmp.path)
        const seen = yield* watch.after(async () => {
          for (const file of ["node_modules/a.js", "pkg/node_modules/b.js", "x/.git/HEAD", "kept.txt"]) {
            await fs.mkdir(path.dirname(path.join(tmp.path, file)), { recursive: true })
            await Bun.write(path.join(tmp.path, file), "z")
          }
        })
        expect(seen).toContain("create kept.txt")
        expect(seen).toContain("create pkg")
        expect(seen.filter((line) => /node_modules|\.git/.test(line))).toEqual([])
        yield* watch.stop
      }).pipe(Effect.provide(realLayer)),
    ),
  )

  it.live("a change inside a folder is not an update of the folder", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const watch = yield* watching(tmp.path)
        const made = yield* watch.after(async () => {
          await fs.mkdir(path.join(tmp.path, "sub"))
          await Bun.write(path.join(tmp.path, "sub", "x.txt"), "x")
        })
        expect(made).toContain("create sub")
        expect(made).toContain("create sub/x.txt".split("/").join(path.sep))
        expect(made).not.toContain("update sub")
        const changed = yield* watch.after(() => Bun.write(path.join(tmp.path, "sub", "x.txt"), "xx"))
        expect(changed).toContain(`update ${path.join("sub", "x.txt")}`)
        expect(changed).not.toContain("update sub")
        const renamed = yield* watch.after(() => fs.rename(path.join(tmp.path, "sub"), path.join(tmp.path, "moved")))
        expect(renamed).toContain("delete sub")
        expect(renamed).toContain("create moved")
        expect(renamed).not.toContain("update moved")
        yield* watch.stop
      }).pipe(Effect.provide(realLayer)),
    ),
  )
})

// An install, a checkout or a build in a watched folder changes more files at once than Windows keeps for a watch, and it
// drops them all. The watch then compares the folder with what it knew, so the real file that follows the burst is heard,
// 6 of 10 times lost over fs.watch alone with 2000 files, and every time with 5000.
describe("a directory watch after a burst of changes in an ignored folder", () => {
  for (const count of [2000, 5000])
    it.live(`hears the real file that follows ${count} ignored files`, () =>
      withTempDir((tmp) =>
        Effect.gen(function* () {
          const service = yield* Watcher.Service
          yield* Effect.forEach(
            Array.from({ length: 10 }, (_, index) => index),
            (index) =>
              Effect.gen(function* () {
                const folder = path.join(tmp.path, `burst-${index}`)
                yield* Effect.promise(() => fs.mkdir(folder))
                const heard: string[] = []
                const ready = yield* Deferred.make<void>()
                const watch = yield* service
                  .subscribe({ path: folder, type: "directory", ignore: IGNORE }, Deferred.succeed(ready, undefined))
                  .pipe(
                    Effect.flatMap(Stream.runForEach((item) => Effect.sync(() => heard.push(path.basename(item.path))))),
                    Effect.forkChild({ startImmediately: true }),
                  )
                yield* Deferred.await(ready)
                const writer = Bun.spawn(
                  [process.execPath, path.join(import.meta.dir, "..", "fixture", "burst-writer.ts"), folder, String(count)],
                  { stdout: "ignore", stderr: "ignore" },
                )
                yield* Effect.promise(() => writer.exited)
                // A real file that is never heard ends in the row's time limit.
                while (!heard.includes("real.txt")) yield* Effect.sleep("20 millis")
                expect(heard.filter((name) => /^f\d+\.js$/.test(name))).toEqual([])
                yield* Fiber.interrupt(watch)
              }),
          )
        }).pipe(Effect.provide(realLayer)),
      ),
    )
})
