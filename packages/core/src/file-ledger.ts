export * as FileLedger from "./file-ledger.js"

import { createHash } from "crypto"
import { ToolFailure } from "@orbit/ai"
import type { Session } from "@orbit/schema/session"
import { SessionEvent } from "@orbit/schema/session-event"
import { Tool } from "@orbit/schema/tool"
import { Context, Effect, Layer, Stream } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"
import { SessionStore } from "./session/store.js"

/**
 * The freshness digest of the exact bytes a caller already holds; the ledger never reads a file to compute one. Every
 * CR LF pair counts as a single LF, so a change of line endings alone is not an edit; a BOM or any other byte still is.
 * Folding happens on bytes, not decoded text, so two different invalid sequences never compare equal.
 */
export const digest = (bytes: Uint8Array) => {
  const hash = createHash("sha256")
  let start = 0
  for (let at = bytes.indexOf(0x0d); at !== -1; at = bytes.indexOf(0x0d, at + 1)) {
    if (bytes[at + 1] !== 0x0a) continue
    hash.update(bytes.subarray(start, at))
    start = at + 1
  }
  return hash.update(bytes.subarray(start)).digest("hex")
}

/** What a caller saw of a file: its modification time, and the digest of its bytes when the caller held all of them. */
export interface Seen {
  readonly mtimeMs: number
  readonly digest?: string
  /**
   * The decoded text that the Session's own write left in the file, or that history shows it held. Only `recordWrite`
   * and `seed` keep it, and a read drops it. A record with text is one the file-change reminder watches.
   */
  readonly text?: string
  /**
   * Where the Session's write really put the file, every link followed, as the write tool resolved it. Only
   * `recordWrite` keeps it. The file-change reminder reads a file outside the project again only while it still leads
   * there, so a link swapped in since, for the file or any folder above it, cannot send that read elsewhere.
   */
  readonly place?: string
}

/** A record that holds text, which the file-change reminder compares the file on disk with. */
export interface Watched {
  readonly path: string
  readonly seen: Seen & { readonly text: string }
}

/** At most this many files per Session. The least recently used record goes first, and its freshness goes with it. */
export const MAX_FILES = 100
/** At most this much stored text per Session, counted in UTF-8 bytes, with each record counting at least one. */
export const MAX_BYTES = 25 * 1024 * 1024

/**
 * Remembers which files each Session has read, and when they last changed, so the edit tools can refuse to change a
 * file the model has not seen or that changed on disk since it last looked. Reads and the tools' own writes both
 * record the file's modification time, and its digest when the caller holds the whole file: a newer time with an
 * unchanged digest is a touch, not an edit.
 *
 * A record of the Session's own write also keeps the text it left, which the file-change reminder compares the file
 * with later. A read keeps no text, so a read ends that watch. Each Session's records are bounded as the reference
 * bounds its read-file cache (`MAX_FILES`, `MAX_BYTES`): recording a file or asking about it is a use, and the least
 * recently used record is dropped first, freshness included.
 *
 * A second, separate memory holds what the last read of each file showed the model, so an identical repeat read can
 * be answered with a stub. A read never clears it; a write, a completed compaction, a committed revert and a deleted
 * or moved Session do. A completed compaction also forgets freshness and every watch.
 *
 * When a subagent's run ends (a child Session's busy period, however it ended), everything held for it goes, as the
 * reference releases a subagent's read-file cache when the subagent returns. A child that is continued later starts
 * with nothing held, as the reference's resumed subagents do: the file-change reminder rebuilds only a Session with no
 * parent.
 */
