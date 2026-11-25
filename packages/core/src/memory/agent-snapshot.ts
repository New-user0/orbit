export * as MemoryAgentSnapshot from "./agent-snapshot.js"

import path from "path"
import { Cause, Context, Effect, Layer, Option, Schema, Semaphore, Stream } from "effect"
import { ConfigAgent } from "@orbit/schema/config/agent"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { ProjectTrust } from "../project-trust.js"
import { MemoryAgent } from "./agent.js"
import { MemoryStore } from "./store.js"

/**
 * Agent memory snapshots: a project may ship what a user-scope agent should start out knowing, in
 * `.orbit/agent-memory-snapshots/<id>/` with a `snapshot.json` that says when it was taken. An agent whose own folder
 * holds no Markdown file gets the snapshot's files copied in, with `.snapshot-synced.json` naming the snapshot; a folder
 * that holds one is the person's memory and is kept, as the reference keeps it. The copy runs once per list of agents,
 * the first time memory is needed in the Location (an agent block, `/memory`), and again after the agents change.
 *
 * The snapshot is the repository's and the target is the person's own folder, which every project shares, so nothing of
 * the snapshot is read while memory is off or before the project is trusted (class 1); its folders are `MemoryAgent`'s
 * checked values (links and shares, classes 4 and 6); only a plain file with a plain name is copied, read at a real path
 * inside its folder and never written through a link (classes 4 and 5); and a bad snapshot or file costs only itself,
 * with one line in the log (class 7). The copy is bounded by the reference's own limits on what it puts in a memory
 * folder: no file over `MAX_FILE_BYTES` and at most `MemoryStore.MAX_SCAN_FILES` files, the first by name (class 7).
 */

export interface Interface {
  /** Copies the snapshots that are due, once per list of agents. It never fails. */
  readonly sync: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/MemoryAgentSnapshot") {}

const META = "snapshot.json"
const SYNCED = ".snapshot-synced.json"
// The largest file copied, as the reference's team memory pull leaves out an entry over this size.
export const MAX_FILE_BYTES = 250_000

// The reference's shape: a non-empty `updatedAt`; other keys are ignored.
const decodeMeta = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ updatedAt: Schema.NonEmptyString })),
)

// The scopes of the config documents whose agents correspond to the reference's agent files: the person's, the
// project's, the local file's and the administrator's. A `--agents` or well-known agent, a built-in and a plugin's agent
// are left out, as the reference leaves out its JSON, built-in and plugin agents (class 8).
const SOURCES = new Set(["user", "project", "local", "managed"])

