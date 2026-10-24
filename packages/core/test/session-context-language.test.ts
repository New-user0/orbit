// Which sessions carry the reply language in their baseline, and where it sits among the other sources, on the real
// session context. The built-in sources are replaced by one source each, so the test sees the order and nothing else.
import { describe, expect } from "bun:test"
import { LanguageModel } from "@orbit/ai"
import { OpenAIChat } from "@orbit/ai/protocols"
import { Agent } from "@orbit/core/agent"
import { AgentInstructions } from "@orbit/core/agent/instructions"
import { Bus } from "@orbit/core/bus"
import { Config } from "@orbit/core/config"
import { Database } from "@orbit/core/database/database"
import { AppNodeBuilder } from "@orbit/core/effect/app-node-builder"
import { InstructionDiscovery } from "@orbit/core/instruction-discovery"
import { InstructionBuiltIns } from "@orbit/core/instructions/builtins"
import { Instructions } from "@orbit/core/instructions/index"
import { Location } from "@orbit/core/location"
import { McpInstructions } from "@orbit/core/mcp/instructions"
import { PluginSupervisor } from "@orbit/core/plugin/supervisor"
import { Project } from "@orbit/core/project"
import { ReferenceInstructions } from "@orbit/core/reference/instructions"
import { AbsolutePath } from "@orbit/core/schema"
import { SessionContext } from "@orbit/core/session/context"
import { SessionProjector } from "@orbit/core/session/projector"
import { SessionRunnerModel } from "@orbit/core/session/runner/model"
import { SessionSchema } from "@orbit/core/session/schema"
import { SessionStore } from "@orbit/core/session/store"
import { SkillInstructions } from "@orbit/core/skill/instructions"
import { Tool } from "@orbit/core/tool"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Effect, Layer, Schema } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { noMemory } from "./lib/memory"
import { noScratchpad } from "./lib/scratchpad"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"

const directory = AbsolutePath.make(FSUtil.resolve("/repo"))
const ids = {
  main: SessionSchema.ID.make("ses_lang_main"),
  sub: SessionSchema.ID.make("ses_lang_sub"),
  forkOfMain: SessionSchema.ID.make("ses_lang_fork_main"),
  forkOfSub: SessionSchema.ID.make("ses_lang_fork_sub"),
}

const source = (key: string) =>
  Instructions.make({
    key: Instructions.Key.make(key),
    codec: Schema.toCodecJson(Schema.String),
    read: Effect.succeed(key),
    render: { initial: (value) => `value of ${value}`, changed: (_previous, value) => `now ${value}` },
  })

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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Project.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      SessionContext.node,
      Location.node,
      Global.node,
      FSUtil.node,
    ]),
    [
      Global.node.replace(tempGlobalLayer),
      Config.node.replace(Config.testLayer()),
      SessionRunnerModel.node.replace(models),
      InstructionBuiltIns.node.replace(
        Layer.mock(InstructionBuiltIns.Service, {
          load: () => Effect.succeed(source("core/date")),
          preferences: () => Effect.succeed(source("core/language")),
        }),
      ),
      AgentInstructions.node.replace(
        Layer.mock(AgentInstructions.Service, { load: () => Effect.succeed(source("core/agent-guidance")) }),
      ),
      InstructionDiscovery.node.replace(InstructionDiscovery.configured()),
      SkillInstructions.node.replace(
        Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      ReferenceInstructions.node.replace(
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ),
      McpInstructions.node.replace(Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })),
      PluginSupervisor.node.replace(Layer.empty),
      noScratchpad,
      noMemory,
      Tool.node.replace(
        Layer.mock(Tool.Service, {
          snapshot: () =>
            Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
        }),
      ),
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory }, { projectDirectory: directory }))),
      ),
    ],
  ),
)

const keys = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const context = yield* SessionContext.Service
    return (yield* context.select(id)).instructions.map((item) => String(item.key))
  })

const seed = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
  })
  const options = { directory, agent: "build" }
  yield* insertSession({ id: ids.main, ...options })
  yield* insertSession({ id: ids.sub, parentID: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfMain, fork: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfSub, parentID: ids.main, fork: ids.sub, ...options })
})

describe("the reply language in a session's baseline", () => {
  it.live("sits after the agent guidance and before the instruction files on the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      const main = yield* keys(ids.main)
      expect(main.indexOf("core/language")).toBe(main.indexOf("core/agent-guidance") + 1)
      expect(main.indexOf("core/instructions")).toBe(main.indexOf("core/language") + 1)
    }),
  )

  it.live("is left out of a subagent and of a fork of one, and kept by a fork of the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      expect(yield* keys(ids.sub)).not.toContain("core/language")
      expect(yield* keys(ids.forkOfSub)).not.toContain("core/language")
      expect(yield* keys(ids.forkOfMain)).toContain("core/language")
    }),
  )
})