export interface Interface {
  /** Record that the Session has seen the file as it is now. Freshness only: it never touches the repeat-read marks. */
  readonly recordRead: (sessionID: Session.ID, path: string, seen: Seen) => Effect.Effect<void>
  /** Record the file as the Session's own change left it, and forget what earlier reads of it showed. */
  readonly recordWrite: (sessionID: Session.ID, path: string, seen: Seen) => Effect.Effect<void>
  /** Fail when the file exists and the Session has no record of it. No file content is read, so a tool can refuse an unread file before it loads one. */
  readonly assertRead: (sessionID: Session.ID, path: string, display: string) => Effect.Effect<void, ToolFailure>
  /**
   * Fail when the file exists and the Session has not read it, or it changed since the Session last did. With
   * `current` the file is not statted; a newer time whose digest equals the stored one passes and is remembered.
   */
  readonly assertFresh: (
    sessionID: Session.ID,
    path: string,
    display: string,
    current?: Seen & { readonly digest: string },
  ) => Effect.Effect<void, ToolFailure>
  /** True when the Session's last read of `path` under `key` showed the same digest; either way the digest is kept. */
  readonly markRead: (sessionID: Session.ID, path: string, key: string, digest: string) => Effect.Effect<boolean>
  /** Forget what reads showed, keeping freshness. */
  readonly forgetReads: (sessionID: Session.ID) => Effect.Effect<void>
  /** The records that hold text, least recently used first. Listing them is not a use. */
  readonly watched: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Watched>>
  /**
   * The records that hold text, in the order the file-change reminder checks them: those not yet checked in the current
   * scan first, then the rest, each part most recently used first. Once every one was checked, a new scan starts and all
   * of them count as unchecked again. Listing them is not a use.
   */
  readonly toCheck: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Watched>>
  /**
   * Note that these files were checked in the current scan, starting a new scan first when the last one was complete.
   * It is not a use, and it does not count anything as seen: freshness changes only through `settle`.
   */
  readonly checked: (sessionID: Session.ID, paths: ReadonlyArray<string>) => Effect.Effect<void>
  /**
   * Replace the record of one file with what a read saw (`next`), or drop it, freshness included, when `next` is
   * undefined (a file that is gone), but only while the record is still exactly `held`. The file-change reminder settles
   * what it found this way after its rows are posted, so a record that a write or a compaction changed or dropped in the
   * meantime stays as that left it.
   */
  readonly settle: (sessionID: Session.ID, path: string, held: Seen, next?: Seen) => Effect.Effect<void>
  /**
   * Claim the Session's rebuild from history: true the first time it is asked for the Session in this process, false
   * after. A completed compaction does not reset it. The file-change reminder claims only a Session with no parent.
   */
  readonly claim: (sessionID: Session.ID) => Effect.Effect<boolean>
  /** Record each file that has no record yet. A record that is already there wins. */
  readonly seed: (sessionID: Session.ID, files: ReadonlyArray<Watched>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/FileLedger") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const environment = yield* Environment.Service
    const store = yield* SessionStore.Service
    // session -> path -> record, in order of use, the least recent first
    const sessions = new Map<Session.ID, Map<string, Seen>>()
    // session -> path -> the last read's key and the digest of the text the model was shown (one slot per path)
    const marks = new Map<Session.ID, Map<string, { readonly key: string; readonly digest: string }>>()
    const rebuilt = new Set<Session.ID>()
    // session -> the watched files checked in the current scan, so each step goes on where the last one stopped
    const scans = new Map<Session.ID, Set<string>>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        sessions.clear()
        marks.clear()
        rebuilt.clear()
        scans.clear()
      }),
    )
    const drop = (sessionID: Session.ID) => {
      sessions.delete(sessionID)
      marks.delete(sessionID)
      rebuilt.delete(sessionID)
      scans.delete(sessionID)
    }
    yield* bus.subscribe([SessionEvent.Deleted, SessionEvent.Moved]).pipe(
      Stream.runForEach((event) => Effect.sync(() => drop(event.data.sessionID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    yield* bus
      .subscribe([SessionEvent.Execution.Succeeded, SessionEvent.Execution.Failed, SessionEvent.Execution.Interrupted])
      .pipe(
        Stream.runForEach((event) =>
          store.get(event.data.sessionID).pipe(
            Effect.map((session) => {
              if (session?.parentID !== undefined) drop(event.data.sessionID)
            }),
          ),
        ),
        Effect.forkScoped({ startImmediately: true }),
      )
    // A completed compaction summarises away what the model saw, so it must read again before changing anything.
    yield* bus.subscribe([SessionEvent.Compaction.Ended]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          sessions.delete(event.data.sessionID)
          marks.delete(event.data.sessionID)
          scans.delete(event.data.sessionID)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    // A committed revert changes what the model remembers; a revert that restored files changed their time on disk.
    yield* bus.subscribe([SessionEvent.RevertEvent.Committed]).pipe(
      Stream.runForEach((event) => Effect.sync(() => marks.delete(event.data.sessionID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    const modified = (path: string) =>
      // A stat that follows links, like the time a read records: `files.stat` would describe the link itself.
      environment.files.read(path, { offset: 0, length: 0 }).pipe(
        Effect.map((file) => file.info.mtimeMs),
        // Only a missing file counts as absent. A file that is there but cannot be opened has an unknown time, so it is
        // treated as changed: an unread one fails `file.unread` and a read one fails `file.stale`.
        Effect.catchTag("Environment.NotFound", () => Effect.undefined),
        Effect.catch(() => Effect.succeed(Number.POSITIVE_INFINITY)),
      )
    const unread = (display: string) =>
      new ToolFailure({
        message: `${display} has no read in this session behind it; read it before changing it.`,
        code: Tool.ErrorCode.FileUnread,
      })
    const remember = (sessionID: Session.ID, path: string, seen: Seen) => {
      const files = sessions.get(sessionID) ?? new Map<string, Seen>()
      files.delete(path)
      // Only these fields: a writer hands over its whole snapshot.
      files.set(path, {
        mtimeMs: seen.mtimeMs,
        ...(seen.digest === undefined ? {} : { digest: seen.digest }),
        ...(seen.text === undefined ? {} : { text: seen.text }),
        ...(seen.place === undefined ? {} : { place: seen.place }),
      })
      sessions.set(sessionID, files)
      bound(files)
    }
    const watched = (sessionID: Session.ID) =>
      Array.from(sessions.get(sessionID) ?? []).flatMap(([path, seen]) =>
        seen.text === undefined ? [] : [{ path, seen: { ...seen, text: seen.text } }],
      )
    // The scan's checked files, or none once every watched file was checked, which starts the next scan.
    const scanned = (sessionID: Session.ID) => {
      const scan = scans.get(sessionID) ?? new Set<string>()
      return watched(sessionID).every((file) => scan.has(file.path)) ? new Set<string>() : scan
    }
    // Asking about a file is a use of its record, which moves it to the end.
    const use = (sessionID: Session.ID, path: string) => {
      const files = sessions.get(sessionID)
      const seen = files?.get(path)
      if (files === undefined || seen === undefined) return undefined
      files.delete(path)
      files.set(path, seen)
      return seen
    }

    return Service.of({
      recordRead: Effect.fn("FileLedger.recordRead")(function* (sessionID, path, seen) {
        remember(sessionID, path, { mtimeMs: seen.mtimeMs, digest: seen.digest })
      }),
      recordWrite: Effect.fn("FileLedger.recordWrite")(function* (sessionID, path, seen) {
        remember(sessionID, path, seen)
        marks.get(sessionID)?.delete(path)
      }),
      assertRead: Effect.fn("FileLedger.assertRead")(function* (sessionID, path, display) {
        if (use(sessionID, path)) return
        if ((yield* modified(path)) === undefined) return
        return yield* unread(display)
      }),
      assertFresh: Effect.fn("FileLedger.assertFresh")(function* (sessionID, path, display, current) {
        const time = current ? current.mtimeMs : yield* modified(path)
        if (time === undefined) return
        const seen = use(sessionID, path)
        if (seen === undefined) return yield* unread(display)
        if (time <= seen.mtimeMs) return
        if (current && seen.digest !== undefined && seen.digest === current.digest) {
          remember(sessionID, path, { ...seen, mtimeMs: time })
          return
        }
        return yield* new ToolFailure({
          message: `${display} changed on disk after your last read, so read it again before changing it.`,
          code: Tool.ErrorCode.FileStale,
        })
      }),
      markRead: Effect.fn("FileLedger.markRead")(function* (sessionID, path, key, digest) {
        const files = marks.get(sessionID) ?? new Map<string, { readonly key: string; readonly digest: string }>()
        const last = files.get(path)
        files.set(path, { key, digest })
        marks.set(sessionID, files)
        return last?.key === key && last.digest === digest
      }),
      forgetReads: Effect.fn("FileLedger.forgetReads")(function* (sessionID) {
        marks.delete(sessionID)
      }),
      watched: Effect.fn("FileLedger.watched")(function* (sessionID) {
        return watched(sessionID)
      }),
      toCheck: Effect.fn("FileLedger.toCheck")(function* (sessionID) {
        const scan = scanned(sessionID)
        const newest = watched(sessionID).toReversed()
        return [...newest.filter((file) => !scan.has(file.path)), ...newest.filter((file) => scan.has(file.path))]
      }),
      checked: Effect.fn("FileLedger.checked")(function* (sessionID, paths) {
        const scan = scanned(sessionID)
        paths.forEach((path) => scan.add(path))
        scans.set(sessionID, scan)
      }),
      settle: Effect.fn("FileLedger.settle")(function* (sessionID, path, held, next) {
        const seen = sessions.get(sessionID)?.get(path)
        if (seen === undefined || !same(seen, held)) return
        if (next === undefined) return sessions.get(sessionID)?.delete(path)
        remember(sessionID, path, { mtimeMs: next.mtimeMs, digest: next.digest })
      }),
      claim: Effect.fn("FileLedger.claim")(function* (sessionID) {
        if (rebuilt.has(sessionID)) return false
        rebuilt.add(sessionID)
        return true
      }),
      seed: Effect.fn("FileLedger.seed")(function* (sessionID, files) {
        files
          .filter((file) => !sessions.get(sessionID)?.has(file.path))
          .forEach((file) => remember(sessionID, file.path, file.seen))
      }),
    })
  }),
)

const same = (left: Seen, right: Seen) =>
  left.mtimeMs === right.mtimeMs &&
  left.digest === right.digest &&
  left.text === right.text &&
  left.place === right.place

// A Map keeps insertion order, so its first key is the least recently used. The newest record always stays.
const bound = (files: Map<string, Seen>) => {
  const size = (seen: Seen) => Math.max(1, seen.text === undefined ? 0 : Buffer.byteLength(seen.text))
  let bytes = Array.from(files.values()).reduce((total, seen) => total + size(seen), 0)
  for (const [path, seen] of files) {
    if (files.size <= 1 || (files.size <= MAX_FILES && bytes <= MAX_BYTES)) return
    files.delete(path)
    bytes -= size(seen)
  }
}

/** Records nothing and allows every change, for tests and embedders that write files without reading them first. */
export const permissiveLayer = Layer.succeed(
  Service,
  Service.of({
    recordRead: () => Effect.void,
    recordWrite: () => Effect.void,
    assertRead: () => Effect.void,
    assertFresh: () => Effect.void,
    markRead: () => Effect.succeed(false),
    forgetReads: () => Effect.void,
    watched: () => Effect.succeed([]),
    toCheck: () => Effect.succeed([]),
    checked: () => Effect.void,
    settle: () => Effect.void,
    claim: () => Effect.succeed(false),
    seed: () => Effect.void,
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Environment.node, SessionStore.node] })
