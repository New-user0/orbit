import { NodeFileSystem } from "@effect/platform-node"
import { Effect, Layer } from "effect"
import { FSUtil } from "@orbit/util/fs-util"
import { LinkShare } from "@orbit/util/link-share"
import { AgentFile } from "@orbit/core/config/plugin/agent-file"
import { CommandFile } from "@orbit/core/config/plugin/command-file"

// Run by `link-share-bounds.test.ts` in a child process, so that a walk which does not end cannot hold the test runner's
// event loop: the parent kills it at a deadline. Argument: the project folder. It loads the commands, agents and skills
// below `.orbit` and walks up from a folder inside the plugin's package folder, and prints the time of each.
const project = process.argv[2]!
const timed = async <A>(run: Effect.Effect<A, unknown, FSUtil.Service>) => {
  const started = Date.now()
  const value = await Effect.runPromise(
    run.pipe(Effect.provide(Layer.provide(FSUtil.layer, NodeFileSystem.layer))) as Effect.Effect<A>,
  )
  return { ms: Date.now() - started, value }
}

const orbit = `${project}/.orbit`
const commands = await timed(
  Effect.gen(function* () {
    const files = yield* FSUtil.Service
    return (yield* CommandFile.load(files, orbit)).length
  }),
)
const agents = await timed(
  Effect.gen(function* () {
    const files = yield* FSUtil.Service
    return (yield* AgentFile.load(files, orbit)).length
  }),
)
const skills = await timed(
  Effect.gen(function* () {
    const files = yield* FSUtil.Service
    return (yield* LinkShare.scan(files, `${orbit}/skills`, ["{*.md,**/SKILL.md}"])).length
  }),
)
const up = await timed(
  Effect.gen(function* () {
    const files = yield* FSUtil.Service
    return (yield* files.up({ targets: ["AGENTS.md"], start: `${orbit}/plugins/p/node_modules/a/b`, stop: project })).length
  }),
)
console.log(JSON.stringify({ commands, agents, skills, up }))
