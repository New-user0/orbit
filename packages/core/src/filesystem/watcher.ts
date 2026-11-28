export * as Watcher from "./watcher.js"

// @ts-ignore
import { createWrapper } from "@parcel/watcher/wrapper.js"
import type ParcelWatcher from "@parcel/watcher"
import { FileSystem } from "@orbit/schema/filesystem"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Cause, Context, Effect, Layer, PubSub, RcMap, Schema, Stream } from "effect"
import { lazy } from "../util/lazy.js"
import { DirectoryWatch } from "./directory-watch.js"
import { existsSync, statSync, watch } from "node:fs"
import path from "path"
import loadBinding from "./watcher-binding.js"

const SUBSCRIBE_TIMEOUT_MS = 10_000
const ended = Symbol("orbit.watcher.ended")
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
    input: Target & {
      readonly publish: (update: Update) => void
      /**
       * The watch ended on its own, after its last update, because its folder went away. The stream of every consumer
       * ends after that update. A consumer that watches again gets a native watch of its own, but nothing watches again
       * for a consumer: each one that keeps a record of what it watches forgets it when the stream ends.
       */
      readonly end?: () => void
    },
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
  /** Delivers one update like `emit`, then ends every watch that got it, as a native watch does when its folder goes away. */
  readonly end: (update: Update) => Effect.Effect<void>
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
            const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<Update | typeof ended>(), (pubsub) =>
              PubSub.shutdown(pubsub),
            )
            const subscription = yield* Effect.acquireRelease(
              native.subscribe({
                ...key,
                publish: (update) => PubSub.publishUnsafe(pubsub, update),
                // The update that told of the end is already queued, so every consumer reads it before its stream ends. The
                // entry leaves the map at once, so a consumer that watches again gets a native watch of its own.
                end: () => {
                  PubSub.publishUnsafe(pubsub, ended)
                  Effect.runSync(RcMap.invalidate(watchers, key))
                },
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
            return Stream.fromSubscription(subscription).pipe(Stream.takeWhile((item): item is Update => item !== ended))
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
    const ends = new Map<(update: Update) => void, () => void>()
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
          if (input.end) ends.set(input.publish, input.end)
          active.set(input.publish, (target) => {
            if (input.type === "file") return target === input.target
            if (input.type === "entries")
              return path.dirname(target) === input.target && input.names.includes(path.basename(target))
            return FSUtil.contains(input.target, target) && !ignored.some((entry) => FSUtil.contains(entry, target))
          })
          return {
            unsubscribe: () => {
              active.delete(input.publish)
              ends.delete(input.publish)
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
      end: (update) =>
        Effect.sync(() => {
          const target = path.resolve(update.path)
          active.forEach((matches, publish) => {
            if (!matches(target)) return
            publish(update)
            ends.get(publish)?.()
          })
        }),
      subscriptions: () => Effect.sync(() => [...subscriptions]),
    })
    return Context.empty().pipe(Context.add(Service, test), Context.add(Test, test))
  }),
)

/**
 * Builds the native watches: Bun's fs.watch for files and entries, and for folders either Parcel's binding (a test passes
 * its own) or, where `directories` is "fs", Bun's own recursive watch too.
 */
export const makeNative = Effect.fnUntraced(function* (
  binding: () => Pick<typeof ParcelWatcher, "subscribe"> | undefined,
  backend: ParcelWatcher.BackendType | undefined,
  directories: DirectoryMode = "parcel",
) {
  const pool: Pool = { ending: undefined }
  return Native.of({
    subscribe: (input) => {
      if (input.type === "file" || input.type === "entries") {
        return Effect.sync(() => {
          const directory = input.type === "file" ? path.dirname(input.target) : input.target
          const names = new Set(input.type === "file" ? [path.basename(input.target)] : input.names)
          const identity = folderIdentity(directory)
          const subscription = watch(directory, { recursive: false }, (event, file) => {
            // Bun keeps one watch per path on Linux: while this one stays open after its folder was removed and made
            // again, a new watch of the path hears nothing. So a watch whose folder went away reports it, closes, and
            // ends, and its consumers watch again once it is closed. A removed folder names itself in the event; the
            // identity also catches one that was made again before the event was read. A child named like the folder
            // (a/a) gives the same event, and is told by being there; one that was removed is told from it by nothing, and
            // ends the watch for no loss, since the consumers watch again.
            const removed =
              event === "rename" &&
              ((file === path.basename(directory) && !(file && existsSync(path.join(directory, file)))) ||
                folderIdentity(directory) !== identity)
            if (!removed && file && !names.has(file)) return
            for (const name of removed || !file ? names : [file]) {
              input.publish({ path: path.join(directory, name), type: "update" })
            }
            if (!removed) return
            close()
            input.end?.()
          })
          // Bun shares one watch among those of a path, and a second close of the same watch closes the one that was made
          // after it: the watch that ended is closed once, here, and its consumers' release finds it closed.
          let closed = false
          const close = () => {
            if (closed) return
            closed = true
            subscription.close()
          }
          subscription.on("error", (error: unknown) =>
            Effect.runFork(Effect.logError("watcher callback failed", { path: directory, error })),
          )
          return { unsubscribe: () => Promise.resolve(close()), backend: "node" }
        })
      }
      if (directories === "fs") {
        return Effect.try({
          try: () => DirectoryWatch.make(input.target, input.ignore, input.publish, input.end),
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.logError("failed to subscribe", { directory: input.target, error }).pipe(Effect.as(undefined)),
          ),
        )
      }
      return Effect.suspend(() =>
        subscribeDirectory(binding(), backend, pool, input.target, input.ignore, input.publish, input.end),
      )
    },
  })
})

