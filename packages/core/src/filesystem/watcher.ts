export * as Watcher from "./watcher.js"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper.js"
import type ParcelWatcher from "@parcel/watcher"
import { FileSystem } from "@orbit/schema/filesystem"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Cause, Context, Effect, Layer, PubSub, RcMap, Schema, Stream } from "effect"
import { lazy } from "../util/lazy.js"
import { statSync, watch } from "node:fs"
import path from "path"
import loadBinding from "./watcher-binding.js"

const SUBSCRIBE_TIMEOUT_MS = 10_000
export const Event = { Updated: FileSystem.Event.Changed }

/** The Parcel binding, loaded on first use; undefined where it cannot load. */
export const binding = lazy((): typeof ParcelWatcher | undefined => {
  try {
    return createWrapper(loadBinding()) as typeof ParcelWatcher
  } catch {
    return
  }
})

/** The Parcel backend of this platform. */
export function backend() {
  if (process.platform === "win32") return "windows"
  if (process.platform === "darwin") return "fs-events"
  if (process.platform === "linux") return "inotify"
}

export const hasNativeBinding = () => !!binding()
export type Update = ParcelWatcher.Event

export type WatchInput =
  | { readonly path: string; readonly type: "file" }
  | { readonly path: string; readonly type: "entries"; readonly names: readonly string[] }
  | { readonly path: string; readonly type: "directory"; readonly ignore?: readonly string[] }

export type Subscription = {
  readonly unsubscribe: () => Promise<void>
  /** Backend name for logging, e.g. "node" or "fs-events". */
  readonly backend?: string
}

type Target = {
  readonly target: string
  readonly ignore: readonly string[]
} & (
  | { readonly type: "entries"; readonly names: readonly string[] }
  | { readonly type: "file" | "directory"; readonly names?: readonly string[] }
)

export interface NativeInterface {
  readonly subscribe: (
    input: Target & { readonly publish: (update: Update) => void },
  ) => Effect.Effect<Subscription | undefined>
}

/** Uses fs.watch for immediate entries and Parcel for recursive directories. */
export class Native extends Context.Service<Native, NativeInterface>()("@orbit/Watcher/Native") {}

export interface Interface {
  /** onReady runs after native acquisition and listener registration, when the stream is consumed. */
  readonly subscribe: (input: WatchInput, onReady?: Effect.Effect<void>) => Effect.Effect<Stream.Stream<Update>>
}

export const Options = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@orbit/Watcher") {}

export interface TestInterface extends Interface {
  /** Delivers one update to every active watch whose target covers `update.path`. */
  readonly emit: (update: Update) => Effect.Effect<void>
  /** Returns every subscribe call observed so far, in order. */
  readonly subscriptions: () => Effect.Effect<readonly WatchInput[]>
}

export class Test extends Context.Service<Test, TestInterface>()("@orbit/Watcher/Test") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (options?.enabled === false) {
        return Service.of({ subscribe: () => Effect.succeed(Stream.empty) })
      }
      const native = yield* Native

      // Keys compare structurally (effect Equal), so equivalent watches share one entry.
      const watchers = yield* RcMap.make({
        lookup: (key: Target) =>
          Effect.gen(function* () {
            const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Update>(), (pubsub) => PubSub.shutdown(pubsub))
            const subscription = yield* Effect.acquireRelease(
              native.subscribe({
                ...key,
                publish: (update) => PubSub.publishUnsafe(pubsub, update),
              }),
              (subscription) =>
                subscription
                  ? Effect.promise(() => subscription.unsubscribe()).pipe(
                      Effect.ignoreCause,
                      Effect.andThen(Effect.logInfo("watcher stopped", { path: key.target, type: key.type })),
                    )
                  : Effect.void,
              // Native subscription may stay pending up to SUBSCRIBE_TIMEOUT_MS;
              // scope shutdown must not wait behind an uninterruptible acquisition.
              { interruptible: true },
            )
            if (!subscription) {
              // Unsupported backend: end subscriber streams instead of hanging them.
              yield* PubSub.shutdown(pubsub)
              return pubsub
            }
            yield* Effect.logInfo("watcher started", {
              path: key.target,
              type: key.type,
              backend: subscription.backend,
              ignores: key.ignore.length,
            })
            return pubsub
          }),
      })

      const subscribe = Effect.fnUntraced(function* (input: WatchInput, onReady: Effect.Effect<void> = Effect.void) {
        const target = path.resolve(input.path)
        const ignore = [...new Set(input.type === "directory" ? (input.ignore ?? []) : [])].toSorted()
        const names = [...new Set(input.type === "entries" ? input.names : [])].toSorted()
        yield* Effect.logInfo("watcher subscribe", {
          path: target,
          type: input.type,
          ignores: ignore.length,
        })
        return Stream.unwrap(
          Effect.gen(function* () {
            const pubsub = yield* RcMap.get(watchers, { type: input.type, target, ignore, names })
            const subscription = yield* PubSub.subscribe(pubsub)
            if (yield* PubSub.isShutdown(pubsub)) return Stream.empty
            yield* onReady
            return Stream.fromSubscription(subscription)
          }),
        )
      })

      return Service.of({ subscribe })
    }),
  )

