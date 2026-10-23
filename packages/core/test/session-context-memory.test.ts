// context-memory-9: where the memory guide and index sit in a session's baseline, and which sessions carry them, on the
// real session context with the real memory sources. The index follows the instruction files, as the reference loads
// MEMORY.md after its instruction files; the guide is for the main thread, as the reference's memory section is part
// of the main system prompt only, and a system prompt that replaces Orbit's (`system_prompt`) drops it while the index
// stays; an agent that leaves the instruction files out (`context.instructions: false`) gets no index.
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
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
import { Document, Info, type Entry } from "@orbit/schema/config"
import { LayerNode } from "@orbit/util/effect/layer-node"
import { FSUtil } from "@orbit/util/fs-util"
import { Global } from "@orbit/util/global"
import { Effect, Layer, Schema } from "effect"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { noScratchpad } from "./lib/scratchpad"
import { insertSession } from "./lib/session-row"
import { stubSnapshot } from "./lib/tool"

const directory = AbsolutePath.make(FSUtil.resolve("/repo"))
const GUIDE = "core/memory-guide"
const INDEX = "core/memory-index"
const ids = {
  main: SessionSchema.ID.make("ses_mem_ctx_main"),
  sub: SessionSchema.ID.make("ses_mem_ctx_sub"),
  forkOfMain: SessionSchema.ID.make("ses_mem_ctx_fork_main"),
  forkOfSub: SessionSchema.ID.make("ses_mem_ctx_fork_sub"),
  bare: SessionSchema.ID.make("ses_mem_ctx_bare"),
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

const harness = (entries: Entry[] = []) =>
  testEffect(
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
        Config.node.replace(Config.testLayer(entries)),
        SessionRunnerModel.node.replace(models),
        InstructionBuiltIns.node.replace(
          Layer.mock(InstructionBuiltIns.Service, {
            load: () => Effect.succeed(source("core/date")),
            preferences: () => Effect.succeed(Instructions.empty),
          }),
        ),
        AgentInstructions.node.replace(
          Layer.mock(AgentInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured()),
        SkillInstructions.node.replace(
          Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        ReferenceInstructions.node.replace(
          Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        McpInstructions.node.replace(
          Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
        ),
        PluginSupervisor.node.replace(Layer.empty),
        noScratchpad,
        Tool.node.replace(
          Layer.mock(Tool.Service, {
            snapshot: () =>
              Effect.succeed(stubSnapshot({ definitions: [], execute: () => Effect.die(new Error("unused")) })),
          }),
        ),
        Location.node.replace(
          Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory }, { projectDirectory: directory })),
          ),
        ),
      ],
    ),
  )

const it = harness()
const customPrompt = harness([
  new Document({
    type: "document",
    scope: "user",
    path: AbsolutePath.make(FSUtil.resolve("/config/orbit.json")),
    info: Schema.decodeUnknownSync(Info)({ system_prompt: "You are a custom assistant." }),
  }),
])

// The sources of a session's baseline, each with whether it holds a value.
const sources = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const context = yield* SessionContext.Service
    const instructions = (yield* context.select(id)).instructions
    const read = yield* Instructions.read(instructions)
    return {
      keys: instructions.map((item) => String(item.key)),
      present: read.flatMap((entry) => (entry.value === Instructions.removed ? [] : [String(entry.key)])),
    }
  })

const seed = Effect.gen(function* () {
  const global = yield* Global.Service
  yield* Effect.promise(async () => {
    const folder = path.join(global.data, "memory", Project.ID.global)
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(path.join(folder, "MEMORY.md"), "- [a](a.md): a memory\n")
  })
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    })
    editor.update(Agent.ID.make("bare"), (agent) => {
      agent.mode = "primary"
      agent.context = { instructions: false }
    })
  })
  const options = { directory, agent: "build" }
  yield* insertSession({ id: ids.main, ...options })
  yield* insertSession({ id: ids.sub, parentID: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfMain, fork: ids.main, ...options })
  yield* insertSession({ id: ids.forkOfSub, parentID: ids.main, fork: ids.sub, ...options })
  yield* insertSession({ id: ids.bare, directory, agent: "bare" })
})

describe("memory in a session's baseline", () => {
  it.live("puts the guide and then the index right after the instruction files on the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      const main = yield* sources(ids.main)
      expect(main.keys.indexOf(GUIDE)).toBe(main.keys.indexOf("core/instructions") + 1)
      expect(main.keys.indexOf(INDEX)).toBe(main.keys.indexOf(GUIDE) + 1)
      expect(main.keys.indexOf("core/date")).toBe(main.keys.indexOf(INDEX) + 1)
      expect(main.present).toContain(GUIDE)
      expect(main.present).toContain(INDEX)
    }),
  )

  it.live("gives a subagent and a fork of one the index without the guide, and a fork of the main thread both", () =>
    Effect.gen(function* () {
      yield* seed
      for (const id of [ids.sub, ids.forkOfSub]) {
        const sub = yield* sources(id)
        expect(sub.present).not.toContain(GUIDE)
        expect(sub.present).toContain(INDEX)
      }
      const fork = yield* sources(ids.forkOfMain)
      expect(fork.present).toContain(GUIDE)
      expect(fork.present).toContain(INDEX)
    }),
  )

  it.live("leaves the index out for an agent that leaves the instruction files out", () =>
    Effect.gen(function* () {
      yield* seed
      const bare = yield* sources(ids.bare)
      expect(bare.present).not.toContain(INDEX)
      expect((yield* sources(ids.main)).present).toContain(INDEX)
    }),
  )
})

describe("memory under a system prompt of the person's", () => {
  customPrompt.live("drops the guide and keeps the index on the main thread", () =>
    Effect.gen(function* () {
      yield* seed
      const main = yield* sources(ids.main)
      expect(main.keys).toContain(GUIDE)
      expect(main.present).not.toContain(GUIDE)
      expect(main.present).toContain(INDEX)
    }),
  )
})
