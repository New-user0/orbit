export * as SessionInstructions from "./instructions.js"

import { relative } from "path"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "../bus.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Config } from "../config.js"
import { ConfigInstructionFile } from "../config/instruction-file.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { SessionEvent } from "./event.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

const InjectedMetadata = Schema.Struct({
  instruction: Schema.Struct({ paths: Schema.Array(Schema.String) }),
})

export interface Interface {
  readonly load: (input: {
    readonly sessionID: SessionSchema.ID
    readonly paths: ReadonlyArray<string>
  }) => Effect.Effect<void, MessageDecodeError | FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/SessionInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const store = yield* SessionStore.Service
    const location = yield* Location.Service
    const trust = yield* ProjectTrust.Service
    const global = yield* Global.Service
    // Resolved once for the Location layer; the synthetic text and dedup ledger keep
    // absolute paths, but the human-facing description shows paths relative to the project
    // root so opening a subdirectory still describes paths from the project root.
    const root = yield* fs.resolve(location.project.directory)
    const home = yield* fs.resolve(global.home)
    // Same-step parallel reads settle concurrently, so an in-memory claim guards each
    // Session/path pair while a load is in flight. The claim is released once the load
    // settles: the synthetic message metadata scanned below is the only lasting ledger,
    // so paths whose synthetics drop out of model-visible history (compaction, revert)
    // are re-discovered and re-injected instead of staying silently lost.
    const inFlight = yield* Ref.make<Map<SessionSchema.ID, Set<string>>>(new Map())
    // Files already reported as skipped, so that one the model's reads keep finding is reported once.
    const skipped = new Set<string>()

    // The import guard, asked just before the file is read. The paths here are real, so a file that a link in the
    // repository points at, such as a key or a credentials file, is left out before it can go into the conversation, in a
    // trusted project as in one that is not. A session at the home folder or a filesystem root has no root until that
    // folder is trusted.
    const reachable = Effect.fnUntraced(function* (path: string) {
      if (yield* trust.importable(path, path)) return true
      if (skipped.has(path)) return false
      skipped.add(path)
      yield* Effect.logWarning("instruction file skipped", {
        path,
        reason: "leads outside the folders the session may load instruction files from",
      })
      return false
    })

    const load = Effect.fn("SessionInstructions.load")(function* (input: Parameters<Interface["load"]>[0]) {
      const claimed = yield* Ref.modify(inFlight, (map) => {
        const existing = map.get(input.sessionID) ?? new Set<string>()
        const newlyClaimed = input.paths.filter((path) => !existing.has(path))
        if (newlyClaimed.length === 0) return [newlyClaimed, map]
        const next = new Map(map)
        next.set(input.sessionID, new Set([...existing, ...newlyClaimed]))
        return [newlyClaimed, next]
      })
      if (claimed.length === 0) return
      // The imports that this call has claimed, which are released with the paths it was asked about.
      const imported: string[] = []
      yield* Effect.gen(function* () {
        const alreadyInjected = yield* previouslyInjected(store, input.sessionID)
        // What the settings of every scope exclude as of now, which is asked before anything is read: an excluded file is
        // never opened. Exclusion only takes files out, so the gate that follows is the one that was always here.
        const patterns = yield* ConfigInstructionFile.prepare(
          ConfigInstructionFile.excludes(yield* config.entries()),
          fs.resolve,
        )
        const toInject = yield* Effect.filter(
          claimed.filter((path) => !alreadyInjected.has(path)),
          (path) =>
            ConfigInstructionFile.excluded(patterns, [path])
              ? Effect.logDebug("instruction file excluded", { path }).pipe(Effect.as(false))
              : reachable(path),
        )
        if (toInject.length === 0) return
        // The model reads each file as the session start does (`ConfigInstructionFile`), and the files it imports after it,
        // inside the project only: a file the model's reads load never imports from outside, trusted or not. Injecting it
        // is not a read as the edit tools count it: the ledger is not told, so changing the file still needs a real read of
        // it. A file that is excluded, or has nothing left once processed, is not recorded either, and the next read looks
        // at it again. Only the files loaded at the start are flagged for their size, so no warning is made here. A fresh
        // set of handled files for each call, and the files one after the other, so that an import two of them share is
        // loaded once.
        const visited = new Set<string>()
        const readable: Array<{ path: string; content: string }> = []
        for (const path of toInject) {
          const loaded = yield* ConfigInstructionFile.load({
            path,
            scope: "project",
            visited,
            patterns,
            home,
            fs,
            leads: trust.leads,
            allow: (real, spelling) => trust.importable(spelling, real),
            // An import that is already in the conversation, or that a read in flight is loading, is not loaded again.
            claim: Effect.fnUntraced(function* (real: string) {
              const taken = yield* Ref.modify(inFlight, (map) => {
                const existing = map.get(input.sessionID) ?? new Set<string>()
                if (existing.has(real)) return [false, map]
                const next = new Map(map)
                next.set(input.sessionID, new Set([...existing, real]))
                return [true, next]
              })
              if (!taken) return false
              imported.push(real)
              // The conversation is asked after the claim is made: a read that finished in between has released its claim
              // only after its message was committed, so one of the two answers is always no.
              // A history that cannot be read leaves the import out, which only costs the import.
              return yield* previouslyInjected(store, input.sessionID).pipe(
                Effect.map((injected) => !injected.has(real)),
                Effect.orElseSucceed(() => false),
              )
            }),
          })
          if (loaded === undefined) continue
          for (const item of loaded.skipped)
            yield* Effect.logDebug("instruction import skipped", {
              path: item.importer,
              target: item.target,
              reason: "outside the project",
            })
          readable.push(...loaded.files)
        }
        if (readable.length === 0) return
        // Publish directly rather than through Session.synthetic: a Location-scoped layer
        // cannot depend on Session (it routes through LocationServiceMap, forming a type
        // cycle with this node). The durable publish commits the synthetic and its metadata
        // ledger atomically, so releasing the claim afterwards cannot readmit the paths.
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          text: readable.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n"),
          description: `Loaded ${readable.map((file) => describePath(root, file.path)).join(", ")}`,
          metadata: { instruction: { paths: readable.map((file) => file.path) } },
        })
      }).pipe(
        Effect.ensuring(
          Ref.update(inFlight, (map) => {
            const existing = map.get(input.sessionID)
            if (!existing) return map
            const remaining = new Set([...existing].filter((path) => !claimed.includes(path) && !imported.includes(path)))
            const next = new Map(map)
            if (remaining.size === 0) next.delete(input.sessionID)
            else next.set(input.sessionID, remaining)
            return next
          }),
        ),
      )
    })

    return Service.of({ load })
  }),
)

function previouslyInjected(store: SessionStore.Interface, sessionID: SessionSchema.ID) {
  return Effect.gen(function* () {
    const history = yield* store.context(sessionID)
    return new Set(
      history
        .filter((message): message is SessionMessage.Synthetic => message.type === "synthetic")
        .flatMap(
          (message) =>
            Option.getOrUndefined(Schema.decodeUnknownOption(InjectedMetadata)(message.metadata))?.instruction.paths ??
            [],
        ),
    )
  })
}

// Paths are normally discovered under the project root, so the description shows them
// relative to it. A directly-loaded path outside the root falls back to its absolute form
// rather than emitting `../..` chains.
function describePath(root: string, path: string) {
  return FSUtil.contains(root, path) ? relative(root, path) : path
}

export const node = makeLocationNode({
  name: "session-instructions",
  layer,
  deps: [Bus.node, Config.node, FSUtil.node, Global.node, Location.node, ProjectTrust.node, SessionStore.node],
})
