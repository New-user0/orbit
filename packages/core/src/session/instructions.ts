export * as SessionInstructions from "./instructions.js"

import { relative } from "path"
import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "../bus.js"
import { FSUtil } from "@orbit/util/fs-util"
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
    // Resolved once for the Location layer; the synthetic text and dedup ledger keep
    // absolute paths, but the human-facing description shows paths relative to the project
    // root so opening a subdirectory still describes paths from the project root.
    const root = yield* fs.resolve(location.project.directory)
    // Same-step parallel reads settle concurrently, so an in-memory claim guards each
    // Session/path pair while a load is in flight. The claim is released once the load
    // settles: the synthetic message metadata scanned below is the only lasting ledger,
    // so paths whose synthetics drop out of model-visible history (compaction, revert)
    // are re-discovered and re-injected instead of staying silently lost.
    const inFlight = yield* Ref.make<Map<SessionSchema.ID, Set<string>>>(new Map())
    // Files already reported as skipped, so that one the model's reads keep finding is reported once.
    const skipped = new Set<string>()

    // Until the project is trusted it supplies only what is inside it. The paths here are real, so a file that a link in
    // the repository points at, such as a key or a credentials file, is left out before it can go into the conversation.
    const reachable = Effect.fnUntraced(function* (path: string) {
      if (yield* trust.reachable(path)) return true
      if (skipped.has(path)) return false
      skipped.add(path)
      yield* Effect.logWarning("instruction file skipped", {
        path,
        reason: "outside the project, which is not trusted",
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
        // The model reads each file as the session start does (`ConfigInstructionFile`). Injecting it is not a read as the
        // edit tools count it: the ledger is not told, so changing the file still needs a real read of it. A file that is
        // excluded, or has nothing left once processed, is not recorded either, and the next read looks at it again. Only
        // the files loaded at the start are flagged for their size, so no warning is made here.
        const files = yield* Effect.forEach(
          toInject,
          (path) =>
            fs.readFileStringSafe(path).pipe(
              Effect.map((text) =>
                text === undefined
                  ? undefined
                  : { path, content: ConfigInstructionFile.parse(text, { frontmatter: true }).content },
              ),
            ),
          { concurrency: "unbounded" },
        )
        const readable = files.filter(
          (file): file is { path: string; content: string } => file !== undefined && file.content.trim() !== "",
        )
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
            const remaining = new Set([...existing].filter((path) => !claimed.includes(path)))
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
  deps: [Bus.node, Config.node, FSUtil.node, Location.node, ProjectTrust.node, SessionStore.node],
})
