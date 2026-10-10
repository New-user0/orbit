import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileLedger } from "@orbit/core/file-ledger"
import { readNow } from "./fixture/ledger"
import { Location } from "@orbit/core/location"
import { Session } from "@orbit/core/session"
import { tempLocationLayer } from "./fixture/location"
import { tmpdirScoped } from "./fixture/tmpdir"
import { it } from "./lib/effect"

const sessionID = Session.ID.make("ses_file_ledger_test")
const other = Session.ID.make("ses_file_ledger_other")

const message = (exit: Exit.Exit<void, { readonly message: string }>) =>
  Exit.isFailure(exit) ? exit.cause.toString() : "ok"

describe("FileLedger", () => {
  it.live("requires a read before changing an existing file, and a fresh read after it changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "a.ts")
      yield* Effect.promise(async () => {
        await Bun.write(file, "one\n")
        await fs.utimes(file, new Date(1_000_000), new Date(1_000_000))
      })
      const ledger = yield* FileLedger.Service

      expect(yield* ledger.assertFresh(sessionID, path.join(tmp.path, "new.ts"), "new.ts").pipe(Effect.exit)).toEqual(
        Exit.void,
      )
      expect(message(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit))).toContain(
        "a.ts has not been read in this session",
      )
      expect((yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")

      yield* readNow(sessionID, file)
      expect(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit)).toEqual(Exit.void)
      expect(message(yield* ledger.assertFresh(other, file, "a.ts").pipe(Effect.exit))).toContain("has not been read")
      expect((yield* ledger.assertFresh(other, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")

      yield* Effect.promise(() => fs.utimes(file, new Date(2_000_000), new Date(2_000_000)))
      expect(message(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit))).toContain(
        "a.ts changed since it was last read",
      )
      expect((yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.stale")
    }).pipe(Effect.provide(AppNodeBuilder.build(FileLedger.node, [Location.node.replace(tempLocationLayer)]))),
  )

  const ledgerLayer = AppNodeBuilder.build(FileLedger.node, [Location.node.replace(tempLocationLayer)])
  const touch = (file: string, seconds: number) =>
    Effect.promise(() => fs.utimes(file, new Date(seconds * 1000), new Date(seconds * 1000)))
  const digestOf = (text: string) => FileLedger.digest(new TextEncoder().encode(text))

  it.live("passes a file that was only touched after a whole read, and fails one whose content changed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "one\n"))
      yield* touch(file, 1_000)
      const ledger = yield* FileLedger.Service
      yield* readNow(sessionID, file)

      yield* touch(file, 2_000)
      // Without the current digest the mtime check still refuses, as it does for a file read in pages.
      expect((yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.stale")
      yield* ledger.assertFresh(sessionID, file, "a.ts", { mtimeMs: 2_000_000, digest: digestOf("one\n") })
      // The pass is remembered: the same time no longer needs the digest.
      yield* ledger.assertFresh(sessionID, file, "a.ts")

      yield* touch(file, 3_000)
      expect(
        message(
          yield* ledger
            .assertFresh(sessionID, file, "a.ts", { mtimeMs: 3_000_000, digest: digestOf("two\n") })
            .pipe(Effect.exit),
        ),
      ).toContain("a.ts changed since it was last read")
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("keeps mtime-only freshness for a file read without a digest", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "large.log")
      yield* ledger.recordRead(sessionID, file, { mtimeMs: 1_000 })
      yield* ledger.assertFresh(sessionID, file, "large.log", { mtimeMs: 1_000, digest: digestOf("x") })
      const stale = yield* ledger
        .assertFresh(sessionID, file, "large.log", { mtimeMs: 2_000, digest: digestOf("x") })
        .pipe(Effect.flip)
      expect(stale.code).toBe("file.stale")
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("passes a touched file after recordWrite with a digest", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "written.ts")
      yield* ledger.recordWrite(sessionID, file, { mtimeMs: 1_000, digest: digestOf("body") })
      yield* ledger.assertFresh(sessionID, file, "written.ts", { mtimeMs: 5_000, digest: digestOf("body") })
      const changed = yield* ledger
        .assertFresh(sessionID, file, "written.ts", { mtimeMs: 9_000, digest: digestOf("other") })
        .pipe(Effect.flip)
      expect(changed.code).toBe("file.stale")
      // Another session never read it.
      const unread = yield* ledger
        .assertFresh(other, file, "written.ts", { mtimeMs: 1_000, digest: digestOf("body") })
        .pipe(Effect.flip)
      expect(unread.code).toBe("file.unread")
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("marks a repeat read: false, then true, then true, and false for another digest", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "marked.ts")
      expect(yield* ledger.markRead(sessionID, file, "1:default", "a")).toBe(false)
      expect(yield* ledger.markRead(sessionID, file, "1:default", "a")).toBe(true)
      expect(yield* ledger.markRead(sessionID, file, "1:default", "a")).toBe(true)
      expect(yield* ledger.markRead(sessionID, file, "1:default", "b")).toBe(false)
      expect(yield* ledger.markRead(sessionID, file, "1:default", "b")).toBe(true)
      // Another range, file or session has its own mark.
      expect(yield* ledger.markRead(sessionID, file, "5:10", "b")).toBe(false)
      expect(yield* ledger.markRead(sessionID, path.join("some", "other.ts"), "1:default", "b")).toBe(false)
      expect(yield* ledger.markRead(other, file, "1:default", "b")).toBe(false)
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("recordRead leaves the marks, recordWrite clears that file's, forgetReads clears all but not freshness", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "a.ts")
      const sibling = path.join("some", "b.ts")
      yield* ledger.markRead(sessionID, file, "1:default", "a")
      yield* ledger.markRead(sessionID, sibling, "1:default", "a")

      yield* ledger.recordRead(sessionID, file, { mtimeMs: 1 })
      expect(yield* ledger.markRead(sessionID, file, "1:default", "a")).toBe(true)

      yield* ledger.recordWrite(sessionID, file, { mtimeMs: 2 })
      expect(yield* ledger.markRead(sessionID, file, "1:default", "a")).toBe(false)
      expect(yield* ledger.markRead(sessionID, sibling, "1:default", "a")).toBe(true)

      yield* ledger.forgetReads(sessionID)
      expect(yield* ledger.markRead(sessionID, sibling, "1:default", "a")).toBe(false)
      yield* ledger.assertFresh(sessionID, file, "a.ts", { mtimeMs: 2, digest: "x" })
    }).pipe(Effect.provide(ledgerLayer)),
  )
})
