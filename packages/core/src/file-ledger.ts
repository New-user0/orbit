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

/** The digest of the exact bytes a caller already holds; the ledger never reads a file to compute one. */
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** What a caller saw of a file: its modification time, and the digest of its bytes when the caller held all of them. */
export interface Seen {
  readonly mtimeMs: number
  readonly digest?: string
}

/**
 * Remembers which files each Session has read, and when they last changed, so the edit tools can refuse to change a
 * file the model has not seen or that changed on disk since it last looked. Reads and the tools' own writes both
 * record the file's modification time, and its digest when the caller holds the whole file: a newer time with an
 * unchanged digest is a touch, not an edit.
 *
 * A second, separate memory holds what each read showed the model, so an identical repeat read can be answered with a
 * stub. A read never clears it; a write, compaction, a committed revert and a deleted or moved Session do.
 */
export interface Interface {
  /** Record that the Session has seen the file as it is now. Freshness only: it never touches the repeat-read marks. */
  readonly recordRead: (sessionID: Session.ID, path: string, seen: Seen) => Effect.Effect<void>
  /** Record the file as the Session's own change left it, and forget what earlier reads of it showed. */
  readonly recordWrite: (sessionID: Session.ID, path: string, seen: Seen) => Effect.Effect<void>
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
}

export class Service extends Context.Service<Service, Interface>()("@orbit/FileLedger") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const environment = yield* Environment.Service
    const sessions = new Map<Session.ID, Map<string, Seen>>()
    // session -> path -> read key -> digest of the text the model was shown
    const marks = new Map<Session.ID, Map<string, Map<string, string>>>()
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        sessions.clear()
        marks.clear()
      }),
    )
    yield* bus.subscribe([SessionEvent.Deleted, SessionEvent.Moved]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          sessions.delete(event.data.sessionID)
          marks.delete(event.data.sessionID)
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
    // Compaction and a committed revert change what the model remembers, not what is on disk.
    yield* bus.subscribe([SessionEvent.Compaction.Ended, SessionEvent.RevertEvent.Committed]).pipe(
      Stream.runForEach((event) => Effect.sync(() => marks.delete(event.data.sessionID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    const modified = (path: string) =>
      environment.files.stat(path).pipe(
        Effect.map((info) => info.mtimeMs),
        Effect.catch(() => Effect.undefined),
      )
    const remember = (sessionID: Session.ID, path: string, seen: Seen) => {
      const files = sessions.get(sessionID) ?? new Map<string, Seen>()
      files.set(path, seen)
      sessions.set(sessionID, files)
    }

    return Service.of({
      recordRead: Effect.fn("FileLedger.recordRead")(function* (sessionID, path, seen) {
        remember(sessionID, path, seen)
      }),
      recordWrite: Effect.fn("FileLedger.recordWrite")(function* (sessionID, path, seen) {
        remember(sessionID, path, seen)
        marks.get(sessionID)?.delete(path)
      }),
      assertFresh: Effect.fn("FileLedger.assertFresh")(function* (sessionID, path, display, current) {
        const time = current ? current.mtimeMs : yield* modified(path)
        if (time === undefined) return
        const seen = sessions.get(sessionID)?.get(path)
        if (seen === undefined)
          return yield* new ToolFailure({
            message: `${display} has not been read in this session. Read it before changing it.`,
            code: Tool.ErrorCode.FileUnread,
          })
        if (time <= seen.mtimeMs) return
        if (current && seen.digest !== undefined && seen.digest === current.digest) {
          remember(sessionID, path, { mtimeMs: time, digest: seen.digest })
          return
        }
        return yield* new ToolFailure({
          message: `${display} changed since it was last read. Read it again before changing it.`,
          code: Tool.ErrorCode.FileStale,
        })
      }),
      markRead: Effect.fn("FileLedger.markRead")(function* (sessionID, path, key, digest) {
        const files = marks.get(sessionID) ?? new Map<string, Map<string, string>>()
        const keys = files.get(path) ?? new Map<string, string>()
        const same = keys.get(key) === digest
        keys.set(key, digest)
        files.set(path, keys)
        marks.set(sessionID, files)
        return same
      }),
      forgetReads: Effect.fn("FileLedger.forgetReads")(function* (sessionID) {
        marks.delete(sessionID)
      }),
    })
  }),
)

/** Records nothing and allows every change, for tests and embedders that write files without reading them first. */
export const permissiveLayer = Layer.succeed(
  Service,
  Service.of({
    recordRead: () => Effect.void,
    recordWrite: () => Effect.void,
    assertFresh: () => Effect.void,
    markRead: () => Effect.succeed(false),
    forgetReads: () => Effect.void,
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Environment.node] })