/** Real subscription lifecycle with in-memory, path-filtered event delivery. */
export const testLayer = Layer.effectContext(
  Effect.gen(function* () {
    const subscriptions: WatchInput[] = []
    const active = new Map<(update: Update) => void, (path: string) => boolean>()
    const native = Native.of({
      subscribe: (input) =>
        Effect.sync(() => {
          subscriptions.push(
            input.type === "file"
              ? { path: input.target, type: "file" }
              : input.type === "entries"
                ? { path: input.target, type: "entries", names: input.names }
                : input.ignore.length > 0
                  ? { path: input.target, type: "directory", ignore: input.ignore }
                  : { path: input.target, type: "directory" },
          )
          // Ignore entries resolve against the target like the parcel wrapper's
          // literal paths. Glob entries resolve to paths nothing lives under, so
          // they are inert here rather than compiled the way parcel compiles them.
          const ignored = input.ignore.map((entry) => path.resolve(input.target, entry))
          active.set(input.publish, (target) => {
            if (input.type === "file") return target === input.target
            if (input.type === "entries")
              return path.dirname(target) === input.target && input.names.includes(path.basename(target))
            return FSUtil.contains(input.target, target) && !ignored.some((entry) => FSUtil.contains(entry, target))
          })
          return {
            unsubscribe: () => {
              active.delete(input.publish)
              return Promise.resolve()
            },
          }
        }),
    })
    const context = yield* Layer.build(layer().pipe(Layer.provide(Layer.succeed(Native, native))))
    const test = Test.of({
      subscribe: Context.get(context, Service).subscribe,
      emit: (update) =>
        Effect.sync(() => {
          const target = path.resolve(update.path)
          active.forEach((matches, publish) => {
            if (matches(target)) publish(update)
          })
        }),
      subscriptions: () => Effect.sync(() => [...subscriptions]),
    })
    return Context.empty().pipe(Context.add(Service, test), Context.add(Test, test))
  }),
)

/**
 * Builds the native watches over a Parcel binding; a test passes its own binding. The Windows
 * directory watches parked in this scope end when it closes: a live Parcel watch keeps the event loop
 * running, so a host that closes Orbit could not exit otherwise.
 */
export const makeNative = Effect.fnUntraced(function* (
  binding: () => Pick<typeof ParcelWatcher, "subscribe"> | undefined,
  backend: ParcelWatcher.BackendType | undefined,
) {
  const pool: Pool = { closed: false, parked: new Map() }
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      pool.closed = true
      const parked = [...pool.parked.values()].flat()
      pool.parked.clear()
      return Promise.all(parked.map((entry) => entry.subscription.unsubscribe().catch(() => {})))
    }),
  )
  return Native.of({
    subscribe: (input) => {
      if (input.type === "file" || input.type === "entries") {
        return Effect.sync(() => {
          const directory = input.type === "file" ? path.dirname(input.target) : input.target
          const names = new Set(input.type === "file" ? [path.basename(input.target)] : input.names)
          const subscription = watch(directory, { recursive: false }, (_event, file) => {
            if (file && !names.has(file)) return
            for (const name of file ? [file] : names) {
              input.publish({ path: path.join(directory, name), type: "update" })
            }
          })
          subscription.on("error", (error: unknown) =>
            Effect.runFork(Effect.logError("watcher callback failed", { path: directory, error })),
          )
          return { unsubscribe: () => Promise.resolve(subscription.close()), backend: "node" }
        })
      }
      return Effect.suspend(() =>
        subscribeDirectory(binding(), backend, pool, input.target, input.ignore, input.publish),
      )
    },
  })
})

export const nativeLayer = Layer.effect(Native, makeNative(binding, backend()))

