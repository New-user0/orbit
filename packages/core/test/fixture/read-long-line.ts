// Run in a child process by tool-read-filesystem.test.ts: reads one file through the Read driver and reports what came
// back and what it cost. argv: file, offset (or "-"), limit (or "-").
import { Environment } from "@orbit/core/environment/index"
import { AbsolutePath } from "@orbit/core/schema"
import { ReadToolFileSystem } from "@orbit/core/tool/read-filesystem"
import { CrossSpawnSpawner } from "@orbit/util/cross-spawn-spawner"
import { LayerNodePlatform } from "@orbit/util/effect/app-node-platform"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"

const [file, offset, limit] = process.argv.slice(2)
const layer = LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node, LayerNodePlatform.filesystem]))
const started = performance.now()

const outcome = await Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const environment = Environment.makeFiles(Environment.makeLocalDriver(spawner))
  return yield* ReadToolFileSystem.read(environment, AbsolutePath.make(file), "long-line.txt", {
    ...(offset === "-" ? {} : { offset: Number(offset) }),
    ...(limit === "-" ? {} : { limit: Number(limit) }),
  }).pipe(
    Effect.map((result) => ({
      type: result.content.type,
      content: "content" in result.content ? result.content.content.slice(0, 40) : "",
      length: "content" in result.content ? result.content.content.length : 0,
      next: "next" in result.content ? result.content.next : undefined,
    })),
    Effect.catch((error) => Effect.succeed({ error: error._tag })),
  )
}).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

console.log(
  JSON.stringify({ outcome, ms: performance.now() - started, maxRssMb: process.resourceUsage().maxRSS / 1024 }),
)
