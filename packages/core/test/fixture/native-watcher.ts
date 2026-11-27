import type ParcelWatcher from "@parcel/watcher"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Effect, Layer, Scope } from "effect"

// The native watches of a test process. Closing `Watcher.makeNative` ends every Windows directory watch it parked, and
// ending a live Parcel watch on Windows can free it while its directory read is still queued
// (parcel-bundler/watcher#262), which crashed core test workers (FU-M5-022). Each test builds and closes a runtime of
// its own, so the tests met that close all the time. A test process has no need for it: bun ends a test worker with
// live watches still open. So the runtimes of a test process take their watches from one pool per binding whose scope
// is never closed, and a runtime that closes parks its watches there for the next one instead of ending them.

type Binding = () => Pick<typeof ParcelWatcher, "subscribe"> | undefined

const pools = new Map<Binding, Watcher.NativeInterface>()

/** The process's native watches over `binding`: built on first use, never closed. */
export function processNative(binding: Binding, backend: ParcelWatcher.BackendType | undefined) {
  const found = pools.get(binding)
  if (found) return found
  const native = Effect.runSync(
    Scope.make().pipe(Effect.flatMap((scope) => Watcher.makeNative(binding, backend).pipe(Scope.provide(scope)))),
  )
  pools.set(binding, native)
  return native
}

/**
 * For `Watcher.nativeNode.replace`: the real binding, with the process's watches. A row whose runtime is built apart
 * from the row's own memo map (`Layer.fresh`, or a plain `test` that calls Effect.runPromise) replaces the node with it.
 */
export const processNativeLayer = Layer.sync(Watcher.Native, () => processNative(Watcher.binding, Watcher.backend()))

/**
 * Effect builds a runtime's layers in a fork of the fiber's `Layer.CurrentMemoMap`, and a fork reuses what its parent
 * has already built. This parent holds one entry, the product's `Watcher.nativeLayer` (which `Watcher.nativeNode`
 * builds), built once from the process's watches in a scope that is never closed; everything else a runtime builds
 * stays in its own fork and closes with it. `testEffect` runs every row with it, so no row's runtime ends a live watch.
 */
export const processMemoMap = Effect.runSync(
  Effect.gen(function* () {
    const memo = Layer.makeMemoMapUnsafe()
    const scope = yield* Scope.make()
    yield* memo.getOrElseMemoize(Watcher.nativeLayer, scope, (map, layerScope) =>
      Layer.buildWithMemoMap(processNativeLayer, map, layerScope),
    )
    return memo
  }),
)
