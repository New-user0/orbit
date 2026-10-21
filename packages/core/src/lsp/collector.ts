export * as LspDiagnostics from "./collector.js"

import { createHash } from "crypto"
import type { Session } from "@orbit/schema/session"
import { SessionEvent } from "@orbit/schema/session-event"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Context, Effect, Layer, Stream } from "effect"
import { Bus } from "../bus.js"
import { Lsp } from "./index.js"
import { LspClient } from "./client.js"

/**
 * The problems a language server published for a file a session changed, after the inline block of the edit already
 * went out. A server can take longer than the edit tool waits, so this remembers which files each session touched and,
 * when asked, reads what those servers hold now. A problem is reported once: the marks only grow until the session is
 * deleted, moved or compacted, so a problem that stays is not repeated and one that moves to another line is new.
 *
 * It reads the latest publication instead of queuing every one. Servers are shared by every session of a Location, so a
 * queue could not say whose edit a publication belongs to, and the latest publication never holds a problem that the
 * server has already withdrawn. State lives in memory, like the file ledger's.
 */

export const MAX_FILES = 500
export const MAX_PER_FILE = 10
export const MAX_TOTAL = 30

export interface Problems {
  readonly file: string
  readonly diagnostics: ReadonlyArray<Lsp.Diagnostic>
}

export interface Interface {
  /**
   * Records files the session changed, and the diagnostics the inline block already showed for them. It only adds: an
   * earlier mark is never cleared.
   */
  readonly touch: (
    sessionID: Session.ID,
    files: readonly string[],
    delivered: Readonly<Record<string, ReadonlyArray<Lsp.Diagnostic>>>,
  ) => Effect.Effect<void>
  /**
   * The problems the touched files hold now that were not reported yet, errors first, at most 10 per file and 30 in all,
   * in the order the files were touched. What it returns is marked reported; what the caps cut is offered again.
   */
  readonly drain: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Problems>>
  /** How many files the session has touched; for tests of the bound and the lifecycle. */
  readonly size: (sessionID: Session.ID) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/LspDiagnostics") {}

/** The same problem has the same fingerprint: where it is, how serious, what it says and who said it. */
export const fingerprint = (file: string, diagnostic: Lsp.Diagnostic) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        LspClient.keyOf(file),
        diagnostic.range.start.line,
        diagnostic.range.start.character,
        diagnostic.range.end.line,
        diagnostic.range.end.character,
        LspClient.severity(diagnostic),
        diagnostic.message,
        diagnostic.source ?? null,
        diagnostic.code === undefined ? null : [typeof diagnostic.code, diagnostic.code],
      ]),
    )
    .digest("hex")

type Touched = { readonly file: string; readonly delivered: Set<string> }

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const lsp = yield* Lsp.Service
    // session -> file key -> the file and what was reported for it. A Map keeps touch order; the newest touch goes last.
    const sessions = new Map<Session.ID, Map<string, Touched>>()
    yield* Effect.addFinalizer(() => Effect.sync(() => sessions.clear()))
    yield* bus.subscribe([SessionEvent.Deleted, SessionEvent.Moved]).pipe(
      Stream.runForEach((event) => Effect.sync(() => sessions.delete(event.data.sessionID))),
      Effect.forkScoped({ startImmediately: true }),
    )
    // A compaction summarises away what the reports said (reminder rows stay out of its input), so a problem that remains
    // is reported again afterwards. The touched files stay: the session still owns those edits.
    yield* bus.subscribe([SessionEvent.Compaction.Ended]).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => sessions.get(event.data.sessionID)?.forEach((entry) => entry.delivered.clear())),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )

    return Service.of({
      touch: (sessionID, files, delivered) =>
        Effect.sync(() => {
          const touched = sessions.get(sessionID) ?? new Map<string, Touched>()
          sessions.set(sessionID, touched)
          files.forEach((file) => {
            const key = LspClient.keyOf(file)
            const entry = touched.get(key) ?? { file, delivered: new Set<string>() }
            touched.delete(key)
            touched.set(key, { file, delivered: entry.delivered })
            ;(delivered[file] ?? []).forEach((item) => entry.delivered.add(fingerprint(file, item)))
          })
          // The least recently touched file goes first.
          while (touched.size > MAX_FILES) touched.delete(touched.keys().next().value!)
        }),
      size: (sessionID) => Effect.sync(() => sessions.get(sessionID)?.size ?? 0),
      drain: Effect.fn("LspDiagnostics.drain")(function* (sessionID) {
        const touched = sessions.get(sessionID)
        if (!touched || touched.size === 0) return []
        const entries = [...touched.values()]
        const current = yield* lsp.current(entries.map((entry) => entry.file))
        return entries.reduce<{ total: number; result: Problems[] }>(
          (state, entry) => {
            const seen = new Set<string>()
            const fresh = (current[entry.file] ?? []).flatMap((item) => {
              const print = fingerprint(entry.file, item)
              if (seen.has(print) || entry.delivered.has(print)) return []
              seen.add(print)
              return [{ item, print }]
            })
            // A stable sort keeps the server's order within one severity.
            const taken = fresh
              .toSorted((a, b) => LspClient.severity(a.item) - LspClient.severity(b.item))
              .slice(0, Math.min(MAX_PER_FILE, MAX_TOTAL - state.total))
            if (taken.length === 0) return state
            taken.forEach((problem) => entry.delivered.add(problem.print))
            return {
              total: state.total + taken.length,
              result: [...state.result, { file: entry.file, diagnostics: taken.map((problem) => problem.item) }],
            }
          },
          { total: 0, result: [] },
        ).result
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Lsp.node] })
