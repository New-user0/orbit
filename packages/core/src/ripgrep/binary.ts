import path from "path"
import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { which } from "@orbit/util/which"

export namespace RipgrepBinary {
  interface Interface {
    readonly filepath: Effect.Effect<string, Error>
  }

  export class Service extends Context.Service<Service, Interface>()("@orbit/RipgrepBinary") {}

  const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const executable = process.platform === "win32" ? "rg.exe" : "rg"

      return Service.of({
        // ripgrep is never downloaded at runtime: it must already be on PATH or in the app's bin directory.
        filepath: yield* Effect.cached(
          Effect.gen(function* () {
            const system = which(executable, undefined, global.bin)
            if (system && (yield* fs.isFile(system).pipe(Effect.orDie))) return system
            const target = path.join(global.bin, executable)
            if (yield* fs.isFile(target).pipe(Effect.orDie)) return target
            return yield* Effect.fail(
              new Error(`ripgrep (${executable}) was not found. Install ripgrep and put it on PATH, or copy it to ${target}.`),
            )
          }),
        ),
      })
    }),
  )

  export const node = makeGlobalNode({
    service: Service,
    layer: layer,
    deps: [FSUtil.node, Global.node],
  })
}
