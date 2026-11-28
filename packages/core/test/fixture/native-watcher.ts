import type ParcelWatcher from "@parcel/watcher"
import { Watcher } from "@orbit/core/filesystem/watcher"
import { Effect, Layer, Scope } from "effect"

// The native watches of a test file: one pool per binding, built on first use and never closed, so every runtime a row
// builds takes the watches of the process. A watch a finished file leaves open keeps a callback of that file's global,
// which a parallel worker replaces for its next file, so a later file must not touch a folder the watch follows: the rows
// watch folders of their own under tmpdir(), which they remove while their file runs (a removed folder ends its watch),
// and test/preload.ts gives each file a config folder of its own, the one folder that a runtime with the default Global
// watches outside a row's folders.

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
