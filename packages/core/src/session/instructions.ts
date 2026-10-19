export * as SessionInstructions from "./instructions.js"

import { join, relative } from "path"
import { Cause, Context, Effect, Layer, Option, Ref, Schema } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { Bus } from "../bus.js"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { LinkShare } from "@orbit/util/link-share"
import { Config } from "../config.js"
import { ConfigInstructionFile } from "../config/instruction-file.js"
import { Location } from "../location.js"
import { ProjectTrust } from "../project-trust.js"
import { ReminderText } from "./reminder-text.js"
import { SessionEvent } from "./event.js"
import { MessageDecodeError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

const InjectedMetadata = Schema.Struct({
  instruction: Schema.Struct({ paths: Schema.Array(Schema.String) }),
})

/**
 * A file to hand to the model, as a real path, and where it comes from. The scope picks the gate it passes just before it is
 * read: a project's file must lead inside the folders the session may load instruction files from, trusted or not, while a
 * file of the person's or of an administrator's is their own and is refused only when it names a network share.
 */
export interface Entry {
  readonly path: string
  readonly scope: "managed" | "user" | "project"
  /**
   * Set for a rule that waits for a matching read: the model is told which files it is about, and the files it imports are
   * not sent, because the ones without patterns of their own are already part of the baseline.
   */
  readonly patterns?: readonly string[]
  /**
   * The folder a rule that waits for a read is matched from, set for a project rule so that injecting it asks again what
   * the start of the session asked, even for a folder above the folders the session may import from.
   */
  readonly base?: string
  /** The file is in a rules folder, so a file it imports that has patterns of its own waits for a read of its own. */
  readonly rule?: boolean
}

export interface Interface {
  readonly load: (input: {
    readonly sessionID: SessionSchema.ID
    readonly entries: ReadonlyArray<Entry>
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
    const reachable = Effect.fnUntraced(function* (path: string, base?: string) {
      // A file that was found as a real path may have been replaced by a link since, so the guard is asked of where it leads now.
      const lead = yield* trust.leads(path)
      if (yield* trust.importable(path, lead)) return true
      // A rule in a folder above the project (never one inside it, whose link out stays refused) passed `reachable` and
      // `supplies` when the session started. It is asked the same
      // again of where it leads now, and it must still be the file that was found: a swapped link is not that rule.
      if (
        base !== undefined &&
        !FSUtil.contains(root, base) &&
        FSUtil.contains(path, lead) &&
        FSUtil.contains(lead, path) &&
        (yield* trust.reachable(lead)) &&
        (yield* trust.supplies({ path: join(base, ".orbit"), scope: "project", trusted: false }, lead))
      )
        return true
      if (skipped.has(path)) return false
      skipped.add(path)
      yield* Effect.logWarning("instruction file skipped", {
        path,
        reason: "leads outside the folders the session may load instruction files from",
      })
      return false
    })

    // A file of the person's or of an administrator's is theirs, so the project's guard says nothing about it. What it
    // must not do is reach a network share, or links that were never followed to their end: that is refused before any disk
    // access, and a link that leads to one is named as the share without being opened.
    const owned = Effect.fnUntraced(function* (path: string) {
      const real = yield* trust.leads(path)
      if (!/^[\\/]{2}/.test(real) && !LinkShare.isUnresolved(real)) return true
      yield* Effect.logWarning("instruction file skipped", { path, reason: "a network path" })
      return false
    })

    const load = Effect.fn("SessionInstructions.load")(function* (input: Parameters<Interface["load"]>[0]) {
      const entries = new Map<string, Entry>()
      for (const entry of input.entries) if (!entries.has(entry.path)) entries.set(entry.path, entry)
      const claimed = yield* Ref.modify(inFlight, (map) => {
        const existing = map.get(input.sessionID) ?? new Set<string>()
        const newlyClaimed = [...entries.keys()].filter((path) => !existing.has(path))
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
          (path) => {
            const scope = entries.get(path)!.scope
            // No pattern of `instructions_exclude` applies to the administrator's files.
            if (scope !== "managed" && ConfigInstructionFile.excluded(patterns, [path]))
              return Effect.logDebug("instruction file excluded", { path }).pipe(Effect.as(false))
            return scope === "project" ? reachable(path, entries.get(path)!.base) : owned(path)
          },
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
        const readable: Array<{ path: string; content: string; patterns?: readonly string[] }> = []
        for (const path of toInject) {
          const entry = entries.get(path)!
          const loaded = yield* ConfigInstructionFile.load({
            path: yield* trust.leads(path),
            scope: entry.scope === "user" ? "user" : "project",
            visited,
            patterns: entry.scope === "managed" ? [] : patterns,
            home,
            fs,
            leads: trust.leads,
            // A rule that waits for a read brings no imports: the plain ones are in the baseline already.
            imports: entry.patterns === undefined,
            rules: entry.rule === true || entry.patterns !== undefined,
            allow: (real, spelling) => trust.importable(spelling, real),
            // What an administrator's file imports from outside the project waits for the project to be trusted.
            ...(entry.scope === "managed"
              ? {
                  outward: () =>
                    trust.trusted().pipe(Effect.map((open) => ({ open, directory: location.project.canonical }))),
                }
              : {}),
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
          }).pipe(
            // One file that cannot be read, such as one another program holds open, costs only itself: the others of this
            // read are still handed over, and the next read looks at it again.
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("instruction file not loaded", { path, cause }).pipe(Effect.as(undefined)),
            ),
          )
          if (loaded === undefined) continue
          for (const item of loaded.skipped)
            yield* Effect.logDebug("instruction import skipped", {
              path: item.importer,
              target: item.target,
              reason: "outside the project",
            })
          // A file that waits for a read of its own is not part of this one: its imports with patterns are left to it.
          readable.push(
            ...loaded.files.flatMap((file) =>
              file.importedBy !== undefined && file.patterns !== undefined
                ? []
                : [
                    {
                      path: file.path,
                      content: file.content,
                      ...(file.importedBy === undefined && entry.patterns !== undefined ? { patterns: entry.patterns } : {}),
                    },
                  ],
            ),
          )
        }
        if (readable.length === 0) return
        // Publish directly rather than through Session.synthetic: a Location-scoped layer
        // cannot depend on Session (it routes through LocationServiceMap, forming a type
        // cycle with this node). The durable publish commits the synthetic and its metadata
        // ledger atomically, so releasing the claim afterwards cannot readmit the paths.
        yield* bus.publish(SessionEvent.Synthetic, {
          sessionID: input.sessionID,
          text: readable.map((file) => `${heading(file)}\n${file.content}`).join("\n\n"),
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

// The line above a file. A rule that waited for a read says which files it is about and why it arrived now. The patterns are
// the repository's, so they are flattened to one line and an envelope look-alike in them is escaped.
function heading(file: { readonly path: string; readonly patterns?: readonly string[] }) {
  if (file.patterns === undefined) return `Instructions from: ${file.path}`
  return `Instructions from: ${file.path} (a rule for files matching ${ReminderText.oneLine(file.patterns.join(", "))}, loaded because a file it covers was read)`
}

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
