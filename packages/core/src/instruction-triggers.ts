export * as InstructionTriggers from "./instruction-triggers.js"

import { dirname } from "path"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@orbit/util/effect/app-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Config } from "./config.js"
import { ConfigInstructionFile } from "./config/instruction-file.js"
import { InstructionDiscovery } from "./instruction-discovery.js"
import { Location } from "./location.js"
import { SessionInstructions } from "./session/instructions.js"
import { SessionSchema } from "./session/schema.js"

export interface Target {
  readonly path: string
  /** The path is a folder the model listed: its own instruction file counts, not only those above it. */
  readonly listing?: boolean
}

export interface Interface {
  /**
   * A file or folder reached the model through a tool. The instruction files of the folders between the folder the
   * session started in (exclusive) and the target are handed to the session, outermost folder first. It never fails: what
   * goes wrong here costs the nested files, not the tool call that triggered it.
   */
  readonly touched: (input: {
    readonly sessionID: SessionSchema.ID
    readonly targets: ReadonlyArray<Target>
  }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@orbit/InstructionTriggers") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const discovery = yield* InstructionDiscovery.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const instructions = yield* SessionInstructions.Service

    const walk = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, target: Target) {
      const root = yield* fs.resolve(location.directory)
      const real = yield* fs.resolve(target.path)
      // Only what is strictly inside the folder the session started in: that folder and the ones above it are loaded at
      // the start. Both paths are real, so a link cannot make a file outside look inside, or the other way round.
      if (real === root || !FSUtil.contains(root, real)) return
      const start = target.listing ? real : dirname(real)
      const folders = new Set<string>()
      for (let folder = start; folder !== root && FSUtil.contains(root, folder); folder = dirname(folder)) folders.add(folder)
      if (folders.size === 0) return
      const discovered = yield* fs.up({
        targets: [...ConfigInstructionFile.names(yield* config.compatEnabled())],
        start,
        stop: root,
        type: "file",
      })
      // A name that the settings exclude is as good as absent, as it is when the session starts, so the next name in its
      // folder is the one that loads. `SessionInstructions` asks again for every path it is given.
      const patterns = yield* ConfigInstructionFile.prepare(
        ConfigInstructionFile.excludes(yield* config.entries()),
        fs.resolve,
      )
      const candidates = (yield* ConfigInstructionFile.included(patterns, discovered, fs.resolve))
        .map((item) => ({ real: item.real, folder: dirname(item.file) }))
        .filter((item) => folders.has(item.folder))
      // `up` walks from the target's folder outward and names the folder's files in order, so the first of a folder is the
      // one it loads, as it is when the session starts. The file being read is dropped after that choice, not before it:
      // reading a folder's first file must not bring the second. The model reads the outermost folder's file first.
      const paths = candidates
        .filter(
          (item, index) =>
            candidates.findIndex((other) => other.folder === item.folder) === index && item.real !== real,
        )
        .map((item) => item.real)
        .reverse()
        .filter((path, index, all) => all.indexOf(path) === index)
      if (paths.length === 0) return
      yield* instructions.load({ sessionID, paths })
    })

    return Service.of({
      touched: Effect.fn("InstructionTriggers.touched")(function* (input) {
        // `--bare` and a vanilla instance read nothing about the project, and a file the model reads is no exception.
        if (!discovery.project) return
        for (const target of input.targets)
          yield* walk(input.sessionID, target).pipe(
            Effect.catch((error) => Effect.logDebug("nested instruction files not loaded", { error })),
            Effect.catchDefect((defect) => Effect.logDebug("nested instruction files not loaded", { defect })),
          )
      }),
    })
  }),
)

export const node = makeLocationNode({
  name: "instruction-triggers",
  layer,
  deps: [Config.node, FSUtil.node, InstructionDiscovery.node, Location.node, SessionInstructions.node],
})
