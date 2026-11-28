import type ParcelWatcher from "@parcel/watcher"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Effect, Layer, Scope } from "effect"

// The native watches of a test file. Closing `Watcher.makeNative` ends every Windows directory watch it parked or
// retired, and ending a live Parcel watch on Windows can free it while its directory read is still queued
// (parcel-bundler/watcher#262), which crashed core test workers (FU-M5-022). Each test builds and closes a runtime of
// its own, so the tests met that close all the time. So the runtimes of a test file take their watches from one pool
// per binding, and a runtime that closes parks its watches there for the next one instead of ending them.
//
// The pool is never closed: a test process ends no live watch. Bun ends a test worker with live watches still open,
// so nothing waits on them. A watch the file leaves open keeps a callback of the file's global, which a parallel worker
// replaces for its next file, so a later file must not touch a folder the watch follows: the rows watch folders of
// their own under tmpdir(), which they remove while their file runs (a removed folder ends its watch), and test/preload.ts
// gives each file a config folder of its own, the one folder that a runtime with the default Global watches outside a
// row's folders. A count over the core files that watch folders on Windows found 12 ends of a watch that still had a
// read queued in one pass before (at a file's end, in config/reload's replaced roots and its repository skill folders)
// and none after.

type Binding = () => Pick<typeof ParcelWatcher, "subscribe"> | undefined

const pools = new Map<Binding, Watcher.NativeInterface>()

/** The file's native watches over `binding`: built on first use, never ended. */
export function processNative(
  binding: Binding,
  backend: ParcelWatcher.BackendType | undefined,
  mode: Watcher.DirectoryMode = Watcher.directoryMode(),
) {
  const found = pools.get(binding)
  if (found) return found
  const native = Effect.runSync(Watcher.makeNative(binding, backend, mode).pipe(Scope.provide(Effect.runSync(Scope.make()))))
  pools.set(binding, native)
  return native
}

/**
 * For `Watcher.nativeNode.replace`: the real binding, with the file's watches. A row whose runtime is built apart
 * from the row's own memo map (`Layer.fresh`, or a plain `test` that calls Effect.runPromise) replaces the node with it.
 */
export const processNativeLayer = Layer.sync(Watcher.Native, () => processNative(Watcher.binding, Watcher.backend()))

/**
 * Effect builds a runtime's layers in a fork of the fiber's `Layer.CurrentMemoMap`, and a fork reuses what its parent
 * has already built. This parent holds one entry, the product's `Watcher.nativeLayer` (which `Watcher.nativeNode`
 * builds), built once from the file's watches (the entry's own scope holds no finalizer, and the pool's scope is never
 * closed); everything else a runtime builds stays in its own fork and closes with it. `testEffect` runs every row with
 * it, so no row's runtime ends a live watch.
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
