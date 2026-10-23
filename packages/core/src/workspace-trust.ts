export * as WorkspaceTrust from "./workspace-trust.js"

import path from "path"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Trust } from "@orbit/schema/trust"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Bus } from "./bus.js"
import { KV } from "./kv.js"
import { AbsolutePath } from "./schema.js"

/**
 * Where grants that outlive the process are kept: `trust/<key>`. An older Orbit also kept records of what each grant
 * approved under `trust-fingerprint/`; nothing reads those rows any more, and they are left in place.
 */
const prefix = "trust/"

const decodeGrant = Schema.decodeUnknownOption(Trust.Grant)

/** What the store knows about a folder. The files that hold something back are the Location's to report. */
export type State = Omit<Trust.Status, "withheld">

export interface Interface {
  /**
   * Whether the folder is trusted now, and why: a grant of its own, a server that trusts every folder, or a grant for a
   * folder above it (`granted`). Never waits for a person: it reads at most one stored grant per folder on the way up.
   */
  readonly status: (root: string) => Effect.Effect<State>
  /**
   * Trusts the folder and publishes `trust.updated`. The grant is stored on disk only when `persist` is set and the
   * folder is neither the home directory nor a filesystem root, which are trusted until the serving process restarts.
   * Nothing about the folder's config is recorded: a trusted folder's config loads as it is whenever it is read (D8).
   */
  readonly grant: (root: string, input: { readonly persist: boolean; readonly via: string }) => Effect.Effect<State>
  /**
   * Ends every grant for the folder and publishes `trust.updated`. A server with implicit trust keeps trusting it, and
   * so does a grant for a folder above it, which the answer names as `granted`.
   */
  readonly revoke: (root: string) => Effect.Effect<State>
  /** The grants stored on disk, ordered by key. Grants that last until the process restarts are not listed. */
  readonly list: () => Effect.Effect<readonly Trust.Grant[]>
  /**
   * Ends the stored grant whose folder has this key or is shown as this directory, without needing the folder to exist.
   * Returns the directories it ended, which is none for a folder that was never granted. It only narrows trust, so a
   * lexical match is enough.
   */
  readonly forget: (directory: string) => Effect.Effect<readonly string[]>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/WorkspaceTrust") {}

/**
 * Work was asked for in a folder that is not trusted, through a door that no server route stands in front of, such as a
 * plugin's (trust-first, class 12). It names the folder whose grant would let the work through.
 */
export class UntrustedError extends Schema.TaggedError<UntrustedError>()("WorkspaceTrust.UntrustedError", {
  directory: AbsolutePath,
  persistent: Schema.Boolean,
}) {}

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
      const home = key(yield* fs.resolve(global.home))

      // A folder's shown path and its key, from the same real path, so the key never depends on how it was spelled.
      const identify = Effect.fnUntraced(function* (root: string) {
        const directory = AbsolutePath.make(FSUtil.normalizePath(yield* fs.resolve(root)))
        const id = key(directory)
        // The home directory and filesystem roots hold everything below them, so no stored grant ever covers them.
        return { directory, id, persistent: id !== home && path.dirname(id) !== id }
      })

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
        input: { readonly persist: boolean; readonly via: string },
      ) {
        const folder = yield* identify(root)
        const stores = input.persist && folder.persistent
        if (stores)
          yield* kv.set(prefix + folder.id, {
            directory: folder.directory,
            time: yield* Clock.currentTimeMillis,
            via: input.via,
          })
        if (stores) session.delete(folder.id)
        if (!stores) session.add(folder.id)
        yield* bus.publish(Trust.Event.Updated, { directory: folder.directory, trusted: true }, { global: true })
        return yield* status(root)
      })

      const revoke = Effect.fn("WorkspaceTrust.revoke")(function* (root: string) {
        const folder = yield* identify(root)
        yield* kv.remove(prefix + folder.id)
        session.delete(folder.id)
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
