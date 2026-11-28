import { describe, expect, setDefaultTimeout } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Effect, Fiber, Layer, Stream } from "effect"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { processNative } from "../fixture/native-watcher"
import { withTempDir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

setDefaultTimeout(120_000)
const it = testEffect(Layer.empty)

// With the machine this busy Parcel's Windows backend lost 15 of 60 and 18 of 30 such files, so 30 tries leave it a chance of
// 2 in 100,000 to pass (0.7 to the 30th power).
const TRIES = 30

const realLayer = Watcher.layer().pipe(
  Layer.provide(Layer.succeed(Watcher.Native, processNative(Watcher.binding, Watcher.backend()))),
)

// This file runs alone, after the others (`script/test.ts`): it keeps every CPU busy, and the rows that run beside it would
// see a machine that is not the one they are written for.
//
// A watch is ready when its subscribe is answered, and a file written at that moment is heard. Parcel's Windows backend
// answers before it has queued the read of the folder, and loses such a file when the machine is busy, so Windows watches
// folders with Bun's fs.watch, which is armed when it returns. The write is made inside the readiness callback itself, with
// the busy loops already running hot.
describe("a file written the moment a directory watch is ready", () => {
  it.live("is heard, with the machine busy", () =>
    withTempDir((tmp) =>
      Effect.gen(function* () {
        const busy = yield* Effect.acquireRelease(
          Effect.sync(() =>
            Array.from({ length: os.availableParallelism() * 2 }, () =>
              Bun.spawn([process.execPath, "-e", "const end = Date.now() + 180000; while (Date.now() < end) {}"], {
                stdout: "ignore",
                stderr: "ignore",
              }),
            ),
          ),
          (children) => Effect.sync(() => children.forEach((child) => child.kill())),
        )
        expect(busy.length).toBeGreaterThan(0)
        // The loops are hot before the first try.
        yield* Effect.sleep("2 seconds")
        const service = yield* Watcher.Service
        yield* Effect.forEach(
          Array.from({ length: TRIES }, (_, index) => index),
          (index) =>
            Effect.gen(function* () {
              const folder = path.join(tmp.path, `ready-${index}`)
              fs.mkdirSync(folder)
              const heard: string[] = []
              const written = Effect.sync(() => fs.writeFileSync(path.join(folder, "x.txt"), "x"))
              const watch = yield* service.subscribe({ path: folder, type: "directory" }, written).pipe(
                Effect.flatMap(Stream.runForEach((item) => Effect.sync(() => heard.push(path.basename(item.path))))),
                Effect.forkChild({ startImmediately: true }),
              )
              // A file that is never heard ends in the row's time limit.
              while (!heard.includes("x.txt")) yield* Effect.sleep("20 millis")
              yield* Fiber.interrupt(watch)
            }),
        )
      }).pipe(Effect.provide(realLayer)),
    ),
  )
})
