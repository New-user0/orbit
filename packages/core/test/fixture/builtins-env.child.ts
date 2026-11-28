// Run by test/instructions/builtins.test.ts in a child `bun test` with ORBIT_DISABLE_INSTRUCTIONS set: the default
// InstructionBuiltIns.node reads that variable once, when its module loads, so only a fresh process sees it set.
import { expect, test } from "bun:test"
import os from "os"
import { Effect, Layer } from "effect"
import { Config } from "@orbit/core/config"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Location } from "@orbit/core/location"
import { AbsolutePath } from "@orbit/core/schema"
import { ShellSelect } from "@orbit/core/shell/select"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { location } from "./location"

test("the default node carries the tool-results section unless the variable is 1", async () => {
  const config = Config.testLayer()
  const layer = Layer.merge(
    config,
    AppNodeBuilder.build(LayerNode.group([InstructionBuiltIns.node, ShellSelect.node]), [
      Location.node.replace(
        Layer.succeed(
          Location.Service,
          Location.Service.of(location({ directory: AbsolutePath.make(FSUtil.resolve("/repo")) })),
        ),
      ),
      Global.node.replace(Global.layerWith({ config: os.tmpdir(), tmp: os.tmpdir() })),
      Config.node.replace(config),
    ]),
  )
  const count = await Effect.gen(function* () {
    const context = yield* InstructionBuiltIns.Service
    return context.toolResults(Effect.succeed(true)).length
  }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)
  expect(count).toBe(process.env.ORBIT_DISABLE_INSTRUCTIONS === "1" ? 0 : 1)
})
