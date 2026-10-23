import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit } from "effect"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { FileLedger } from "@orbit/core/file-ledger"
import { readNow } from "./fixture/ledger"
import { Location } from "@orbit/core/location"
import { canLinkFile } from "./fixture/symlink"
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
        "a.ts has no read in this session behind it",
      )
      expect((yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")

      yield* readNow(sessionID, file)
      expect(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit)).toEqual(Exit.void)
      expect(message(yield* ledger.assertFresh(other, file, "a.ts").pipe(Effect.exit))).toContain("has no read in this session")
      expect((yield* ledger.assertFresh(other, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")

      yield* Effect.promise(() => fs.utimes(file, new Date(2_000_000), new Date(2_000_000)))
      expect(message(yield* ledger.assertFresh(sessionID, file, "a.ts").pipe(Effect.exit))).toContain(
        "a.ts changed on disk after your last read",
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
      ).toContain("a.ts changed on disk after your last read")
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

  it.live("marks one slot per file: a read of another range replaces the first, so A, B, A is never a repeat", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "slot.ts")
      expect([
        yield* ledger.markRead(sessionID, file, "A", "x"),
        yield* ledger.markRead(sessionID, file, "B", "x"),
        yield* ledger.markRead(sessionID, file, "A", "x"),
      ]).toEqual([false, false, false])
      expect([
        yield* ledger.markRead(sessionID, file, "A", "x"),
        yield* ledger.markRead(sessionID, file, "A", "x"),
      ]).toEqual([true, true])
      // The same range with other text is not a repeat either.
      expect(yield* ledger.markRead(sessionID, file, "A", "y")).toBe(false)
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("assertRead refuses an unread existing file without its content, and passes a read or a missing one", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const file = path.join(tmp.path, "a.ts")
      yield* Effect.promise(() => Bun.write(file, "one\n"))
      const ledger = yield* FileLedger.Service
      expect((yield* ledger.assertRead(sessionID, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")
      yield* ledger.assertRead(sessionID, path.join(tmp.path, "missing.ts"), "missing.ts")
      yield* ledger.recordRead(sessionID, file, { mtimeMs: 1 })
      // Freshness is not its question: an old record is still a record.
      yield* ledger.assertRead(sessionID, file, "a.ts")
      expect((yield* ledger.assertRead(other, file, "a.ts").pipe(Effect.flip)).code).toBe("file.unread")
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.effect("digests a CR LF pair as an LF and nothing else as equal", () =>
    Effect.sync(() => {
      const text = (value: string) => new TextEncoder().encode(value)
      const bytes = (...values: number[]) => Uint8Array.from(values)
      expect(FileLedger.digest(text("a\r\nb\r\n"))).toBe(FileLedger.digest(text("a\nb\n")))
      // A lone CR, a changed letter and a BOM all differ.
      expect(FileLedger.digest(text("a\rb\n"))).not.toBe(FileLedger.digest(text("a\nb\n")))
      expect(FileLedger.digest(text("a\nc\n"))).not.toBe(FileLedger.digest(text("a\nb\n")))
      expect(FileLedger.digest(bytes(0xef, 0xbb, 0xbf, 0x61))).not.toBe(FileLedger.digest(bytes(0x61)))
      // Two different invalid bytes never compare equal, as decoded text would make them.
      expect(FileLedger.digest(bytes(0x61, 0xff))).not.toBe(FileLedger.digest(bytes(0x61, 0xfe)))
      // A trailing CR with no LF after it is kept.
      expect(FileLedger.digest(bytes(0x61, 0x0d))).not.toBe(FileLedger.digest(bytes(0x61)))
    }),
  )

  const changedAfterRead = (name: string, before: Uint8Array, after: Uint8Array, passes: boolean) =>
    it.live(name, () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const file = path.join(tmp.path, "a.txt")
        yield* Effect.promise(() => Bun.write(file, before))
        yield* touch(file, 1_000)
        const ledger = yield* FileLedger.Service
        yield* readNow(sessionID, file)
        yield* Effect.promise(() => Bun.write(file, after))
        yield* touch(file, 2_000)
        const exit = yield* ledger
          .assertFresh(sessionID, file, "a.txt", { mtimeMs: 2_000_000, digest: FileLedger.digest(after) })
          .pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(passes)
      }).pipe(Effect.provide(ledgerLayer)),
    )
  const utf8 = (value: string) => new TextEncoder().encode(value)
  changedAfterRead("passes a change of line endings alone after a whole read", utf8("a\r\nb\r\n"), utf8("a\nb\n"), true)
  changedAfterRead(
    "refuses an added BOM after a whole read",
    utf8("a\n"),
    Uint8Array.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]),
    false,
  )
  changedAfterRead(
    "refuses a changed invalid byte after a whole read",
    Uint8Array.from([0x61, 0xff]),
    Uint8Array.from([0x61, 0xfe]),
    false,
  )

  it.live("keeps mtime-only freshness for a file only read in pages, until the session writes it", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "paged.log")
      yield* ledger.recordRead(sessionID, file, { mtimeMs: 1_000 })
      const stale = yield* ledger
        .assertFresh(sessionID, file, "paged.log", { mtimeMs: 2_000, digest: digestOf("x") })
        .pipe(Effect.flip)
      expect(stale.code).toBe("file.stale")
      yield* ledger.recordWrite(sessionID, file, { mtimeMs: 3_000, digest: digestOf("x") })
      yield* ledger.assertFresh(sessionID, file, "paged.log", { mtimeMs: 4_000, digest: digestOf("x") })
    }).pipe(Effect.provide(ledgerLayer)),
  )

  // A link inside the project reaches the ledger under its own path, while a read records the target's time.
  const linked = canLinkFile ? it.live : it.live.skip
  linked("compares the time of a link's target, whichever of the two is newer", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "target.txt")
      const link = path.join(tmp.path, "link.txt")
      yield* Effect.promise(async () => {
        await Bun.write(target, "one\n")
        await fs.symlink(target, link)
      })
      const ledger = yield* FileLedger.Service
      const stamp = (file: string, seconds: number) =>
        Effect.promise(() => fs.utimes(file, new Date(seconds * 1000), new Date(seconds * 1000)))
      const stampLink = (seconds: number) =>
        Effect.promise(() => fs.lutimes(link, new Date(seconds * 1000), new Date(seconds * 1000)))

      // The link is newer than the target: bumping only the link is not a change to the file.
      yield* stamp(target, 1_000)
      yield* stampLink(5_000)
      yield* readNow(sessionID, link)
      yield* ledger.assertFresh(sessionID, link, "link.txt")
      yield* stampLink(9_000)
      yield* ledger.assertFresh(sessionID, link, "link.txt")

      // The link is older than the target's last read: a change to the target is still seen.
      yield* stampLink(100)
      yield* Effect.promise(() => Bun.write(target, "two\n"))
      yield* stamp(target, 2_000)
      expect((yield* ledger.assertFresh(sessionID, link, "link.txt").pipe(Effect.flip)).code).toBe("file.stale")
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

  it.live("treats a path that exists but cannot be read as present: unread without a record, stale with one", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      // A directory exists but cannot be opened as a file, so its time is unknown.
      const dir = path.join(tmp.path, "dir")
      yield* Effect.promise(() => fs.mkdir(dir))
      const ledger = yield* FileLedger.Service
      expect((yield* ledger.assertRead(sessionID, dir, "dir").pipe(Effect.flip)).code).toBe("file.unread")
      expect((yield* ledger.assertFresh(sessionID, dir, "dir").pipe(Effect.flip)).code).toBe("file.unread")
      yield* ledger.recordRead(sessionID, dir, { mtimeMs: 1 })
      expect((yield* ledger.assertFresh(sessionID, dir, "dir").pipe(Effect.flip)).code).toBe("file.stale")
      expect(yield* ledger.assertRead(sessionID, path.join(tmp.path, "missing"), "missing").pipe(Effect.exit)).toEqual(
        Exit.void,
      )
    }).pipe(Effect.provide(ledgerLayer)),
  )
})