export const nativeNode = makeGlobalNode({ service: Native, layer: nativeLayer, deps: [] })

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [nativeNode] })
}

export const node = configured()

type DirectoryWatch = { publish: (update: Update) => void; ended: boolean }
type Parked = {
  readonly watch: DirectoryWatch
  readonly subscription: ParcelWatcher.AsyncSubscription
  readonly folder: string | undefined
}
type Pool = { closed: boolean; readonly parked: Map<string, Parked[]> }

// On Windows, @parcel/watcher's unsubscribe frees a watch while its directory read is still queued,
// and the read's completion then runs on freed memory and can crash the process
// (parcel-bundler/watcher#262; the fix, #277, is in no release yet). A live watch always has a read
// queued, so on Windows Orbit does not end one: a released watch is parked with its callback detached
// and the next watch of the same folder and ignore list reuses it. A watch that reported an error or
// the deletion of its own folder has no read queued, so it is unsubscribed and a folder created again
// gets a new native watch. A parked watch follows its folder when the folder is moved, and the binding
// would join a new watch of the same path to it, so a watch parked on a folder that is no longer at
// its path, or whose folder cannot be read, is unsubscribed too. That case, after a watched folder
// moved or became unreadable while nothing watched it, and the close of the native layer (see
// makeNative) are the two that still meet #262.
function subscribeDirectory(
  native: Pick<typeof ParcelWatcher, "subscribe"> | undefined,
  backend: ParcelWatcher.BackendType | undefined,
  pool: Pool,
  directory: string,
  ignore: readonly string[],
  publish: (update: Update) => void,
): Effect.Effect<Subscription | undefined> {
  if (!native || !backend) {
    return Effect.logError("watcher backend not supported", { directory, platform: process.platform }).pipe(
      Effect.as(undefined),
    )
  }
  const key = JSON.stringify([directory, ignore])
  const free = pool.parked.get(key) ?? []
  const current = free.length > 0 ? folderIdentity(directory) : undefined
  const reusable = (entry: Parked) => !entry.watch.ended && entry.folder !== undefined && entry.folder === current
  // The binding drops a callback before unsubscribe returns, so a subscribe after it starts a new
  // native watch instead of joining the one being ended.
  free.filter((entry) => !reusable(entry)).forEach((entry) => entry.subscription.unsubscribe().catch(() => {}))
  const reused = free.find(reusable)
  pool.parked.set(
    key,
    free.filter((entry) => entry !== reused && reusable(entry)),
  )
  const release = (watch: DirectoryWatch, subscription: ParcelWatcher.AsyncSubscription) => {
    if (backend !== "windows" || watch.ended || pool.closed) return subscription.unsubscribe()
    watch.publish = () => {}
    pool.parked.set(key, [...(pool.parked.get(key) ?? []), { watch, subscription, folder: folderIdentity(directory) }])
    return Promise.resolve()
  }
  if (reused) {
    reused.watch.publish = publish
    return Effect.succeed({ unsubscribe: () => release(reused.watch, reused.subscription), backend })
  }
  const watch: DirectoryWatch = { publish, ended: false }
  const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
    if (error) {
      watch.ended = true
      Effect.runFork(Effect.logError("watcher callback failed", { error }))
    }
    if (updates.some((update) => update.type === "delete" && update.path === directory)) watch.ended = true
    for (const update of updates) watch.publish(update)
  }
  // Copy `ignore`: it aliases the RcMap key, whose structural hash is cached,
  // so the array handed to native code must never be the mutable original.
  const pending = native.subscribe(directory, callback, { ignore: [...ignore], backend })
  return Effect.promise(() => pending).pipe(
    Effect.map((subscription) => ({ unsubscribe: () => release(watch, subscription), backend })),
    // Interruption (including the timeout below) abandons the pending native
    // subscription, so release it once it eventually resolves.
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        pending.then((subscription) => release(watch, subscription)).catch(() => {})
      }),
    ),
    Effect.timeout(SUBSCRIBE_TIMEOUT_MS),
    Effect.catchCause((cause) =>
      Effect.logError("failed to subscribe", {
        directory,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(undefined)),
    ),
  )
}

// Undefined when the folder cannot be read, which makes a parked watch not reusable.
function folderIdentity(directory: string) {
  try {
    const stat = statSync(directory, { bigint: true, throwIfNoEntry: false })
    return stat?.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined
  } catch {
    return undefined
  }
}
