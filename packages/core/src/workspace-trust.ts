export * as WorkspaceTrust from "./workspace-trust.js"

import path from "path"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Trust } from "@orbit/schema/trust"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Hash } from "@orbit/util/hash"
import { Bus } from "./bus.js"
import { KV } from "./kv.js"
import { AbsolutePath } from "./schema.js"

/** Where grants that outlive the process are kept: `trust/<key>`. */
const prefix = "trust/"

/** Where what a grant approved is kept: `trust-fingerprint/<key>/<source>`. Not under `trust/`, so `list` never sees it. */
const recordPrefix = "trust-fingerprint/"

const decodeGrant = Schema.decodeUnknownOption(Trust.Grant)

/** What a grant recorded about one source of executable config: the digest of each kind it held then. */
const StoredRecord = Schema.Struct({
  path: Schema.String,
  digests: Schema.Record(Schema.String, Schema.String),
})
const decodeRecord = Schema.decodeUnknownOption(StoredRecord)

/**
 * What a digest says when the file behind it could not be read. It is not a hash, so it equals no record, and a grant
 * does not store it: such a kind counts as changed until it can be read.
 */
export const unreadable = "unreadable"

/** The executable config of one source (a document or a config directory), as the last load of the config read it. */
export interface Observation {
  /** The source as the config lists it, which is what a status shows. */
  readonly path: string
  /** The source's real path, which names its record. */
  readonly identity: string
  /** The digest of each kind the source holds. A kind it holds nothing of has none. */
  readonly digests: Readonly<Partial<Record<Trust.Kind, string>>>
}

/** Where a trusted folder's sources differ from the grant, and the kinds that do. */
export interface Difference {
  readonly path: string
  readonly kinds: readonly Trust.Kind[]
}

/** What the store knows about a folder. The files that hold something back are the Location's to report. */
export type State = Omit<Trust.Status, "withheld" | "changed">

export interface Interface {
  /**
   * Whether the folder is trusted now, and why: a grant of its own, a server that trusts every folder, or a grant for a
   * folder above it (`granted`). Never waits for a person: it reads at most one stored grant per folder on the way up.
   */
  readonly status: (root: string) => Effect.Effect<State>
  /**
   * Trusts the folder and publishes `trust.updated`. The grant is stored on disk only when `persist` is set and the
   * folder is neither the home directory nor a filesystem root, which are trusted until the serving process restarts.
   * `observations` are the sources whose executable config the grant approves: it records them beside the grant, leaves
   * the records of other sources as they are, and drops those of sources that are gone. A grant without them records
   * nothing, so every source reads as changed.
   */
  readonly grant: (
    root: string,
    input: { readonly persist: boolean; readonly via: string; readonly observations?: readonly Observation[] },
  ) => Effect.Effect<State>
  /**
   * Ends every grant for the folder, and the records beside them, and publishes `trust.updated`. A server with implicit
   * trust keeps trusting it, and so does a grant for a folder above it, which the answer names as `granted`.
   */
  readonly revoke: (root: string) => Effect.Effect<State>
  /** The grants stored on disk, ordered by key. Grants that last until the process restarts are not listed. */
  readonly list: () => Effect.Effect<readonly Trust.Grant[]>
  /**
   * Which sources differ from what the folder's grant recorded, and the kinds that do: a source with no record has all
   * the kinds it holds, and otherwise a kind whose digest is not the recorded one. A source that is gone, or a kind it
   * no longer holds, differs in nothing. Nothing differs while the folder is untrusted, which holds everything back
   * anyway, or trusted without a grant, which approves no config in particular.
   */
  readonly compare: (root: string, observations: readonly Observation[]) => Effect.Effect<readonly Difference[]>
  /**
   * Ends the stored grant, and the records, whose folder has this key or is shown as this directory, without needing
   * the folder to exist. Returns the directories it ended, which is none for a folder that was never granted. It only
   * narrows trust, so a lexical match is enough.
   */
  readonly forget: (directory: string) => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/WorkspaceTrust") {}

export interface Options {
  /**
   * Trust every folder except the home directory and filesystem roots, without a grant. Unset, it follows
   * ORBIT_TRUST_PROJECT, which is how tests opt the default node in. The server always passes a value, so a host that
   * does not configure it never follows the environment.
   */
  readonly implicit?: boolean
}

/**
 * The identity of a folder in the trust store. Callers pass a path that is already real. Windows ignores case, so
 * `C:\Repo` and `c:\repo` share one key there, whichever way the folder was reached.
 */
export function key(directory: string, platform: NodeJS.Platform = process.platform) {
  const normalized = FSUtil.normalizePath(directory)
  return platform === "win32" ? normalized.toLowerCase() : normalized
}

export function layer(options?: Options) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const kv = yield* KV.Service
      const bus = yield* Bus.Service
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const implicit = options?.implicit ?? truthy(process.env.ORBIT_TRUST_PROJECT)
      // Grants that last until this process stops, by key.
      const session = new Set<string>()
      // The records of those grants, which are lost with them: by folder key, then by source.
      const memory = new Map<string, Map<string, typeof StoredRecord.Type>>()
      const home = key(yield* fs.resolve(global.home))