// prompts-context-7: the ledger is also the store of the text a session's own write left in a file, which the
// file-change reminder diffs against. As in the reference's read-file cache, one bounded store serves both freshness and
// change detection, and only an entry that holds text is watched.
describe("FileLedger, the text the session's writes left", () => {
  const ledgerLayer = AppNodeBuilder.build(FileLedger.node, [Location.node.replace(tempLocationLayer)])
  const digestOf = (text: string) => FileLedger.digest(new TextEncoder().encode(text))
  const written = (text: string, mtimeMs = 1_000) => ({ mtimeMs, digest: digestOf(text), text })

  it.live("watches a written file with its text; a read of it ends the watch and keeps freshness", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const file = path.join("some", "written.ts")
      const read = path.join("some", "read.ts")
      yield* ledger.recordWrite(sessionID, file, written("body\n"))
      yield* ledger.recordRead(sessionID, read, { mtimeMs: 1_000, digest: digestOf("x") })
      expect(yield* ledger.watched(sessionID)).toEqual([expect.objectContaining({ path: file, mtimeMs: 1_000, text: "body\n" })])
      expect(yield* ledger.watched(other)).toEqual([])

      yield* ledger.recordRead(sessionID, file, { mtimeMs: 2_000, digest: digestOf("body\n") })
      expect(yield* ledger.watched(sessionID)).toEqual([])
      yield* ledger.assertFresh(sessionID, file, "written.ts", { mtimeMs: 2_000, digest: digestOf("other") })
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("forgets one path on request, and only that path", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const ledger = yield* FileLedger.Service
      const gone = path.join(tmp.path, "gone.ts")
      const kept = path.join(tmp.path, "kept.ts")
      yield* Effect.promise(() => Promise.all([Bun.write(gone, "a"), Bun.write(kept, "b")]))
      yield* ledger.recordWrite(sessionID, gone, written("a"))
      yield* ledger.recordWrite(sessionID, kept, written("b"))
      yield* ledger.forget(sessionID, gone)
      expect((yield* ledger.watched(sessionID)).map((entry) => entry.path)).toEqual([kept])
      expect((yield* ledger.assertRead(sessionID, gone, "gone.ts").pipe(Effect.flip)).code).toBe("file.unread")
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("holds at most 100 files per session and drops the least recently used first", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const ledger = yield* FileLedger.Service
      const first = path.join(tmp.path, "file-0.ts")
      yield* Effect.promise(() => Bun.write(first, "0"))
      expect(FileLedger.MAX_FILES).toBe(100)
      for (let index = 0; index <= FileLedger.MAX_FILES; index++)
        yield* ledger.recordWrite(sessionID, path.join(tmp.path, `file-${index}.ts`), written(String(index)))
      const paths = (yield* ledger.watched(sessionID)).map((entry) => entry.path)
      expect(paths).toHaveLength(FileLedger.MAX_FILES)
      expect(paths).not.toContain(first)
      // Dropped from the one store, so freshness goes with it, as in the reference.
      expect((yield* ledger.assertRead(sessionID, first, "file-0.ts").pipe(Effect.flip)).code).toBe("file.unread")
      // A file another session wrote is counted for that session only.
      yield* ledger.recordWrite(other, first, written("0"))
      expect(yield* ledger.watched(other)).toHaveLength(1)
    }).pipe(Effect.provide(ledgerLayer)),
  )

  it.live("holds at most 25 MB of written text per session", () =>
    Effect.gen(function* () {
      const ledger = yield* FileLedger.Service
      const large = "x".repeat(13 * 1024 * 1024)
      expect(FileLedger.MAX_TEXT_BYTES).toBe(25 * 1024 * 1024)
      yield* ledger.recordWrite(sessionID, "one.txt", written(large))
      yield* ledger.recordWrite(sessionID, "small.txt", written("small"))
      yield* ledger.recordWrite(sessionID, "two.txt", written(large))
      expect((yield* ledger.watched(sessionID)).map((entry) => entry.path).toSorted()).toEqual(["small.txt", "two.txt"])
    }).pipe(Effect.provide(ledgerLayer)),
  )
})