/**
 * How folders are watched. Parcel's Windows backend returns from subscribe before the read of the folder is queued to its
 * thread, so a file written right after a watch is ready is lost for good, and ending one of its watches can crash the
 * process (parcel-bundler/watcher#262). Bun's recursive `fs.watch` is armed when it returns, so Windows uses it
 * (`directory-watch.ts`); Linux and macOS use Parcel.
 */
export type DirectoryMode = "parcel" | "fs"
export const directoryMode = (): DirectoryMode => (process.platform === "win32" ? "fs" : "parcel")

export const nativeLayer = Layer.effect(Native, makeNative(binding, backend(), directoryMode()))

export const nativeNode = makeGlobalNode({ service: Native, layer: nativeLayer, deps: [] })

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [nativeNode] })
}

export const node = configured()

// Every native watch that is still being ended. Parcel shares one backend among all the watches of a process and destroys
// it when the last one ends, so a watch of any folder that is made while the last one is being ended joins the backend
// that is going away and hears nothing for good. A subscribe waits for this, so an unsubscribe that never settles blocks
// every later directory subscribe of the process, each until its 10 s limit.
type Pool = { ending: Promise<unknown> | undefined }

function subscribeDirectory(
  native: Pick<typeof ParcelWatcher, "subscribe"> | undefined,
  backend: ParcelWatcher.BackendType | undefined,
  pool: Pool,
  directory: string,
  ignore: readonly string[],
  publish: (update: Update) => void,
  end: (() => void) | undefined,
): Effect.Effect<Subscription | undefined> {
  if (!native || !backend) {
    return Effect.logError("watcher backend not supported", { directory, platform: process.platform }).pipe(
      Effect.as(undefined),
    )
  }
  const callback: ParcelWatcher.SubscribeCallback = (error, updates) => {
    if (error) Effect.runFork(Effect.logError("watcher callback failed", { error }))
    for (const update of updates) publish(update)
    // The watch is over when its folder is deleted or the backend failed: its consumers watch again, after it is ended.
    if (error || updates.some((update) => update.type === "delete" && update.path === directory)) end?.()
  }
  const subscribe = () => native.subscribe(directory, callback, { ignore: [...ignore], backend })
  const pending = pool.ending ? pool.ending.then(subscribe) : subscribe()
  const release = (subscription: ParcelWatcher.AsyncSubscription) => ending(pool, subscription.unsubscribe())
  return Effect.promise(() => pending).pipe(
    Effect.map((subscription) => ({ unsubscribe: () => release(subscription), backend })),
    // Interruption (including the timeout below) abandons the pending native subscription, so release it once it
    // eventually resolves. It is counted at once, so a watch made before the native one resolves waits for its end too.
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        ending(pool, pending.then(release)).catch(() => {})
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

// Undefined when the folder cannot be read: a watch of a file or entries compares it to tell a folder that was made again.
function folderIdentity(directory: string) {
  try {
    const stat = statSync(directory, { bigint: true, throwIfNoEntry: false })
    return stat?.isDirectory() ? `${stat.dev}:${stat.ino}` : undefined
  } catch {
    return undefined
  }
}

// Tracks the end of a native watch in the pool, and returns it. The pool forgets it once it and every end after it settled.
function ending<T>(pool: Pool, unsubscribed: Promise<T>) {
  const settled = Promise.all([pool.ending, unsubscribed.catch(() => {})]).then(() => {
    if (pool.ending === settled) pool.ending = undefined
  })
  pool.ending = settled
  return unsubscribed
}