      // A folder's shown path and its key, from the same real path, so the key never depends on how it was spelled.
      const identify = Effect.fnUntraced(function* (root: string) {
        const directory = AbsolutePath.make(FSUtil.normalizePath(yield* fs.resolve(root)))
        const id = key(directory)
        // The home directory and filesystem roots hold everything below them, so no stored grant ever covers them.
        return { directory, id, persistent: id !== home && path.dirname(id) !== id }
      })

      const recordKey = (id: string, identity: string) => `${recordPrefix}${id}/${Hash.fast(key(identity))}`

      // The records of one folder. A folder's key holds slashes, so the records of a folder inside it share the prefix:
      // only a key with nothing but the source after the prefix is this folder's own.
      const stored = (id: string): Effect.Effect<readonly KV.Entry[]> => {
        const own = `${recordPrefix}${id}/`
        const page = (after?: string): Effect.Effect<readonly KV.Entry[]> =>
          kv.scan({ prefix: own, after, limit: 1000 }).pipe(
            Effect.flatMap((result) => {
              const entries = result.entries.filter((entry) => !entry.key.slice(own.length).includes("/"))
              if (result.next === undefined) return Effect.succeed(entries)
              return page(result.next).pipe(Effect.map((rest) => [...entries, ...rest]))
            }),
          )
        return page()
      }

      // The grant a folder holds in its own right, by key: one stored on disk, or one for this process.
      const own = Effect.fnUntraced(function* (id: string, persistent: boolean) {
        if (persistent && Option.isSome(decodeGrant(yield* kv.get(prefix + id)))) return "saved" as const
        return session.has(id) ? ("session" as const) : undefined
      })

      // The nearest folder above `directory` whose grant covers it, as the reference's walk up the parents finds one. The
      // home directory and filesystem roots hold everything below them, so their grant covers themselves alone and the
      // walk passes over them (class 3). `directory` is a real path (`real` below), so a link is covered by where it leads
      // (class 4).
      const covering = (
        directory: string,
      ): Effect.Effect<{ readonly directory: AbsolutePath; readonly source: Trust.Source } | undefined> => {
        const parent = path.dirname(directory)
        if (parent === directory) return Effect.succeed(undefined)
        const id = key(parent)
        if (id === home || path.dirname(id) === id) return covering(parent)
        return own(id, true).pipe(
          Effect.flatMap((source) =>
            source === undefined ? covering(parent) : Effect.succeed({ directory: AbsolutePath.make(parent), source }),
          ),
        )
      }

      // Where the walk up the parents starts. `identify` keeps the spelled path of a part that is not there, and a walk up
      // that spelling would let a missing folder below a link be covered by the folder the link sits in (class 4). So the
      // longest part that exists is made real and the rest is added to it. A part that is there but leads nowhere, such
      // as a dangling link, or that cannot be read, gives no start, and only the folder's own grant counts.
      const real = (directory: string): Effect.Effect<string | undefined> =>
        fs.realPath(directory).pipe(
          Effect.catchReason("PlatformError", "NotFound", () =>
            fs.readLink(directory).pipe(
              Effect.as(undefined),
              Effect.catchReason("PlatformError", "NotFound", () => {
                const parent = path.dirname(directory)
                if (parent === directory) return Effect.succeed(undefined)
                return real(parent).pipe(
                  Effect.map((found) => (found === undefined ? undefined : path.join(found, path.basename(directory)))),
                )
              }),
            ),
          ),
          Effect.orElseSucceed(() => undefined),
        )

      const status = Effect.fn("WorkspaceTrust.status")(function* (root: string) {
        const folder = yield* identify(root)
        const mine = yield* own(folder.id, folder.persistent)
        const implied = mine === undefined && implicit && folder.persistent ? ("implicit" as const) : undefined
        const start = mine === undefined && implied === undefined ? yield* real(folder.directory) : undefined
        const cover = start === undefined ? undefined : yield* covering(FSUtil.normalizePath(start))
        const source = mine ?? implied ?? cover?.source
        return {
          directory: folder.directory,
          trusted: source !== undefined,
          persistent: folder.persistent,
          ...(source === undefined ? {} : { source }),
          ...(cover === undefined ? {} : { granted: cover.directory }),
        } satisfies State
      })

