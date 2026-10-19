// The scratchpad in the baseline of a session: where it stands among the sources, and who shares it. The sources are the
// real ones for the date, the environment, the scratchpad and the entries of the API, on the real session context.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { Project } from "@orbit/core/project"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { InstructionEntry } from "@orbit/core/session/instruction-entry"
import { InstructionState } from "@orbit/core/session/instruction-state"
import { SessionHistory } from "@orbit/core/session/history"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionScratchpad } from "@orbit/core/session/scratchpad"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Tool } from "@orbit/core/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { Global } from "@orbit/util/global"
import { Effect, Layer } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"

const directory = "/project"
const ids = {
  main: SessionSchema.ID.make("ses_baseline_main"),
  child: SessionSchema.ID.make("ses_baseline_child"),
  fork: SessionSchema.ID.make("ses_baseline_fork"),
  forkOfChild: SessionSchema.ID.make("ses_baseline_forkchild"),
}

const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(LanguageModel.make({ id: "primary", provider: "test", route: OpenAIChat.route }), {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})
const empty = Instructions.empty

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      InstructionEntry.node,
      SessionScratchpad.node,
      SessionContext.node,
      Global.node,
    ]),
    [
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
      SessionRunnerModel.node.replace(models),
      InstructionDiscovery.node.replace(
        Layer.mock(InstructionDiscovery.Service, { project: true, global: true, load: () => Effect.succeed(empty) }),
      ),
      SkillInstructions.node.replace(Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(empty) })),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(empty) }),
      ),
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(empty) })),
      PluginSupervisor.node.replace(Layer.empty),
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: () =>
            Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
        }),
      ),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make(directory) })),
    ],
  ),
)

const setup = Effect.gen(function* () {
  const agents = yield* Agent.Service
  const context = yield* SessionContext.Service
  const scratchpad = yield* SessionScratchpad.Service
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
  const options = { directory, agent: "build" }
  yield* insertSession({ id: ids.main, ...options })
  yield* insertSession({ id: ids.child, parentID: ids.main, ...options })
  yield* insertSession({ id: ids.fork, fork: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfChild, fork: ids.child, ...options })
  const select = (id: SessionSchema.ID) => context.select(id)
  // The value that a session's baseline would hold for the scratchpad, as it reads it now.
  const value = (id: SessionSchema.ID) =>
    select(id).pipe(
      Effect.flatMap((selected) => Instructions.read(selected.instructions)),
      Effect.map((read) => read.find((entry) => entry.key === "core/scratchpad")?.value),
    )
  const prepare = (id: SessionSchema.ID) =>
    select(id).pipe(Effect.flatMap((selected) => InstructionState.prepare(db, bus, selected.instructions, id)))
  return { context, scratchpad, db, select, value, prepare }
})

describe("an exact fork renders its parent's baseline", () => {
  it.live("the rendered epoch baseline of an exact fork of a root session equals the parent's", () =>
    Effect.gen(function* () {
      const { db, select, prepare } = yield* setup
      yield* prepare(ids.main)
      const values = yield* InstructionState.values(db, ids.main)
      // As Session.fork({ prompt: "exact" }) seeds it: initial from the parent's initial, current from its current.
      yield* InstructionState.initialize(db, ids.fork, 0, { initial: values!.initial, current: values!.current })
      const parent = yield* InstructionState.initial(db, ids.main, (yield* select(ids.main)).instructions)
      const fork = yield* InstructionState.initial(db, ids.fork, (yield* select(ids.fork)).instructions)
      expect(parent).toContain("# Scratchpad")
      expect(fork).toBe(parent)
    }),
  )
})