const isUpdated = Schema.is(Agent.Event.Updated)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const memoryAgent = yield* MemoryAgent.Service
    const store = yield* MemoryStore.Service
    const fs = yield* FSUtil.Service
    const trust = yield* ProjectTrust.Service
    const bus = yield* Bus.Service

    // A change to the agents moves the generation, which arms the next sync, as the reference's load runs again once
    // its agent cache is cleared. The listener runs inside the publish, so the next sync after a change sees it.
    const state = { generation: 0, done: -1 }
    const unsubscribe = yield* bus.listen((event) =>
      isUpdated(event) ? Effect.sync(() => void state.generation++) : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    const lock = Semaphore.makeUnsafe(1)

    const copy = Effect.fnUntraced(function* (id: string) {
      const source = yield* memoryAgent.snapshot(id)
      if (source === undefined) return
      // Not there is the usual case: most agents have no snapshot, and nothing is logged for them.
      if (!(yield* fs.isDir(source.real))) return
      const entries = yield* fs.readDirectoryEntries(source.real)
      if (!entries.some((entry) => entry.name === META)) return
      const updatedAt = yield* readMeta(fs, source.real)
      if (updatedAt === undefined)
        return yield* Effect.logWarning(`agent memory snapshot of ${id} not read: its ${META} is not valid`)
      const target = yield* memoryAgent.folder(id, "user")
      if (target === undefined) return
      const present = yield* fs.isDir(target.real)
      const held = present ? yield* fs.readDirectoryEntries(target.real) : []
      // A Markdown file in the folder means the person's memory, which is kept as it is.
      if (held.some((entry) => entry.type === "file" && entry.name.endsWith(".md"))) return
      // On Windows a folder renamed onto a file replaces it, so whatever else holds the folder's name stays as it is.
      if (!present && (yield* fs.exists(target.real))) return yield* Effect.fail("its folder's name is taken")
      // Only a plain name is copied (class 5), and at most the first `MAX_SCAN_FILES` of them by name, so the cut is the
      // same on every machine; a checkout's file times order nothing. The rest are left out with one line (class 7).
      const candidates = entries.filter((entry) => entry.type === "file" && entry.name !== META)
      yield* Effect.forEach(
        candidates.filter((entry) => !ConfigAgent.isName(entry.name)),
        (entry) =>
          Effect.logWarning("agent memory snapshot file skipped: its name is not a plain name", { name: entry.name }),
        { discard: true },
      )
      const named = candidates.map((entry) => entry.name).filter((name) => ConfigAgent.isName(name))
      const kept = named.toSorted().slice(0, MemoryStore.MAX_SCAN_FILES)
      if (kept.length < named.length)
        yield* Effect.logWarning(
          `agent memory snapshot of ${id}: ${named.length - kept.length} files left out, past the first ${MemoryStore.MAX_SCAN_FILES} by name`,
        )
      // Once the first Markdown file is in, the folder counts as the person's and is never copied into again. So the
      // files are copied into a new folder beside it, where a sync that is stopped leaves nothing but that folder, which
      // is removed; only the move into place, a rename for each file or one for the whole folder, waits (class 7). The
      // folder is made and its removal attached in one step that an interrupt waits for, so none is left behind.
      const parent = path.dirname(target.real)
      yield* fs.makeDirectory(parent, { recursive: true })
      const copied = yield* Effect.acquireUseRelease(
        fs.makeTempDirectory({ directory: parent, prefix: `.${path.basename(target.real)}.snapshot-` }),
        (staging) =>
          Effect.gen(function* () {
            const staged = yield* Effect.forEach(kept, (name) =>
              copyFile(fs, source.real, staging, name).pipe(
                Effect.as(name),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`agent memory snapshot of ${id}: ${name} not copied`, { cause }).pipe(
                    Effect.as(undefined),
                  ),
                ),
              ),
            )
            const names = staged.filter((name) => name !== undefined)
            const marker = JSON.stringify({ syncedFrom: updatedAt })
            const unwritten = (cause: Cause.Cause<unknown>) =>
              Effect.logWarning(`agent memory snapshot of ${id}: ${SYNCED} not written`, { cause })
            // A folder that is not there yet gets the whole copy, marker included, in one rename. An interrupt waits for
            // it, or the removal below would race the rename still running over the same folder.
            if (!present)
              return yield* fs
                .writeFileString(path.join(staging, SYNCED), marker)
                .pipe(
                  Effect.catchCause(unwritten),
                  Effect.andThen(fs.rename(staging, target.real)),
                  Effect.as(names.length),
                  Effect.uninterruptible,
                )
            return yield* Effect.forEach(names, (name) =>
              unlinked(
                fs,
                path.join(target.real, name),
                fs.rename(path.join(staging, name), path.join(target.real, name)),
              ).pipe(
                Effect.as(true),
                Effect.catchCause((cause) =>
                  Effect.logWarning(`agent memory snapshot of ${id}: ${name} not copied`, { cause }).pipe(
                    Effect.as(false),
                  ),
                ),
              ),
            ).pipe(
              Effect.tap(() =>
                unlinked(
                  fs,
                  path.join(target.real, SYNCED),
                  fs.writeFileString(path.join(target.real, SYNCED), marker),
                ).pipe(Effect.catchCause(unwritten)),
              ),
              Effect.map((moved) => moved.filter(Boolean).length),
              Effect.uninterruptible,
            )
          }),
        (staging) => fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore),
      )
      yield* Effect.logInfo(`agent memory snapshot of ${id}: ${copied} files copied`)
    })

    const run = Effect.gen(function* () {
      const due = (yield* agents.list()).filter(
        (agent) =>
          agent.memory === "user" &&
          agent.source !== undefined &&
          SOURCES.has(agent.source.scope) &&
          agent.source.plugin === undefined,
      )
      // Each agent goes on its own: one that fails costs only its own snapshot (class 7).
      yield* Effect.forEach(
        due,
        (agent) =>
          copy(agent.id).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`agent memory snapshot of ${agent.id} not copied`, { cause }),
            ),
          ),
        { discard: true },
      )
    })

    const sync = Effect.fn("MemoryAgentSnapshot.sync")(function* () {
      // Read nothing while memory is off or before the project is trusted; that does not count as the run (class 1).
      if (!(yield* store.enabled())) return
      if (!(yield* trust.trusted())) return
      // Calls at once wait for the one run; a later call returns at once until the agents change.
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          if (state.done === state.generation) return
          const generation = state.generation
          yield* run
          state.done = generation
        }),
      )
    })

    return Service.of({ sync })
  }),
)

// The time of the snapshot, read at its real path inside the snapshot folder (class 4), or undefined when it is not a
// file there or is not valid.
const readMeta = (fs: FSUtil.Interface, folder: string) =>
  Effect.gen(function* () {
    const real = yield* MemoryStore.locate(fs, folder, path.join(folder, META))
    if (real === undefined) return undefined
    const text = yield* fs.readFileString(real).pipe(Effect.orElseSucceed(() => ""))
    return Option.getOrUndefined(decodeMeta(text))?.updatedAt
  })

// Copies one file of the snapshot, by its plain name, into the new folder. It is read at its real path inside the
// snapshot folder (class 4), and its size is decided from what that read returns: at most one byte past the limit is
// read, so a file that grows meanwhile is bounded too (class 7).
const copyFile = (fs: FSUtil.Interface, from: string, to: string, name: string) =>
  Effect.gen(function* () {
    const real = yield* MemoryStore.locate(fs, from, path.join(from, name))
    if (real === undefined) return yield* Effect.fail("it is not a file in the snapshot folder")
    const bytes = yield* Stream.mkUint8Array(fs.stream(real, { bytesToRead: MAX_FILE_BYTES + 1 }))
    if (bytes.length > MAX_FILE_BYTES) return yield* Effect.fail(`it is over ${MAX_FILE_BYTES} bytes`)
    yield* fs.writeFile(path.join(to, name), bytes)
  })

// Puts `file` in place unless a link of any kind is at its name, one that leads nowhere included, so nothing is written
// through it (class 4).
const unlinked = <E>(fs: FSUtil.Interface, file: string, put: Effect.Effect<void, E>) =>
  Effect.gen(function* () {
    if (yield* Effect.isSuccess(fs.readLink(file))) return yield* Effect.fail("a link is at its name")
    yield* put
  })

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Agent.node, MemoryAgent.node, MemoryStore.node, FSUtil.node, ProjectTrust.node, Bus.node],
})
