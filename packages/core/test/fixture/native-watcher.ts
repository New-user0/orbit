import type ParcelWatcher from "@parcel/watcher"
import { afterAll } from "bun:test"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Effect, Exit, Layer, Scope } from "effect"

// The native watches of a test file. Closing `Watcher.makeNative` ends every Windows directory watch it parked, and
// ending a live Parcel watch on Windows can free it while its directory read is still queued
// (parcel-bundler/watcher#262), which crashed core test workers (FU-M5-022). Each test builds and closes a runtime of
// its own, so the tests met that close all the time. So the runtimes of a test file take their watches from one pool
// per binding, and a runtime that closes parks its watches there for the next one instead of ending them.
//
// The pool ends with its file. A parallel worker runs each file in a fresh module registry and global, and the binding
// keeps one native watch per folder for the whole process, so a watch left open by a finished file would join the next
// file's watch of the same folder and hand its events to a callback of the finished file's global. In the ci-measure
// runs of ci-always-green, pools that were never closed went with four worker crashes in 77 Windows core 1/3 runs (two
// in JSC's marking, one in the binding's read completion, one fail-fast) against none in 45 runs of the base, which ends
// each runtime's watches. Closing once, after the file's last row, ends only what is still parked by then: most of it
// watches folders the rows already removed, which have no read queued.

type Binding = () => Pick<typeof ParcelWatcher, "subscribe"> | undefined

const pools = new Map<Binding, Watcher.NativeInterface>()
const scopes: Scope.Closeable[] = []

const fileScope = () => {
  const scope = Effect.runSync(Scope.make())
  scopes.push(scope)
  return scope
}

afterAll(() => Effect.runPromise(Effect.forEach(scopes.splice(0), (scope) => Scope.close(scope, Exit.void))))

/** The file's native watches over `binding`: built on first use, ended after the file's last row. */
export function processNative(binding: Binding, backend: ParcelWatcher.BackendType | undefined) {
  const found = pools.get(binding)
  if (found) return found
  const native = Effect.runSync(Watcher.makeNative(binding, backend).pipe(Scope.provide(fileScope())))
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
 * builds), built once from the file's watches (the entry's own scope holds no finalizer: the pool's scope ends with the
 * file); everything else a runtime builds stays in its own fork and closes with it. `testEffect` runs every row with
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
