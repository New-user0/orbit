import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Effect, Layer } from "effect"

/**
 * The real `FSUtil` that remembers every path it is called with, so that a test pins what was touched rather than how
 * long it took: a stat or a connection to a share cannot hide behind a fast answer. `touched` is cleared by the test
 * before the call it watches.
 */
export const recordedFileSystem = () => {
  const touched: string[] = []
  // Each call as `method path`, for a test that pins which folders were listed: a link's own path is a drive path, so a
  // listing of the share it leads to shows in `touched` only under that path.
  const calls: string[] = []
  const layer = Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      return new Proxy(real, {
        get: (target, key) => {
          const value: unknown = (target as unknown as Record<string | symbol, unknown>)[key]
          if (typeof value !== "function") return value
          return (...args: unknown[]) => {
            calls.push(
              ...args.filter((arg): arg is string => typeof arg === "string").map((arg) => `${String(key)} ${arg}`),
            )
            touched.push(...args.filter((arg): arg is string => typeof arg === "string"))
            return value.apply(target, args)
          }
        },
      })
    }),
  ).pipe(Layer.provide(FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))))
  return { layer, touched, calls }
}

/** The recorded paths that name a share or a device (`\\host\share`, `//host/share`, `\\?\...`, `\\.\...`). */
export const sharesTouched = (touched: readonly string[]) =>
  touched.filter((file) => file.startsWith("\\\\") || file.startsWith("//"))