      const grant = Effect.fn("WorkspaceTrust.grant")(function* (
        root: string,
        input: { readonly persist: boolean; readonly via: string; readonly observations?: readonly Observation[] },
      ) {
        const folder = yield* identify(root)
        const observations = input.observations ?? []
        const stores = input.persist && folder.persistent
        // What the grant approves. A kind that could not be read is not approved, so it stays changed.
        const approved = observations.map((observation) => ({
          observation,
          record: {
            path: observation.identity,
            digests: Object.fromEntries(
              Object.entries(observation.digests).filter(
                (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== unreadable,
              ),
            ),
          },
        }))
        if (stores) {
          yield* kv.set(prefix + folder.id, {
            directory: folder.directory,
            time: yield* Clock.currentTimeMillis,
            via: input.via,
          })
          session.delete(folder.id)
          memory.delete(folder.id)
          yield* Effect.forEach(
            approved,
            (item) =>
              Object.keys(item.record.digests).length === 0
                ? kv.remove(recordKey(folder.id, item.observation.identity))
                : kv.set(recordKey(folder.id, item.observation.identity), item.record),
            { discard: true },
          )
          // The records of sources that are gone are dropped; those of other sources that exist stay as they are.
          const named = new Set(observations.map((observation) => recordKey(folder.id, observation.identity)))
          yield* Effect.forEach(
            (yield* stored(folder.id)).filter((entry) => !named.has(entry.key)),
            (entry) =>
              Option.match(decodeRecord(entry.value), {
                onNone: () => kv.remove(entry.key),
                onSome: (record) =>
                  fs.exists(record.path).pipe(
                    Effect.orElseSucceed(() => true),
                    Effect.flatMap((there) => (there ? Effect.void : kv.remove(entry.key))),
                  ),
              }),
            { discard: true },
          )
        } else {
          session.add(folder.id)
          const records = memory.get(folder.id) ?? new Map<string, typeof StoredRecord.Type>()
          memory.set(folder.id, records)
          for (const item of approved) {
            const name = recordKey(folder.id, item.observation.identity)
            if (Object.keys(item.record.digests).length === 0) records.delete(name)
            else records.set(name, item.record)
          }
          for (const [name, record] of [...records]) {
            if (!approved.some((item) => recordKey(folder.id, item.observation.identity) === name))
              if (!(yield* fs.exists(record.path).pipe(Effect.orElseSucceed(() => true)))) records.delete(name)
          }
        }
        yield* bus.publish(Trust.Event.Updated, { directory: folder.directory, trusted: true }, { global: true })
        return yield* status(root)
      })

      const removeRecords = Effect.fnUntraced(function* (id: string) {
        memory.delete(id)
        yield* Effect.forEach(yield* stored(id), (entry) => kv.remove(entry.key), { discard: true })
      })

      const revoke = Effect.fn("WorkspaceTrust.revoke")(function* (root: string) {
        const folder = yield* identify(root)
        yield* kv.remove(prefix + folder.id)
        session.delete(folder.id)
        yield* removeRecords(folder.id)
        const result = yield* status(root)
        yield* bus.publish(
          Trust.Event.Updated,
          { directory: folder.directory, trusted: result.trusted },
          { global: true },
        )
        return result
      })

      const page = (after?: string): Effect.Effect<readonly Trust.Grant[]> =>
        kv.scan({ prefix, after, limit: 1000 }).pipe(
          Effect.flatMap((result) => {
            const grants = result.entries.flatMap((entry) => Option.toArray(decodeGrant(entry.value)))
            if (result.next === undefined) return Effect.succeed(grants)
            return page(result.next).pipe(Effect.map((rest) => [...grants, ...rest]))
          }),
        )

      const compare = Effect.fn("WorkspaceTrust.compare")(function* (
        root: string,
        observations: readonly Observation[],
      ) {
        const folder = yield* identify(root)
        const state = yield* status(root)
        // A server that trusts every folder compares nothing, even for a folder that also has a saved grant: revoking
        // that grant would otherwise turn withholding on for a server that is configured to trust everything.
        if (!state.trusted || (implicit && folder.persistent)) return []
        // The records are those of the folder whose grant applies, which is a folder above this one when it covers it.
        const holder = state.granted === undefined ? folder.id : key(state.granted)
        const records = session.has(holder) ? memory.get(holder) : undefined
        const differences = yield* Effect.forEach(observations, (observation) =>
          Effect.gen(function* () {
            const name = recordKey(holder, observation.identity)
            const record = Option.getOrUndefined(
              decodeRecord(records === undefined ? yield* kv.get(name) : records.get(name)),
            )
            const kinds = Trust.Kinds.filter((kind) => {
              const digest = observation.digests[kind]
              if (digest === undefined) return false
              return digest === unreadable || record?.digests[kind] !== digest
            })
            return kinds.length === 0 ? [] : [{ path: observation.path, kinds }]
          }),
        )
        return differences.flat()
      })

      const forget = Effect.fn("WorkspaceTrust.forget")(function* (directory: string) {
        const wanted = key(path.resolve(directory))
        const ended = (yield* page()).filter((item) => key(item.directory) === wanted || item.directory === directory)
        yield* Effect.forEach(
          ended,
          (item) =>
            Effect.gen(function* () {
              const id = key(item.directory)
              yield* kv.remove(prefix + id)
              session.delete(id)
              yield* removeRecords(id)
              yield* bus.publish(Trust.Event.Updated, { directory: item.directory, trusted: false }, { global: true })
            }),
          { discard: true },
        )
        return ended.map((item) => item.directory)
      })

      return Service.of({
        status,
        grant,
        revoke,
        list: Effect.fn("WorkspaceTrust.list")(() => page()),
        compare,
        forget,
      })
    }),
  )
}

export function configured(options?: Options) {
  return makeGlobalNode({
    service: Service,
    layer: layer(options),
    deps: [KV.node, Bus.node, FSUtil.node, Global.node],
  })
}

export const node = configured()

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}
