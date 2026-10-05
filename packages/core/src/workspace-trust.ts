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

/** Where grants that outlive the process are kept: `trust/<key>`. */
const prefix = "trust/"

const decodeGrant = Schema.decodeUnknownOption(Trust.Grant)

/** What the store knows about a folder. The files that hold something back are the Location's to report. */
export type State = Omit<Trust.Status, "withheld">

export interface Interface {
  /** Whether the folder is trusted now, and why. Never waits for a person: it reads at most one stored grant. */
  readonly status: (root: string) => Effect.Effect<State>
  /**
   * Trusts the folder and publishes `trust.updated`. The grant is stored on disk only when `persist` is set and the
   * folder is neither the home directory nor a filesystem root, which are trusted until the serving process restarts.
   */
  readonly grant: (root: string, input: { readonly persist: boolean; readonly via: string }) => Effect.Effect<State>
  /** Ends every grant for the folder and publishes `trust.updated`. A server with implicit trust keeps trusting it. */
  readonly revoke: (root: string) => Effect.Effect<State>
  /** The grants stored on disk, ordered by key. Grants that last until the process restarts are not listed. */
  readonly list: () => Effect.Effect<readonly Trust.Grant[]>
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
      const home = key(yield* fs.resolve(global.home))

      // A folder's shown path and its key, from the same real path, so the key never depends on how it was spelled.
      const identify = Effect.fnUntraced(function* (root: string) {
        const directory = AbsolutePath.make(FSUtil.normalizePath(yield* fs.resolve(root)))
        const id = key(directory)
        // The home directory and filesystem roots hold everything below them, so no stored grant ever covers them.
        return { directory, id, persistent: id !== home && path.dirname(id) !== id }
      })

      const status = Effect.fn("WorkspaceTrust.status")(function* (root: string) {
        const folder = yield* identify(root)
        const saved = folder.persistent && Option.isSome(decodeGrant(yield* kv.get(prefix + folder.id)))
        const source: Trust.Source | undefined = saved
          ? "saved"
          : session.has(folder.id)
            ? "session"
            : implicit && folder.persistent
              ? "implicit"
              : undefined
        return {
          directory: folder.directory,
          trusted: source !== undefined,
          persistent: folder.persistent,
          ...(source === undefined ? {} : { source }),
        } satisfies State
      })

      const grant = Effect.fn("WorkspaceTrust.grant")(function* (
        root: string,
        input: { readonly persist: boolean; readonly via: string },
      ) {
        const folder = yield* identify(root)
        if (input.persist && folder.persistent) {
          yield* kv.set(prefix + folder.id, {
            directory: folder.directory,
            time: yield* Clock.currentTimeMillis,
            via: input.via,
          })
          session.delete(folder.id)
        } else session.add(folder.id)
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

      return Service.of({ status, grant, revoke, list: Effect.fn("WorkspaceTrust.list")(() => page()) })
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
