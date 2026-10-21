import { Effect } from "effect"
import { Git } from "@orbit/core/git"
import { AbsolutePath } from "@orbit/core/schema"
import { gitExecutable } from "@orbit/core/util/git-executable"
import { LayerNode } from "@orbit/util/effect/layer-node"

// What a host does to start git: the Git service of the core, which starts `gitExecutable` through the spawner of Orbit, in
// the folder in its first argument. A test runs this file in a process of its own, under Bun and bundled for Node, with a PATH
// that the test chose, because `gitExecutable` is decided once when the module loads and the lookup that Windows makes
// depends on the host that spawns. It prints what it resolved and whether git found a repository.
const folder = AbsolutePath.make(process.argv[2]!)

const repository = await Effect.gen(function* () {
  return yield* (yield* Git.Service).repo.discover(folder)
}).pipe(Effect.provide(LayerNode.compile(Git.node)), Effect.scoped, Effect.runPromise)

console.log(JSON.stringify({ gitExecutable, found: repository !== undefined }))
