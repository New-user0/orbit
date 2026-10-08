export * as FileLedger from "./file-ledger.js"

import { ToolFailure } from "@orbit/ai"
import type { Session } from "@orbit/schema/session"
import { SessionEvent } from "@orbit/schema/session-event"
import { Tool } from "@orbit/schema/tool"
import { Context, Effect, Layer, Stream } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"

/**
 * Remembers which files each Session has read, and when they last changed, so the edit tools can refuse to change a
 * file the model has not seen or that changed on disk since it last looked. Reads and the tools' own writes both
 * record the file's current modification time.
 */
export interface Interface {
  /** Record that the Session has seen the file as it is now. */
  readonly record: (sessionID: Session.ID, path: string) => Effect.Effect<void>
  /** Fail when the file exists and the Session has not read it, or it changed since the Session last did. */
  readonly assertFresh: (sessionID: Session.ID, path: string, display: string) => Effect.Effect<void, ToolFailure>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/FileLedger") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const environment = yield* Environment.Service
    const sessions = new Map<Session.ID, Map<string, number>>()
    yield* Effect.addFinalizer(() => Effect.sync(() => sessions.clear()))
    yield* bus.subscribe([SessionEvent.Deleted, SessionEvent.Moved]).pipe(
      Stream.runForEach((event) => Effect.sync(() => sessions.delete(event.data.sessionID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    const modified = (path: string) =>
      environment.files.stat(path).pipe(
        Effect.map((info) => info.mtimeMs),
        Effect.catch(() => Effect.undefined),
      )

    return Service.of({
      record: Effect.fn("FileLedger.record")(function* (sessionID, path) {
        const time = yield* modified(path)
        if (time === undefined) return
        const files = sessions.get(sessionID) ?? new Map<string, number>()
        files.set(path, time)
        sessions.set(sessionID, files)
      }),
      assertFresh: Effect.fn("FileLedger.assertFresh")(function* (sessionID, path, display) {
        const time = yield* modified(path)
        if (time === undefined) return
        const seen = sessions.get(sessionID)?.get(path)
        if (seen === undefined)
          return yield* new ToolFailure({
            message: `${display} has not been read in this session. Read it before changing it.`,
            code: Tool.ErrorCode.FileUnread,
          })
        if (time > seen)
          return yield* new ToolFailure({
            message: `${display} changed since it was last read. Read it again before changing it.`,
            code: Tool.ErrorCode.FileStale,
          })
      }),
    })
  }),
)

/** Records nothing and allows every change, for tests and embedders that write files without reading them first. */
export const permissiveLayer = Layer.succeed(
  Service,
  Service.of({ record: () => Effect.void, assertFresh: () => Effect.void }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Environment.node] })
